import { EventEmitter } from 'events';
import { Contract } from 'ethers';
import JSBI from 'jsbi';
import { getLogger } from '../util/logger';
import { withRetry } from '../util/retry';

export interface PoolState {
  sqrtPriceX96: JSBI;
  tick: number;
  liquidity: JSBI;
  timestamp: number;
}

export interface PositionRange {
  tickLower: number;
  tickUpper: number;
}

export class PoolMonitor extends EventEmitter {
  private readonly logger = getLogger();
  private intervalHandle?: NodeJS.Timeout;
  private lastState?: PoolState;

  constructor(
    private readonly poolContract: Contract,
    private readonly poolId: string,
    private readonly checkIntervalMs: number,
  ) {
    super();
  }

  async fetchPoolState(): Promise<PoolState> {
    const [slot0, liquidity] = await withRetry(
      () => Promise.all([this.poolContract.slot0(), this.poolContract.liquidity()]),
      `${this.poolId}:fetchPoolState`,
    );

    const state: PoolState = {
      sqrtPriceX96: JSBI.BigInt(slot0.sqrtPriceX96.toString()),
      tick: slot0.tick,
      liquidity: JSBI.BigInt(liquidity.toString()),
      timestamp: Date.now(),
    };

    this.lastState = state;
    return state;
  }

  startMonitoring(positionRange?: PositionRange): void {
    this.logger.info({ poolId: this.poolId, intervalMs: this.checkIntervalMs }, 'Starting pool monitoring');

    this.intervalHandle = setInterval(async () => {
      try {
        const state = await this.fetchPoolState();
        this.emit('priceUpdate', state);

        if (positionRange) {
          this.checkRange(state, positionRange);
        }
      } catch (err) {
        this.logger.error({ poolId: this.poolId, err }, 'Error polling pool state');
        this.emit('error', err);
      }
    }, this.checkIntervalMs);
  }

  stopMonitoring(): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = undefined;
      this.logger.info({ poolId: this.poolId }, 'Stopped pool monitoring');
    }
  }

  updatePositionRange(range: PositionRange): void {
    this.stopMonitoring();
    this.startMonitoring(range);
  }

  getLastState(): PoolState | undefined {
    return this.lastState;
  }

  private checkRange(state: PoolState, range: PositionRange): void {
    const { tick } = state;
    const { tickLower, tickUpper } = range;
    const rangeWidth = tickUpper - tickLower;

    if (tick < tickLower || tick >= tickUpper) {
      this.logger.warn({ poolId: this.poolId, tick, tickLower, tickUpper }, 'Price OUT OF RANGE');
      this.emit('outOfRange', state, range);
      return;
    }

    const distToLower = tick - tickLower;
    const distToUpper = tickUpper - tick;
    const minDist = Math.min(distToLower, distToUpper);
    const percentFromEdge = (minDist / rangeWidth) * 100;

    if (percentFromEdge < 20) {
      const boundary = distToLower < distToUpper ? 'lower' : 'upper';
      this.logger.info(
        { poolId: this.poolId, tick, boundary, percentFromEdge: percentFromEdge.toFixed(1) },
        'Approaching range boundary',
      );
      this.emit('approachingBoundary', state, range, boundary);
    }
  }
}
