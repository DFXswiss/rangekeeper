import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import path from 'path';
import { getLogger } from '../util/logger';

export interface PoolState {
  tokenId?: string;
  tickLower?: number;
  tickUpper?: number;
  lastRebalanceTime?: number;
  initialValueUsd?: number;
}

export interface BotState {
  version: number;
  startedAt: string;
  pools: Record<string, PoolState>;
}

export class StateStore {
  private readonly logger = getLogger();
  private state: BotState;

  constructor(private readonly filePath: string) {
    this.state = this.load();
  }

  private load(): BotState {
    try {
      if (existsSync(this.filePath)) {
        const raw = readFileSync(this.filePath, 'utf-8');
        const parsed = JSON.parse(raw) as BotState;
        this.logger.info({ pools: Object.keys(parsed.pools).length }, 'Loaded bot state from disk');
        return parsed;
      }
    } catch (err) {
      this.logger.warn({ err }, 'Failed to load state file, starting fresh');
    }

    return {
      version: 1,
      startedAt: new Date().toISOString(),
      pools: {},
    };
  }

  save(): void {
    try {
      const dir = path.dirname(this.filePath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      writeFileSync(this.filePath, JSON.stringify(this.state, null, 2), 'utf-8');
    } catch (err) {
      this.logger.error({ err }, 'Failed to save state');
    }
  }

  getPoolState(poolId: string): PoolState | undefined {
    return this.state.pools[poolId];
  }

  updatePoolState(poolId: string, update: Partial<PoolState>): void {
    if (!this.state.pools[poolId]) {
      this.state.pools[poolId] = {};
    }
    Object.assign(this.state.pools[poolId], update);
  }

  getState(): BotState {
    return this.state;
  }
}
