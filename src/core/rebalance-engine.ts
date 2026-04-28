import { BigNumber, Contract, providers, utils } from 'ethers';
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
import { updatePoolStatus, recordPrice, recordBandOpen, recordBandClose, getBandEvents, recordPortfolio, setPortfolioInitial } from '../health/health-server';
import { PoolEntry } from '../config';
import { getErc20Contract } from '../chain/contracts';
import { GasOracle, estimateGasCostUsd } from '../chain/gas-oracle';
import { NonceTracker } from '../chain/nonce-tracker';
import { tickToAdjustedPrice, getAmountsFromLiquidity } from '../util/tick-math';
import { Wallet } from 'ethers';
import { BandManager, Band, TriggerDirection } from './band-manager';

export type RebalanceState =
  | 'IDLE'
  | 'MONITORING'
  | 'EVALUATING'
  | 'WITHDRAWING'
  | 'SWAPPING'
  | 'MINTING'
  | 'ERROR'
  | 'STOPPED';

const REBALANCE_GAS_ESTIMATE = 800_000;
const MIN_OPERATIONAL_BANDS = 5;

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
  private vaultRate = 1;
  private lastVaultRateFetch = 0;
  private cachedLiquidity: Map<string, number> = new Map();
  private lastLiquidityFetch = 0;

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

    // Load band state from persistence and validate against on-chain
    if (savedState?.bands?.length) {
      const bands: Band[] = savedState.bands.map((b, i) => ({
        index: i,
        tokenId: BigNumber.from(b.tokenId),
        tickLower: b.tickLower,
        tickUpper: b.tickUpper,
      }));

      // Validate each band exists on-chain (protects against crash during emergency withdraw)
      const validBands: Band[] = [];
      let validationAborted = false;
      for (const band of bands) {
        try {
          const pos = await positionManager.getPosition(band.tokenId);
          if (!pos.liquidity.isZero()) {
            validBands.push(band);
          } else {
            this.logger.warn({ tokenId: band.tokenId.toString() }, 'Dropping band with zero liquidity from state');
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message.toLowerCase() : '';
          if (msg.includes('invalid token id') || msg.includes('nonexistent token')) {
            this.logger.warn({ tokenId: band.tokenId.toString() }, 'Dropping orphaned band not found on-chain');
          } else {
            // RPC or transient error — abort validation to prevent data loss
            this.logger.error({ err }, 'Band validation failed due to RPC error, keeping all bands from state');
            validationAborted = true;
            break;
          }
        }
      }

      if (validationAborted) {
        this.bandManager.setBands(bands, savedState.bandTickWidth ?? 0);
        this.logger.info({ bandCount: bands.length }, 'Restored band state from disk (validation skipped)');
      } else {
        if (validBands.length !== bands.length) {
          this.logger.warn(
            { loaded: bands.length, valid: validBands.length },
            'Removed stale bands during on-chain validation',
          );
          validBands.forEach((b, i) => (b.index = i));
        }
        if (validBands.length > 0) {
          this.bandManager.setBands(validBands, savedState.bandTickWidth ?? 0);
          this.persistState(stateStore, poolEntry.id);
        }
        this.logger.info({ bandCount: validBands.length }, 'Restored band state from disk');
      }
      this.lastRebalanceTime = savedState.lastRebalanceTime ?? 0;
    }

    // Verify pending TXs from previous run
    if (savedState?.pendingTxHashes?.length) {
      const provider = wallet.provider as providers.JsonRpcProvider;
      for (const hash of savedState.pendingTxHashes) {
        try {
          const receipt = await provider.getTransactionReceipt(hash);
          if (receipt) {
            this.logger.info(
              { txHash: hash, status: receipt.status },
              receipt.status === 1 ? 'Pending TX confirmed' : 'Pending TX reverted',
            );
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
      this.logger.warn(
        { poolId: poolEntry.id, stage: savedState.rebalanceStage },
        'Recovering from incomplete rebalance',
      );
      this.bandManager.setBands([], 0);
      stateStore.updatePoolState(poolEntry.id, {
        rebalanceStage: undefined,
        pendingTxHashes: undefined,
        bands: undefined,
        bandTickWidth: undefined,
      });
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
          // Use individual band width (tickUpper - tickLower) instead of inter-band distance,
          // which would be wrong if bands are non-contiguous after partial emergency withdraw
          const bandWidth = activeBands[0].tickUpper - activeBands[0].tickLower;
          this.bandManager.setBands(activeBands, bandWidth);
          this.logger.info({ bandCount: activeBands.length, bandWidth }, 'Found existing on-chain positions as bands');
        }
      }
    }

    // Guard: band count too low for correct trigger logic (safe zone overlaps trigger zone)
    const loadedBandCount = this.bandManager.getBandCount();
    if (loadedBandCount > 0 && loadedBandCount < MIN_OPERATIONAL_BANDS) {
      this.logger.error(
        { bandCount: loadedBandCount, minRequired: MIN_OPERATIONAL_BANDS },
        'Band count below minimum for safe trigger logic — manual intervention required',
      );
      await notifier.notify(
        `CRITICAL: Only ${loadedBandCount} bands remaining (minimum ${MIN_OPERATIONAL_BANDS} needed). ` +
          'Engine stopped to prevent silent inactivity. Manual intervention required.',
      );
      this.ctx.emergencyStop.trigger(`Band count ${loadedBandCount} below minimum ${MIN_OPERATIONAL_BANDS}`, 'manual');
      this.setState('STOPPED');
      return;
    }

    // Register existing bands in health server for chart overlays (only if not already loaded from persistence)
    if (getBandEvents(poolEntry.id).length === 0) {
      for (const band of this.bandManager.getBands()) {
        recordBandOpen(poolEntry.id, band.tokenId.toNumber(), band.tickLower, band.tickUpper);
      }
    }

    // Ensure token approvals for both NFT manager and swap router
    await positionManager.approveTokens(pool.token0.address, pool.token1.address);
    await this.ctx.swapExecutor.approveTokens(pool.token0.address, pool.token1.address);

    // RESET_BANDS: close all existing bands and let the bot re-mint with current config
    if (process.env.RESET_BANDS === 'true' && this.bandManager.getBandCount() > 0) {
      this.logger.warn({ poolId: poolEntry.id }, 'RESET_BANDS: closing all bands');
      const bandsToClose = [...this.bandManager.getBands()];
      for (const band of bandsToClose) {
        recordBandClose(poolEntry.id, band.tokenId.toNumber());
      }
      await this.emergencyWithdraw();
      // Reset emergency state so the bot can re-mint
      this.ctx.emergencyStop.reset();
      this.state = 'IDLE';
      await notifier.notify(`RESET_BANDS: All bands closed for ${poolEntry.id}, will re-mint with new config`);
      this.logger.info({ poolId: poolEntry.id }, 'RESET_BANDS: all bands closed, will re-mint on next price update');
    }

    // Set portfolio initial from config (if not already set from persistence)
    if (poolEntry.portfolio) {
      setPortfolioInitial(poolEntry.id, {
        initialToken0: poolEntry.portfolio.initialToken0,
        initialToken1: poolEntry.portfolio.initialToken1,
        initialValueUsd: 0, // calculated on first tracking
        startTime: Math.floor(Date.now() / 1000),
      });
    }

    this.setState('MONITORING');
  }

  async onPriceUpdate(poolState: PoolState): Promise<void> {
    // Auto-recovery: if emergency stop has cleared, transition back to monitoring
    if ((this.state === 'ERROR' || this.state === 'STOPPED') && !this.ctx.emergencyStop.isStopped()) {
      this.logger.info({ previousState: this.state }, 'Auto-recovered after emergency stop cooldown');
      this.consecutiveErrors = 0;
      this.setState('MONITORING');
    }

    if (this.state === 'STOPPED' || this.state === 'ERROR') return;
    if (this.state !== 'MONITORING' && this.state !== 'IDLE') return;
    if (this.rebalanceLock) return;
    if (this.ctx.emergencyStop.isStopped()) {
      this.setState('STOPPED');
      return;
    }

    const { poolEntry } = this.ctx;

    const vaultRate = await this.fetchVaultRate();
    recordPrice(poolEntry.id, poolState.tick, vaultRate).catch(() => {});

    updatePoolStatus(poolEntry.id, {
      state: this.state,
      currentTick: poolState.tick,
      activeBand: this.bandManager.getBandIndexForTick(poolState.tick),
      bands: this.bandManager.getBands().map((b) => {
        const event = getBandEvents(poolEntry.id).find((e) => e.tokenId === b.tokenId.toNumber() && e.closeTime === null);
        return {
          index: b.index,
          tokenId: b.tokenId.toNumber(),
          tickLower: b.tickLower,
          tickUpper: b.tickUpper,
          amount0: event?.amount0,
          amount1: event?.amount1,
          liquidity: event?.liquidity,
        };
      }),
      consecutiveErrors: this.consecutiveErrors,
      emergencyStopped: this.ctx.emergencyStop.isStopped(),
      emergencyReason: this.ctx.emergencyStop.isStopped() ? this.ctx.emergencyStop.getReason() : undefined,
      walletAddress: this.ctx.wallet.address,
      chainId: poolEntry.chain.chainId,
      token0Symbol: poolEntry.pool.token0.symbol,
      token1Symbol: poolEntry.pool.token1.symbol,
      vaultRate,
      rangeWidthPercent: poolEntry.strategy.rangeWidthPercent,
      feeTier: poolEntry.pool.feeTier,
      bandCount: this.bandManager.getBandCount(),
    });

    // Portfolio tracking
    this.trackPortfolio(poolEntry, poolState, vaultRate).catch(() => {});

    // Check depeg
    if (await this.checkDepeg(poolState)) return;

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

  private async checkDepeg(poolState: PoolState): Promise<boolean> {
    const { poolEntry, emergencyStop, notifier } = this.ctx;
    const { strategy } = poolEntry;

    if (!strategy.expectedPriceRatio) return false;

    const { pool } = poolEntry;
    const currentPrice = tickToAdjustedPrice(poolState.tick, pool.token0.decimals, pool.token1.decimals);
    const deviation = (Math.abs(currentPrice - strategy.expectedPriceRatio) / strategy.expectedPriceRatio) * 100;
    const threshold = strategy.depegThresholdPercent ?? 5;

    if (deviation > threshold) {
      this.logger.error(
        {
          poolId: poolEntry.id,
          currentPrice,
          expectedPrice: strategy.expectedPriceRatio,
          deviation: deviation.toFixed(2),
        },
        'TOKEN DEPEG DETECTED',
      );
      emergencyStop.trigger(
        `Token depeg: price ${currentPrice.toFixed(6)} deviates ${deviation.toFixed(2)}% from expected ${strategy.expectedPriceRatio}`,
        'depeg',
      );
      notifier
        .notify(
          `ALERT: DEPEG detected for ${poolEntry.id}!\n` +
            `Current price: ${currentPrice.toFixed(6)}\n` +
            `Expected: ${strategy.expectedPriceRatio}\n` +
            `Deviation: ${deviation.toFixed(2)}%\n` +
            `Action: closing all bands and stopping bot`,
        )
        .catch(() => {});

      try {
        await this.emergencyWithdraw();
      } catch (err) {
        this.logger.error({ err }, 'Failed emergency withdraw on depeg');
      }
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
    const totalBands = bands.length;
    let removedCount = 0;
    try {
      for (const band of bands) {
        try {
          const pos = await positionManager.getPosition(band.tokenId);
          if (!pos.liquidity.isZero()) {
            await positionManager.removePosition(band.tokenId, pos.liquidity, strategy.slippageTolerancePercent);
          }
          this.bandManager.removeBand(band.tokenId);
          removedCount++;
          this.persistState(stateStore, poolEntry.id);
        } catch (bandErr) {
          this.logger.error(
            { tokenId: band.tokenId.toString(), err: bandErr },
            'Failed to remove band during emergency withdraw, skipping',
          );
        }
      }

      historyLogger.log({
        type: OperationType.EMERGENCY_STOP,
        poolId: poolEntry.id,
        bandCount: totalBands,
        removedCount,
      });

      if (removedCount < totalBands) {
        const remaining = this.bandManager.getBandCount();
        await notifier
          .notify(
            `CRITICAL: Emergency withdraw PARTIAL for ${poolEntry.id}!\n` +
              `Removed ${removedCount}/${totalBands} bands, ${remaining} bands still on-chain\n` +
              `Reason: ${this.ctx.emergencyStop.getReason() ?? 'unknown'}\n` +
              `Manual intervention required immediately`,
          )
          .catch(() => {});
      } else {
        await notifier
          .notify(
            `EMERGENCY: All ${totalBands} bands closed for ${poolEntry.id}\n` +
              `Reason: ${this.ctx.emergencyStop.getReason() ?? 'unknown'}\n` +
              `Action: bot stopped, manual intervention required`,
          )
          .catch(() => {});
      }
    } catch (err) {
      this.logger.error({ err }, 'Emergency withdraw failed');
      await notifier
        .notify(
          `CRITICAL: Emergency withdraw FAILED for ${poolEntry.id}!\n` +
            `Error: ${err instanceof Error ? err.message : String(err)}\n` +
            `Removed ${removedCount}/${totalBands} bands before failure\n` +
            `Manual intervention required immediately`,
        )
        .catch(() => {});
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

      if (!this.ctx.ethPriceUsd) {
        this.logger.warn('No ETH price available, skipping USD gas cost check');
        return true;
      }

      const estimatedCostUsd = estimateGasCostUsd(REBALANCE_GAS_ESTIMATE, gasInfo.gasPriceGwei, this.ctx.ethPriceUsd);

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
    const { poolEntry, wallet, positionManager, balanceTracker, ilTracker, stateStore, historyLogger, notifier } =
      this.ctx;
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
        const remainingBands = bandCount - i;

        // Re-read actual remaining wallet balance after each mint
        const [remaining0, remaining1] = await Promise.all([
          token0Contract.balanceOf(wallet.address),
          token1Contract.balanceOf(wallet.address),
        ]);
        const amount0 = remaining0.div(remainingBands);
        const amount1 = remaining1.div(remainingBands);

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
        recordBandOpen(poolEntry.id, result.tokenId.toNumber(), bandConfig.tickLower, bandConfig.tickUpper, undefined, {
          amount0: result.amount0.toString(),
          amount1: result.amount1.toString(),
          liquidity: result.liquidity.toString(),
        });
      }

      this.bandManager.setBands(bands, layout.bandTickWidth);
      this.lastRebalanceTime = Date.now();
      this.consecutiveErrors = 0;

      // Set IL tracker entry and initial portfolio value
      const currentPrice = tickToAdjustedPrice(poolState.tick, pool.token0.decimals, pool.token1.decimals);
      const bal0 = parseFloat(utils.formatUnits(totalBalance0, pool.token0.decimals));
      const bal1 = parseFloat(utils.formatUnits(totalBalance1, pool.token1.decimals));
      ilTracker.setEntry(bal0, bal1, currentPrice);

      const initialValue = this.estimatePortfolioValue(
        totalBalance0,
        totalBalance1,
        pool.token0.decimals,
        pool.token1.decimals,
        currentPrice,
      );
      balanceTracker.setInitialValue(initialValue);
      this.logger.info({ initialValueUsd: initialValue.toFixed(2) }, 'Initial portfolio value set');

      // Record initial investment for portfolio tracking
      setPortfolioInitial(poolEntry.id, {
        initialToken0: bal0,
        initialToken1: bal1,
        initialValueUsd: initialValue,
        startTime: Math.floor(Date.now() / 1000),
      });

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
    const { poolEntry, wallet, positionManager, swapExecutor, emergencyStop, stateStore, historyLogger, notifier } =
      this.ctx;
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
      // STEP 1: Dissolve the opposite band
      this.setState('WITHDRAWING');
      const bandToDissolve = this.bandManager.getBandToDissolve(direction);
      let removeResult: RemoveResult | undefined;

      const pos = await positionManager.getPosition(bandToDissolve.tokenId);
      if (!pos.liquidity.isZero()) {
        removeResult = await positionManager.removePosition(
          bandToDissolve.tokenId,
          pos.liquidity,
          strategy.slippageTolerancePercent,
        );
      }

      this.bandManager.removeBand(bandToDissolve.tokenId);
      recordBandClose(poolEntry.id, bandToDissolve.tokenId.toNumber());

      // Checkpoint: band dissolved, funds in wallet
      this.persistCheckpoint(
        stateStore,
        poolEntry.id,
        'WITHDRAWN',
        removeResult?.txHashes
          ? [removeResult.txHashes.decreaseLiquidity, removeResult.txHashes.collect, removeResult.txHashes.burn]
          : [],
      );

      // STEP 2: Swap through own pool (6 remaining bands provide liquidity)
      // Only swap the tokens received from the dissolved band, not the entire wallet balance
      this.setState('SWAPPING');
      const token0Contract = getErc20Contract(pool.token0.address, wallet);
      const token1Contract = getErc20Contract(pool.token1.address, wallet);
      const [balance0, balance1] = await Promise.all([
        token0Contract.balanceOf(wallet.address),
        token1Contract.balanceOf(wallet.address),
      ]);

      // Pre-swap value: wallet balance (meaningful baseline for loss check)
      const preSwapPrice = tickToAdjustedPrice(poolState.tick, pool.token0.decimals, pool.token1.decimals);
      const preSwapValue = this.estimatePortfolioValue(
        balance0,
        balance1,
        pool.token0.decimals,
        pool.token1.decimals,
        preSwapPrice,
      );

      // Determine swap amount from dissolved band (principal + fees)
      const dissolvedAmount0 = removeResult ? removeResult.amount0.add(removeResult.fee0) : BigNumber.from(0);
      const dissolvedAmount1 = removeResult ? removeResult.amount1.add(removeResult.fee1) : BigNumber.from(0);

      let swapResult: SwapResult | undefined;
      // When price goes lower: dissolved top band yields token0, we need token1 for new bottom band
      // When price goes upper: dissolved bottom band yields token1, we need token0 for new top band
      if (direction === 'lower' && dissolvedAmount0.gt(0)) {
        // Cap at wallet balance in case of rounding
        const swapAmount = dissolvedAmount0.gt(balance0) ? balance0 : dissolvedAmount0;
        swapResult = await swapExecutor.executeSwap(
          pool.token0.address,
          pool.token1.address,
          pool.feeTier,
          swapAmount,
          strategy.slippageTolerancePercent,
          poolState.tick,
          pool.token0.decimals,
          pool.token1.decimals,
          true,
        );
      } else if (direction === 'upper' && dissolvedAmount1.gt(0)) {
        // Cap at wallet balance in case of rounding
        const swapAmount = dissolvedAmount1.gt(balance1) ? balance1 : dissolvedAmount1;
        swapResult = await swapExecutor.executeSwap(
          pool.token1.address,
          pool.token0.address,
          pool.feeTier,
          swapAmount,
          strategy.slippageTolerancePercent,
          poolState.tick,
          pool.token1.decimals,
          pool.token0.decimals,
          false,
        );
      }

      // Checkpoint: swap completed
      this.persistCheckpoint(stateStore, poolEntry.id, 'SWAPPED', swapResult ? [swapResult.txHash] : []);

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
      recordBandOpen(poolEntry.id, mintResult.tokenId.toNumber(), newBandTicks.tickLower, newBandTicks.tickUpper, undefined, {
        amount0: mintResult.amount0.toString(),
        amount1: mintResult.amount1.toString(),
        liquidity: mintResult.liquidity.toString(),
      });

      this.lastRebalanceTime = Date.now();
      this.consecutiveErrors = 0;

      // Post-swap value check: compare value before swap (dissolved band) with value after swap
      const postSwapPrice = tickToAdjustedPrice(poolState.tick, pool.token0.decimals, pool.token1.decimals);
      const postSwapValue = this.estimatePortfolioValue(
        newBal0,
        newBal1,
        pool.token0.decimals,
        pool.token1.decimals,
        postSwapPrice,
      );

      if (preSwapValue > 0 && postSwapValue > 0 && emergencyStop.checkRebalanceLoss(preSwapValue, postSwapValue)) {
        await notifier.notify(
          `ALERT: Rebalance swap loss too high for ${poolEntry.id}!\n` +
            `Pre-swap: $${preSwapValue.toFixed(2)} → Post-swap: $${postSwapValue.toFixed(2)}\n` +
            `Loss: ${(((preSwapValue - postSwapValue) / preSwapValue) * 100).toFixed(2)}%\n` +
            `Action: pausing bot`,
        );
        this.setState('STOPPED');
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

  private async trackPortfolio(poolEntry: PoolEntry, poolState: PoolState, vaultRate: number): Promise<void> {
    const { pool } = poolEntry;
    const wallet = this.ctx.wallet;

    try {
      // Refresh liquidity cache every 5 min (avoid excessive RPC calls)
      const now = Date.now();
      if (now - this.lastLiquidityFetch > 300_000) {
        this.lastLiquidityFetch = now;
        for (const band of this.bandManager.getBands()) {
          try {
            const pos = await this.ctx.positionManager.getPosition(band.tokenId);
            this.cachedLiquidity.set(band.tokenId.toString(), parseFloat(pos.liquidity.toString()));
          } catch {
            // keep previous value
          }
        }
      }

      // Wallet balances
      const token0Contract = getErc20Contract(pool.token0.address, wallet);
      const token1Contract = getErc20Contract(pool.token1.address, wallet);
      const [walletBal0, walletBal1] = await Promise.all([
        token0Contract.balanceOf(wallet.address),
        token1Contract.balanceOf(wallet.address),
      ]);

      let totalAmount0 = parseFloat(utils.formatUnits(walletBal0, pool.token0.decimals));
      let totalAmount1 = parseFloat(utils.formatUnits(walletBal1, pool.token1.decimals));

      // Position amounts (calculated from cached liquidity + current tick)
      for (const band of this.bandManager.getBands()) {
        const liq = this.cachedLiquidity.get(band.tokenId.toString()) ?? 0;
        if (liq > 0) {
          const amounts = getAmountsFromLiquidity(liq, poolState.tick, band.tickLower, band.tickUpper);
          totalAmount0 += amounts.amount0 / Math.pow(10, pool.token0.decimals);
          totalAmount1 += amounts.amount1 / Math.pow(10, pool.token1.decimals);
        }
      }

      // USD value: token0 (svJUSD) valued at vaultRate, token1 (WCBTC) valued at BTC price
      const rawPrice = Math.pow(1.0001, poolState.tick);
      const btcPriceUsd = (rawPrice < 0.01 ? 1 / rawPrice : rawPrice) * vaultRate;
      const valueUsd = totalAmount0 * vaultRate + totalAmount1 * btcPriceUsd;

      recordPortfolio(poolEntry.id, {
        time: Math.floor(Date.now() / 1000),
        totalToken0: totalAmount0,
        totalToken1: totalAmount1,
        valueUsd,
      });
    } catch (err) {
      this.logger.warn({ err }, 'Failed to track portfolio');
    }
  }

  private async fetchVaultRate(): Promise<number> {
    const now = Date.now();
    if (now - this.lastVaultRateFetch < 300_000) return this.vaultRate;

    const vaultWrapper = this.ctx.poolEntry.wrappers?.find((w) => w.type === 'erc4626');
    if (!vaultWrapper) return 1;

    try {
      const vault = new Contract(
        vaultWrapper.wrappedToken,
        ['function convertToAssets(uint256 shares) view returns (uint256)'],
        this.ctx.wallet,
      );
      const oneShare = BigNumber.from(10).pow(18);
      const assets: BigNumber = await vault.convertToAssets(oneShare);
      this.vaultRate = parseFloat(utils.formatUnits(assets, 18));
      this.lastVaultRateFetch = now;
    } catch (err) {
      this.logger.warn({ err }, 'Failed to fetch vault rate');
    }
    return this.vaultRate;
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
      this.ctx.emergencyStop.trigger(`${this.consecutiveErrors} consecutive errors: ${message}`, 'tx-error');
      this.ctx.notifier
        .notify(`ALERT: ${this.ctx.poolEntry.id} stopped after ${this.consecutiveErrors} errors: ${message}`)
        .catch(() => {});
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
    const bal0 = parseFloat(utils.formatUnits(balance0, decimals0));
    const bal1 = parseFloat(utils.formatUnits(balance1, decimals1));
    const value = bal0 * price + bal1;
    if (!Number.isFinite(value)) {
      this.logger.error({ bal0, bal1, price, value }, 'Portfolio value calculation produced non-finite result');
      return 0;
    }
    return value;
  }
}
