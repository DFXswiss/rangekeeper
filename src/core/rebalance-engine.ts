import { BigNumber } from 'ethers';
import { getLogger } from '../util/logger';
import { PoolMonitor, PoolState, PositionRange } from './pool-monitor';
import { PositionManager, MintResult, RemoveResult } from './position-manager';
import { calculateRange, shouldRebalance, isInRange } from './range-calculator';
import { calculateSwap } from '../swap/ratio-calculator';
import { SwapExecutor } from '../swap/swap-executor';
import { EmergencyStop } from '../risk/emergency-stop';
import { SlippageGuard } from '../risk/slippage-guard';
import { ILTracker } from '../risk/il-tracker';
import { BalanceTracker } from './balance-tracker';
import { StateStore } from '../persistence/state-store';
import { HistoryLogger, OperationType } from '../persistence/history-logger';
import { Notifier } from '../notification/notifier';
import { updatePoolStatus } from '../health/health-server';
import { PoolEntry } from '../config';
import { getErc20Contract } from '../chain/contracts';
import { getGasInfo, isGasSpike, estimateGasCostUsd } from '../chain/gas-oracle';
import { tickToPrice } from '../util/tick-math';
import { Wallet } from 'ethers';

export type RebalanceState = 'IDLE' | 'MONITORING' | 'EVALUATING' | 'WITHDRAWING' | 'SWAPPING' | 'MINTING' | 'ERROR' | 'STOPPED';

const REBALANCE_GAS_ESTIMATE = 800_000; // conservative estimate for full rebalance cycle
const ETH_PRICE_USD_FALLBACK = 3000; // fallback if no oracle available

export interface RebalanceContext {
  poolEntry: PoolEntry;
  wallet: Wallet; // mutable: updated on RPC failover
  poolMonitor: PoolMonitor;
  positionManager: PositionManager;
  swapExecutor: SwapExecutor;
  emergencyStop: EmergencyStop;
  slippageGuard: SlippageGuard;
  ilTracker: ILTracker;
  balanceTracker: BalanceTracker;
  stateStore: StateStore;
  historyLogger: HistoryLogger;
  notifier: Notifier;
  ethPriceUsd?: number;
  maxTotalLossPercent: number;
}

export class RebalanceEngine {
  private readonly logger = getLogger();
  private state: RebalanceState = 'IDLE';
  private currentTokenId?: BigNumber;
  private currentRange?: PositionRange;
  private lastRebalanceTime = 0;
  private consecutiveErrors = 0;

  constructor(private readonly ctx: RebalanceContext) {}

  getState(): RebalanceState {
    return this.state;
  }

  getCurrentTokenId(): BigNumber | undefined {
    return this.currentTokenId;
  }

  getCurrentRange(): PositionRange | undefined {
    return this.currentRange;
  }

  async initialize(): Promise<void> {
    const { poolEntry, positionManager, wallet, stateStore } = this.ctx;
    const { pool } = poolEntry;

    this.logger.info({ poolId: poolEntry.id }, 'Initializing rebalance engine');

    // Load persisted state
    const savedState = stateStore.getPoolState(poolEntry.id);
    if (savedState?.tokenId) {
      this.currentTokenId = BigNumber.from(savedState.tokenId);
      this.currentRange = savedState.tickLower !== undefined && savedState.tickUpper !== undefined
        ? { tickLower: savedState.tickLower, tickUpper: savedState.tickUpper }
        : undefined;
      this.lastRebalanceTime = savedState.lastRebalanceTime ?? 0;
      this.logger.info({ tokenId: savedState.tokenId, range: this.currentRange }, 'Restored state from disk');
    }

    // Check for existing on-chain positions
    if (!this.currentTokenId) {
      const existing = await positionManager.findExistingPositions(
        wallet.address,
        pool.token0.address,
        pool.token1.address,
        pool.feeTier,
      );

      if (existing.length > 0) {
        const active = existing.find((p) => !p.liquidity.isZero());
        if (active) {
          this.currentTokenId = active.tokenId;
          this.currentRange = { tickLower: active.tickLower, tickUpper: active.tickUpper };
          this.logger.info(
            { tokenId: active.tokenId.toString(), tickLower: active.tickLower, tickUpper: active.tickUpper },
            'Found existing on-chain position',
          );
        }
      }
    }

    // Ensure token approvals
    await positionManager.approveTokens(pool.token0.address, pool.token1.address);

    this.setState('MONITORING');
  }

  async onPriceUpdate(poolState: PoolState): Promise<void> {
    if (this.state === 'STOPPED' || this.state === 'ERROR') return;
    // Prevent re-entrant rebalance while already in progress
    if (this.state !== 'MONITORING' && this.state !== 'IDLE') return;

    const { poolEntry } = this.ctx;
    const { strategy } = poolEntry;

    updatePoolStatus(poolEntry.id, {
      state: this.state,
      currentTick: poolState.tick,
      positionTickLower: this.currentRange?.tickLower,
      positionTickUpper: this.currentRange?.tickUpper,
      tokenId: this.currentTokenId?.toNumber(),
    });

    // Check depeg
    if (this.checkDepeg(poolState)) return;

    // No position yet → mint initial
    if (!this.currentTokenId) {
      await this.mintInitialPosition(poolState);
      return;
    }

    // Check if rebalance needed
    if (this.currentRange && shouldRebalance(poolState.tick, this.currentRange.tickLower, this.currentRange.tickUpper, strategy.rebalanceThresholdPercent)) {
      await this.executeRebalance(poolState);
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
          `Action: closing position and stopping bot`,
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

    if (!this.currentTokenId) return;

    this.setState('WITHDRAWING');
    try {
      const pos = await positionManager.getPosition(this.currentTokenId);
      if (!pos.liquidity.isZero()) {
        await positionManager.removePosition(this.currentTokenId, pos.liquidity, strategy.slippageTolerancePercent);
      }

      historyLogger.log({
        type: OperationType.EMERGENCY_STOP,
        poolId: poolEntry.id,
        tokenId: this.currentTokenId.toString(),
      });

      this.currentTokenId = undefined;
      this.currentRange = undefined;
      this.persistState(stateStore, poolEntry.id);
    } catch (err) {
      this.logger.error({ err }, 'Emergency withdraw failed');
    }

    this.setState('STOPPED');
  }

  private async checkGasCost(isOutOfRange: boolean): Promise<boolean> {
    const { poolEntry, wallet } = this.ctx;
    const { strategy } = poolEntry;

    try {
      const provider = wallet.provider;
      const gasInfo = await getGasInfo(provider as any);

      if (isGasSpike(gasInfo.gasPriceGwei)) {
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

  private async mintInitialPosition(poolState: PoolState): Promise<void> {
    const { poolEntry, wallet, positionManager, balanceTracker, ilTracker, stateStore, historyLogger, notifier } = this.ctx;
    const { pool, strategy } = poolEntry;

    this.setState('MINTING');

    try {
      const range = calculateRange(poolState.tick, strategy.rangeWidthPercent, pool.feeTier);

      const token0Contract = getErc20Contract(pool.token0.address, wallet);
      const token1Contract = getErc20Contract(pool.token1.address, wallet);
      const [balance0, balance1] = await Promise.all([
        token0Contract.balanceOf(wallet.address),
        token1Contract.balanceOf(wallet.address),
      ]);

      const result = await positionManager.mint({
        token0: pool.token0.address,
        token1: pool.token1.address,
        fee: pool.feeTier,
        tickLower: range.tickLower,
        tickUpper: range.tickUpper,
        amount0Desired: balance0,
        amount1Desired: balance1,
        slippagePercent: strategy.slippageTolerancePercent,
        recipient: wallet.address,
      });

      this.currentTokenId = result.tokenId;
      this.currentRange = { tickLower: range.tickLower, tickUpper: range.tickUpper };
      this.lastRebalanceTime = Date.now();
      this.consecutiveErrors = 0;

      // Set IL tracker entry and initial portfolio value
      const currentPrice = tickToPrice(poolState.tick);
      const amount0Norm = parseFloat(result.amount0.toString()) / Math.pow(10, pool.token0.decimals);
      const amount1Norm = parseFloat(result.amount1.toString()) / Math.pow(10, pool.token1.decimals);
      ilTracker.setEntry(amount0Norm, amount1Norm, currentPrice);

      // Estimate initial portfolio value (token0 priced via pool, token1 as base)
      const initialValue = this.estimatePortfolioValue(balance0, balance1, pool.token0.decimals, pool.token1.decimals, currentPrice);
      balanceTracker.setInitialValue(initialValue);
      this.logger.info({ initialValueUsd: initialValue.toFixed(2) }, 'Initial portfolio value set');

      this.persistState(stateStore, poolEntry.id);
      historyLogger.log({
        type: OperationType.MINT,
        poolId: poolEntry.id,
        tokenId: result.tokenId.toString(),
        tickLower: range.tickLower,
        tickUpper: range.tickUpper,
        amount0: result.amount0.toString(),
        amount1: result.amount1.toString(),
      });

      await notifier.notify(
        `Initial position minted for ${poolEntry.id}\n` +
          `TokenId: ${result.tokenId.toString()}\n` +
          `Range: [${range.tickLower}, ${range.tickUpper}]\n` +
          `Price: [${range.priceLower.toFixed(6)}, ${range.priceUpper.toFixed(6)}]`,
      );

      this.setState('MONITORING');
    } catch (err) {
      this.handleError('mintInitialPosition', err);
    }
  }

  private async executeRebalance(poolState: PoolState): Promise<void> {
    const { poolEntry, wallet, positionManager, swapExecutor, emergencyStop, ilTracker, balanceTracker, stateStore, historyLogger, notifier } = this.ctx;
    const { pool, strategy } = poolEntry;

    const outOfRange = this.currentRange
      ? !isInRange(poolState.tick, this.currentRange.tickLower, this.currentRange.tickUpper)
      : true;

    // Check min interval (skip only if still in range)
    const elapsed = Date.now() - this.lastRebalanceTime;
    const minInterval = strategy.minRebalanceIntervalMinutes * 60 * 1000;
    if (elapsed < minInterval && !outOfRange) {
      this.logger.info({ elapsed, minInterval }, 'Skipping rebalance: too soon and still in range');
      return;
    }

    // Emergency stop check
    if (emergencyStop.isStopped()) {
      this.logger.warn('Emergency stop active, skipping rebalance');
      return;
    }

    // Gas cost check
    const gasOk = await this.checkGasCost(outOfRange);
    if (!gasOk) return;

    this.setState('EVALUATING');
    this.logger.info({ poolId: poolEntry.id, tick: poolState.tick, outOfRange }, 'Starting rebalance');

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

      // STEP 1: Withdraw
      this.setState('WITHDRAWING');
      let removeResult: RemoveResult | undefined;
      if (this.currentTokenId) {
        const pos = await positionManager.getPosition(this.currentTokenId);
        if (!pos.liquidity.isZero()) {
          removeResult = await positionManager.removePosition(this.currentTokenId, pos.liquidity, strategy.slippageTolerancePercent);
        }
        this.currentTokenId = undefined;
        this.currentRange = undefined;
      }

      // STEP 2: Calculate new range
      const freshState = await this.ctx.poolMonitor.fetchPoolState();
      const newRange = calculateRange(freshState.tick, strategy.rangeWidthPercent, pool.feeTier);

      // STEP 3: Swap if needed
      this.setState('SWAPPING');
      const token0Contract = getErc20Contract(pool.token0.address, wallet);
      const token1Contract = getErc20Contract(pool.token1.address, wallet);
      const [balance0, balance1] = await Promise.all([
        token0Contract.balanceOf(wallet.address),
        token1Contract.balanceOf(wallet.address),
      ]);

      const swapPlan = calculateSwap(
        balance0,
        balance1,
        pool.token0.decimals,
        pool.token1.decimals,
        freshState.tick,
        newRange.tickLower,
        newRange.tickUpper,
        pool.feeTier,
        pool.token0.address,
        pool.token1.address,
      );

      if (swapPlan && swapPlan.amountIn.gt(0)) {
        await swapExecutor.executeSwap(
          swapPlan.tokenIn,
          swapPlan.tokenOut,
          pool.feeTier,
          swapPlan.amountIn,
          strategy.slippageTolerancePercent,
        );
      }

      // STEP 4: Mint new position
      this.setState('MINTING');
      const [newBalance0, newBalance1] = await Promise.all([
        token0Contract.balanceOf(wallet.address),
        token1Contract.balanceOf(wallet.address),
      ]);

      const mintResult = await positionManager.mint({
        token0: pool.token0.address,
        token1: pool.token1.address,
        fee: pool.feeTier,
        tickLower: newRange.tickLower,
        tickUpper: newRange.tickUpper,
        amount0Desired: newBalance0,
        amount1Desired: newBalance1,
        slippagePercent: strategy.slippageTolerancePercent,
        recipient: wallet.address,
      });

      this.currentTokenId = mintResult.tokenId;
      this.currentRange = { tickLower: newRange.tickLower, tickUpper: newRange.tickUpper };
      this.lastRebalanceTime = Date.now();
      this.consecutiveErrors = 0;

      // Calculate IL
      const currentPrice = tickToPrice(freshState.tick);
      const amount0Norm = parseFloat(mintResult.amount0.toString()) / Math.pow(10, pool.token0.decimals);
      const amount1Norm = parseFloat(mintResult.amount1.toString()) / Math.pow(10, pool.token1.decimals);
      const ilSnapshot = ilTracker.calculate(amount0Norm, amount1Norm, currentPrice);

      // Post-rebalance value check
      const postValue = this.estimatePortfolioValue(newBalance0, newBalance1, pool.token0.decimals, pool.token1.decimals, currentPrice);

      // Check single-rebalance loss (>2% → pause + alert)
      if (preValue > 0 && emergencyStop.checkRebalanceLoss(preValue, postValue)) {
        await notifier.notify(
          `ALERT: Rebalance loss too high for ${poolEntry.id}!\n` +
            `Pre: $${preValue.toFixed(2)} → Post: $${postValue.toFixed(2)}\n` +
            `Loss: ${(((preValue - postValue) / preValue) * 100).toFixed(2)}%\n` +
            `Action: pausing bot`,
        );
        this.setState('STOPPED');
        return;
      }

      // Check total portfolio loss (>maxTotalLossPercent → emergency stop)
      const initialValue = balanceTracker.getInitialValue();
      if (initialValue && emergencyStop.checkPortfolioLoss(postValue, initialValue, this.ctx.maxTotalLossPercent)) {
        await this.emergencyWithdraw();
        await notifier.notify(
          `ALERT: Portfolio loss limit reached for ${poolEntry.id}!\n` +
            `Initial: $${initialValue.toFixed(2)} → Current: $${postValue.toFixed(2)}\n` +
            `Loss: ${(((initialValue - postValue) / initialValue) * 100).toFixed(2)}%\n` +
            `Action: position closed, bot stopped`,
        );
        return;
      }

      this.persistState(stateStore, poolEntry.id);
      historyLogger.log({
        type: OperationType.REBALANCE,
        poolId: poolEntry.id,
        tokenId: mintResult.tokenId.toString(),
        tickLower: newRange.tickLower,
        tickUpper: newRange.tickUpper,
        amount0: mintResult.amount0.toString(),
        amount1: mintResult.amount1.toString(),
        feesCollected0: removeResult?.fee0.toString(),
        feesCollected1: removeResult?.fee1.toString(),
        ilPercent: ilSnapshot?.ilPercent?.toFixed(4),
      });

      let message =
        `Rebalance completed for ${poolEntry.id}\n` +
        `New TokenId: ${mintResult.tokenId.toString()}\n` +
        `New Range: [${newRange.tickLower}, ${newRange.tickUpper}]\n` +
        `Price: [${newRange.priceLower.toFixed(6)}, ${newRange.priceUpper.toFixed(6)}]`;

      if (ilSnapshot) {
        message += `\nIL: ${ilSnapshot.ilPercent.toFixed(4)}%`;
      }

      await notifier.notify(message);

      this.setState('MONITORING');
    } catch (err) {
      this.handleError('executeRebalance', err);
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
    stateStore.updatePoolState(poolId, {
      tokenId: this.currentTokenId?.toString(),
      tickLower: this.currentRange?.tickLower,
      tickUpper: this.currentRange?.tickUpper,
      lastRebalanceTime: this.lastRebalanceTime,
    });
    stateStore.save();
  }

  /**
   * Estimate total portfolio value using token1 as the base unit.
   * For stablecoin pairs (USDT/ZCHF), this approximates USD value.
   * price = token0/token1 ratio from the pool tick.
   */
  private estimatePortfolioValue(
    balance0: BigNumber,
    balance1: BigNumber,
    decimals0: number,
    decimals1: number,
    price: number,
  ): number {
    const bal0 = parseFloat(balance0.toString()) / Math.pow(10, decimals0);
    const bal1 = parseFloat(balance1.toString()) / Math.pow(10, decimals1);
    // price = how much token1 per token0
    return bal0 * price + bal1;
  }
}
