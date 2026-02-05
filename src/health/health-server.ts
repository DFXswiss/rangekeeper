import express from 'express';
import { getLogger } from '../util/logger';

export interface BotStatus {
  uptime: number;
  pools: PoolStatus[];
  lastError?: string;
  dryRun: boolean;
}

export interface PoolStatus {
  id: string;
  state: string;
  currentTick?: number;
  positionTickLower?: number;
  positionTickUpper?: number;
  tokenId?: number;
  lastRebalance?: string;
  portfolioValueUsd?: number;
}

const botStatus: BotStatus = {
  uptime: 0,
  pools: [],
  dryRun: false,
};

const startTime = Date.now();

export function updatePoolStatus(poolId: string, status: Partial<PoolStatus>): void {
  const existing = botStatus.pools.find((p) => p.id === poolId);
  if (existing) {
    Object.assign(existing, status);
  } else {
    botStatus.pools.push({ id: poolId, state: 'initializing', ...status });
  }
}

export function updateBotError(error: string): void {
  botStatus.lastError = error;
}

export function getBotStatus(): BotStatus {
  return { ...botStatus, uptime: Math.floor((Date.now() - startTime) / 1000) };
}

export function setDryRunMode(enabled: boolean): void {
  botStatus.dryRun = enabled;
}

export function startHealthServer(port: number): void {
  const logger = getLogger();
  const app = express();

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', uptime: Math.floor((Date.now() - startTime) / 1000) });
  });

  app.get('/status', (_req, res) => {
    res.json(getBotStatus());
  });

  app.listen(port, () => {
    logger.info({ port }, 'Health server listening');
  });
}
