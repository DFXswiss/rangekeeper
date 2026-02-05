import { calculateRange, isInRange, rangeUtilization, shouldRebalance } from '../src/core/range-calculator';

describe('calculateRange', () => {
  it('should calculate symmetric range around current tick', () => {
    const currentTick = 0;
    const rangeWidthPercent = 3.0;
    const feeTier = 100; // tickSpacing = 1

    const result = calculateRange(currentTick, rangeWidthPercent, feeTier);

    expect(result.tickLower).toBeLessThan(currentTick);
    expect(result.tickUpper).toBeGreaterThan(currentTick);
    expect(result.tickSpacing).toBe(1);
    expect(result.currentPrice).toBeCloseTo(1.0, 5);
  });

  it('should align ticks to tickSpacing for fee tier 3000', () => {
    const currentTick = 100;
    const rangeWidthPercent = 5.0;
    const feeTier = 3000; // tickSpacing = 60

    const result = calculateRange(currentTick, rangeWidthPercent, feeTier);

    expect(Math.abs(result.tickLower % 60)).toBe(0);
    expect(Math.abs(result.tickUpper % 60)).toBe(0);
    expect(result.tickLower).toBeLessThan(currentTick);
    expect(result.tickUpper).toBeGreaterThan(currentTick);
  });

  it('should align ticks to tickSpacing for fee tier 500', () => {
    const currentTick = 205;
    const rangeWidthPercent = 4.0;
    const feeTier = 500; // tickSpacing = 10

    const result = calculateRange(currentTick, rangeWidthPercent, feeTier);

    expect(result.tickLower % 10).toBe(0);
    expect(result.tickUpper % 10).toBe(0);
  });

  it('should produce wider range for larger rangeWidthPercent', () => {
    const currentTick = 0;
    const feeTier = 100;

    const narrow = calculateRange(currentTick, 2.0, feeTier);
    const wide = calculateRange(currentTick, 5.0, feeTier);

    const narrowWidth = narrow.tickUpper - narrow.tickLower;
    const wideWidth = wide.tickUpper - wide.tickLower;

    expect(wideWidth).toBeGreaterThan(narrowWidth);
  });

  it('should produce correct price bounds', () => {
    const currentTick = 0;
    const rangeWidthPercent = 3.0;
    const feeTier = 100;

    const result = calculateRange(currentTick, rangeWidthPercent, feeTier);

    // Price at tick 0 = 1.0
    expect(result.priceLower).toBeLessThan(1.0);
    expect(result.priceUpper).toBeGreaterThan(1.0);
    // Range width should be approximately 3%
    const actualWidth = ((result.priceUpper - result.priceLower) / result.currentPrice) * 100;
    expect(actualWidth).toBeGreaterThan(2.5);
    expect(actualWidth).toBeLessThan(3.5);
  });

  it('should throw for a range that is too narrow for tick spacing', () => {
    // feeTier 10000 has tickSpacing=200, very narrow range may collapse
    expect(() => calculateRange(0, 0.001, 10000)).toThrow('Invalid range');
  });
});

describe('isInRange', () => {
  it('should return true when tick is within range', () => {
    expect(isInRange(100, 50, 150)).toBe(true);
  });

  it('should return true when tick equals tickLower', () => {
    expect(isInRange(50, 50, 150)).toBe(true);
  });

  it('should return false when tick equals tickUpper', () => {
    expect(isInRange(150, 50, 150)).toBe(false);
  });

  it('should return false when tick is below range', () => {
    expect(isInRange(30, 50, 150)).toBe(false);
  });

  it('should return false when tick is above range', () => {
    expect(isInRange(200, 50, 150)).toBe(false);
  });
});

describe('rangeUtilization', () => {
  it('should return 0 when tick is below range', () => {
    expect(rangeUtilization(30, 50, 150)).toBe(0);
  });

  it('should return 1 when tick is above range', () => {
    expect(rangeUtilization(200, 50, 150)).toBe(1);
  });

  it('should return 0.5 at midpoint', () => {
    expect(rangeUtilization(100, 50, 150)).toBe(0.5);
  });

  it('should return 0 at tickLower', () => {
    expect(rangeUtilization(50, 50, 150)).toBe(0);
  });
});

describe('shouldRebalance', () => {
  it('should return false when tick is in safe zone', () => {
    // threshold=80 means rebalance when 80% through = within 20% of edge
    // range [0, 100], midpoint = safe
    expect(shouldRebalance(50, 0, 100, 80)).toBe(false);
  });

  it('should return true when tick is near lower boundary', () => {
    // range [0, 100], threshold=80, edge zone = 20 ticks from each side
    expect(shouldRebalance(10, 0, 100, 80)).toBe(true);
  });

  it('should return true when tick is near upper boundary', () => {
    expect(shouldRebalance(90, 0, 100, 80)).toBe(true);
  });

  it('should return true when tick is out of range (below)', () => {
    expect(shouldRebalance(-10, 0, 100, 80)).toBe(true);
  });

  it('should return true when tick is out of range (above)', () => {
    expect(shouldRebalance(110, 0, 100, 80)).toBe(true);
  });

  it('should return false when tick is just inside safe zone', () => {
    // edge threshold = 100 * 0.2 = 20 ticks
    expect(shouldRebalance(25, 0, 100, 80)).toBe(false);
  });
});
