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
  private poolContract: Contract;

  constructor(
    poolContract: Contract,
    private readonly poolId: string,
    private readonly checkIntervalMs: number,
  ) {
    super();
    this.poolContract = poolContract;
  }

  setPoolContract(contract: Contract): void {
    this.poolContract = contract;
    this.logger.info({ poolId: this.poolId }, 'Pool contract updated (RPC failover)');
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

  startMonitoring(): void {
    this.logger.info({ poolId: this.poolId, intervalMs: this.checkIntervalMs }, 'Starting pool monitoring');

    this.intervalHandle = setInterval(async () => {
      try {
        const state = await this.fetchPoolState();
        this.emit('priceUpdate', state);
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

  getLastState(): PoolState | undefined {
    return this.lastState;
  }
}
