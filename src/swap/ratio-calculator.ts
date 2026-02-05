import { BigNumber } from 'ethers';
import JSBI from 'jsbi';
import { TickMath, SqrtPriceMath } from '@uniswap/v3-sdk';

export interface SwapPlan {
  tokenIn: string;
  tokenOut: string;
  amountIn: BigNumber;
  direction: 'token0to1' | 'token1to0';
}

/**
 * Calculate swap needed to achieve correct token ratio for a given tick range.
 *
 * For concentrated liquidity, the ratio of token0:token1 depends on where the
 * current price sits within the range. We compute the ideal ratio and determine
 * how much to swap.
 */
export function calculateSwap(
  balance0: BigNumber,
  balance1: BigNumber,
  decimals0: number,
  decimals1: number,
  currentTick: number,
  tickLower: number,
  tickUpper: number,
  feeTier: number,
  token0Address?: string,
  token1Address?: string,
): SwapPlan | null {
  // Get sqrt prices for range boundaries
  const sqrtRatioA = TickMath.getSqrtRatioAtTick(tickLower);
  const sqrtRatioB = TickMath.getSqrtRatioAtTick(tickUpper);
  const sqrtRatioCurrent = TickMath.getSqrtRatioAtTick(currentTick);

  // Calculate amounts for 1 unit of liquidity to get the ratio
  const testLiquidity = JSBI.BigInt('1000000000000000000'); // 1e18

  let amount0Needed: JSBI;
  let amount1Needed: JSBI;

  if (currentTick < tickLower) {
    // Price below range: only token0 needed
    amount0Needed = SqrtPriceMath.getAmount0Delta(sqrtRatioA, sqrtRatioB, testLiquidity, true);
    amount1Needed = JSBI.BigInt(0);
  } else if (currentTick >= tickUpper) {
    // Price above range: only token1 needed
    amount0Needed = JSBI.BigInt(0);
    amount1Needed = SqrtPriceMath.getAmount1Delta(sqrtRatioA, sqrtRatioB, testLiquidity, true);
  } else {
    // Price in range: both tokens needed
    amount0Needed = SqrtPriceMath.getAmount0Delta(sqrtRatioCurrent, sqrtRatioB, testLiquidity, true);
    amount1Needed = SqrtPriceMath.getAmount1Delta(sqrtRatioA, sqrtRatioCurrent, testLiquidity, true);
  }

  // If one side is 0, all tokens should be on the other side
  const a0 = JSBI.toNumber(amount0Needed);
  const a1 = JSBI.toNumber(amount1Needed);

  if (a0 === 0 && a1 === 0) return null;

  // Normalize balances to a comparable scale
  const bal0Normalized = parseFloat(balance0.toString()) / Math.pow(10, decimals0);
  const bal1Normalized = parseFloat(balance1.toString()) / Math.pow(10, decimals1);

  if (a0 === 0) {
    // Need all token1 → swap all token0 to token1
    if (balance0.gt(0)) {
      return {
        tokenIn: token0Address ?? '',
        tokenOut: token1Address ?? '',
        amountIn: balance0,
        direction: 'token0to1',
      };
    }
    return null;
  }

  if (a1 === 0) {
    // Need all token0 → swap all token1 to token0
    if (balance1.gt(0)) {
      return {
        tokenIn: token1Address ?? '',
        tokenOut: token0Address ?? '',
        amountIn: balance1,
        direction: 'token1to0',
      };
    }
    return null;
  }

  // Calculate ideal ratio: what fraction of total value should be token0
  // Use price to convert to common unit
  const price = Math.pow(1.0001, currentTick) * Math.pow(10, decimals0 - decimals1);
  const totalValue = bal0Normalized + bal1Normalized * price;

  if (totalValue === 0) return null;

  // The ideal amount0 (in token0 units) based on the ratio
  const a0Norm = a0 / Math.pow(10, decimals0);
  const a1Norm = a1 / Math.pow(10, decimals1);
  const idealRatio0 = a0Norm / (a0Norm + a1Norm * price);

  const currentRatio0 = bal0Normalized / totalValue;

  const diff = currentRatio0 - idealRatio0;

  // threshold: only swap if more than 1% difference
  if (Math.abs(diff) < 0.01) return null;

  if (diff > 0) {
    // Too much token0 → swap some to token1
    const swapAmount0 = diff * totalValue;
    const swapAmountRaw = BigNumber.from(
      Math.floor(swapAmount0 * Math.pow(10, decimals0)).toString(),
    );
    // Don't swap more than balance
    const cappedAmount = swapAmountRaw.gt(balance0) ? balance0 : swapAmountRaw;
    if (cappedAmount.lte(0)) return null;

    return {
      tokenIn: token0Address ?? '',
      tokenOut: token1Address ?? '',
      amountIn: cappedAmount,
      direction: 'token0to1',
    };
  } else {
    // Too much token1 → swap some to token0
    const swapAmount1 = Math.abs(diff) * totalValue / price;
    const swapAmountRaw = BigNumber.from(
      Math.floor(swapAmount1 * Math.pow(10, decimals1)).toString(),
    );
    const cappedAmount = swapAmountRaw.gt(balance1) ? balance1 : swapAmountRaw;
    if (cappedAmount.lte(0)) return null;

    return {
      tokenIn: token1Address ?? '',
      tokenOut: token0Address ?? '',
      amountIn: cappedAmount,
      direction: 'token1to0',
    };
  }
}
