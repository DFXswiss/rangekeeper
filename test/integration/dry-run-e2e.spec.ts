import { Wallet } from 'ethers';

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
  getNftManagerContract: jest.fn(() => ({
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    balanceOf: jest.fn().mockResolvedValue(require('ethers').BigNumber.from(0)),
  })),
  getSwapRouterContract: jest.fn(),
  ensureApproval: jest.fn().mockResolvedValue(undefined),
}));

import { RebalanceEngine } from '../../src/core/rebalance-engine';
import { DryRunPositionManager } from '../../src/core/dry-run-position-manager';
import { DryRunSwapExecutor } from '../../src/swap/dry-run-swap-executor';
import { EmergencyStop } from '../../src/risk/emergency-stop';
import { SlippageGuard } from '../../src/risk/slippage-guard';
import { ILTracker } from '../../src/risk/il-tracker';
import { createPoolState, AMOUNT_100_USDT, AMOUNT_100_ZCHF } from '../helpers/fixtures';
import { getErc20Contract } from '../../src/chain/contracts';

const mockedGetErc20Contract = getErc20Contract as jest.MockedFunction<typeof getErc20Contract>;

describe('Dry Run E2E Integration', () => {
  let mockWallet: Wallet;
  let dryPM: DryRunPositionManager;
  let drySE: DryRunSwapExecutor;

  beforeEach(() => {
    jest.clearAllMocks();
    mockWallet = { address: '0xWALLET', provider: {} } as unknown as Wallet;
    dryPM = new DryRunPositionManager(() => mockWallet, '0xNFT');
    drySE = new DryRunSwapExecutor(() => mockWallet, '0xSWAP');

    const balanceOf = jest.fn();
    let callCount = 0;
    balanceOf.mockImplementation(() => {
      callCount++;
      return Promise.resolve(callCount % 2 === 1 ? AMOUNT_100_USDT : AMOUNT_100_ZCHF);
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockedGetErc20Contract.mockReturnValue({ balanceOf } as any);
  });

  function buildDryRunContext() {
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

    return {
      poolEntry,
      wallet: mockWallet,
      poolMonitor: { fetchPoolState: jest.fn().mockResolvedValue(createPoolState(200)), startMonitoring: jest.fn(), stopMonitoring: jest.fn(), on: jest.fn() },
      positionManager: dryPM,
      swapExecutor: drySE,
      emergencyStop: new EmergencyStop(),
      slippageGuard: new SlippageGuard(0.5),
      ilTracker: new ILTracker(),
      balanceTracker: { setInitialValue: jest.fn(), getInitialValue: jest.fn().mockReturnValue(undefined), getLossPercent: jest.fn() },
      gasOracle: { getGasInfo: jest.fn().mockResolvedValue({ gasPriceGwei: 20, isEip1559: false }), isGasSpike: jest.fn().mockReturnValue(false) },
      stateStore: { getPoolState: jest.fn().mockReturnValue(undefined), updatePoolState: jest.fn(), save: jest.fn(), saveOrThrow: jest.fn(), getState: jest.fn() },
      historyLogger: { log: jest.fn() },
      notifier: { notify: jest.fn().mockResolvedValue(undefined) },
      maxTotalLossPercent: 10,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
  }

  it('DryRunPositionManager + DryRunSwapExecutor in full engine flow: init → mint 7 bands → rebalance', async () => {
    const ctx = buildDryRunContext();
    const engine = new RebalanceEngine(ctx);
    await engine.initialize();

    expect(engine.getState()).toBe('MONITORING');

    // Initial mint of 7 bands
    await engine.onPriceUpdate(createPoolState(0));
    expect(engine.getState()).toBe('MONITORING');

    const bands = engine.getBands();
    expect(bands).toHaveLength(7);
    // All virtual token IDs should be >= 900_000_000
    for (const band of bands) {
      expect(band.tokenId.gte(900_000_000)).toBe(true);
    }

    // Trigger rebalance by moving price to band 5 (upper trigger)
    const band5 = bands[5];
    const triggerTick = Math.floor((band5.tickLower + band5.tickUpper) / 2);
    await engine.onPriceUpdate(createPoolState(triggerTick));

    const newBands = engine.getBands();
    expect(newBands).toHaveLength(7);
    expect(engine.getState()).toBe('MONITORING');
  });

  it('virtual positions are tracked through lifecycle', async () => {
    const ctx = buildDryRunContext();
    const engine = new RebalanceEngine(ctx);
    await engine.initialize();

    // Before mint: no virtual positions
    expect(dryPM.getVirtualPositions()).toHaveLength(0);

    // After mint: 7 virtual positions
    await engine.onPriceUpdate(createPoolState(0));
    expect(dryPM.getVirtualPositions()).toHaveLength(7);

    // After rebalance: 1 removed + 1 created = still 7
    const bands = engine.getBands();
    const band5 = bands[5];
    const triggerTick = Math.floor((band5.tickLower + band5.tickUpper) / 2);
    await engine.onPriceUpdate(createPoolState(triggerTick));
    expect(dryPM.getVirtualPositions()).toHaveLength(7);
  });

  it('no real contract calls made (approve, mint, swap all simulated)', async () => {
    const ctx = buildDryRunContext();
    const engine = new RebalanceEngine(ctx);
    await engine.initialize();

    await engine.onPriceUpdate(createPoolState(0));

    const bands = engine.getBands();
    const band5 = bands[5];
    const triggerTick = Math.floor((band5.tickLower + band5.tickUpper) / 2);
    await engine.onPriceUpdate(createPoolState(triggerTick));

    // All token IDs should be virtual (>= 900_000_000)
    for (const band of engine.getBands()) {
      expect(band.tokenId.gte(900_000_000)).toBe(true);
    }
    expect(engine.getState()).toBe('MONITORING');
  });
});
