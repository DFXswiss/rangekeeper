import path from 'path';
import { loadEnvConfig, loadPoolConfigs } from './config';
import { createLogger } from './util/logger';
import { createFailoverProvider, getWallet, verifyConnection } from './chain/evm-provider';
import { getPoolContract, getFactoryContract } from './chain/contracts';
import { getChainAddresses } from './config/chain-addresses';
import { PoolMonitor } from './core/pool-monitor';
import { PositionManager } from './core/position-manager';
import { DryRunPositionManager } from './core/dry-run-position-manager';
import { RebalanceEngine, RebalanceContext } from './core/rebalance-engine';
import { BalanceTracker } from './core/balance-tracker';
import { SwapExecutor } from './swap/swap-executor';
import { DryRunSwapExecutor } from './swap/dry-run-swap-executor';
import { EmergencyStop } from './risk/emergency-stop';
import { SlippageGuard } from './risk/slippage-guard';
import { ILTracker } from './risk/il-tracker';
import { StateStore } from './persistence/state-store';
import { HistoryLogger } from './persistence/history-logger';
import { CompositeNotifier, ConsoleNotifier, DryRunNotifier, Notifier } from './notification/notifier';
import { TelegramNotifier } from './notification/telegram-notifier';
import { DiscordNotifier } from './notification/discord-notifier';
import { GasOracle } from './chain/gas-oracle';
import { NonceTracker } from './chain/nonce-tracker';
import { startHealthServer, setDryRunMode } from './health/health-server';

const engines: RebalanceEngine[] = [];

async function main(): Promise<void> {
  const env = loadEnvConfig();
  const logger = createLogger(env.LOG_LEVEL);

  if (env.DRY_RUN) {
    logger.warn('============================================');
    logger.warn('  DRY RUN MODE — no on-chain writes will be executed');
    logger.warn('============================================');
    setDryRunMode(true);
  }

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
  let notifier: Notifier = new CompositeNotifier(notifiers);
  if (env.DRY_RUN) {
    notifier = new DryRunNotifier(notifier);
  }

  // Persistence
  const dataDir = path.resolve(process.cwd(), 'data');
  const stateStore = new StateStore(path.join(dataDir, 'state.json'));
  const historyLogger = new HistoryLogger(path.join(dataDir, 'history.jsonl'));

  // Load pool configs
  const pools = loadPoolConfigs();
  logger.info({ poolCount: pools.length }, 'Loaded pool configurations');

  for (const poolEntry of pools) {
    try {
      // Create failover provider with backup RPCs
      const failoverProvider = createFailoverProvider(
        poolEntry.chain.rpcUrl,
        poolEntry.chain.backupRpcUrls ?? [],
      );

      const provider = failoverProvider.getProvider();
      let wallet = getWallet(env.PRIVATE_KEY, provider);

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

      let poolContract = getPoolContract(poolAddress, wallet);
      const poolMonitor = new PoolMonitor(poolContract, poolEntry.id, poolEntry.monitoring.checkIntervalSeconds * 1000);
      const nonceTracker = env.DRY_RUN
        ? undefined
        : new NonceTracker(wallet.address, () => failoverProvider.getProvider());
      const positionManager = env.DRY_RUN
        ? new DryRunPositionManager(() => wallet, poolEntry.pool.nftManagerAddress)
        : new PositionManager(() => wallet, poolEntry.pool.nftManagerAddress, nonceTracker);
      const swapExecutor = env.DRY_RUN
        ? new DryRunSwapExecutor(() => wallet, poolEntry.pool.swapRouterAddress)
        : new SwapExecutor(() => wallet, poolEntry.pool.swapRouterAddress, nonceTracker);
      const emergencyStop = new EmergencyStop();
      const slippageGuard = new SlippageGuard(poolEntry.strategy.slippageTolerancePercent);
      const ilTracker = new ILTracker();
      const gasOracle = new GasOracle();
      const balanceTracker = new BalanceTracker(() => wallet);

      // Register failover callback to rebuild contracts with new provider
      // Defers if a rebalance is in progress to avoid mixed-provider state
      failoverProvider.setFailoverCallback((fromUrl, toUrl, newProvider) => {
        const applyFailover = () => {
          logger.warn({ poolId: poolEntry.id, from: fromUrl, to: toUrl }, 'RPC failover: reconnecting contracts');
          wallet = getWallet(env.PRIVATE_KEY, newProvider);
          poolContract = getPoolContract(poolAddress, wallet);
          poolMonitor.setPoolContract(poolContract);
          ctx.wallet = wallet;
          nonceTracker?.syncOnFailover().catch((err) => {
            logger.error({ poolId: poolEntry.id, err }, 'Failed to sync nonce on failover');
          });
          notifier.notify(
            `ALERT: RPC failover for ${poolEntry.id}\nSwitched from ${fromUrl} to ${toUrl}`,
          ).catch(() => {});
        };

        if (engine.isRebalancing()) {
          logger.warn({ poolId: poolEntry.id }, 'RPC failover deferred: rebalance in progress');
          const deferInterval = setInterval(() => {
            if (!engine.isRebalancing()) {
              clearInterval(deferInterval);
              applyFailover();
            }
          }, 1000);
          // Safety: don't defer forever (30s max)
          setTimeout(() => {
            clearInterval(deferInterval);
            if (engine.isRebalancing()) {
              logger.error({ poolId: poolEntry.id }, 'RPC failover forced after 30s defer timeout');
            }
            applyFailover();
          }, 30_000);
        } else {
          applyFailover();
        }
      });

      const ctx: RebalanceContext = {
        poolEntry,
        wallet,
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
        maxTotalLossPercent: env.MAX_TOTAL_LOSS_PERCENT,
        nonceTracker,
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
        failoverProvider.recordError();
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
