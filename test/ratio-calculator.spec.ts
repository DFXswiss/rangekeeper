import { BigNumber } from 'ethers';
import { calculateSwap } from '../src/swap/ratio-calculator';

describe('calculateSwap', () => {
  const USDT = '0xdAC17F958D2ee523a2206206994597C13D831ec7';
  const ZCHF = '0xB58906E27d85EFC9DD6f15A0234dF2e2a23e5847';
  const decimals0 = 6;
  const decimals1 = 18;
  const feeTier = 100;

  it('should return null when balances are zero', () => {
    const result = calculateSwap(
      BigNumber.from(0),
      BigNumber.from(0),
      decimals0,
      decimals1,
      0,
      -100,
      100,
      feeTier,
      USDT,
      ZCHF,
    );
    expect(result).toBeNull();
  });

  it('should return swap when price is below range (need all token0)', () => {
    const balance0 = BigNumber.from(0);
    const balance1 = BigNumber.from('100000000000000000000'); // 100 token1

    const result = calculateSwap(
      balance0,
      balance1,
      decimals0,
      decimals1,
      -200, // current tick below range
      -100,
      100,
      feeTier,
      USDT,
      ZCHF,
    );

    // Price below range → need all token0, so swap token1 → token0
    expect(result).not.toBeNull();
    expect(result!.direction).toBe('token1to0');
    expect(result!.amountIn.gt(0)).toBe(true);
  });

  it('should return swap when price is above range (need all token1)', () => {
    const balance0 = BigNumber.from('100000000'); // 100 USDT
    const balance1 = BigNumber.from(0);

    const result = calculateSwap(
      balance0,
      balance1,
      decimals0,
      decimals1,
      200, // current tick above range
      -100,
      100,
      feeTier,
      USDT,
      ZCHF,
    );

    // Price above range → need all token1, so swap token0 → token1
    expect(result).not.toBeNull();
    expect(result!.direction).toBe('token0to1');
    expect(result!.amountIn.gt(0)).toBe(true);
  });

  it('should return null when ratio difference is small', () => {
    // When already balanced, should return null
    const balance0 = BigNumber.from('50000000'); // 50 USDT
    const balance1 = BigNumber.from('50000000000000000000'); // 50 ZCHF

    const result = calculateSwap(
      balance0,
      balance1,
      decimals0,
      decimals1,
      0, // tick=0, price ~1, centered in range
      -150,
      150,
      feeTier,
      USDT,
      ZCHF,
    );

    // At tick=0 with symmetric range, 50/50 split is approximately correct
    // Either null or very small swap
    if (result !== null) {
      // If there's a swap, it should be relatively small
      const amountNorm = parseFloat(result.amountIn.toString());
      const balance0Norm = 50000000;
      expect(amountNorm / balance0Norm).toBeLessThan(0.1); // less than 10%
    }
  });

  it('should not swap more than available balance', () => {
    const balance0 = BigNumber.from('10000000'); // 10 USDT
    const balance1 = BigNumber.from('1000000000000000000000'); // 1000 ZCHF

    const result = calculateSwap(
      balance0,
      balance1,
      decimals0,
      decimals1,
      0,
      -100,
      100,
      feeTier,
      USDT,
      ZCHF,
    );

    if (result) {
      if (result.direction === 'token0to1') {
        expect(result.amountIn.lte(balance0)).toBe(true);
      } else {
        expect(result.amountIn.lte(balance1)).toBe(true);
      }
    }
  });
});
