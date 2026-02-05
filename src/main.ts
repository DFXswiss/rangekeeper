import path from 'path';
import { loadEnvConfig, loadPoolConfigs, getRpcUrl } from './config';
import { createLogger } from './util/logger';
import { getProvider, getWallet, verifyConnection } from './chain/evm-provider';
import { getPoolContract, getFactoryContract } from './chain/contracts';
import { getChainAddresses } from './config/chain-addresses';
import { PoolMonitor } from './core/pool-monitor';
import { PositionManager } from './core/position-manager';
import { RebalanceEngine, RebalanceContext } from './core/rebalance-engine';
import { BalanceTracker } from './core/balance-tracker';
import { SwapExecutor } from './swap/swap-executor';
import { EmergencyStop } from './risk/emergency-stop';
import { SlippageGuard } from './risk/slippage-guard';
import { StateStore } from './persistence/state-store';
import { HistoryLogger } from './persistence/history-logger';
import { CompositeNotifier, ConsoleNotifier, Notifier } from './notification/notifier';
import { TelegramNotifier } from './notification/telegram-notifier';
import { DiscordNotifier } from './notification/discord-notifier';
import { startHealthServer } from './health/health-server';

const engines: RebalanceEngine[] = [];

async function main(): Promise<void> {
  const env = loadEnvConfig();
  const logger = createLogger(env.LOG_LEVEL);

  logger.info('Starting RangeKeeper');

  // Start health server
  startHealthServer(env.HEALTH_PORT);

  // Build notifier
  const notifiers: Notifier[] = [new ConsoleNotifier()];
  if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) {
    notifiers.push(new TelegramNotifier(env.TELEGRAM_BOT_TOKEN, env.TELEGRAM_CHAT_ID));
  }
  if (env.DISCORD_WEBHOOK_URL) {
    notifiers.push(new DiscordNotifier(env.DISCORD_WEBHOOK_URL));
  }
  const notifier = new CompositeNotifier(notifiers);

  // Persistence
  const dataDir = path.resolve(process.cwd(), 'data');
  const stateStore = new StateStore(path.join(dataDir, 'state.json'));
  const historyLogger = new HistoryLogger(path.join(dataDir, 'history.jsonl'));

  // Load pool configs
  const pools = loadPoolConfigs();
  logger.info({ poolCount: pools.length }, 'Loaded pool configurations');

  for (const poolEntry of pools) {
    try {
      const rpcUrl = poolEntry.chain.rpcUrl;
      const provider = getProvider(rpcUrl);
      const wallet = getWallet(env.PRIVATE_KEY, provider);

      const { chainId, blockNumber } = await verifyConnection(provider);
      logger.info({ poolId: poolEntry.id, chainId, blockNumber, wallet: wallet.address }, 'Connected');

      // Resolve pool address via factory
      const chainAddresses = getChainAddresses(chainId);
      const factory = getFactoryContract(chainAddresses.factory, wallet);
      const poolAddress: string = await factory.getPool(
        poolEntry.pool.token0.address,
        poolEntry.pool.token1.address,
        poolEntry.pool.feeTier,
      );

      if (poolAddress === '0x0000000000000000000000000000000000000000') {
        throw new Error(`Pool not found for ${poolEntry.pool.token0.symbol}/${poolEntry.pool.token1.symbol} fee=${poolEntry.pool.feeTier}`);
      }

      logger.info({ poolId: poolEntry.id, poolAddress }, 'Pool resolved');

      const poolContract = getPoolContract(poolAddress, wallet);
      const poolMonitor = new PoolMonitor(poolContract, poolEntry.id, poolEntry.monitoring.checkIntervalSeconds * 1000);
      const positionManager = new PositionManager(wallet, poolEntry.pool.nftManagerAddress);
      const swapExecutor = new SwapExecutor(wallet, poolEntry.pool.swapRouterAddress);
      const emergencyStop = new EmergencyStop();
      const slippageGuard = new SlippageGuard(poolEntry.strategy.slippageTolerancePercent);
      const balanceTracker = new BalanceTracker(wallet);

      const ctx: RebalanceContext = {
        poolEntry,
        wallet,
        poolMonitor,
        positionManager,
        swapExecutor,
        emergencyStop,
        slippageGuard,
        balanceTracker,
        stateStore,
        historyLogger,
        notifier,
      };

      const engine = new RebalanceEngine(ctx);
      engines.push(engine);

      await engine.initialize();

      // Wire up events
      poolMonitor.on('priceUpdate', (state) => engine.onPriceUpdate(state));
      poolMonitor.on('outOfRange', (state) => engine.onPriceUpdate(state));
      poolMonitor.on('approachingBoundary', (state) => engine.onPriceUpdate(state));
      poolMonitor.on('error', (err) => {
        logger.error({ poolId: poolEntry.id, err }, 'Pool monitor error');
      });

      // Start monitoring
      const currentRange = engine.getCurrentRange();
      poolMonitor.startMonitoring(currentRange ?? undefined);

      logger.info({ poolId: poolEntry.id }, 'Engine started');
    } catch (err) {
      logger.error({ poolId: poolEntry.id, err }, 'Failed to initialize pool');
    }
  }

  await notifier.notify(`RangeKeeper started with ${engines.length} pool(s)`);

  logger.info({ activeEngines: engines.length }, 'RangeKeeper is running');
}

// Graceful shutdown
function setupShutdownHandlers(): void {
  const logger = createLogger();

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received');

    for (const engine of engines) {
      await engine.stop();
    }

    logger.info('All engines stopped, exiting');
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  process.on('uncaughtException', (err) => {
    logger.fatal({ err }, 'Uncaught exception');
    process.exit(1);
  });

  process.on('unhandledRejection', (reason) => {
    logger.fatal({ reason }, 'Unhandled rejection');
    process.exit(1);
  });
}

setupShutdownHandlers();
main().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
