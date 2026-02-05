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

  const wallet = { address: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8', provider: {} };
  const emergencyStop = new EmergencyStop();

  const mocks = {
    fetchPoolState: jest.fn(),
    approveTokensPM: jest.fn().mockResolvedValue(undefined),
    mint: jest.fn().mockResolvedValue({
      tokenId: BigNumber.from(123),
      liquidity: BigNumber.from('1000000000000'),
      amount0: AMOUNT_100_USDT,
      amount1: AMOUNT_100_ZCHF,
    }),
    removePosition: jest.fn().mockResolvedValue({
      amount0: AMOUNT_100_USDT,
      amount1: AMOUNT_100_ZCHF,
      fee0: BigNumber.from(0),
      fee1: BigNumber.from(0),
    }),
    getPosition: jest.fn().mockResolvedValue({
      tokenId: BigNumber.from(123),
      liquidity: BigNumber.from('1000000000000'),
      tokensOwed0: BigNumber.from(0),
      tokensOwed1: BigNumber.from(0),
    }),
    findExistingPositions: jest.fn().mockResolvedValue([]),
    approveTokensSE: jest.fn().mockResolvedValue(undefined),
    executeSwap: jest.fn().mockResolvedValue(BigNumber.from(50_000_000)),
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
    poolMonitor: {
      fetchPoolState: mocks.fetchPoolState,
      startMonitoring: jest.fn(),
      stopMonitoring: jest.fn(),
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
    emergencyStop,
    slippageGuard: new SlippageGuard(0.5),
    ilTracker: new ILTracker(),
    balanceTracker: {
      setInitialValue: mocks.setInitialValue,
      getInitialValue: mocks.getInitialValue,
      getLossPercent: mocks.getLossPercent,
    },
    gasOracle: { getGasInfo: mocks.getGasInfo, isGasSpike: mocks.isGasSpike },
    stateStore: { getPoolState: mocks.getPoolState, updatePoolState: mocks.updatePoolState, save: mocks.save, getState: mocks.getState },
    historyLogger: { log: mocks.log },
    notifier: { notify: mocks.notify },
    maxTotalLossPercent: 10,
    ...overrides,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;

  return { ctx, mocks, emergencyStop };
}

describe('Emergency Scenarios Integration', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('depeg detected triggers emergency withdraw and state=STOPPED', async () => {
    const { ctx, mocks, emergencyStop } = buildContext();
    const engine = new RebalanceEngine(ctx);
    await engine.initialize();

    // Mint initial position at tick=0
    await engine.onPriceUpdate(createPoolState(0));
    expect(engine.getCurrentTokenId()!.eq(123)).toBe(true);

    // Depeg: tick corresponding to price deviation > 5% from 1.0
    // tick ~= ln(price) / ln(1.0001); for price=1.06, tick ~= 582
    const depegState = createPoolState(600);
    await engine.onPriceUpdate(depegState);

    // Wait for async emergency withdraw
    await new Promise((r) => setTimeout(r, 50));

    expect(emergencyStop.isStopped()).toBe(true);
    expect(engine.getState()).toBe('STOPPED');
    expect(mocks.notify).toHaveBeenCalledWith(expect.stringContaining('DEPEG'));
  });

  it('depeg with no open position triggers emergency stop without withdraw attempt', async () => {
    const { ctx, mocks, emergencyStop } = buildContext();
    const engine = new RebalanceEngine(ctx);
    await engine.initialize();

    // No position minted - send depeg price directly
    const depegState = createPoolState(600);
    await engine.onPriceUpdate(depegState);

    await new Promise((r) => setTimeout(r, 50));

    expect(emergencyStop.isStopped()).toBe(true);
    // emergencyWithdraw returns early when no position, so state stays MONITORING
    // but emergency stop flag is set, preventing further operations
    expect(mocks.removePosition).not.toHaveBeenCalled();
    expect(mocks.notify).toHaveBeenCalledWith(expect.stringContaining('DEPEG'));
  });

  it('depeg emergency withdraw failure sends CRITICAL notification, state=STOPPED', async () => {
    const { ctx, mocks } = buildContext();
    const engine = new RebalanceEngine(ctx);
    await engine.initialize();

    // Mint initial position
    await engine.onPriceUpdate(createPoolState(0));

    // Make getPosition fail during emergency withdraw
    mocks.getPosition.mockRejectedValue(new Error('RPC unavailable'));

    const depegState = createPoolState(600);
    await engine.onPriceUpdate(depegState);

    await new Promise((r) => setTimeout(r, 50));

    expect(engine.getState()).toBe('STOPPED');
    expect(mocks.notify).toHaveBeenCalledWith(expect.stringContaining('CRITICAL'));
  });

  it('3 consecutive mint errors trigger state=ERROR and emergency stop', async () => {
    const { ctx, mocks, emergencyStop } = buildContext();
    const engine = new RebalanceEngine(ctx);

    // Disable depeg check for this test
    ctx.poolEntry.strategy.expectedPriceRatio = undefined;

    await engine.initialize();

    // Make mint fail
    mocks.mint.mockRejectedValue(new Error('Mint failed'));

    // 3 consecutive failures
    await engine.onPriceUpdate(createPoolState(0));
    expect(engine.getState()).toBe('MONITORING'); // 1 error, recovers

    await engine.onPriceUpdate(createPoolState(0));
    expect(engine.getState()).toBe('MONITORING'); // 2 errors, recovers

    await engine.onPriceUpdate(createPoolState(0));
    expect(engine.getState()).toBe('ERROR'); // 3 errors → ERROR

    expect(emergencyStop.isStopped()).toBe(true);
    expect(mocks.notify).toHaveBeenCalledWith(expect.stringContaining('stopped after 3 errors'));
  });

  it('portfolio loss > maxTotalLossPercent triggers emergency withdraw + notification', async () => {
    const { ctx, mocks } = buildContext();
    const engine = new RebalanceEngine(ctx);
    ctx.poolEntry.strategy.expectedPriceRatio = undefined;

    await engine.initialize();

    // Mint initial position with normal amounts
    await engine.onPriceUpdate(createPoolState(0));

    // Set a high initial value to simulate accumulated losses
    // Current balances will show ~80 value while initial was 1000
    mocks.getInitialValue.mockReturnValue(1000);

    // Reset for rebalance
    mocks.mint.mockClear();
    mocks.fetchPoolState.mockResolvedValue(createPoolState(0));

    // Mock new mint result with small amounts
    const smallAmount = BigNumber.from(40_000_000); // 40 USDT
    mocks.mint.mockResolvedValue({
      tokenId: BigNumber.from(456),
      liquidity: BigNumber.from('1000000000000'),
      amount0: smallAmount,
      amount1: smallAmount,
    });

    // For pre and post rebalance: return same low amounts
    // This keeps single-rebalance loss at 0% but total portfolio loss > 10%
    // Pre-value: 40 * price + 40 ≈ 80; post-value: same 80
    // Portfolio loss: (1000-80)/1000 = 92% >> 10%
    mocks.balanceOf.mockResolvedValue(smallAmount);

    // Trigger rebalance (tick=200 is out of range [-148, 148])
    await engine.onPriceUpdate(createPoolState(200));

    expect(engine.getState()).toBe('STOPPED');
    expect(mocks.notify).toHaveBeenCalledWith(expect.stringContaining('Portfolio loss limit'));
  });

  it('rebalance loss > 2% triggers state=STOPPED', async () => {
    const { ctx, mocks } = buildContext();
    const engine = new RebalanceEngine(ctx);
    ctx.poolEntry.strategy.expectedPriceRatio = undefined;

    await engine.initialize();

    // Mint initial position with high balances
    let callIdx = 0;
    mocks.balanceOf.mockImplementation(() => {
      callIdx++;
      // First 2 calls: initial mint (high balances)
      if (callIdx <= 4) {
        return Promise.resolve(callIdx % 2 === 1 ? AMOUNT_100_USDT : AMOUNT_100_ZCHF);
      }
      // Pre-rebalance check: high balances
      if (callIdx <= 6) {
        return Promise.resolve(callIdx % 2 === 1 ? AMOUNT_100_USDT : AMOUNT_100_ZCHF);
      }
      // Post-withdraw+swap: very low balances (simulating loss)
      return Promise.resolve(BigNumber.from(100_000)); // ~0.1 USDT
    });

    await engine.onPriceUpdate(createPoolState(0));

    mocks.fetchPoolState.mockResolvedValue(createPoolState(0));
    mocks.mint.mockResolvedValue({
      tokenId: BigNumber.from(456),
      liquidity: BigNumber.from('1000'),
      amount0: BigNumber.from(100_000),
      amount1: BigNumber.from(100_000),
    });

    // Trigger out-of-range rebalance
    await engine.onPriceUpdate(createPoolState(500));

    expect(engine.getState()).toBe('STOPPED');
    expect(mocks.notify).toHaveBeenCalledWith(expect.stringContaining('Rebalance loss too high'));
  });

  it('error recovery: 2 errors then success resets consecutiveErrors, continues MONITORING', async () => {
    const { ctx, mocks, emergencyStop } = buildContext();
    const engine = new RebalanceEngine(ctx);
    ctx.poolEntry.strategy.expectedPriceRatio = undefined;

    await engine.initialize();

    // Fail twice
    mocks.mint.mockRejectedValue(new Error('Fail'));
    await engine.onPriceUpdate(createPoolState(0));
    await engine.onPriceUpdate(createPoolState(0));
    expect(engine.getState()).toBe('MONITORING');
    expect(emergencyStop.isStopped()).toBe(false);

    // Succeed
    mocks.mint.mockResolvedValue({
      tokenId: BigNumber.from(123),
      liquidity: BigNumber.from('1000000000000'),
      amount0: AMOUNT_100_USDT,
      amount1: AMOUNT_100_ZCHF,
    });
    await engine.onPriceUpdate(createPoolState(0));

    expect(engine.getState()).toBe('MONITORING');
    expect(engine.getCurrentTokenId()!.eq(123)).toBe(true);
    expect(emergencyStop.isStopped()).toBe(false);

    // Now fail twice more — should not trigger ERROR (only 2 after reset)
    mocks.mint.mockClear();
    // Need to make the engine think it has no position again
    // Actually now it has a position, so we need to trigger rebalance
    mocks.fetchPoolState.mockResolvedValue(createPoolState(0));
    mocks.mint.mockRejectedValue(new Error('Fail again'));

    await engine.onPriceUpdate(createPoolState(500));
    expect(engine.getState()).toBe('MONITORING'); // 1st error after reset

    await engine.onPriceUpdate(createPoolState(500));
    expect(engine.getState()).toBe('MONITORING'); // 2nd error after reset
    expect(emergencyStop.isStopped()).toBe(false);
  });
});
