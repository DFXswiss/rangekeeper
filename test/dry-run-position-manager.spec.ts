import { BigNumber, Wallet } from 'ethers';
import { DryRunPositionManager } from '../src/core/dry-run-position-manager';
import { MintParams } from '../src/core/position-manager';

// Suppress pino logs during tests
jest.mock('../src/util/logger', () => ({
  getLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }),
}));

describe('DryRunPositionManager', () => {
  let manager: DryRunPositionManager;
  const mockWallet = { address: '0xWALLET' } as unknown as Wallet;

  beforeEach(() => {
    manager = new DryRunPositionManager(() => mockWallet, '0xNFT_MANAGER');
  });

  const baseMintParams: MintParams = {
    token0: '0xTOKEN0',
    token1: '0xTOKEN1',
    fee: 500,
    tickLower: -100,
    tickUpper: 100,
    amount0Desired: BigNumber.from('1000000'),
    amount1Desired: BigNumber.from('2000000'),
    slippagePercent: 0.5,
    recipient: '0xWALLET',
  };

  describe('approveTokens', () => {
    it('should not throw and not call on-chain approval', async () => {
      await expect(manager.approveTokens('0xTOKEN0', '0xTOKEN1')).resolves.toBeUndefined();
    });
  });

  describe('mint', () => {
    it('should return a virtual position with tokenId >= 900_000_000 and txHash', async () => {
      const result = await manager.mint(baseMintParams);
      expect(result.tokenId.gte(900_000_000)).toBe(true);
      expect(result.amount0.eq(baseMintParams.amount0Desired)).toBe(true);
      expect(result.amount1.eq(baseMintParams.amount1Desired)).toBe(true);
      expect(result.liquidity.eq(baseMintParams.amount0Desired.add(baseMintParams.amount1Desired))).toBe(true);
      expect(result.txHash).toMatch(/^dry-run-mint-/);
    });

    it('should assign incrementing tokenIds', async () => {
      const r1 = await manager.mint(baseMintParams);
      const r2 = await manager.mint(baseMintParams);
      expect(r2.tokenId.sub(r1.tokenId).eq(1)).toBe(true);
    });

    it('should store virtual positions retrievable via getVirtualPositions', async () => {
      await manager.mint(baseMintParams);
      await manager.mint(baseMintParams);
      expect(manager.getVirtualPositions()).toHaveLength(2);
    });
  });

  describe('getPosition', () => {
    it('should return virtual position data for minted positions', async () => {
      const mintResult = await manager.mint(baseMintParams);
      const pos = await manager.getPosition(mintResult.tokenId);

      expect(pos.tokenId.eq(mintResult.tokenId)).toBe(true);
      expect(pos.token0).toBe('0xTOKEN0');
      expect(pos.token1).toBe('0xTOKEN1');
      expect(pos.fee).toBe(500);
      expect(pos.tickLower).toBe(-100);
      expect(pos.tickUpper).toBe(100);
      expect(pos.liquidity.eq(mintResult.liquidity)).toBe(true);
      expect(pos.tokensOwed0.eq(0)).toBe(true);
      expect(pos.tokensOwed1.eq(0)).toBe(true);
    });
  });

  describe('removePosition', () => {
    it('should remove a virtual position and return its amounts with txHashes', async () => {
      const mintResult = await manager.mint(baseMintParams);
      const removeResult = await manager.removePosition(mintResult.tokenId, mintResult.liquidity, 0.5);

      expect(removeResult.amount0.eq(baseMintParams.amount0Desired)).toBe(true);
      expect(removeResult.amount1.eq(baseMintParams.amount1Desired)).toBe(true);
      expect(removeResult.fee0.eq(0)).toBe(true);
      expect(removeResult.fee1.eq(0)).toBe(true);
      expect(removeResult.txHashes.decreaseLiquidity).toMatch(/^dry-run-decrease-/);
      expect(removeResult.txHashes.collect).toMatch(/^dry-run-collect-/);
      expect(removeResult.txHashes.burn).toMatch(/^dry-run-burn-/);
      expect(manager.getVirtualPositions()).toHaveLength(0);
    });

    it('should not find a removed virtual position via getVirtualPositions', async () => {
      const r1 = await manager.mint(baseMintParams);
      const r2 = await manager.mint(baseMintParams);
      await manager.removePosition(r1.tokenId, r1.liquidity, 0.5);

      const remaining = manager.getVirtualPositions();
      expect(remaining).toHaveLength(1);
      expect(remaining[0].tokenId.eq(r2.tokenId)).toBe(true);
    });
  });
});
