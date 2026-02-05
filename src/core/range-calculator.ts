import { nearestUsableTick, TickMath } from '@uniswap/v3-sdk';
import { feeToTickSpacing } from '../util/tick-math';

export interface RangeResult {
  tickLower: number;
  tickUpper: number;
  tickSpacing: number;
  priceLower: number;
  priceUpper: number;
  currentPrice: number;
}

export function calculateRange(currentTick: number, rangeWidthPercent: number, feeTier: number): RangeResult {
  const tickSpacing = feeToTickSpacing(feeTier);

  // Calculate tick offset: log(1 + rangeWidth/100) / log(1.0001)
  const halfWidth = rangeWidthPercent / 2;
  const tickOffset = Math.floor(Math.log(1 + halfWidth / 100) / Math.log(1.0001));

  // Compute raw ticks
  const rawLower = currentTick - tickOffset;
  const rawUpper = currentTick + tickOffset;

  // Align to tick spacing
  const tickLower = nearestUsableTick(rawLower, tickSpacing);
  const tickUpper = nearestUsableTick(rawUpper, tickSpacing);

  // Clamp to valid range
  const minTick = Math.ceil(TickMath.MIN_TICK / tickSpacing) * tickSpacing;
  const maxTick = Math.floor(TickMath.MAX_TICK / tickSpacing) * tickSpacing;
  const clampedLower = Math.max(tickLower, minTick);
  const clampedUpper = Math.min(tickUpper, maxTick);

  if (clampedLower >= clampedUpper) {
    throw new Error(`Invalid range: tickLower ${clampedLower} >= tickUpper ${clampedUpper}`);
  }

  return {
    tickLower: clampedLower,
    tickUpper: clampedUpper,
    tickSpacing,
    priceLower: Math.pow(1.0001, clampedLower),
    priceUpper: Math.pow(1.0001, clampedUpper),
    currentPrice: Math.pow(1.0001, currentTick),
  };
}

export function isInRange(tick: number, tickLower: number, tickUpper: number): boolean {
  return tick >= tickLower && tick < tickUpper;
}

export function rangeUtilization(tick: number, tickLower: number, tickUpper: number): number {
  if (tick < tickLower) return 0;
  if (tick >= tickUpper) return 1;
  return (tick - tickLower) / (tickUpper - tickLower);
}

export function shouldRebalance(
  currentTick: number,
  tickLower: number,
  tickUpper: number,
  thresholdPercent: number,
): boolean {
  const rangeWidth = tickUpper - tickLower;
  const edgeThreshold = rangeWidth * ((100 - thresholdPercent) / 100);

  const distToLower = currentTick - tickLower;
  const distToUpper = tickUpper - currentTick;

  // Out of range
  if (distToLower < 0 || distToUpper <= 0) return true;

  // Approaching boundary (within threshold)
  return distToLower < edgeThreshold || distToUpper < edgeThreshold;
}
