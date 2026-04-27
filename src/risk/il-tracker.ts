import { getLogger } from '../util/logger';

export interface ILSnapshot {
  timestamp: number;
  token0Amount: number;
  token1Amount: number;
  entryPrice: number;
  currentPrice: number;
  ilPercent: number;
  holdValueUsd: number;
  positionValueUsd: number;
}

export class ILTracker {
  private readonly logger = getLogger();
  private entryToken0Amount?: number;
  private entryToken1Amount?: number;
  private entryPrice?: number;

  setEntry(token0Amount: number, token1Amount: number, price: number): void {
    this.entryToken0Amount = token0Amount;
    this.entryToken1Amount = token1Amount;
    this.entryPrice = price;
    this.logger.info({ token0Amount, token1Amount, price }, 'IL tracker entry set');
  }

  calculate(
    currentToken0: number,
    currentToken1: number,
    currentPrice: number,
    priceIsToken0InToken1 = true,
  ): ILSnapshot | null {
    if (!this.entryToken0Amount || !this.entryToken1Amount || !this.entryPrice) {
      return null;
    }

    // Hold value: what the original tokens would be worth now
    // priceIsToken0InToken1=true: price = token0 per token1 → value = token0 * price + token1
    // priceIsToken0InToken1=false: price = token1 per token0 → value = token0 + token1 * price
    let holdValueUsd: number;
    let positionValueUsd: number;

    if (priceIsToken0InToken1) {
      holdValueUsd = this.entryToken0Amount * currentPrice + this.entryToken1Amount;
      positionValueUsd = currentToken0 * currentPrice + currentToken1;
    } else {
      holdValueUsd = this.entryToken0Amount + this.entryToken1Amount * currentPrice;
      positionValueUsd = currentToken0 + currentToken1 * currentPrice;
    }

    // IL = (positionValue / holdValue - 1) * 100
    const ilPercent = holdValueUsd > 0 ? (positionValueUsd / holdValueUsd - 1) * 100 : 0;

    const snapshot: ILSnapshot = {
      timestamp: Date.now(),
      token0Amount: currentToken0,
      token1Amount: currentToken1,
      entryPrice: this.entryPrice,
      currentPrice,
      ilPercent,
      holdValueUsd,
      positionValueUsd,
    };

    this.logger.debug({ ilPercent: ilPercent.toFixed(4), holdValueUsd, positionValueUsd }, 'IL calculated');

    return snapshot;
  }
}
