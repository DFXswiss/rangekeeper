import { BigNumber } from 'ethers';
import { mkdtempSync, writeFileSync, existsSync, unlinkSync, rmdirSync } from 'fs';
import path from 'path';
import os from 'os';

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

import { StateStore } from '../../src/persistence/state-store';
import { RebalanceEngine } from '../../src/core/rebalance-engine';
import { EmergencyStop } from '../../src/risk/emergency-stop';
import { SlippageGuard } from '../../src/risk/slippage-guard';
import { ILTracker } from '../../src/risk/il-tracker';
import { createPoolState, AMOUNT_100_USDT, AMOUNT_100_ZCHF } from '../helpers/fixtures';
import { getErc20Contract } from '../../src/chain/contracts';

const mockedGetErc20Contract = getErc20Contract as jest.MockedFunction<typeof getErc20Contract>;

function createTmpDir(): string {
  return mkdtempSync(path.join(os.tmpdir(), 'rangekeeper-test-'));
}

function cleanupTmpDir(dirPath: string): void {
  try {
    const stateFile = path.join(dirPath, 'state.json');
    if (existsSync(stateFile)) unlinkSync(stateFile);
    rmdirSync(dirPath);
  } catch {
    // ignore cleanup errors
  }
}

describe('State Persistence Integration', () => {
  let tmpDir: string;

  beforeEach(() => {
    jest.clearAllMocks();
    tmpDir = createTmpDir();
  });

  afterEach(() => {
    cleanupTmpDir(tmpDir);
  });

  it('StateStore saves and reloads state across instances', () => {
    const filePath = path.join(tmpDir, 'state.json');

    const store1 = new StateStore(filePath);
    store1.updatePoolState('pool-1', { tokenId: '100', tickLower: -10, tickUpper: 10 });
    store1.save();

    const store2 = new StateStore(filePath);
    const loaded = store2.getPoolState('pool-1');

    expect(loaded).toBeDefined();
    expect(loaded!.tokenId).toBe('100');
    expect(loaded!.tickLower).toBe(-10);
    expect(loaded!.tickUpper).toBe(10);
  });

  it('Engine persists after initial mint, new StateStore reads tokenId and range', async () => {
    const filePath = path.join(tmpDir, 'state.json');
    const stateStore = new StateStore(filePath);

    const balanceOf = jest.fn();
    let callCount = 0;
    balanceOf.mockImplementation(() => {
      callCount++;
      return Promise.resolve(callCount % 2 === 1 ? AMOUNT_100_USDT : AMOUNT_100_ZCHF);
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockedGetErc20Contract.mockReturnValue({ balanceOf } as any);

    const ctx = {
      poolEntry: {
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
      },
      wallet: { address: '0xWALLET', provider: {} },
      poolMonitor: { fetchPoolState: jest.fn(), startMonitoring: jest.fn(), stopMonitoring: jest.fn(), on: jest.fn() },
      positionManager: {
        approveTokens: jest.fn().mockResolvedValue(undefined),
        mint: jest.fn().mockResolvedValue({
          tokenId: BigNumber.from(123),
          liquidity: BigNumber.from('1000'),
          amount0: AMOUNT_100_USDT,
          amount1: AMOUNT_100_ZCHF,
        }),
        removePosition: jest.fn().mockResolvedValue({ amount0: AMOUNT_100_USDT, amount1: AMOUNT_100_ZCHF, fee0: BigNumber.from(0), fee1: BigNumber.from(0) }),
        getPosition: jest.fn().mockResolvedValue({ liquidity: BigNumber.from('1000') }),
        findExistingPositions: jest.fn().mockResolvedValue([]),
      },
      swapExecutor: { approveTokens: jest.fn().mockResolvedValue(undefined), executeSwap: jest.fn().mockResolvedValue(BigNumber.from(0)) },
      emergencyStop: new EmergencyStop(),
      slippageGuard: new SlippageGuard(0.5),
      ilTracker: new ILTracker(),
      balanceTracker: { setInitialValue: jest.fn(), getInitialValue: jest.fn(), getLossPercent: jest.fn() },
      gasOracle: { getGasInfo: jest.fn().mockResolvedValue({ gasPriceGwei: 20, isEip1559: false }), isGasSpike: jest.fn().mockReturnValue(false) },
      stateStore,
      historyLogger: { log: jest.fn() },
      notifier: { notify: jest.fn().mockResolvedValue(undefined) },
      maxTotalLossPercent: 10,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;

    const engine = new RebalanceEngine(ctx);
    await engine.initialize();
    await engine.onPriceUpdate(createPoolState(0));

    // Verify state was persisted
    const store2 = new StateStore(filePath);
    const loaded = store2.getPoolState('USDT-ZCHF-100');
    expect(loaded).toBeDefined();
    expect(loaded!.tokenId).toBe('123');
    expect(loaded!.tickLower).toBeDefined();
    expect(loaded!.tickUpper).toBeDefined();
  });

  it('Engine persists after rebalance with updated tokenId and range', async () => {
    const filePath = path.join(tmpDir, 'state.json');
    const stateStore = new StateStore(filePath);

    const balanceOf = jest.fn();
    let callCount = 0;
    balanceOf.mockImplementation(() => {
      callCount++;
      return Promise.resolve(callCount % 2 === 1 ? AMOUNT_100_USDT : AMOUNT_100_ZCHF);
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockedGetErc20Contract.mockReturnValue({ balanceOf } as any);

    const mint = jest.fn().mockResolvedValue({
      tokenId: BigNumber.from(123),
      liquidity: BigNumber.from('1000'),
      amount0: AMOUNT_100_USDT,
      amount1: AMOUNT_100_ZCHF,
    });

    const ctx = {
      poolEntry: {
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
      },
      wallet: { address: '0xWALLET', provider: {} },
      poolMonitor: { fetchPoolState: jest.fn(), startMonitoring: jest.fn(), stopMonitoring: jest.fn(), on: jest.fn() },
      positionManager: {
        approveTokens: jest.fn().mockResolvedValue(undefined),
        mint,
        removePosition: jest.fn().mockResolvedValue({ amount0: AMOUNT_100_USDT, amount1: AMOUNT_100_ZCHF, fee0: BigNumber.from(0), fee1: BigNumber.from(0) }),
        getPosition: jest.fn().mockResolvedValue({ liquidity: BigNumber.from('1000') }),
        findExistingPositions: jest.fn().mockResolvedValue([]),
      },
      swapExecutor: { approveTokens: jest.fn().mockResolvedValue(undefined), executeSwap: jest.fn().mockResolvedValue(BigNumber.from(0)) },
      emergencyStop: new EmergencyStop(),
      slippageGuard: new SlippageGuard(0.5),
      ilTracker: new ILTracker(),
      balanceTracker: { setInitialValue: jest.fn(), getInitialValue: jest.fn().mockReturnValue(undefined), getLossPercent: jest.fn() },
      gasOracle: { getGasInfo: jest.fn().mockResolvedValue({ gasPriceGwei: 20, isEip1559: false }), isGasSpike: jest.fn().mockReturnValue(false) },
      stateStore,
      historyLogger: { log: jest.fn() },
      notifier: { notify: jest.fn().mockResolvedValue(undefined) },
      maxTotalLossPercent: 10,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;

    const engine = new RebalanceEngine(ctx);
    await engine.initialize();
    await engine.onPriceUpdate(createPoolState(0));

    // Now rebalance with new tokenId
    mint.mockResolvedValue({
      tokenId: BigNumber.from(456),
      liquidity: BigNumber.from('2000'),
      amount0: AMOUNT_100_USDT,
      amount1: AMOUNT_100_ZCHF,
    });
    ctx.poolMonitor.fetchPoolState.mockResolvedValue(createPoolState(0));

    await engine.onPriceUpdate(createPoolState(200));

    const store2 = new StateStore(filePath);
    const loaded = store2.getPoolState('USDT-ZCHF-100');
    expect(loaded!.tokenId).toBe('456');
  });

  it('corrupt state file results in fresh state', () => {
    const filePath = path.join(tmpDir, 'state.json');
    writeFileSync(filePath, 'not valid json {{{', 'utf-8');

    const store = new StateStore(filePath);
    const state = store.getState();

    expect(state.version).toBe(1);
    expect(Object.keys(state.pools)).toHaveLength(0);
  });

  it('missing state file creates fresh state', () => {
    const filePath = path.join(tmpDir, 'nonexistent-state.json');

    const store = new StateStore(filePath);
    const state = store.getState();

    expect(state.version).toBe(1);
    expect(Object.keys(state.pools)).toHaveLength(0);
  });
});
