import { getLogger } from '../util/logger';

export class EmergencyStop {
  private readonly logger = getLogger();
  private stopped = false;
  private reason?: string;
  private consecutiveTxErrors = 0;

  trigger(reason: string): void {
    this.stopped = true;
    this.reason = reason;
    this.logger.error({ reason }, 'EMERGENCY STOP TRIGGERED');
  }

  isStopped(): boolean {
    return this.stopped;
  }

  getReason(): string | undefined {
    return this.reason;
  }

  reset(): void {
    this.stopped = false;
    this.reason = undefined;
    this.consecutiveTxErrors = 0;
    this.logger.info('Emergency stop reset');
  }

  recordTxError(): number {
    this.consecutiveTxErrors++;
    if (this.consecutiveTxErrors > 3) {
      this.trigger(`${this.consecutiveTxErrors} consecutive transaction errors`);
    }
    return this.consecutiveTxErrors;
  }

  recordTxSuccess(): void {
    this.consecutiveTxErrors = 0;
  }

  checkPortfolioLoss(currentValueUsd: number, initialValueUsd: number, maxLossPercent: number): boolean {
    const lossPct = ((initialValueUsd - currentValueUsd) / initialValueUsd) * 100;
    if (lossPct > maxLossPercent) {
      this.trigger(`Portfolio loss ${lossPct.toFixed(2)}% exceeds max ${maxLossPercent}%`);
      return true;
    }
    return false;
  }

  checkRebalanceLoss(preValueUsd: number, postValueUsd: number, maxLossPercent = 2): boolean {
    const lossPct = ((preValueUsd - postValueUsd) / preValueUsd) * 100;
    if (lossPct > maxLossPercent) {
      this.trigger(`Rebalance loss ${lossPct.toFixed(2)}% exceeds max ${maxLossPercent}%`);
      return true;
    }
    return false;
  }
}
