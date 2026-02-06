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
    },
    monitoring: { checkIntervalSeconds: 30 },
  };

  const getTransactionReceipt = jest.fn().mockResolvedValue(null);
  const wallet = {
    address: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
    provider: { getTransactionReceipt },
  };

  let mintCallCount = 0;
  const mocks = {
    fetchPoolState: jest.fn(),
    approveTokensPM: jest.fn().mockResolvedValue(undefined),
    mint: jest.fn().mockImplementation(async () => {
      mintCallCount++;
      return {
        tokenId: BigNumber.from(100 + mintCallCount),
        liquidity: BigNumber.from('1000000000000'),
        amount0: AMOUNT_100_USDT,
        amount1: AMOUNT_100_ZCHF,
        txHash: `0xmock-mint-hash-${mintCallCount}`,
      };
    }),
    removePosition: jest.fn().mockResolvedValue({
      amount0: AMOUNT_100_USDT,
      amount1: AMOUNT_100_ZCHF,
      fee0: BigNumber.from(1_000_000),
      fee1: BigNumber.from('1000000000000000000'),
      txHashes: {
        decreaseLiquidity: '0xmock-decrease-hash',
        collect: '0xmock-collect-hash',
        burn: '0xmock-burn-hash',
      },
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
    saveOrThrow: jest.fn(),
    getState: jest.fn(),
    log: jest.fn(),
    notify: jest.fn().mockResolvedValue(undefined),
    balanceOf: jest.fn().mockResolvedValue(AMOUNT_100_USDT),
    getTransactionReceipt,
  };

  // Setup ERC20 mock
  mockedGetErc20Contract.mockReturnValue({
    balanceOf: mocks.balanceOf,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);

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
      startMonitoring: jest.fn(),
      stopMonitoring: jest.fn(),
      updatePositionRange: jest.fn(),
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
      saveOrThrow: mocks.saveOrThrow,
      getState: mocks.getState,
    },
    historyLogger: { log: mocks.log },
    notifier: { notify: mocks.notify },
    maxTotalLossPercent: 10,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;

  return { ctx, mocks };
}

describe('Checkpoint Recovery Integration', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('recovery from WITHDRAWN stage clears bands and sends notification', async () => {
    const { ctx, mocks } = buildContext();
    mocks.getPoolState.mockReturnValue({
      bands: [
        { tokenId: '201', tickLower: -150, tickUpper: -107 },
        { tokenId: '202', tickLower: -107, tickUpper: -64 },
      ],
      bandTickWidth: 43,
      lastRebalanceTime: Date.now() - 60000,
      rebalanceStage: 'WITHDRAWN',
      pendingTxHashes: ['0xabc', '0xdef'],
    });

    const engine = new RebalanceEngine(ctx);
    await engine.initialize();

    // Should have cleared the stage
    expect(mocks.updatePoolState).toHaveBeenCalledWith('USDT-ZCHF-100', expect.objectContaining({
      rebalanceStage: undefined,
      pendingTxHashes: undefined,
      bands: undefined,
      bandTickWidth: undefined,
    }));
    expect(mocks.save).toHaveBeenCalled();

    // Should have sent recovery notification
    expect(mocks.notify).toHaveBeenCalledWith(expect.stringContaining('RECOVERY'));
    expect(mocks.notify).toHaveBeenCalledWith(expect.stringContaining('WITHDRAWN'));

    // Bands should be cleared (position was withdrawn)
    expect(engine.getBands()).toHaveLength(0);
    expect(engine.getState()).toBe('MONITORING');
  });

  it('recovery from SWAPPED stage clears bands and sends notification', async () => {
    const { ctx, mocks } = buildContext();
    mocks.getPoolState.mockReturnValue({
      bands: [
        { tokenId: '201', tickLower: -150, tickUpper: -107 },
      ],
      bandTickWidth: 43,
      lastRebalanceTime: Date.now() - 60000,
      rebalanceStage: 'SWAPPED',
      pendingTxHashes: ['0xswap-hash'],
    });

    const engine = new RebalanceEngine(ctx);
    await engine.initialize();

    expect(mocks.updatePoolState).toHaveBeenCalledWith('USDT-ZCHF-100', expect.objectContaining({
      rebalanceStage: undefined,
      pendingTxHashes: undefined,
    }));
    expect(mocks.notify).toHaveBeenCalledWith(expect.stringContaining('SWAPPED'));
    expect(engine.getBands()).toHaveLength(0);
    expect(engine.getState()).toBe('MONITORING');
  });

  it('normal startup without rebalance stage does not trigger recovery', async () => {
    const { ctx, mocks } = buildContext();
    mocks.getPoolState.mockReturnValue({
      bands: [
        { tokenId: '201', tickLower: -150, tickUpper: -107 },
        { tokenId: '202', tickLower: -107, tickUpper: -64 },
        { tokenId: '203', tickLower: -64, tickUpper: -21 },
        { tokenId: '204', tickLower: -21, tickUpper: 22 },
        { tokenId: '205', tickLower: 22, tickUpper: 65 },
        { tokenId: '206', tickLower: 65, tickUpper: 108 },
        { tokenId: '207', tickLower: 108, tickUpper: 151 },
      ],
      bandTickWidth: 43,
      lastRebalanceTime: Date.now() - 60000,
    });

    const engine = new RebalanceEngine(ctx);
    await engine.initialize();

    // No recovery notification
    expect(mocks.notify).not.toHaveBeenCalledWith(expect.stringContaining('RECOVERY'));

    // Bands should be restored normally
    expect(engine.getBands()).toHaveLength(7);
    expect(engine.getBands()[0].tokenId.eq(201)).toBe(true);
  });

  it('pending TX verification checks receipts on startup', async () => {
    const { ctx, mocks } = buildContext();
    mocks.getPoolState.mockReturnValue({
      bands: [
        { tokenId: '201', tickLower: -150, tickUpper: -107 },
      ],
      bandTickWidth: 43,
      pendingTxHashes: ['0xconfirmed', '0xreverted', '0xnotfound'],
    });

    mocks.getTransactionReceipt
      .mockResolvedValueOnce({ status: 1 })  // confirmed
      .mockResolvedValueOnce({ status: 0 })  // reverted
      .mockResolvedValueOnce(null);           // not found

    const engine = new RebalanceEngine(ctx);
    await engine.initialize();

    expect(mocks.getTransactionReceipt).toHaveBeenCalledTimes(3);
    expect(mocks.getTransactionReceipt).toHaveBeenCalledWith('0xconfirmed');
    expect(mocks.getTransactionReceipt).toHaveBeenCalledWith('0xreverted');
    expect(mocks.getTransactionReceipt).toHaveBeenCalledWith('0xnotfound');
  });

  it('recovery allows minting new bands on next price update', async () => {
    const { ctx, mocks } = buildContext();
    mocks.getPoolState.mockReturnValue({
      bands: [
        { tokenId: '201', tickLower: -150, tickUpper: -107 },
      ],
      bandTickWidth: 43,
      lastRebalanceTime: Date.now() - 60000,
      rebalanceStage: 'WITHDRAWN',
      pendingTxHashes: [],
    });

    const engine = new RebalanceEngine(ctx);
    await engine.initialize();

    // Bands cleared by recovery
    expect(engine.getBands()).toHaveLength(0);

    // Now price update should trigger initial mint of 7 bands
    await engine.onPriceUpdate(createPoolState(0));

    expect(mocks.mint).toHaveBeenCalledTimes(7);
    expect(engine.getBands()).toHaveLength(7);
    expect(engine.getState()).toBe('MONITORING');
  });
});
