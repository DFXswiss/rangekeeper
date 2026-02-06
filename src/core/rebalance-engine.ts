import { BigNumber, providers } from 'ethers';
import { getLogger } from '../util/logger';
import { PoolMonitor, PoolState, PositionRange } from './pool-monitor';
import { PositionManager, RemoveResult } from './position-manager';
import { calculateBands } from './range-calculator';
import { SwapExecutor, SwapResult } from '../swap/swap-executor';
import { EmergencyStop } from '../risk/emergency-stop';
import { SlippageGuard } from '../risk/slippage-guard';
import { ILTracker } from '../risk/il-tracker';
import { BalanceTracker } from './balance-tracker';
import { StateStore, RebalanceStage, BandState } from '../persistence/state-store';
import { HistoryLogger, OperationType } from '../persistence/history-logger';
import { Notifier } from '../notification/notifier';
import { updatePoolStatus } from '../health/health-server';
import { PoolEntry } from '../config';
import { getErc20Contract } from '../chain/contracts';
import { GasOracle, estimateGasCostUsd } from '../chain/gas-oracle';
import { NonceTracker } from '../chain/nonce-tracker';
import { tickToPrice } from '../util/tick-math';
import { Wallet } from 'ethers';
import { BandManager, Band, TriggerDirection } from './band-manager';

export type RebalanceState = 'IDLE' | 'MONITORING' | 'EVALUATING' | 'WITHDRAWING' | 'SWAPPING' | 'MINTING' | 'ERROR' | 'STOPPED';

const REBALANCE_GAS_ESTIMATE = 800_000;
const ETH_PRICE_USD_FALLBACK = 3000;

export interface RebalanceContext {
  poolEntry: PoolEntry;
  wallet: Wallet;
  poolMonitor: PoolMonitor;
  positionManager: PositionManager;
  swapExecutor: SwapExecutor;
  emergencyStop: EmergencyStop;
  slippageGuard: SlippageGuard;
  ilTracker: ILTracker;
  balanceTracker: BalanceTracker;
  gasOracle: GasOracle;
  stateStore: StateStore;
  historyLogger: HistoryLogger;
  notifier: Notifier;
  ethPriceUsd?: number;
  maxTotalLossPercent: number;
  nonceTracker?: NonceTracker;
}

export class RebalanceEngine {
  private readonly logger = getLogger();
  private state: RebalanceState = 'IDLE';
  private bandManager = new BandManager();
  private lastRebalanceTime = 0;
  private consecutiveErrors = 0;
  private rebalanceLock = false;

  constructor(private readonly ctx: RebalanceContext) {}

  isRebalancing(): boolean {
    return this.rebalanceLock;
  }

  getState(): RebalanceState {
    return this.state;
  }

  getBands(): Band[] {
    return this.bandManager.getBands();
  }

  getBandManager(): BandManager {
    return this.bandManager;
  }

  getCurrentRange(): PositionRange | undefined {
    return this.bandManager.getOverallRange();
  }

  async initialize(): Promise<void> {
    const { poolEntry, positionManager, wallet, stateStore, notifier } = this.ctx;
    const { pool } = poolEntry;

    this.logger.info({ poolId: poolEntry.id }, 'Initializing rebalance engine');

    const savedState = stateStore.getPoolState(poolEntry.id);

    // Load band state from persistence
    if (savedState?.bands?.length) {
      const bands: Band[] = savedState.bands.map((b, i) => ({
        index: i,
        tokenId: BigNumber.from(b.tokenId),
        tickLower: b.tickLower,
        tickUpper: b.tickUpper,
      }));
      this.bandManager.setBands(bands, savedState.bandTickWidth ?? 0);
      this.lastRebalanceTime = savedState.lastRebalanceTime ?? 0;
      this.logger.info({ bandCount: bands.length }, 'Restored band state from disk');
    }

    // Verify pending TXs from previous run
    if (savedState?.pendingTxHashes?.length) {
      const provider = wallet.provider as providers.JsonRpcProvider;
      for (const hash of savedState.pendingTxHashes) {
        try {
          const receipt = await provider.getTransactionReceipt(hash);
          if (receipt) {
            this.logger.info({ txHash: hash, status: receipt.status }, receipt.status === 1 ? 'Pending TX confirmed' : 'Pending TX reverted');
          } else {
            this.logger.warn({ txHash: hash }, 'Pending TX not found on-chain');
          }
        } catch (err) {
          this.logger.warn({ txHash: hash, err }, 'Failed to verify pending TX');
        }
      }
    }

    // Initialize nonce tracker
    if (this.ctx.nonceTracker) {
      await this.ctx.nonceTracker.initialize(savedState?.lastNonce);
    }

    // Recover from incomplete rebalance
    if (savedState?.rebalanceStage) {
      this.logger.warn({ poolId: poolEntry.id, stage: savedState.rebalanceStage }, 'Recovering from incomplete rebalance');
      this.bandManager.setBands([], 0);
      stateStore.updatePoolState(poolEntry.id, { rebalanceStage: undefined, pendingTxHashes: undefined, bands: undefined, bandTickWidth: undefined });
      stateStore.save();
      await notifier.notify(`RECOVERY: ${poolEntry.id} recovering from stage ${savedState.rebalanceStage}`);
    }

    // Check for existing on-chain positions if no bands loaded
    if (this.bandManager.getBandCount() === 0) {
      const existing = await positionManager.findExistingPositions(
        wallet.address,
        pool.token0.address,
        pool.token1.address,
        pool.feeTier,
      );

      if (existing.length > 0) {
        const activeBands: Band[] = existing
          .filter((p) => !p.liquidity.isZero())
          .map((p, i) => ({
            index: i,
            tokenId: p.tokenId,
            tickLower: p.tickLower,
            tickUpper: p.tickUpper,
          }));
        if (activeBands.length > 0) {
          const bandWidth = activeBands.length > 1
            ? activeBands[1].tickLower - activeBands[0].tickLower
            : activeBands[0].tickUpper - activeBands[0].tickLower;
          this.bandManager.setBands(activeBands, bandWidth);
          this.logger.info({ bandCount: activeBands.length }, 'Found existing on-chain positions as bands');
        }
      }
    }

    // Ensure token approvals for both NFT manager and swap router
    await positionManager.approveTokens(pool.token0.address, pool.token1.address);
    await this.ctx.swapExecutor.approveTokens(pool.token0.address, pool.token1.address);

    this.setState('MONITORING');
  }

  async onPriceUpdate(poolState: PoolState): Promise<void> {
    if (this.state === 'STOPPED' || this.state === 'ERROR') return;
    if (this.state !== 'MONITORING' && this.state !== 'IDLE') return;

    const { poolEntry } = this.ctx;

    updatePoolStatus(poolEntry.id, {
      state: this.state,
      currentTick: poolState.tick,
      activeBand: this.bandManager.getBandIndexForTick(poolState.tick),
      bands: this.bandManager.getBands().map((b) => ({
        index: b.index,
        tokenId: b.tokenId.toNumber(),
        tickLower: b.tickLower,
        tickUpper: b.tickUpper,
      })),
    });

    // Check depeg
    if (this.checkDepeg(poolState)) return;

    // No bands yet → mint initial bands
    if (this.bandManager.getBandCount() === 0) {
      await this.mintInitialBands(poolState);
      return;
    }

    // Price in safe zone (bands 2-4) → do nothing
    if (this.bandManager.isInSafeZone(poolState.tick)) return;

    // Trigger band reached?
    const direction = this.bandManager.getTriggerDirection(poolState.tick);
    if (direction) {
      await this.executeBandRebalance(poolState, direction);
    }
  }

  private checkDepeg(poolState: PoolState): boolean {
    const { poolEntry, emergencyStop, notifier } = this.ctx;
    const { strategy } = poolEntry;

    if (!strategy.expectedPriceRatio) return false;

    const currentPrice = tickToPrice(poolState.tick);
    const deviation = Math.abs(currentPrice - strategy.expectedPriceRatio) / strategy.expectedPriceRatio * 100;
    const threshold = strategy.depegThresholdPercent ?? 5;

    if (deviation > threshold) {
      this.logger.error(
        { poolId: poolEntry.id, currentPrice, expectedPrice: strategy.expectedPriceRatio, deviation: deviation.toFixed(2) },
        'TOKEN DEPEG DETECTED',
      );
      emergencyStop.trigger(`Token depeg: price ${currentPrice.toFixed(6)} deviates ${deviation.toFixed(2)}% from expected ${strategy.expectedPriceRatio}`);
      notifier.notify(
        `ALERT: DEPEG detected for ${poolEntry.id}!\n` +
          `Current price: ${currentPrice.toFixed(6)}\n` +
          `Expected: ${strategy.expectedPriceRatio}\n` +
          `Deviation: ${deviation.toFixed(2)}%\n` +
          `Action: closing all bands and stopping bot`,
      ).catch(() => {});

      this.emergencyWithdraw().catch((err) => {
        this.logger.error({ err }, 'Failed emergency withdraw on depeg');
      });
      return true;
    }

    return false;
  }

  private async emergencyWithdraw(): Promise<void> {
    const { poolEntry, positionManager, stateStore, historyLogger, notifier } = this.ctx;
    const { strategy } = poolEntry;
    const bands = this.bandManager.getBands();

    if (bands.length === 0) return;

    this.rebalanceLock = true;
    this.setState('WITHDRAWING');
    try {
      for (const band of bands) {
        const pos = await positionManager.getPosition(band.tokenId);
        if (!pos.liquidity.isZero()) {
          await positionManager.removePosition(band.tokenId, pos.liquidity, strategy.slippageTolerancePercent);
        }
      }

      historyLogger.log({
        type: OperationType.EMERGENCY_STOP,
        poolId: poolEntry.id,
        bandCount: bands.length,
      });

      await notifier.notify(
        `EMERGENCY: All ${bands.length} bands closed for ${poolEntry.id}\n` +
          `Reason: ${this.ctx.emergencyStop.getReason() ?? 'unknown'}\n` +
          `Action: bot stopped, manual intervention required`,
      );

      this.bandManager.setBands([], 0);
      this.persistState(stateStore, poolEntry.id);
    } catch (err) {
      this.logger.error({ err }, 'Emergency withdraw failed');
      await notifier.notify(
        `CRITICAL: Emergency withdraw FAILED for ${poolEntry.id}!\n` +
          `Error: ${err instanceof Error ? err.message : String(err)}\n` +
          `Manual intervention required immediately`,
      ).catch(() => {});
    } finally {
      this.rebalanceLock = false;
    }

    this.setState('STOPPED');
  }

  private async checkGasCost(isOutOfRange: boolean): Promise<boolean> {
    const { poolEntry, wallet, gasOracle } = this.ctx;
    const { strategy } = poolEntry;

    try {
      const provider = wallet.provider as providers.JsonRpcProvider;
      const gasInfo = await gasOracle.getGasInfo(provider);

      if (gasOracle.isGasSpike(gasInfo.gasPriceGwei)) {
        this.logger.warn({ gasPriceGwei: gasInfo.gasPriceGwei }, 'Gas spike detected');
        if (!isOutOfRange) {
          this.logger.info('Skipping rebalance due to gas spike (still in range)');
          return false;
        }
        this.logger.warn('Gas spike but position is out of range, proceeding anyway');
      }

      const ethPrice = this.ctx.ethPriceUsd ?? ETH_PRICE_USD_FALLBACK;
      const estimatedCostUsd = estimateGasCostUsd(REBALANCE_GAS_ESTIMATE, gasInfo.gasPriceGwei, ethPrice);

      if (estimatedCostUsd > strategy.maxGasCostUsd && !isOutOfRange) {
        this.logger.info(
          { estimatedCostUsd: estimatedCostUsd.toFixed(2), maxGasCostUsd: strategy.maxGasCostUsd },
          'Skipping rebalance: gas cost exceeds limit (still in range)',
        );
        return false;
      }

      if (estimatedCostUsd > strategy.maxGasCostUsd) {
        this.logger.warn(
          { estimatedCostUsd: estimatedCostUsd.toFixed(2), maxGasCostUsd: strategy.maxGasCostUsd },
          'Gas cost exceeds limit but position is out of range, proceeding',
        );
      }

      return true;
    } catch (err) {
      this.logger.warn({ err }, 'Failed to check gas cost, proceeding with rebalance');
      return true;
    }
  }

  private async mintInitialBands(poolState: PoolState): Promise<void> {
    const { poolEntry, wallet, positionManager, balanceTracker, ilTracker, stateStore, historyLogger, notifier } = this.ctx;
    const { pool, strategy } = poolEntry;

    this.rebalanceLock = true;
    this.setState('MINTING');

    try {
      const layout = calculateBands(poolState.tick, strategy.rangeWidthPercent, pool.feeTier);

      const token0Contract = getErc20Contract(pool.token0.address, wallet);
      const token1Contract = getErc20Contract(pool.token1.address, wallet);
      const [totalBalance0, totalBalance1] = await Promise.all([
        token0Contract.balanceOf(wallet.address),
        token1Contract.balanceOf(wallet.address),
      ]);

      // Distribute tokens across bands proportionally
      const bandCount = layout.bands.length;
      const bands: Band[] = [];

      for (let i = 0; i < bandCount; i++) {
        const bandConfig = layout.bands[i];
        // Equal share per band
        const amount0 = totalBalance0.div(bandCount - i);
        const amount1 = totalBalance1.div(bandCount - i);

        // Recalculate remaining for next iteration
        const result = await positionManager.mint({
          token0: pool.token0.address,
          token1: pool.token1.address,
          fee: pool.feeTier,
          tickLower: bandConfig.tickLower,
          tickUpper: bandConfig.tickUpper,
          amount0Desired: amount0,
          amount1Desired: amount1,
          slippagePercent: strategy.slippageTolerancePercent,
          recipient: wallet.address,
        });

        bands.push({
          index: i,
          tokenId: result.tokenId,
          tickLower: bandConfig.tickLower,
          tickUpper: bandConfig.tickUpper,
        });
      }

      this.bandManager.setBands(bands, layout.bandTickWidth);
      this.lastRebalanceTime = Date.now();
      this.consecutiveErrors = 0;

      // Set IL tracker entry and initial portfolio value
      const currentPrice = tickToPrice(poolState.tick);
      const bal0 = parseFloat(totalBalance0.toString()) / Math.pow(10, pool.token0.decimals);
      const bal1 = parseFloat(totalBalance1.toString()) / Math.pow(10, pool.token1.decimals);
      ilTracker.setEntry(bal0, bal1, currentPrice);

      const initialValue = this.estimatePortfolioValue(totalBalance0, totalBalance1, pool.token0.decimals, pool.token1.decimals, currentPrice);
      balanceTracker.setInitialValue(initialValue);
      this.logger.info({ initialValueUsd: initialValue.toFixed(2) }, 'Initial portfolio value set');

      this.persistState(stateStore, poolEntry.id);
      historyLogger.log({
        type: OperationType.MINT,
        poolId: poolEntry.id,
        bandCount: bands.length,
        tickLower: layout.totalTickLower,
        tickUpper: layout.totalTickUpper,
      });

      const overallRange = this.bandManager.getOverallRange()!;
      await notifier.notify(
        `Initial ${bands.length} bands minted for ${poolEntry.id}\n` +
          `Range: [${overallRange.tickLower}, ${overallRange.tickUpper}]\n` +
          `Band width: ${layout.bandTickWidth} ticks`,
      );

      this.setState('MONITORING');
    } catch (err) {
      this.handleError('mintInitialBands', err);
    } finally {
      this.rebalanceLock = false;
    }
  }

  private async executeBandRebalance(poolState: PoolState, direction: TriggerDirection): Promise<void> {
    const { poolEntry, wallet, positionManager, swapExecutor, emergencyStop, balanceTracker, stateStore, historyLogger, notifier } = this.ctx;
    const { pool, strategy } = poolEntry;

    // Check min interval
    const elapsed = Date.now() - this.lastRebalanceTime;
    const minInterval = strategy.minRebalanceIntervalMinutes * 60 * 1000;
    if (elapsed < minInterval) {
      this.logger.info({ elapsed, minInterval }, 'Skipping band rebalance: too soon');
      return;
    }

    // Emergency stop check
    if (emergencyStop.isStopped()) {
      this.logger.warn('Emergency stop active, skipping rebalance');
      return;
    }

    // Gas cost check
    const gasOk = await this.checkGasCost(true);
    if (!gasOk) return;

    this.rebalanceLock = true;
    this.setState('EVALUATING');
    this.logger.info({ poolId: poolEntry.id, tick: poolState.tick, direction }, 'Starting band rebalance');

    try {
      // Pre-rebalance value estimation
      const preToken0 = getErc20Contract(pool.token0.address, wallet);
      const preToken1 = getErc20Contract(pool.token1.address, wallet);
      const [preBal0, preBal1] = await Promise.all([
        preToken0.balanceOf(wallet.address),
        preToken1.balanceOf(wallet.address),
      ]);
      const prePrice = tickToPrice(poolState.tick);
      const preValue = this.estimatePortfolioValue(preBal0, preBal1, pool.token0.decimals, pool.token1.decimals, prePrice);

      // STEP 1: Dissolve the opposite band
      this.setState('WITHDRAWING');
      const bandToDissolve = this.bandManager.getBandToDissolve(direction);
      let removeResult: RemoveResult | undefined;

      const pos = await positionManager.getPosition(bandToDissolve.tokenId);
      if (!pos.liquidity.isZero()) {
        removeResult = await positionManager.removePosition(bandToDissolve.tokenId, pos.liquidity, strategy.slippageTolerancePercent);
      }

      this.bandManager.removeBand(bandToDissolve.tokenId);

      // Checkpoint: band dissolved, funds in wallet
      this.persistCheckpoint(stateStore, poolEntry.id, 'WITHDRAWN',
        removeResult?.txHashes
          ? [removeResult.txHashes.decreaseLiquidity, removeResult.txHashes.collect, removeResult.txHashes.burn]
          : []);

      // STEP 2: Swap through own pool (6 remaining bands provide liquidity)
      this.setState('SWAPPING');
      const token0Contract = getErc20Contract(pool.token0.address, wallet);
      const token1Contract = getErc20Contract(pool.token1.address, wallet);
      const [balance0, balance1] = await Promise.all([
        token0Contract.balanceOf(wallet.address),
        token1Contract.balanceOf(wallet.address),
      ]);

      let swapResult: SwapResult | undefined;
      // When price goes lower: dissolved top band yields token0, we need token1 for new bottom band
      // When price goes upper: dissolved bottom band yields token1, we need token0 for new top band
      if (direction === 'lower' && balance0.gt(0)) {
        swapResult = await swapExecutor.executeSwap(
          pool.token0.address,
          pool.token1.address,
          pool.feeTier,
          balance0,
          strategy.slippageTolerancePercent,
        );
      } else if (direction === 'upper' && balance1.gt(0)) {
        swapResult = await swapExecutor.executeSwap(
          pool.token1.address,
          pool.token0.address,
          pool.feeTier,
          balance1,
          strategy.slippageTolerancePercent,
        );
      }

      // Checkpoint: swap completed
      this.persistCheckpoint(stateStore, poolEntry.id, 'SWAPPED',
        swapResult ? [swapResult.txHash] : []);

      // STEP 3: Mint new band at the opposite end
      this.setState('MINTING');
      const newBandTicks = this.bandManager.getNewBandTicks(direction);
      const [newBal0, newBal1] = await Promise.all([
        token0Contract.balanceOf(wallet.address),
        token1Contract.balanceOf(wallet.address),
      ]);

      const mintResult = await positionManager.mint({
        token0: pool.token0.address,
        token1: pool.token1.address,
        fee: pool.feeTier,
        tickLower: newBandTicks.tickLower,
        tickUpper: newBandTicks.tickUpper,
        amount0Desired: newBal0,
        amount1Desired: newBal1,
        slippagePercent: strategy.slippageTolerancePercent,
        recipient: wallet.address,
      });

      // STEP 4: Update band manager
      this.bandManager.addBand(
        { tokenId: mintResult.tokenId, tickLower: newBandTicks.tickLower, tickUpper: newBandTicks.tickUpper },
        direction === 'lower' ? 'start' : 'end',
      );

      this.lastRebalanceTime = Date.now();
      this.consecutiveErrors = 0;

      // Post-rebalance value check
      const currentPrice = tickToPrice(poolState.tick);
      const postValue = this.estimatePortfolioValue(newBal0, newBal1, pool.token0.decimals, pool.token1.decimals, currentPrice);

      if (preValue > 0 && postValue > 0 && emergencyStop.checkRebalanceLoss(preValue, postValue)) {
        await notifier.notify(
          `ALERT: Rebalance loss too high for ${poolEntry.id}!\n` +
            `Pre: $${preValue.toFixed(2)} → Post: $${postValue.toFixed(2)}\n` +
            `Loss: ${(((preValue - postValue) / preValue) * 100).toFixed(2)}%\n` +
            `Action: pausing bot`,
        );
        this.setState('STOPPED');
        return;
      }

      const initialValue = balanceTracker.getInitialValue();
      if (initialValue && emergencyStop.checkPortfolioLoss(postValue, initialValue, this.ctx.maxTotalLossPercent)) {
        await this.emergencyWithdraw();
        await notifier.notify(
          `ALERT: Portfolio loss limit reached for ${poolEntry.id}!\n` +
            `Initial: $${initialValue.toFixed(2)} → Current: $${postValue.toFixed(2)}\n` +
            `Loss: ${(((initialValue - postValue) / initialValue) * 100).toFixed(2)}%\n` +
            `Action: all bands closed, bot stopped`,
        );
        return;
      }

      this.persistState(stateStore, poolEntry.id);
      historyLogger.log({
        type: OperationType.REBALANCE,
        poolId: poolEntry.id,
        direction,
        dissolvedTokenId: bandToDissolve.tokenId.toString(),
        newTokenId: mintResult.tokenId.toString(),
        newTickLower: newBandTicks.tickLower,
        newTickUpper: newBandTicks.tickUpper,
        swapTxHash: swapResult?.txHash,
        removeTxHashes: removeResult?.txHashes,
        mintTxHash: mintResult.txHash,
      });

      const overallRange = this.bandManager.getOverallRange()!;
      await notifier.notify(
        `Band rebalance completed for ${poolEntry.id}\n` +
          `Direction: ${direction}\n` +
          `Dissolved: band at [${bandToDissolve.tickLower}, ${bandToDissolve.tickUpper}]\n` +
          `New band: [${newBandTicks.tickLower}, ${newBandTicks.tickUpper}]\n` +
          `Overall range: [${overallRange.tickLower}, ${overallRange.tickUpper}]`,
      );

      this.setState('MONITORING');
    } catch (err) {
      this.handleError('executeBandRebalance', err);
    } finally {
      this.rebalanceLock = false;
    }
  }

  async stop(): Promise<void> {
    this.setState('STOPPED');
    this.ctx.poolMonitor.stopMonitoring();
    this.logger.info({ poolId: this.ctx.poolEntry.id }, 'Rebalance engine stopped');
  }

  private setState(newState: RebalanceState): void {
    this.logger.debug({ poolId: this.ctx.poolEntry.id, from: this.state, to: newState }, 'State transition');
    this.state = newState;
    updatePoolStatus(this.ctx.poolEntry.id, { state: newState });
  }

  private handleError(operation: string, err: unknown): void {
    this.consecutiveErrors++;
    const message = err instanceof Error ? err.message : String(err);
    this.logger.error({ operation, error: message, consecutiveErrors: this.consecutiveErrors }, 'Rebalance error');

    if (this.consecutiveErrors >= 3) {
      this.setState('ERROR');
      this.ctx.emergencyStop.trigger(`${this.consecutiveErrors} consecutive errors: ${message}`);
      this.ctx.notifier.notify(`ALERT: ${this.ctx.poolEntry.id} stopped after ${this.consecutiveErrors} errors: ${message}`).catch(() => {});
    } else {
      this.setState('MONITORING');
    }
  }

  private persistState(stateStore: StateStore, poolId: string): void {
    const bands = this.bandManager.getBands();
    const bandStates: BandState[] = bands.map((b) => ({
      tokenId: b.tokenId.toString(),
      tickLower: b.tickLower,
      tickUpper: b.tickUpper,
    }));

    stateStore.updatePoolState(poolId, {
      bands: bandStates,
      bandTickWidth: this.bandManager.getBandTickWidth(),
      lastRebalanceTime: this.lastRebalanceTime,
      rebalanceStage: undefined,
      pendingTxHashes: undefined,
      lastNonce: this.ctx.nonceTracker?.getCurrentNonce(),
      // Clear legacy fields
      tokenId: undefined,
      tickLower: undefined,
      tickUpper: undefined,
    });
    stateStore.save();
  }

  private persistCheckpoint(stateStore: StateStore, poolId: string, stage: RebalanceStage, txHashes: string[]): void {
    const bands = this.bandManager.getBands();
    const bandStates: BandState[] = bands.map((b) => ({
      tokenId: b.tokenId.toString(),
      tickLower: b.tickLower,
      tickUpper: b.tickUpper,
    }));

    stateStore.updatePoolState(poolId, {
      bands: bandStates,
      bandTickWidth: this.bandManager.getBandTickWidth(),
      lastRebalanceTime: this.lastRebalanceTime,
      rebalanceStage: stage,
      pendingTxHashes: txHashes,
      lastNonce: this.ctx.nonceTracker?.getCurrentNonce(),
    });
    stateStore.saveOrThrow();
  }

  private estimatePortfolioValue(
    balance0: BigNumber,
    balance1: BigNumber,
    decimals0: number,
    decimals1: number,
    price: number,
  ): number {
    if (!Number.isFinite(price) || price <= 0) {
      this.logger.error({ price }, 'Invalid price for portfolio estimation, returning 0');
      return 0;
    }
    const bal0 = parseFloat(balance0.toString()) / Math.pow(10, decimals0);
    const bal1 = parseFloat(balance1.toString()) / Math.pow(10, decimals1);
    const value = bal0 * price + bal1;
    if (!Number.isFinite(value)) {
      this.logger.error({ bal0, bal1, price, value }, 'Portfolio value calculation produced non-finite result');
      return 0;
    }
    return value;
  }
}
