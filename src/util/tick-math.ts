import { nearestUsableTick, TickMath } from '@uniswap/v3-sdk';
import JSBI from 'jsbi';

export function tickToPrice(tick: number): number {
  return Math.pow(1.0001, tick);
}

export function tickToAdjustedPrice(tick: number, decimals0: number, decimals1: number): number {
  return Math.pow(1.0001, tick) * Math.pow(10, decimals0 - decimals1);
}

export function priceToTick(price: number): number {
  return Math.floor(Math.log(price) / Math.log(1.0001));
}

export function alignTick(tick: number, tickSpacing: number): number {
  return nearestUsableTick(tick, tickSpacing);
}

export function feeToTickSpacing(feeTier: number): number {
  switch (feeTier) {
    case 100:
      return 1;
    case 500:
      return 10;
    case 3000:
      return 60;
    case 10000:
      return 200;
    default:
      throw new Error(`Unknown fee tier: ${feeTier}`);
  }
}

export function sqrtPriceX96ToPrice(sqrtPriceX96: JSBI, decimals0: number, decimals1: number): number {
  const sqrtPrice = JSBI.toNumber(sqrtPriceX96) / Math.pow(2, 96);
  const price = sqrtPrice * sqrtPrice;
  return price * Math.pow(10, decimals0 - decimals1);
}

export function getMinTick(tickSpacing: number): number {
  return Math.ceil(TickMath.MIN_TICK / tickSpacing) * tickSpacing;
}

export function getMaxTick(tickSpacing: number): number {
  return Math.floor(TickMath.MAX_TICK / tickSpacing) * tickSpacing;
}

/**
 * Calculate token amounts from Uniswap V3 position liquidity.
 * Uses the standard Uniswap V3 math: L * (sqrt(upper) - sqrt(lower)) for token amounts.
 */
export function getAmountsFromLiquidity(
  liquidity: number,
  currentTick: number,
  tickLower: number,
  tickUpper: number,
): { amount0: number; amount1: number } {
  const sqrtCurrent = Math.sqrt(Math.pow(1.0001, currentTick));
  const sqrtLower = Math.sqrt(Math.pow(1.0001, tickLower));
  const sqrtUpper = Math.sqrt(Math.pow(1.0001, tickUpper));

  let amount0 = 0;
  let amount1 = 0;

  if (currentTick < tickLower) {
    // All token0
    amount0 = liquidity * (1 / sqrtLower - 1 / sqrtUpper);
  } else if (currentTick >= tickUpper) {
    // All token1
    amount1 = liquidity * (sqrtUpper - sqrtLower);
  } else {
    // Mixed
    amount0 = liquidity * (1 / sqrtCurrent - 1 / sqrtUpper);
    amount1 = liquidity * (sqrtCurrent - sqrtLower);
  }

  return { amount0, amount1 };
}
