import { getLogger } from '../util/logger';

export type StopCategory = 'tx-error' | 'portfolio-loss' | 'rebalance-loss' | 'depeg' | 'manual';

export class EmergencyStop {
  private readonly logger = getLogger();
  private stopped = false;
  private reason?: string;
  private category?: StopCategory;
  private consecutiveTxErrors = 0;
  private stoppedAt?: number;
  private autoRecoveryCooldownMs: number;

  constructor(autoRecoveryCooldownMs = 5 * 60 * 1000) {
    this.autoRecoveryCooldownMs = autoRecoveryCooldownMs;
  }

  trigger(reason: string, category: StopCategory = 'manual'): void {
    this.stopped = true;
    this.reason = reason;
    this.category = category;
    this.stoppedAt = Date.now();
    this.logger.error({ reason, category }, 'EMERGENCY STOP TRIGGERED');
  }

  isStopped(): boolean {
    if (this.stopped && this.category === 'tx-error' && this.stoppedAt) {
      if (Date.now() - this.stoppedAt >= this.autoRecoveryCooldownMs) {
        this.logger.info(
          { cooldownMs: this.autoRecoveryCooldownMs, reason: this.reason },
          'Auto-recovering from tx-error emergency stop after cooldown',
        );
        this.reset();
        return false;
      }
    }
    return this.stopped;
  }

  getReason(): string | undefined {
    return this.reason;
  }

  reset(): void {
    this.stopped = false;
    this.reason = undefined;
    this.category = undefined;
    this.stoppedAt = undefined;
    this.consecutiveTxErrors = 0;
    this.logger.info('Emergency stop reset');
  }

  recordTxError(): number {
    this.consecutiveTxErrors++;
    if (this.consecutiveTxErrors > 3) {
      this.trigger(`${this.consecutiveTxErrors} consecutive transaction errors`, 'tx-error');
    }
    return this.consecutiveTxErrors;
  }

  recordTxSuccess(): void {
    this.consecutiveTxErrors = 0;
  }

  checkPortfolioLoss(currentValueUsd: number, initialValueUsd: number, maxLossPercent: number): boolean {
    const lossPct = ((initialValueUsd - currentValueUsd) / initialValueUsd) * 100;
    if (lossPct > maxLossPercent) {
      this.trigger(`Portfolio loss ${lossPct.toFixed(2)}% exceeds max ${maxLossPercent}%`, 'portfolio-loss');
      return true;
    }
    return false;
  }

  checkRebalanceLoss(preValueUsd: number, postValueUsd: number, maxLossPercent = 2): boolean {
    const lossPct = ((preValueUsd - postValueUsd) / preValueUsd) * 100;
    if (lossPct > maxLossPercent) {
      this.trigger(`Rebalance loss ${lossPct.toFixed(2)}% exceeds max ${maxLossPercent}%`, 'rebalance-loss');
      return true;
    }
    return false;
  }
}
