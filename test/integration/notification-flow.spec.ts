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
import { DryRunNotifier } from '../../src/notification/notifier';
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
      nftManagerAddress: '0xNFT',
      swapRouterAddress: '0xSWAP',
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
      fee0: BigNumber.from(1_000_000),
      fee1: BigNumber.from('1000000000000000000'),
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
    poolEntry: overrides.poolEntry ?? poolEntry,
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
    ...overrides,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;

  return { ctx, mocks };
}

describe('Notification Flow Integration', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('initial mint notification contains tokenId, range, and price', async () => {
    const { ctx, mocks } = buildContext();
    const engine = new RebalanceEngine(ctx);
    await engine.initialize();

    await engine.onPriceUpdate(createPoolState(0));

    expect(mocks.notify).toHaveBeenCalledTimes(1);
    const msg = mocks.notify.mock.calls[0][0] as string;
    expect(msg).toContain('Initial position minted');
    expect(msg).toContain('TokenId: 123');
    expect(msg).toContain('Range:');
    expect(msg).toContain('Price:');
  });

  it('rebalance notification contains new tokenId, range, and IL%', async () => {
    const { ctx, mocks } = buildContext();
    // Disable depeg for rebalance test
    ctx.poolEntry.strategy.expectedPriceRatio = undefined;

    const engine = new RebalanceEngine(ctx);
    await engine.initialize();

    // Initial mint
    await engine.onPriceUpdate(createPoolState(0));
    mocks.notify.mockClear();

    mocks.mint.mockResolvedValue({
      tokenId: BigNumber.from(456),
      liquidity: BigNumber.from('1000'),
      amount0: AMOUNT_100_USDT,
      amount1: AMOUNT_100_ZCHF,
    });

    // Trigger rebalance
    await engine.onPriceUpdate(createPoolState(200));

    // Find the rebalance notification
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const calls = mocks.notify.mock.calls.map((c: any[]) => c[0] as string);
    const rebalanceMsg = calls.find((m: string) => m.includes('Rebalance completed'));
    expect(rebalanceMsg).toBeDefined();
    expect(rebalanceMsg).toContain('New TokenId: 456');
    expect(rebalanceMsg).toContain('New Range:');
    expect(rebalanceMsg).toContain('IL:');
  });

  it('depeg notification contains current price, deviation%, and action', async () => {
    const { ctx, mocks } = buildContext();
    const engine = new RebalanceEngine(ctx);
    await engine.initialize();

    // Mint position
    await engine.onPriceUpdate(createPoolState(0));
    mocks.notify.mockClear();

    // Depeg
    await engine.onPriceUpdate(createPoolState(600));
    await new Promise((r) => setTimeout(r, 50));

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const calls = mocks.notify.mock.calls.map((c: any[]) => c[0] as string);
    const depegMsg = calls.find((m: string) => m.includes('DEPEG'));
    expect(depegMsg).toBeDefined();
    expect(depegMsg).toContain('Current price:');
    expect(depegMsg).toContain('Deviation:');
    expect(depegMsg).toContain('Action:');
  });

  it('consecutive errors notification contains error count and message', async () => {
    const { ctx, mocks } = buildContext();
    ctx.poolEntry.strategy.expectedPriceRatio = undefined;

    const engine = new RebalanceEngine(ctx);
    await engine.initialize();

    mocks.mint.mockRejectedValue(new Error('TX reverted'));

    // 3 failures
    await engine.onPriceUpdate(createPoolState(0));
    await engine.onPriceUpdate(createPoolState(0));
    await engine.onPriceUpdate(createPoolState(0));

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const calls = mocks.notify.mock.calls.map((c: any[]) => c[0] as string);
    const errorMsg = calls.find((m: string) => m.includes('stopped after'));
    expect(errorMsg).toBeDefined();
    expect(errorMsg).toContain('3 errors');
    expect(errorMsg).toContain('TX reverted');
  });

  it('DryRunNotifier wraps all messages with [DRY RUN] prefix', async () => {
    const innerNotify = jest.fn().mockResolvedValue(undefined);
    const innerNotifier = { notify: innerNotify };
    const dryNotifier = new DryRunNotifier(innerNotifier);

    await dryNotifier.notify('Position minted');

    expect(innerNotify).toHaveBeenCalledWith('[DRY RUN] Position minted');
  });
});
