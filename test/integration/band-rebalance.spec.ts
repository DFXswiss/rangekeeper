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
import { createPoolState, AMOUNT_100_USDT, AMOUNT_100_ZCHF, createBandLayout } from '../helpers/fixtures';
import { getErc20Contract } from '../../src/chain/contracts';
import { BandManager } from '../../src/core/band-manager';

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

  const wallet = {
    address: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
    provider: {},
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
    saveOrThrow: jest.fn(),
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

describe('Band Rebalance Integration', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('initial: 7 bands are correctly minted', async () => {
    const { ctx, mocks } = buildContext();
    const engine = new RebalanceEngine(ctx);
    await engine.initialize();

    const poolState = createPoolState(0);
    await engine.onPriceUpdate(poolState);

    // 7 bands should be minted
    expect(mocks.mint).toHaveBeenCalledTimes(7);
    expect(engine.getBands()).toHaveLength(7);
    expect(engine.getState()).toBe('MONITORING');

    // Bands should be contiguous
    const bands = engine.getBands();
    for (let i = 1; i < bands.length; i++) {
      expect(bands[i].tickLower).toBe(bands[i - 1].tickUpper);
    }
  });

  it('idle: price in safe zone triggers no rebalance', async () => {
    const { ctx, mocks } = buildContext();
    const engine = new RebalanceEngine(ctx);
    await engine.initialize();

    // Mint initial bands
    await engine.onPriceUpdate(createPoolState(0));
    mocks.mint.mockClear();
    mocks.removePosition.mockClear();

    // Price in center band (safe zone) → no action
    const bands = engine.getBands();
    const centerBand = bands[3];
    const safeTick = Math.floor((centerBand.tickLower + centerBand.tickUpper) / 2);

    await engine.onPriceUpdate(createPoolState(safeTick));

    expect(mocks.removePosition).not.toHaveBeenCalled();
    expect(mocks.mint).not.toHaveBeenCalled();
  });

  it('trigger lower: price in band 1 dissolves last band, mints new band at start', async () => {
    const { ctx, mocks } = buildContext();
    const engine = new RebalanceEngine(ctx);
    await engine.initialize();

    // Mint initial bands
    await engine.onPriceUpdate(createPoolState(0));
    const initialBands = engine.getBands();
    const lastBandTokenId = initialBands[6].tokenId;

    mocks.mint.mockClear();
    mocks.removePosition.mockClear();
    mocks.executeSwap.mockClear();

    // Configure single new mint result
    mocks.mint.mockResolvedValue({
      tokenId: BigNumber.from(999),
      liquidity: BigNumber.from('1000000000000'),
      amount0: AMOUNT_100_USDT,
      amount1: AMOUNT_100_ZCHF,
      txHash: '0xmock-new-mint',
    });

    // Price in band 1 (lower trigger)
    const band1 = initialBands[1];
    const triggerTick = Math.floor((band1.tickLower + band1.tickUpper) / 2);
    await engine.onPriceUpdate(createPoolState(triggerTick));

    // Band 7 (last) dissolved
    expect(mocks.removePosition).toHaveBeenCalledTimes(1);
    expect(mocks.removePosition).toHaveBeenCalledWith(lastBandTokenId, expect.anything(), expect.anything());

    // Swap executed (token0 → token1)
    expect(mocks.executeSwap).toHaveBeenCalledTimes(1);

    // New band minted
    expect(mocks.mint).toHaveBeenCalledTimes(1);

    // Still 7 bands
    expect(engine.getBands()).toHaveLength(7);

    // New band is at the start (lower end)
    const newBands = engine.getBands();
    expect(newBands[0].tokenId.eq(999)).toBe(true);
    expect(newBands[0].tickUpper).toBe(initialBands[0].tickLower);
  });

  it('trigger upper: price in band 5 dissolves first band, mints new band at end', async () => {
    const { ctx, mocks } = buildContext();
    const engine = new RebalanceEngine(ctx);
    await engine.initialize();

    // Mint initial bands
    await engine.onPriceUpdate(createPoolState(0));
    const initialBands = engine.getBands();
    const firstBandTokenId = initialBands[0].tokenId;

    mocks.mint.mockClear();
    mocks.removePosition.mockClear();
    mocks.executeSwap.mockClear();

    mocks.mint.mockResolvedValue({
      tokenId: BigNumber.from(888),
      liquidity: BigNumber.from('1000000000000'),
      amount0: AMOUNT_100_USDT,
      amount1: AMOUNT_100_ZCHF,
      txHash: '0xmock-new-mint',
    });

    // Price in band 5 (upper trigger)
    const band5 = initialBands[5];
    const triggerTick = Math.floor((band5.tickLower + band5.tickUpper) / 2);
    await engine.onPriceUpdate(createPoolState(triggerTick));

    // Band 1 (first) dissolved
    expect(mocks.removePosition).toHaveBeenCalledTimes(1);
    expect(mocks.removePosition).toHaveBeenCalledWith(firstBandTokenId, expect.anything(), expect.anything());

    // Swap executed (token1 → token0)
    expect(mocks.executeSwap).toHaveBeenCalledTimes(1);

    // New band minted
    expect(mocks.mint).toHaveBeenCalledTimes(1);

    // Still 7 bands
    expect(engine.getBands()).toHaveLength(7);

    // New band is at the end (upper end)
    const newBands = engine.getBands();
    expect(newBands[6].tokenId.eq(888)).toBe(true);
    expect(newBands[6].tickLower).toBe(initialBands[6].tickUpper);
  });

  it('emergency withdraw closes all 7 bands', async () => {
    const { ctx, mocks } = buildContext();
    // Enable depeg detection
    ctx.poolEntry.strategy.expectedPriceRatio = 1.0;
    ctx.poolEntry.strategy.depegThresholdPercent = 5;

    const engine = new RebalanceEngine(ctx);
    await engine.initialize();

    // Mint initial bands
    await engine.onPriceUpdate(createPoolState(0));
    expect(engine.getBands()).toHaveLength(7);

    mocks.removePosition.mockClear();
    mocks.getPosition.mockClear();

    // Depeg: tick 600 = price ~1.06 = >5% deviation
    const depegState = createPoolState(600);
    await engine.onPriceUpdate(depegState);

    await new Promise((r) => setTimeout(r, 50));

    // All 7 bands should be removed
    expect(mocks.getPosition).toHaveBeenCalledTimes(7);
    expect(mocks.removePosition).toHaveBeenCalledTimes(7);
    expect(engine.getBands()).toHaveLength(0);
    expect(engine.getState()).toBe('STOPPED');
  });

  it('state persistence: bands are saved and loaded correctly', async () => {
    const { ctx, mocks } = buildContext();

    // Simulate saved band state
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

    expect(engine.getBands()).toHaveLength(7);
    expect(engine.getBands()[0].tokenId.eq(201)).toBe(true);
    expect(engine.getBands()[6].tokenId.eq(207)).toBe(true);
    expect(engine.getBandManager().getBandTickWidth()).toBe(43);
  });

  it('bands remain contiguous after lower rebalance', async () => {
    const { ctx, mocks } = buildContext();
    const engine = new RebalanceEngine(ctx);
    await engine.initialize();

    // Mint initial bands
    await engine.onPriceUpdate(createPoolState(0));

    mocks.mint.mockClear();
    mocks.mint.mockResolvedValue({
      tokenId: BigNumber.from(999),
      liquidity: BigNumber.from('1000000000000'),
      amount0: AMOUNT_100_USDT,
      amount1: AMOUNT_100_ZCHF,
      txHash: '0xmock-new-mint',
    });

    const initialBands = engine.getBands();
    const band1 = initialBands[1];
    const triggerTick = Math.floor((band1.tickLower + band1.tickUpper) / 2);
    await engine.onPriceUpdate(createPoolState(triggerTick));

    // Verify all 7 bands are contiguous
    const newBands = engine.getBands();
    expect(newBands).toHaveLength(7);
    for (let i = 1; i < newBands.length; i++) {
      expect(newBands[i].tickLower).toBe(newBands[i - 1].tickUpper);
    }
  });

  it('rebalance persists state and logs history', async () => {
    const { ctx, mocks } = buildContext();
    const engine = new RebalanceEngine(ctx);
    await engine.initialize();

    await engine.onPriceUpdate(createPoolState(0));
    mocks.log.mockClear();
    mocks.notify.mockClear();
    mocks.updatePoolState.mockClear();
    mocks.save.mockClear();

    mocks.mint.mockClear();
    mocks.mint.mockResolvedValue({
      tokenId: BigNumber.from(999),
      liquidity: BigNumber.from('1000000000000'),
      amount0: AMOUNT_100_USDT,
      amount1: AMOUNT_100_ZCHF,
      txHash: '0xmock-new-mint',
    });

    const initialBands = engine.getBands();
    const band1 = initialBands[1];
    const triggerTick = Math.floor((band1.tickLower + band1.tickUpper) / 2);
    await engine.onPriceUpdate(createPoolState(triggerTick));

    expect(mocks.updatePoolState).toHaveBeenCalled();
    expect(mocks.save).toHaveBeenCalled();
    expect(mocks.log).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'REBALANCE', poolId: 'USDT-ZCHF-100', direction: 'lower' }),
    );
    expect(mocks.notify).toHaveBeenCalledWith(expect.stringContaining('Band rebalance completed'));
  });

  it('3 consecutive errors trigger ERROR state', async () => {
    const { ctx, mocks } = buildContext();
    const engine = new RebalanceEngine(ctx);
    await engine.initialize();

    mocks.mint.mockRejectedValue(new Error('Mint failed'));

    await engine.onPriceUpdate(createPoolState(0));
    expect(engine.getState()).toBe('MONITORING');

    await engine.onPriceUpdate(createPoolState(0));
    expect(engine.getState()).toBe('MONITORING');

    await engine.onPriceUpdate(createPoolState(0));
    expect(engine.getState()).toBe('ERROR');

    expect(mocks.notify).toHaveBeenCalledWith(expect.stringContaining('stopped after 3 errors'));
  });

  it('recovery from incomplete rebalance clears bands', async () => {
    const { ctx, mocks } = buildContext();
    mocks.getPoolState.mockReturnValue({
      bands: [
        { tokenId: '201', tickLower: -150, tickUpper: -107 },
        { tokenId: '202', tickLower: -107, tickUpper: -64 },
      ],
      bandTickWidth: 43,
      rebalanceStage: 'WITHDRAWN',
      pendingTxHashes: ['0xabc'],
    });

    const engine = new RebalanceEngine(ctx);
    await engine.initialize();

    expect(engine.getBands()).toHaveLength(0);
    expect(mocks.notify).toHaveBeenCalledWith(expect.stringContaining('RECOVERY'));
    expect(mocks.notify).toHaveBeenCalledWith(expect.stringContaining('WITHDRAWN'));
    expect(engine.getState()).toBe('MONITORING');
  });
});

describe('BandManager Unit Tests', () => {
  it('getBandIndexForTick returns correct index', () => {
    const bm = new BandManager();
    const bands = createBandLayout(0, 7);
    bm.setBands(bands, 43);

    const midBand3 = Math.floor((bands[3].tickLower + bands[3].tickUpper) / 2);
    expect(bm.getBandIndexForTick(midBand3)).toBe(3);
    expect(bm.getBandIndexForTick(bands[0].tickLower)).toBe(0);
    expect(bm.getBandIndexForTick(bands[6].tickUpper + 10)).toBe(-1);
    expect(bm.getBandIndexForTick(bands[0].tickLower - 10)).toBe(-1);
  });

  it('isInSafeZone returns true for center bands', () => {
    const bm = new BandManager();
    const bands = createBandLayout(0, 7);
    bm.setBands(bands, 43);

    // Band 2, 3, 4 are safe zone
    expect(bm.isInSafeZone(bands[2].tickLower + 1)).toBe(true);
    expect(bm.isInSafeZone(bands[3].tickLower + 1)).toBe(true);
    expect(bm.isInSafeZone(bands[4].tickLower + 1)).toBe(true);
    // Band 0, 1, 5, 6 are not safe
    expect(bm.isInSafeZone(bands[0].tickLower + 1)).toBe(false);
    expect(bm.isInSafeZone(bands[1].tickLower + 1)).toBe(false);
    expect(bm.isInSafeZone(bands[5].tickLower + 1)).toBe(false);
    expect(bm.isInSafeZone(bands[6].tickLower + 1)).toBe(false);
  });

  it('getTriggerDirection returns correct direction', () => {
    const bm = new BandManager();
    const bands = createBandLayout(0, 7);
    bm.setBands(bands, 43);

    // Band 0 or 1 → lower trigger
    expect(bm.getTriggerDirection(bands[0].tickLower + 1)).toBe('lower');
    expect(bm.getTriggerDirection(bands[1].tickLower + 1)).toBe('lower');
    // Band 5 or 6 → upper trigger
    expect(bm.getTriggerDirection(bands[5].tickLower + 1)).toBe('upper');
    expect(bm.getTriggerDirection(bands[6].tickLower + 1)).toBe('upper');
    // Band 3 (center) → null
    expect(bm.getTriggerDirection(bands[3].tickLower + 1)).toBe(null);
    // Outside below → lower
    expect(bm.getTriggerDirection(bands[0].tickLower - 100)).toBe('lower');
    // Outside above → upper
    expect(bm.getTriggerDirection(bands[6].tickUpper + 100)).toBe('upper');
  });

  it('getBandToDissolve returns correct band', () => {
    const bm = new BandManager();
    const bands = createBandLayout(0, 7);
    bm.setBands(bands, 43);

    // Lower trigger → dissolve last band (index 6)
    const dissolvedLower = bm.getBandToDissolve('lower');
    expect(dissolvedLower.tokenId.eq(bands[6].tokenId)).toBe(true);

    // Upper trigger → dissolve first band (index 0)
    const dissolvedUpper = bm.getBandToDissolve('upper');
    expect(dissolvedUpper.tokenId.eq(bands[0].tokenId)).toBe(true);
  });

  it('getNewBandTicks returns contiguous ticks', () => {
    const bm = new BandManager();
    const bands = createBandLayout(0, 7);
    bm.setBands(bands, 43);

    // Lower → new band below first
    const lowerTicks = bm.getNewBandTicks('lower');
    expect(lowerTicks.tickUpper).toBe(bands[0].tickLower);
    expect(lowerTicks.tickUpper - lowerTicks.tickLower).toBe(43);

    // Upper → new band above last
    const upperTicks = bm.getNewBandTicks('upper');
    expect(upperTicks.tickLower).toBe(bands[6].tickUpper);
    expect(upperTicks.tickUpper - upperTicks.tickLower).toBe(43);
  });

  it('removeBand and addBand maintain correct indices', () => {
    const bm = new BandManager();
    const bands = createBandLayout(0, 7);
    bm.setBands(bands, 43);

    // Remove last band
    bm.removeBand(bands[6].tokenId);
    expect(bm.getBandCount()).toBe(6);
    expect(bm.getBands().every((b, i) => b.index === i)).toBe(true);

    // Add band at start
    bm.addBand(
      { tokenId: BigNumber.from(999), tickLower: bands[0].tickLower - 43, tickUpper: bands[0].tickLower },
      'start',
    );
    expect(bm.getBandCount()).toBe(7);
    expect(bm.getBands()[0].tokenId.eq(999)).toBe(true);
    expect(bm.getBands().every((b, i) => b.index === i)).toBe(true);
  });
});
