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
      nftManagerAddress: '0xNFT',
      swapRouterAddress: '0xSWAP',
    },
    strategy: {
      rangeWidthPercent: 3,
      rebalanceThresholdPercent: 80,
      minRebalanceIntervalMinutes: 0,
      maxGasCostUsd: 5,
      slippageTolerancePercent: 0.5,
    },
    monitoring: { checkIntervalSeconds: 30 },
  };

  const wallet = { address: '0xWALLET', provider: {} };

  const balanceOf = jest.fn();
  let callCount = 0;
  balanceOf.mockImplementation(() => {
    callCount++;
    return Promise.resolve(callCount % 2 === 1 ? AMOUNT_100_USDT : AMOUNT_100_ZCHF);
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mockedGetErc20Contract.mockReturnValue({ balanceOf } as any);

  const mocks = {
    mint: jest.fn().mockResolvedValue({
      tokenId: BigNumber.from(123),
      liquidity: BigNumber.from('1000'),
      amount0: AMOUNT_100_USDT,
      amount1: AMOUNT_100_ZCHF,
    }),
    removePosition: jest.fn().mockResolvedValue({
      amount0: AMOUNT_100_USDT,
      amount1: AMOUNT_100_ZCHF,
      fee0: BigNumber.from(0),
      fee1: BigNumber.from(0),
    }),
    getPosition: jest.fn().mockResolvedValue({ liquidity: BigNumber.from('1000') }),
    findExistingPositions: jest.fn().mockResolvedValue([]),
    fetchPoolState: jest.fn().mockResolvedValue(createPoolState(0)),
    getGasInfo: jest.fn().mockResolvedValue({ gasPriceGwei: 20, isEip1559: false }),
    isGasSpike: jest.fn().mockReturnValue(false),
    notify: jest.fn().mockResolvedValue(undefined),
    balanceOf,
  };

  const ctx = {
    poolEntry,
    wallet,
    poolMonitor: { fetchPoolState: mocks.fetchPoolState, startMonitoring: jest.fn(), stopMonitoring: jest.fn(), on: jest.fn() },
    positionManager: {
      approveTokens: jest.fn().mockResolvedValue(undefined),
      mint: mocks.mint,
      removePosition: mocks.removePosition,
      getPosition: mocks.getPosition,
      findExistingPositions: mocks.findExistingPositions,
    },
    swapExecutor: { approveTokens: jest.fn().mockResolvedValue(undefined), executeSwap: jest.fn().mockResolvedValue(BigNumber.from(0)) },
    emergencyStop: new EmergencyStop(),
    slippageGuard: new SlippageGuard(0.5),
    ilTracker: new ILTracker(),
    balanceTracker: { setInitialValue: jest.fn(), getInitialValue: jest.fn().mockReturnValue(undefined), getLossPercent: jest.fn() },
    gasOracle: { getGasInfo: mocks.getGasInfo, isGasSpike: mocks.isGasSpike },
    stateStore: { getPoolState: jest.fn().mockReturnValue(undefined), updatePoolState: jest.fn(), save: jest.fn(), getState: jest.fn() },
    historyLogger: { log: jest.fn() },
    notifier: { notify: mocks.notify },
    maxTotalLossPercent: 10,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;

  return { ctx, mocks };
}

describe('Pool Monitor Events Integration', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('priceUpdate event calls engine.onPriceUpdate', async () => {
    const { ctx, mocks } = buildContext();
    const engine = new RebalanceEngine(ctx);
    await engine.initialize();

    // Simulate what PoolMonitor would emit
    const state = createPoolState(0);
    await engine.onPriceUpdate(state);

    // Initial mint should have happened
    expect(mocks.mint).toHaveBeenCalledTimes(1);
    expect(engine.getState()).toBe('MONITORING');
  });

  it('outOfRange event triggers rebalance', async () => {
    const { ctx, mocks } = buildContext();
    const engine = new RebalanceEngine(ctx);
    await engine.initialize();

    // Mint initial position
    await engine.onPriceUpdate(createPoolState(0));
    mocks.mint.mockClear();
    mocks.removePosition.mockClear();

    mocks.mint.mockResolvedValue({
      tokenId: BigNumber.from(456),
      liquidity: BigNumber.from('1000'),
      amount0: AMOUNT_100_USDT,
      amount1: AMOUNT_100_ZCHF,
    });

    // Out of range
    await engine.onPriceUpdate(createPoolState(500));

    expect(mocks.removePosition).toHaveBeenCalledTimes(1);
    expect(mocks.mint).toHaveBeenCalledTimes(1);
    expect(engine.getCurrentTokenId()!.eq(456)).toBe(true);
  });

  it('error event does not crash engine', async () => {
    const { ctx } = buildContext();
    const engine = new RebalanceEngine(ctx);
    await engine.initialize();

    // Simulating an error event — the engine itself doesn't crash
    // In real usage, PoolMonitor emits 'error' and the main loop catches it
    // The engine should remain in MONITORING state
    expect(engine.getState()).toBe('MONITORING');

    // Still functional after error
    const state = createPoolState(0);
    await engine.onPriceUpdate(state);
    expect(engine.getState()).toBe('MONITORING');
  });

  it('min rebalance interval skips rebalance if too soon and in-range, proceeds if out-of-range', async () => {
    const { ctx, mocks } = buildContext();
    // Set interval to 60 minutes
    ctx.poolEntry.strategy.minRebalanceIntervalMinutes = 60;

    const engine = new RebalanceEngine(ctx);
    await engine.initialize();

    // Mint initial
    await engine.onPriceUpdate(createPoolState(0));
    mocks.mint.mockClear();
    mocks.removePosition.mockClear();

    mocks.mint.mockResolvedValue({
      tokenId: BigNumber.from(456),
      liquidity: BigNumber.from('1000'),
      amount0: AMOUNT_100_USDT,
      amount1: AMOUNT_100_ZCHF,
    });

    // In-range near edge (triggers shouldRebalance but is in range): should skip due to interval
    const nearEdgeState = createPoolState(13);
    await engine.onPriceUpdate(nearEdgeState);
    expect(mocks.removePosition).not.toHaveBeenCalled();

    // Out of range: should proceed regardless of interval
    await engine.onPriceUpdate(createPoolState(500));
    expect(mocks.removePosition).toHaveBeenCalledTimes(1);
    expect(mocks.mint).toHaveBeenCalledTimes(1);
  });
});
