import { BigNumber } from 'ethers';
import JSBI from 'jsbi';
import { PoolEntry } from '../../src/config';
import { PoolState } from '../../src/core/pool-monitor';
import { MintResult, RemoveResult, PositionInfo } from '../../src/core/position-manager';

// ---- Token addresses ----
export const USDT_ADDRESS = '0xdAC17F958D2ee523a2206206994597C13D831ec7';
export const ZCHF_ADDRESS = '0xB58E61C3098d85632Df34EecfB899A1Ed80921cB';
export const NFT_MANAGER_ADDRESS = '0xC36442b4a4522E871399CD717aBDD847Ab11FE88';
export const SWAP_ROUTER_ADDRESS = '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45';
export const WALLET_ADDRESS = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';

// ---- Token decimals ----
export const USDT_DECIMALS = 6;
export const ZCHF_DECIMALS = 18;

// ---- BigNumber amounts ----
export const AMOUNT_100_USDT = BigNumber.from(100_000_000); // 100 * 10^6
export const AMOUNT_100_ZCHF = BigNumber.from('100000000000000000000'); // 100 * 10^18
export const AMOUNT_50_USDT = BigNumber.from(50_000_000);
export const AMOUNT_50_ZCHF = BigNumber.from('50000000000000000000');

// ---- Factory functions ----

export function createPoolEntry(overrides?: Partial<PoolEntry>): PoolEntry {
  return {
    id: 'USDT-ZCHF-100',
    chain: {
      name: 'ethereum',
      chainId: 1,
      rpcUrl: 'http://localhost:8545',
      backupRpcUrls: [],
    },
    pool: {
      token0: { address: USDT_ADDRESS, symbol: 'USDT', decimals: USDT_DECIMALS },
      token1: { address: ZCHF_ADDRESS, symbol: 'ZCHF', decimals: ZCHF_DECIMALS },
      feeTier: 100,
      nftManagerAddress: NFT_MANAGER_ADDRESS,
      swapRouterAddress: SWAP_ROUTER_ADDRESS,
    },
    strategy: {
      rangeWidthPercent: 3,
      rebalanceThresholdPercent: 80,
      minRebalanceIntervalMinutes: 0,
      maxGasCostUsd: 5,
      slippageTolerancePercent: 0.5,
      expectedPriceRatio: 1.0,
      depegThresholdPercent: 5,
    },
    monitoring: {
      checkIntervalSeconds: 30,
    },
    ...overrides,
  } as PoolEntry;
}

export function createPoolState(tick: number): PoolState {
  // sqrtPriceX96 = sqrt(1.0001^tick) * 2^96
  // Use BigInt to avoid floating-point precision issues with large numbers
  const price = Math.pow(1.0001, tick);
  const sqrtPrice = Math.sqrt(price);
  // Multiply by a large integer first, then scale up to avoid scientific notation
  const PRECISION = 1e15;
  const sqrtScaled = BigInt(Math.floor(sqrtPrice * PRECISION));
  const Q96 = BigInt(2) ** BigInt(96);
  const sqrtPriceX96 = (sqrtScaled * Q96) / BigInt(PRECISION);

  return {
    sqrtPriceX96: JSBI.BigInt(sqrtPriceX96.toString()),
    tick,
    liquidity: JSBI.BigInt('1000000000000000000'),
    timestamp: Date.now(),
  };
}

export function createMintResult(tokenId: number): MintResult {
  return {
    tokenId: BigNumber.from(tokenId),
    liquidity: BigNumber.from('1000000000000'),
    amount0: AMOUNT_100_USDT,
    amount1: AMOUNT_100_ZCHF,
  };
}

export function createRemoveResult(): RemoveResult {
  return {
    amount0: AMOUNT_100_USDT,
    amount1: AMOUNT_100_ZCHF,
    fee0: BigNumber.from(1_000_000), // 1 USDT fee
    fee1: BigNumber.from('1000000000000000000'), // 1 ZCHF fee
  };
}

export function createPositionInfo(
  tokenId: number,
  tickLower: number,
  tickUpper: number,
): PositionInfo {
  return {
    tokenId: BigNumber.from(tokenId),
    token0: USDT_ADDRESS,
    token1: ZCHF_ADDRESS,
    fee: 100,
    tickLower,
    tickUpper,
    liquidity: BigNumber.from('1000000000000'),
    tokensOwed0: BigNumber.from(0),
    tokensOwed1: BigNumber.from(0),
  };
}
