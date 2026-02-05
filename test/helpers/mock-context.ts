import { BigNumber, Wallet } from 'ethers';
import { RebalanceContext } from '../../src/core/rebalance-engine';
import { EmergencyStop } from '../../src/risk/emergency-stop';
import { SlippageGuard } from '../../src/risk/slippage-guard';
import { ILTracker } from '../../src/risk/il-tracker';
import {
  createPoolEntry,
  AMOUNT_100_USDT,
  AMOUNT_100_ZCHF,
  WALLET_ADDRESS,
} from './fixtures';
import { PoolEntry } from '../../src/config';

// Module-level mock for getErc20Contract
const mockBalanceOf = jest.fn();
jest.mock('../../src/chain/contracts', () => ({
  getErc20Contract: jest.fn(() => ({
    balanceOf: mockBalanceOf,
  })),
  getNftManagerContract: jest.fn(),
  getSwapRouterContract: jest.fn(),
  ensureApproval: jest.fn().mockResolvedValue(undefined),
}));

export interface MockSet {
  // PoolMonitor
  fetchPoolState: jest.Mock;
  startMonitoring: jest.Mock;
  stopMonitoring: jest.Mock;
  updatePositionRange: jest.Mock;
  poolMonitorOn: jest.Mock;
  poolMonitorEmit: jest.Mock;

  // PositionManager
  approveTokensPM: jest.Mock;
  mint: jest.Mock;
  removePosition: jest.Mock;
  getPosition: jest.Mock;
  findExistingPositions: jest.Mock;

  // SwapExecutor
  approveTokensSE: jest.Mock;
  executeSwap: jest.Mock;

  // BalanceTracker
  setInitialValue: jest.Mock;
  getInitialValue: jest.Mock;
  getLossPercent: jest.Mock;

  // GasOracle
  getGasInfo: jest.Mock;
  isGasSpike: jest.Mock;

  // StateStore
  getPoolState: jest.Mock;
  updatePoolState: jest.Mock;
  save: jest.Mock;
  getState: jest.Mock;

  // HistoryLogger
  log: jest.Mock;

  // Notifier
  notify: jest.Mock;

  // ERC20
  balanceOf: jest.Mock;

  // Real instances
  emergencyStop: EmergencyStop;
  slippageGuard: SlippageGuard;
  ilTracker: ILTracker;
}

export interface MockContextResult {
  ctx: RebalanceContext;
  mocks: MockSet;
}

export function createMockContext(poolEntryOverrides?: Partial<PoolEntry>): MockContextResult {
  const poolEntry = createPoolEntry(poolEntryOverrides);

  // Real instances (pure logic)
  const emergencyStop = new EmergencyStop();
  const slippageGuard = new SlippageGuard(poolEntry.strategy.slippageTolerancePercent);
  const ilTracker = new ILTracker();

  // Mock wallet
  const mockWallet = {
    address: WALLET_ADDRESS,
    provider: {
      getNetwork: jest.fn().mockResolvedValue({ chainId: 1 }),
      getBlockNumber: jest.fn().mockResolvedValue(100),
      getFeeData: jest.fn().mockResolvedValue({ gasPrice: BigNumber.from('20000000000') }),
    },
  } as unknown as Wallet;

  // PoolMonitor mocks
  const fetchPoolState = jest.fn();
  const startMonitoring = jest.fn();
  const stopMonitoring = jest.fn();
  const updatePositionRange = jest.fn();
  const poolMonitorOn = jest.fn();
  const poolMonitorEmit = jest.fn();

  const poolMonitor = {
    fetchPoolState,
    startMonitoring,
    stopMonitoring,
    updatePositionRange,
    on: poolMonitorOn,
    emit: poolMonitorEmit,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;

  // PositionManager mocks
  const approveTokensPM = jest.fn().mockResolvedValue(undefined);
  const mint = jest.fn().mockResolvedValue({
    tokenId: BigNumber.from(123),
    liquidity: BigNumber.from('1000000000000'),
    amount0: AMOUNT_100_USDT,
    amount1: AMOUNT_100_ZCHF,
  });
  const removePosition = jest.fn().mockResolvedValue({
    amount0: AMOUNT_100_USDT,
    amount1: AMOUNT_100_ZCHF,
    fee0: BigNumber.from(1_000_000),
    fee1: BigNumber.from('1000000000000000000'),
  });
  const getPosition = jest.fn().mockResolvedValue({
    tokenId: BigNumber.from(123),
    token0: poolEntry.pool.token0.address,
    token1: poolEntry.pool.token1.address,
    fee: poolEntry.pool.feeTier,
    tickLower: -15,
    tickUpper: 15,
    liquidity: BigNumber.from('1000000000000'),
    tokensOwed0: BigNumber.from(0),
    tokensOwed1: BigNumber.from(0),
  });
  const findExistingPositions = jest.fn().mockResolvedValue([]);

  const positionManager = {
    approveTokens: approveTokensPM,
    mint,
    removePosition,
    getPosition,
    findExistingPositions,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;

  // SwapExecutor mocks
  const approveTokensSE = jest.fn().mockResolvedValue(undefined);
  const executeSwap = jest.fn().mockResolvedValue(AMOUNT_50_USDT());

  const swapExecutor = {
    approveTokens: approveTokensSE,
    executeSwap,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;

  // BalanceTracker mocks
  const setInitialValue = jest.fn();
  const getInitialValue = jest.fn().mockReturnValue(undefined);
  const getLossPercent = jest.fn().mockReturnValue(undefined);

  const balanceTracker = {
    setInitialValue,
    getInitialValue,
    getLossPercent,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;

  // GasOracle mocks
  const getGasInfo = jest.fn().mockResolvedValue({ gasPriceGwei: 20, isEip1559: false });
  const isGasSpike = jest.fn().mockReturnValue(false);

  const gasOracle = {
    getGasInfo,
    isGasSpike,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;

  // StateStore mocks
  const getPoolStateMock = jest.fn().mockReturnValue(undefined);
  const updatePoolState = jest.fn();
  const save = jest.fn();
  const getState = jest.fn().mockReturnValue({ version: 1, startedAt: new Date().toISOString(), pools: {} });

  const stateStore = {
    getPoolState: getPoolStateMock,
    updatePoolState,
    save,
    getState,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;

  // HistoryLogger mock
  const log = jest.fn();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const historyLogger = { log } as any;

  // Notifier mock
  const notify = jest.fn().mockResolvedValue(undefined);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const notifier = { notify } as any;

  // ERC20 balanceOf default
  mockBalanceOf.mockReset();
  mockBalanceOf.mockResolvedValue(AMOUNT_100_USDT);
  // Alternate returns: first call USDT, second call ZCHF
  // For most tests we just return consistent values
  mockBalanceOf.mockImplementation(() => Promise.resolve(AMOUNT_100_USDT));

  const ctx: RebalanceContext = {
    poolEntry,
    wallet: mockWallet,
    poolMonitor,
    positionManager,
    swapExecutor,
    emergencyStop,
    slippageGuard,
    ilTracker,
    balanceTracker,
    gasOracle,
    stateStore,
    historyLogger,
    notifier,
    maxTotalLossPercent: 10,
  };

  const mocks: MockSet = {
    fetchPoolState,
    startMonitoring,
    stopMonitoring,
    updatePositionRange,
    poolMonitorOn,
    poolMonitorEmit,
    approveTokensPM,
    mint,
    removePosition,
    getPosition,
    findExistingPositions,
    approveTokensSE,
    executeSwap,
    setInitialValue,
    getInitialValue,
    getLossPercent,
    getGasInfo,
    isGasSpike,
    getPoolState: getPoolStateMock,
    updatePoolState,
    save,
    getState,
    log,
    notify,
    balanceOf: mockBalanceOf,
    emergencyStop,
    slippageGuard,
    ilTracker,
  };

  return { ctx, mocks };
}

function AMOUNT_50_USDT(): BigNumber {
  return BigNumber.from(50_000_000);
}
