import { BigNumber } from 'ethers';
import { getLogger } from '../util/logger';

export class SlippageGuard {
  private readonly logger = getLogger();

  constructor(private readonly maxSlippagePercent: number) {}

  calculateMinOut(amountIn: BigNumber, expectedPrice: number, decimalsIn: number, decimalsOut: number): BigNumber {
    const amountInNorm = parseFloat(amountIn.toString()) / Math.pow(10, decimalsIn);
    const expectedOut = amountInNorm * expectedPrice;
    const minOut = expectedOut * (1 - this.maxSlippagePercent / 100);
    return BigNumber.from(Math.floor(minOut * Math.pow(10, decimalsOut)).toString());
  }

  checkSlippage(amountIn: BigNumber, amountOut: BigNumber, decimalsIn: number, decimalsOut: number, expectedPrice: number): boolean {
    const inNorm = parseFloat(amountIn.toString()) / Math.pow(10, decimalsIn);
    const outNorm = parseFloat(amountOut.toString()) / Math.pow(10, decimalsOut);
    const actualPrice = outNorm / inNorm;
    const slippage = Math.abs(actualPrice - expectedPrice) / expectedPrice * 100;

    if (slippage > this.maxSlippagePercent) {
      this.logger.warn({ actualPrice, expectedPrice, slippage: slippage.toFixed(4) }, 'Slippage exceeds threshold');
      return false;
    }

    return true;
  }
}
