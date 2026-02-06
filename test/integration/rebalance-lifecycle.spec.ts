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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function buildContext(overrides: Record<string, any> = {}) {
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
      expectedPriceRatio: 1.0,
      depegThresholdPercent: 5,
    },
    monitoring: { checkIntervalSeconds: 30 },
  };

  const wallet = {
    address: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
    provider: {},
  };

  const mocks = {
    fetchPoolState: jest.fn(),
    startMonitoring: jest.fn(),
    stopMonitoring: jest.fn(),
    updatePositionRange: jest.fn(),
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
      fee0: BigNumber.from(1_000_000),
      fee1: BigNumber.from('1000000000000000000'),
      txHashes: { decreaseLiquidity: '0xmock-decrease-hash', collect: '0xmock-collect-hash', burn: '0xmock-burn-hash' },
    }),
    getPosition: jest.fn().mockResolvedValue({
      tokenId: BigNumber.from(123),
      liquidity: BigNumber.from('1000000000000'),
      tokensOwed0: BigNumber.from(0),
      tokensOwed1: BigNumber.from(0),
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
    getState: jest.fn(),
    log: jest.fn(),
    notify: jest.fn().mockResolvedValue(undefined),
    balanceOf: jest.fn().mockResolvedValue(AMOUNT_100_USDT),
  };

  // Setup ERC20 mock
  mockedGetErc20Contract.mockReturnValue({
    balanceOf: mocks.balanceOf,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);

  // By default, alternate between USDT and ZCHF balances
  let callCount = 0;
  mocks.balanceOf.mockImplementation(() => {
    callCount++;
    return Promise.resolve(callCount % 2 === 1 ? AMOUNT_100_USDT : AMOUNT_100_ZCHF);
  });

  const ctx = {
    poolEntry: overrides.poolEntry ?? poolEntry,
    wallet: overrides.wallet ?? wallet,
    poolMonitor: {
      fetchPoolState: mocks.fetchPoolState,
      startMonitoring: mocks.startMonitoring,
      stopMonitoring: mocks.stopMonitoring,
      updatePositionRange: mocks.updatePositionRange,
      on: jest.fn(),
      emit: jest.fn(),
    },
    positionManager: {
      approveTokens: mocks.approveTokensPM,
      mint: mocks.mint,
      removePosition: mocks.removePosition,
      getPosition: mocks.getPosition,
      findExistingPositions: mocks.findExistingPositions,
    },
    swapExecutor: {
      approveTokens: mocks.approveTokensSE,
      executeSwap: mocks.executeSwap,
    },
    emergencyStop: new EmergencyStop(),
    slippageGuard: new SlippageGuard(0.5),
    ilTracker: new ILTracker(),
    balanceTracker: {
      setInitialValue: mocks.setInitialValue,
      getInitialValue: mocks.getInitialValue,
      getLossPercent: mocks.getLossPercent,
    },
    gasOracle: {
      getGasInfo: mocks.getGasInfo,
      isGasSpike: mocks.isGasSpike,
    },
    stateStore: {
      getPoolState: mocks.getPoolState,
      updatePoolState: mocks.updatePoolState,
      save: mocks.save,
      saveOrThrow: jest.fn(),
      getState: mocks.getState,
    },
    historyLogger: { log: mocks.log },
    notifier: { notify: mocks.notify },
    maxTotalLossPercent: 10,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;

  return { ctx, mocks };
}

describe('Rebalance Lifecycle Integration', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('initialize() without saved state or on-chain position sets state=MONITORING and calls approvals', async () => {
    const { ctx, mocks } = buildContext();
    const engine = new RebalanceEngine(ctx);

    await engine.initialize();

    expect(engine.getState()).toBe('MONITORING');
    expect(mocks.approveTokensPM).toHaveBeenCalledTimes(1);
    expect(mocks.approveTokensSE).toHaveBeenCalledTimes(1);
    expect(mocks.findExistingPositions).toHaveBeenCalledTimes(1);
    expect(engine.getCurrentTokenId()).toBeUndefined();
  });

  it('initialize() with saved state restores tokenId and range without findExisting call', async () => {
    const { ctx, mocks } = buildContext();
    mocks.getPoolState.mockReturnValue({
      tokenId: '456',
      tickLower: -10,
      tickUpper: 10,
      lastRebalanceTime: Date.now() - 60000,
    });

    const engine = new RebalanceEngine(ctx);
    await engine.initialize();

    expect(engine.getState()).toBe('MONITORING');
    expect(engine.getCurrentTokenId()!.eq(456)).toBe(true);
    expect(engine.getCurrentRange()).toEqual({ tickLower: -10, tickUpper: 10 });
    expect(mocks.findExistingPositions).not.toHaveBeenCalled();
  });

  it('initialize() finds on-chain position and sets tokenId from chain', async () => {
    const { ctx, mocks } = buildContext();
    mocks.findExistingPositions.mockResolvedValue([
      {
        tokenId: BigNumber.from(789),
        tickLower: -20,
        tickUpper: 20,
        liquidity: BigNumber.from('5000000'),
      },
    ]);

    const engine = new RebalanceEngine(ctx);
    await engine.initialize();

    expect(engine.getState()).toBe('MONITORING');
    expect(engine.getCurrentTokenId()!.eq(789)).toBe(true);
    expect(engine.getCurrentRange()).toEqual({ tickLower: -20, tickUpper: 20 });
  });

  it('onPriceUpdate with no position mints initial, state goes MINTING then MONITORING', async () => {
    const { ctx, mocks } = buildContext();
    const engine = new RebalanceEngine(ctx);
    await engine.initialize();

    const poolState = createPoolState(0); // tick=0, price ~1.0
    await engine.onPriceUpdate(poolState);

    expect(mocks.mint).toHaveBeenCalledTimes(1);
    expect(engine.getState()).toBe('MONITORING');
    expect(engine.getCurrentTokenId()!.eq(123)).toBe(true);
  });

  it('initial mint persists state, logs history(MINT), sends notification, sets IL entry', async () => {
    const { ctx, mocks } = buildContext();
    const engine = new RebalanceEngine(ctx);
    await engine.initialize();

    const poolState = createPoolState(0);
    await engine.onPriceUpdate(poolState);

    // State persisted
    expect(mocks.updatePoolState).toHaveBeenCalled();
    expect(mocks.save).toHaveBeenCalled();

    // History logged with MINT type
    expect(mocks.log).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'MINT', poolId: 'USDT-ZCHF-100' }),
    );

    // Notification sent
    expect(mocks.notify).toHaveBeenCalledWith(expect.stringContaining('Initial position minted'));

    // IL entry set via balanceTracker
    expect(mocks.setInitialValue).toHaveBeenCalled();
  });

  it('onPriceUpdate out-of-range triggers full rebalance cycle', async () => {
    const { ctx, mocks } = buildContext();
    const engine = new RebalanceEngine(ctx);
    await engine.initialize();

    // First: mint initial position at tick=0
    const initialState = createPoolState(0);
    await engine.onPriceUpdate(initialState);

    expect(engine.getCurrentTokenId()!.eq(123)).toBe(true);

    // Reset call counts
    mocks.mint.mockClear();
    mocks.removePosition.mockClear();
    mocks.log.mockClear();
    mocks.notify.mockClear();
    mocks.updatePoolState.mockClear();
    mocks.save.mockClear();

    // Prepare mocks for rebalance: new mint returns tokenId=456
    mocks.mint.mockResolvedValue({
      tokenId: BigNumber.from(456),
      liquidity: BigNumber.from('1000000000000'),
      amount0: AMOUNT_100_USDT,
      amount1: AMOUNT_100_ZCHF,
      txHash: '0xmock-mint-hash',
    });
    mocks.fetchPoolState.mockResolvedValue(createPoolState(0));

    // Trigger out-of-range: tick=400 is out of [-148,148] but within 5% depeg threshold
    const outOfRangeState = createPoolState(200);
    await engine.onPriceUpdate(outOfRangeState);

    // Full rebalance should have occurred
    expect(mocks.removePosition).toHaveBeenCalledTimes(1);
    expect(mocks.fetchPoolState).toHaveBeenCalledTimes(1); // fresh state
    expect(mocks.mint).toHaveBeenCalledTimes(1);
    expect(engine.getCurrentTokenId()!.eq(456)).toBe(true);
    expect(engine.getState()).toBe('MONITORING');
  });

  it('rebalance cycle removes old position, fetches fresh state, mints new position', async () => {
    const { ctx, mocks } = buildContext();
    const engine = new RebalanceEngine(ctx);
    await engine.initialize();

    // Mint initial
    await engine.onPriceUpdate(createPoolState(0));

    const callOrder: string[] = [];
    mocks.removePosition.mockImplementation(async () => {
      callOrder.push('remove');
      return { amount0: AMOUNT_100_USDT, amount1: AMOUNT_100_ZCHF, fee0: BigNumber.from(0), fee1: BigNumber.from(0), txHashes: { decreaseLiquidity: '0xmock-decrease-hash', collect: '0xmock-collect-hash', burn: '0xmock-burn-hash' } };
    });
    mocks.fetchPoolState.mockImplementation(async () => {
      callOrder.push('fetchFreshState');
      return createPoolState(0);
    });
    mocks.mint.mockImplementation(async () => {
      callOrder.push('mint');
      return { tokenId: BigNumber.from(456), liquidity: BigNumber.from('1000'), amount0: AMOUNT_100_USDT, amount1: AMOUNT_100_ZCHF, txHash: '0xmock-mint-hash' };
    });

    // Out-of-range triggers rebalance
    await engine.onPriceUpdate(createPoolState(200));

    expect(callOrder).toEqual(['remove', 'fetchFreshState', 'mint']);
  });

  it('rebalance persists state, logs history(REBALANCE) with fees and IL, sends notification', async () => {
    const { ctx, mocks } = buildContext();
    const engine = new RebalanceEngine(ctx);
    await engine.initialize();

    await engine.onPriceUpdate(createPoolState(0));

    mocks.log.mockClear();
    mocks.notify.mockClear();
    mocks.updatePoolState.mockClear();
    mocks.save.mockClear();

    mocks.fetchPoolState.mockResolvedValue(createPoolState(0));
    mocks.mint.mockResolvedValue({
      tokenId: BigNumber.from(456),
      liquidity: BigNumber.from('1000000000000'),
      amount0: AMOUNT_100_USDT,
      amount1: AMOUNT_100_ZCHF,
      txHash: '0xmock-mint-hash',
    });

    await engine.onPriceUpdate(createPoolState(200));

    // State persisted
    expect(mocks.updatePoolState).toHaveBeenCalled();
    expect(mocks.save).toHaveBeenCalled();

    // History logged
    expect(mocks.log).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'REBALANCE',
        poolId: 'USDT-ZCHF-100',
        tokenId: '456',
      }),
    );

    // Notification sent
    expect(mocks.notify).toHaveBeenCalledWith(expect.stringContaining('Rebalance completed'));
  });
});
