import { BigNumber, Wallet } from 'ethers';
import { DryRunSwapExecutor } from '../src/swap/dry-run-swap-executor';

// Suppress pino logs during tests
jest.mock('../src/util/logger', () => ({
  getLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }),
}));

describe('DryRunSwapExecutor', () => {
  let executor: DryRunSwapExecutor;
  const mockWallet = { address: '0xWALLET' } as unknown as Wallet;

  beforeEach(() => {
    executor = new DryRunSwapExecutor(() => mockWallet, '0xSWAP_ROUTER');
  });

  describe('approveTokens', () => {
    it('should not throw and not call on-chain approval', async () => {
      await expect(executor.approveTokens('0xTOKEN0', '0xTOKEN1')).resolves.toBeUndefined();
    });
  });

  describe('executeSwap', () => {
    it('should deduct pool fee from amountIn (500 = 0.05%)', async () => {
      const amountIn = BigNumber.from('1000000'); // 1 USDC (6 decimals)
      const result = await executor.executeSwap('0xIN', '0xOUT', 500, amountIn, 0.5);

      // amountOut = 1000000 * (1000000 - 500) / 1000000 = 999500
      expect(result.eq(BigNumber.from('999500'))).toBe(true);
    });

    it('should deduct pool fee (3000 = 0.3%)', async () => {
      const amountIn = BigNumber.from('1000000000'); // 1000 USDC
      const result = await executor.executeSwap('0xIN', '0xOUT', 3000, amountIn, 0.5);

      // amountOut = 1000000000 * (1000000 - 3000) / 1000000 = 997000000
      expect(result.eq(BigNumber.from('997000000'))).toBe(true);
    });

    it('should deduct pool fee (10000 = 1%)', async () => {
      const amountIn = BigNumber.from('10000000');
      const result = await executor.executeSwap('0xIN', '0xOUT', 10000, amountIn, 1);

      // amountOut = 10000000 * (1000000 - 10000) / 1000000 = 9900000
      expect(result.eq(BigNumber.from('9900000'))).toBe(true);
    });

    it('should handle zero amountIn', async () => {
      const result = await executor.executeSwap('0xIN', '0xOUT', 500, BigNumber.from(0), 0.5);
      expect(result.eq(0)).toBe(true);
    });

    it('should handle fee tier of 100 (0.01%)', async () => {
      const amountIn = BigNumber.from('10000000');
      const result = await executor.executeSwap('0xIN', '0xOUT', 100, amountIn, 0.5);

      // amountOut = 10000000 * (1000000 - 100) / 1000000 = 9999000
      expect(result.eq(BigNumber.from('9999000'))).toBe(true);
    });
  });
});
