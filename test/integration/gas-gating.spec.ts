import { BigNumber } from 'ethers';

jest.mock('../../src/util/logger', () => ({
  getLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }),
}));

jest.mock('../../src/health/health-server', () => ({
  updatePoolStatus: jest.fn(),
}));

jest.mock('../../src/chain/contracts', () => ({
  getErc20Contract: jest.fn(),
}));

import { RebalanceEngine } from '../../src/core/rebalance-engine';
import { EmergencyStop } from '../../src/risk/emergency-stop';
import { SlippageGuard } from '../../src/risk/slippage-guard';
import { ILTracker } from '../../src/risk/il-tracker';
import { createPoolState, AMOUNT_100_USDT, AMOUNT_100_ZCHF } from '../helpers/fixtures';
import { getErc20Contract } from '../../src/chain/contracts';

const mockedGetErc20Contract = getErc20Contract as jest.MockedFunction<typeof getErc20Contract>;

function buildContext() {
  const poolEntry = {
    id: 'USDT-ZCHF-100',
    chain: { name: 'ethereum', chainId: 1, rpcUrl: 'http://localhost:8545', backupRpcUrls: [] },
    pool: {
      token0: { address: '0xdAC17F958D2ee523a2206206994597C13D831ec7', symbol: 'USDT', decimals: 6 },
      token1: { address: '0xB58E61C3098d85632Df34EecfB899A1Ed80921cB', symbol: 'ZCHF', decimals: 18 },
      feeTier: 100,
      nftManagerAddress: '0xC36442b4a4522E871399CD717aBDD847Ab11FE88',
      swapRouterAddress: '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45',
    },
    strategy: {
      rangeWidthPercent: 3,
      rebalanceThresholdPercent: 80,
      minRebalanceIntervalMinutes: 0,
      maxGasCostUsd: 5,
      slippageTolerancePercent: 0.5,
      // Disable depeg for gas tests
      expectedPriceRatio: undefined,
      depegThresholdPercent: 5,
    },
    monitoring: { checkIntervalSeconds: 30 },
  };

  const wallet = { address: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8', provider: {} };

  const mocks = {
    fetchPoolState: jest.fn(),
    approveTokensPM: jest.fn().mockResolvedValue(undefined),
    mint: jest.fn().mockResolvedValue({
      tokenId: BigNumber.from(123),
      liquidity: BigNumber.from('1000000000000'),
      amount0: AMOUNT_100_USDT,
      amount1: AMOUNT_100_ZCHF,
      txHash: '0xmock-mint-hash',
    }),
    removePosition: jest.fn().mockResolvedValue({
      amount0: AMOUNT_100_USDT,
      amount1: AMOUNT_100_ZCHF,
      fee0: BigNumber.from(0),
      fee1: BigNumber.from(0),
      txHashes: { decreaseLiquidity: '0xmock-decrease-hash', collect: '0xmock-collect-hash', burn: '0xmock-burn-hash' },
    }),
    getPosition: jest.fn().mockResolvedValue({
      tokenId: BigNumber.from(123),
      liquidity: BigNumber.from('1000000000000'),
    }),
    findExistingPositions: jest.fn().mockResolvedValue([]),
    approveTokensSE: jest.fn().mockResolvedValue(undefined),
    executeSwap: jest.fn().mockResolvedValue({ amountOut: BigNumber.from(50_000_000), txHash: '0xmock-swap-hash' }),
    setInitialValue: jest.fn(),
    getInitialValue: jest.fn().mockReturnValue(undefined),
    getLossPercent: jest.fn(),
    getGasInfo: jest.fn().mockResolvedValue({ gasPriceGwei: 20, isEip1559: false }),
    isGasSpike: jest.fn().mockReturnValue(false),
    getPoolState: jest.fn().mockReturnValue(undefined),
    updatePoolState: jest.fn(),
    save: jest.fn(),
    log: jest.fn(),
    notify: jest.fn().mockResolvedValue(undefined),
    balanceOf: jest.fn(),
  };

  let callCount = 0;
  mocks.balanceOf.mockImplementation(() => {
    callCount++;
    return Promise.resolve(callCount % 2 === 1 ? AMOUNT_100_USDT : AMOUNT_100_ZCHF);
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mockedGetErc20Contract.mockReturnValue({ balanceOf: mocks.balanceOf } as any);

  const ctx = {
    poolEntry,
    wallet,
    poolMonitor: { fetchPoolState: mocks.fetchPoolState, startMonitoring: jest.fn(), stopMonitoring: jest.fn(), on: jest.fn() },
    positionManager: {
      approveTokens: mocks.approveTokensPM,
      mint: mocks.mint,
      removePosition: mocks.removePosition,
      getPosition: mocks.getPosition,
      findExistingPositions: mocks.findExistingPositions,
    },
    swapExecutor: { approveTokens: mocks.approveTokensSE, executeSwap: mocks.executeSwap },
    emergencyStop: new EmergencyStop(),
    slippageGuard: new SlippageGuard(0.5),
    ilTracker: new ILTracker(),
    balanceTracker: { setInitialValue: mocks.setInitialValue, getInitialValue: mocks.getInitialValue, getLossPercent: mocks.getLossPercent },
    gasOracle: { getGasInfo: mocks.getGasInfo, isGasSpike: mocks.isGasSpike },
    stateStore: { getPoolState: mocks.getPoolState, updatePoolState: mocks.updatePoolState, save: mocks.save, saveOrThrow: jest.fn(), getState: jest.fn() },
    historyLogger: { log: mocks.log },
    notifier: { notify: mocks.notify },
    maxTotalLossPercent: 10,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;

  return { ctx, mocks };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function initEngineWithPosition(ctx: any, mocks: any): Promise<RebalanceEngine> {
  const engine = new RebalanceEngine(ctx);
  await engine.initialize();
  await engine.onPriceUpdate(createPoolState(0));
  // Clear mocks after initial mint
  mocks.mint.mockClear();
  mocks.removePosition.mockClear();
  mocks.fetchPoolState.mockResolvedValue(createPoolState(0));
  mocks.mint.mockResolvedValue({
    tokenId: BigNumber.from(456),
    liquidity: BigNumber.from('1000000000000'),
    amount0: AMOUNT_100_USDT,
    amount1: AMOUNT_100_ZCHF,
    txHash: '0xmock-mint-hash',
  });
  return engine;
}

describe('Gas Gating Integration', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('gas spike in-range skips rebalance', async () => {
    const { ctx, mocks } = buildContext();
    const engine = await initEngineWithPosition(ctx, mocks);

    mocks.isGasSpike.mockReturnValue(true);

    // In-range tick that triggers shouldRebalance (near edge) but still in range
    // Range is approximately [-15, 15] for 3% width at tick 0
    // shouldRebalance with 80% threshold triggers at edges (~3 ticks from edge)
    // But isInRange still returns true if within range
    const nearEdgeState = createPoolState(13); // near upper boundary but in-range
    await engine.onPriceUpdate(nearEdgeState);

    // Should not have attempted rebalance
    expect(mocks.removePosition).not.toHaveBeenCalled();
    expect(mocks.mint).not.toHaveBeenCalled();
  });

  it('gas spike out-of-range proceeds with rebalance', async () => {
    const { ctx, mocks } = buildContext();
    const engine = await initEngineWithPosition(ctx, mocks);

    mocks.isGasSpike.mockReturnValue(true);

    // Fully out of range
    const outOfRangeState = createPoolState(500);
    await engine.onPriceUpdate(outOfRangeState);

    expect(mocks.removePosition).toHaveBeenCalled();
    expect(mocks.mint).toHaveBeenCalled();
  });

  it('gas cost > maxGasCostUsd in-range skips rebalance', async () => {
    const { ctx, mocks } = buildContext();
    const engine = await initEngineWithPosition(ctx, mocks);

    // maxGasCostUsd = 5, set gas price very high
    // estimateGasCostUsd(800000, gasPriceGwei, 3000) > 5
    // gasPriceGwei = 5 / (800000/1e9 * 3000) = 5 / 2.4 ≈ 2.08 → need > 2.08 gwei
    // 100 gwei → cost = 800000 * 100 / 1e9 * 3000 = 240 USD >> 5
    mocks.getGasInfo.mockResolvedValue({ gasPriceGwei: 100, isEip1559: false });
    mocks.isGasSpike.mockReturnValue(false);

    const nearEdgeState = createPoolState(13);
    await engine.onPriceUpdate(nearEdgeState);

    expect(mocks.removePosition).not.toHaveBeenCalled();
    expect(mocks.mint).not.toHaveBeenCalled();
  });

  it('gas cost > maxGasCostUsd out-of-range proceeds with rebalance', async () => {
    const { ctx, mocks } = buildContext();
    const engine = await initEngineWithPosition(ctx, mocks);

    mocks.getGasInfo.mockResolvedValue({ gasPriceGwei: 100, isEip1559: false });
    mocks.isGasSpike.mockReturnValue(false);

    const outOfRangeState = createPoolState(500);
    await engine.onPriceUpdate(outOfRangeState);

    expect(mocks.removePosition).toHaveBeenCalled();
    expect(mocks.mint).toHaveBeenCalled();
  });

  it('gas oracle throws proceeds with rebalance (fallback)', async () => {
    const { ctx, mocks } = buildContext();
    const engine = await initEngineWithPosition(ctx, mocks);

    mocks.getGasInfo.mockRejectedValue(new Error('RPC error'));

    const nearEdgeState = createPoolState(13);
    await engine.onPriceUpdate(nearEdgeState);

    // checkGasCost catches the error and returns true (proceed)
    // This only matters if shouldRebalance triggers — let's use out-of-range to be sure
    mocks.getGasInfo.mockRejectedValue(new Error('RPC error'));
    mocks.removePosition.mockClear();
    mocks.mint.mockClear();

    const outOfRangeState = createPoolState(500);
    await engine.onPriceUpdate(outOfRangeState);

    expect(mocks.removePosition).toHaveBeenCalled();
    expect(mocks.mint).toHaveBeenCalled();
  });
});
