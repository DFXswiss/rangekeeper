import { BigNumber } from 'ethers';
import { getLogger } from '../util/logger';

export class SlippageGuard {
  private readonly logger = getLogger();

  constructor(private readonly maxSlippagePercent: number) {}

  calculateMinOut(amountIn: BigNumber, expectedPrice: number, decimalsIn: number, decimalsOut: number): BigNumber {
    // Use integer arithmetic to avoid parseFloat precision loss on large BigNumbers.
    // expectedPrice is expressed as a ratio (e.g. 1.0 for stablecoins).
    // We scale the price to an integer numerator/denominator with 12 digits of precision.
    const PRICE_SCALE = 1_000_000_000_000; // 1e12
    const priceNumerator = BigNumber.from(Math.round(expectedPrice * PRICE_SCALE));
    const slippageNumerator = BigNumber.from(Math.round((1 - this.maxSlippagePercent / 100) * PRICE_SCALE));

    const decimalDiff = decimalsOut - decimalsIn;
    let result: BigNumber;
    if (decimalDiff >= 0) {
      result = amountIn
        .mul(priceNumerator)
        .mul(slippageNumerator)
        .mul(BigNumber.from(10).pow(decimalDiff))
        .div(BigNumber.from(PRICE_SCALE))
        .div(BigNumber.from(PRICE_SCALE));
    } else {
      result = amountIn
        .mul(priceNumerator)
        .mul(slippageNumerator)
        .div(BigNumber.from(10).pow(-decimalDiff))
        .div(BigNumber.from(PRICE_SCALE))
        .div(BigNumber.from(PRICE_SCALE));
    }

    return result;
  }

  checkSlippage(
    amountIn: BigNumber,
    amountOut: BigNumber,
    decimalsIn: number,
    decimalsOut: number,
    expectedPrice: number,
  ): boolean {
    // Use integer cross-multiplication to avoid parseFloat precision loss.
    // actualPrice = (amountOut / 10^decimalsOut) / (amountIn / 10^decimalsIn)
    // slippage% = |actualPrice - expectedPrice| / expectedPrice * 100
    // Rewritten in integers: compare amountOut * 10^decimalsIn vs amountIn * 10^decimalsOut * expectedPrice
    const PRICE_SCALE = 1_000_000_000_000;
    const priceScaled = BigNumber.from(Math.round(expectedPrice * PRICE_SCALE));

    const decimalDiff = decimalsOut - decimalsIn;
    // actual_scaled = amountOut * PRICE_SCALE (represents actual price * amountIn * 10^(decimalsOut-decimalsIn) * PRICE_SCALE)
    // expected_scaled = amountIn * priceScaled * 10^(decimalsOut-decimalsIn)
    let actualScaled: BigNumber;
    let expectedScaled: BigNumber;

    if (decimalDiff >= 0) {
      actualScaled = amountOut.mul(PRICE_SCALE);
      expectedScaled = amountIn.mul(priceScaled).mul(BigNumber.from(10).pow(decimalDiff));
    } else {
      actualScaled = amountOut.mul(PRICE_SCALE).mul(BigNumber.from(10).pow(-decimalDiff));
      expectedScaled = amountIn.mul(priceScaled);
    }

    if (expectedScaled.isZero()) return true;

    // slippage = |actual - expected| / expected * 100
    const diff = actualScaled.gt(expectedScaled) ? actualScaled.sub(expectedScaled) : expectedScaled.sub(actualScaled);
    // slippageBps = diff * 10000 / expected (basis points)
    const slippageBps = diff.mul(10000).div(expectedScaled);
    const maxSlippageBps = Math.round(this.maxSlippagePercent * 100);

    if (slippageBps.gt(maxSlippageBps)) {
      this.logger.warn({ slippageBps: slippageBps.toNumber(), maxSlippageBps }, 'Slippage exceeds threshold');
      return false;
    }

    return true;
  }
}
