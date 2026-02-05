import { BigNumber } from 'ethers';
import { getLogger } from '../util/logger';
import { PoolMonitor, PoolState, PositionRange } from './pool-monitor';
import { PositionManager, MintResult, RemoveResult } from './position-manager';
import { calculateRange, shouldRebalance } from './range-calculator';
import { calculateSwap, SwapPlan } from '../swap/ratio-calculator';
import { SwapExecutor } from '../swap/swap-executor';
import { EmergencyStop } from '../risk/emergency-stop';
import { SlippageGuard } from '../risk/slippage-guard';
import { BalanceTracker } from './balance-tracker';
import { StateStore, BotState } from '../persistence/state-store';
import { HistoryLogger, OperationType } from '../persistence/history-logger';
import { Notifier } from '../notification/notifier';
import { updatePoolStatus } from '../health/health-server';
import { StrategyConfig, PoolEntry } from '../config';
import { getErc20Contract } from '../chain/contracts';
import { Wallet } from 'ethers';

export type RebalanceState = 'IDLE' | 'MONITORING' | 'EVALUATING' | 'WITHDRAWING' | 'SWAPPING' | 'MINTING' | 'ERROR' | 'STOPPED';

export interface RebalanceContext {
  poolEntry: PoolEntry;
  wallet: Wallet;
  poolMonitor: PoolMonitor;
  positionManager: PositionManager;
  swapExecutor: SwapExecutor;
  emergencyStop: EmergencyStop;
  slippageGuard: SlippageGuard;
  balanceTracker: BalanceTracker;
  stateStore: StateStore;
  historyLogger: HistoryLogger;
  notifier: Notifier;
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

    const { poolEntry } = this.ctx;
    const { strategy } = poolEntry;

    updatePoolStatus(poolEntry.id, {
      state: this.state,
      currentTick: poolState.tick,
      positionTickLower: this.currentRange?.tickLower,
      positionTickUpper: this.currentRange?.tickUpper,
      tokenId: this.currentTokenId?.toNumber(),
    });

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

  private async mintInitialPosition(poolState: PoolState): Promise<void> {
    const { poolEntry, wallet, positionManager, balanceTracker, stateStore, historyLogger, notifier } = this.ctx;
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
    const { poolEntry, wallet, positionManager, swapExecutor, slippageGuard, emergencyStop, balanceTracker, stateStore, historyLogger, notifier } = this.ctx;
    const { pool, strategy } = poolEntry;

    // Check min interval
    const elapsed = Date.now() - this.lastRebalanceTime;
    const minInterval = strategy.minRebalanceIntervalMinutes * 60 * 1000;
    if (elapsed < minInterval && this.currentRange && poolState.tick >= this.currentRange.tickLower && poolState.tick < this.currentRange.tickUpper) {
      this.logger.info({ elapsed, minInterval }, 'Skipping rebalance: too soon and still in range');
      return;
    }

    // Emergency stop check
    if (emergencyStop.isStopped()) {
      this.logger.warn('Emergency stop active, skipping rebalance');
      return;
    }

    this.setState('EVALUATING');
    this.logger.info({ poolId: poolEntry.id, tick: poolState.tick }, 'Starting rebalance');

    try {
      // Pre-rebalance snapshot
      const preSnapshot = await balanceTracker.takeSnapshot(pool.token0, pool.token1);

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
      });

      await notifier.notify(
        `Rebalance completed for ${poolEntry.id}\n` +
          `New TokenId: ${mintResult.tokenId.toString()}\n` +
          `New Range: [${newRange.tickLower}, ${newRange.tickUpper}]\n` +
          `Price: [${newRange.priceLower.toFixed(6)}, ${newRange.priceUpper.toFixed(6)}]`,
      );

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
}
