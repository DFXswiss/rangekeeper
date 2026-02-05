import { nearestUsableTick, TickMath } from '@uniswap/v3-sdk';
import JSBI from 'jsbi';

export function tickToPrice(tick: number): number {
  return Math.pow(1.0001, tick);
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
