# RangeKeeper

Autonomous Uniswap V3 Liquidity Provisioning Bot. Ensures that a specific token (e.g. ZCHF) is always liquid and tradeable on decentralized exchanges.

## Why does this project exist?

For a token to be meaningfully tradeable on a DEX, it needs liquidity. Without sufficient liquidity near the current price, trades suffer from high slippage or are simply not possible. RangeKeeper solves this by permanently providing Concentrated Liquidity within a tight price range (±2-5%) around the current market price.

**The goal is not profit maximization — the goal is tradeability.**

The bot is an autonomous market maker for a specific token.

## How does it work?

RangeKeeper is a **self-contained economic system**:

1. **One-time funding** — The wallet is funded once with both tokens of the pair (e.g. USDT + ZCHF). No additional capital is ever injected.

2. **Autonomous repositioning** — The bot places the tokens as a Concentrated Liquidity position on Uniswap V3. When the price moves and the position falls out of range, the bot withdraws the liquidity, rebalances the token ratio via a swap, and opens a new position centered around the current price.

3. **Closed loop** — The tokens never leave the system. They are continuously recycled in an endless loop:

   ```
   Position → Withdraw → Swap (adjust ratio) → new Position → ...
   ```

   Accrued trading fees flow back into the next position. The total capital stays within the system — only the ratio between the two tokens changes depending on the current market price.

4. **Unlimited runtime** — As long as the token price moves within an economically reasonable range, the bot can theoretically run indefinitely. There are no external dependencies, no capital injections, no manual intervention required.

## Setup

### Prerequisites

- Node.js 20+
- Docker (for production)

### Installation

```bash
npm install
cp .env.example .env
```

### Configuration

#### `.env`

| Variable | Description | Required |
|----------|-------------|----------|
| `PRIVATE_KEY` | Wallet Private Key (0x...) | Yes |
| `ETHEREUM_RPC_URL` | Ethereum RPC Endpoint | Depends on pool |
| `POLYGON_RPC_URL` | Polygon RPC Endpoint | Depends on pool |
| `TELEGRAM_BOT_TOKEN` | Telegram Bot Token | No |
| `TELEGRAM_CHAT_ID` | Telegram Chat ID | No |
| `DISCORD_WEBHOOK_URL` | Discord Webhook URL | No |
| `LOG_LEVEL` | Log Level (trace/debug/info/warn/error) | No (default: info) |
| `HEALTH_PORT` | Health Server Port | No (default: 3000) |
| `DRY_RUN` | Simulate without on-chain writes (true/false) | No (default: false) |
| `MAX_TOTAL_LOSS_PERCENT` | Max portfolio loss before bot stops | No (default: 10) |

#### `config/pools.yaml`

Pool configurations with token addresses, fee tier, strategy parameters and monitoring intervals. Environment variables can be referenced with `${VAR_NAME}`.

```yaml
pools:
  - id: "usdt-zchf-ethereum"
    chain:
      name: "ethereum"
      chainId: 1
      rpcUrl: "${ETHEREUM_RPC_URL}"
    pool:
      token0:
        address: "0xdAC17F958D2ee523a2206206994597C13D831ec7"
        symbol: "USDT"
        decimals: 6
      token1:
        address: "0xB58906E27d85EFC9DD6f15A0234dF2e2a23e5847"
        symbol: "ZCHF"
        decimals: 18
      feeTier: 100
      nftManagerAddress: "0xC36442b4a4522E871399CD717aBDD847Ab11FE88"
      swapRouterAddress: "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45"
    strategy:
      rangeWidthPercent: 3.0            # ±1.5% around current price
      rebalanceThresholdPercent: 80      # rebalance at 80% of range
      minRebalanceIntervalMinutes: 30    # min 30 min between rebalances
      maxGasCostUsd: 5.0                 # max gas cost per rebalance
      slippageTolerancePercent: 0.5      # max slippage
    monitoring:
      checkIntervalSeconds: 30           # poll pool price every 30s
```

## Running

### Development

```bash
npm run dev
```

### Production (Docker)

```bash
docker compose up -d
```

### Build

```bash
npm run build
npm start
```

### Tests

```bash
npm test
```

## Architecture

### Rebalance State Machine

```
IDLE → MONITORING → EVALUATING → WITHDRAWING → SWAPPING → MINTING → MONITORING
```

**Rebalance is triggered when:**
- Price reaches 80% of the range boundary (configurable)
- Price is completely out of range

**Rebalance is skipped when:**
- Gas cost too high AND not completely out of range
- Minimum interval since last rebalance not yet reached

**Rebalance flow:**
1. `decreaseLiquidity()` + `collect()` + `burn()`
2. Fetch fresh pool state, calculate new range
3. Calculate token ratio, swap if needed
4. `mint()` with new range
5. Persist state, send notification

### Risk Management

| Condition | Threshold | Action |
|-----------|-----------|--------|
| Portfolio value loss | >10% from start | Close position, stop bot |
| Single rebalance loss | >2% | Pause, alert |
| Consecutive TX errors | >3 in a row | Pause, alert |
| Gas spike | >10x normal | Pause rebalancing |
| Token depeg | >5% from expected price | Emergency withdraw, stop bot |

### Health Endpoints

- `GET /health` — Liveness check
- `GET /status` — Detailed bot status with all pool positions

## Project Structure

```
src/
├── main.ts                     # Entry point, multi-pool loop, graceful shutdown
├── config/                     # Env validation (zod), YAML pool config, chain addresses
├── core/
│   ├── pool-monitor.ts         # Polls pool price, detects out-of-range
│   ├── position-manager.ts     # Mint, remove, collect, burn via NFT Manager
│   ├── range-calculator.ts     # Calculates optimal tick range
│   ├── rebalance-engine.ts     # State machine, orchestration
│   └── balance-tracker.ts      # Portfolio value tracking
├── chain/                      # ethers.js provider, contract factories, gas oracle
├── swap/                       # Token swaps via SwapRouter02, ratio calculation
├── risk/                       # Emergency stop, slippage guard, IL tracker
├── notification/               # Telegram, Discord, console notifier
├── persistence/                # State (JSON), history (JSONL)
├── health/                     # Express /health + /status
└── util/                       # Logger (pino), retry, tick math, formatting
```
