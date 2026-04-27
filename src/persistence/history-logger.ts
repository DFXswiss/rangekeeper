import { appendFileSync, existsSync, mkdirSync, statSync, renameSync } from 'fs';
import path from 'path';
import { getLogger } from '../util/logger';

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB

export enum OperationType {
  MINT = 'MINT',
  REBALANCE = 'REBALANCE',
  REMOVE = 'REMOVE',
  SWAP = 'SWAP',
  EMERGENCY_STOP = 'EMERGENCY_STOP',
  ERROR = 'ERROR',
}

export interface OperationLog {
  type: OperationType;
  poolId: string;
  tokenId?: string;
  tickLower?: number;
  tickUpper?: number;
  amount0?: string;
  amount1?: string;
  feesCollected0?: string;
  feesCollected1?: string;
  gasUsed?: string;
  error?: string;
  [key: string]: unknown;
}

export class HistoryLogger {
  private readonly logger = getLogger();

  constructor(private readonly filePath: string) {
    const dir = path.dirname(filePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }

  log(entry: OperationLog): void {
    const record = {
      timestamp: new Date().toISOString(),
      ...entry,
    };

    try {
      this.rotateIfNeeded();
      appendFileSync(this.filePath, JSON.stringify(record) + '\n', 'utf-8');
      this.logger.debug({ type: entry.type, poolId: entry.poolId }, 'History entry logged');
    } catch (err) {
      this.logger.error({ err }, 'Failed to write history log');
    }
  }

  private rotateIfNeeded(): void {
    try {
      if (!existsSync(this.filePath)) return;
      const stats = statSync(this.filePath);
      if (stats.size > MAX_FILE_SIZE) {
        const rotatedPath = this.filePath + '.1';
        renameSync(this.filePath, rotatedPath);
        this.logger.info({ rotatedPath, sizeMb: (stats.size / 1024 / 1024).toFixed(1) }, 'History log rotated');
      }
    } catch (err) {
      this.logger.warn({ err }, 'Failed to rotate history log');
    }
  }
}
