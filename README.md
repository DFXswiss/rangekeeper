# RangeKeeper

Autonomous Uniswap V3 Liquidity Provisioning Bot. Ensures that a specific token (e.g. ZCHF) is always liquid and tradeable on decentralized exchanges.

## Why does this project exist?

For a token to be meaningfully tradeable on a DEX, it needs liquidity. Without sufficient liquidity near the current price, trades suffer from high slippage or are simply not possible. RangeKeeper solves this by permanently providing Concentrated Liquidity within a tight price range (±2-5%) around the current market price.

**The goal is not profit maximization — the goal is tradeability.**

The bot is an autonomous market maker for a specific token.

## How does it work?

RangeKeeper is a **self-contained economic system**:

1. **One-time funding** — The wallet is funded once with both tokens of the pair (e.g. USDT + ZCHF). No additional capital is ever injected.

2. **7-band model** — Instead of a single Uniswap V3 position, the bot creates **7 contiguous NFT positions** (bands) covering the full price range. This is critical when the bot is the sole LP: removing a single position would leave the pool with zero liquidity, making swaps impossible.

   ```
   [Band 0] [Band 1] [Band 2] [Band 3] [Band 4] [Band 5] [Band 6]
                                  ↑ Price
   ```

   - **Safe zone** (Bands 2–4): Price is near center, no action needed.
   - **Trigger zone** (Band 1 or 5): Price is drifting — rebalance is triggered.

3. **Autonomous repositioning** — When the price enters a trigger band, the bot dissolves the band on the opposite end, swaps through the pool (6 remaining bands still provide liquidity), and mints a new band on the side the price is moving towards.

   ```
   Price drifts down into Band 1:
     → Dissolve Band 6 (opposite end)
     → Swap token0 → token1 (6 bands provide liquidity)
     → Mint new Band below Band 0
     → Still 7 bands, shifted downward
   ```

4. **Closed loop** — The tokens never leave the system. They are continuously recycled. Accrued trading fees flow back into the next position. The total capital stays within the system — only the ratio between the two tokens changes depending on the current market price.

5. **Unlimited runtime** — As long as the token price moves within an economically reasonable range, the bot can theoretically run indefinitely. There are no external dependencies, no capital injections, no manual intervention required.

### Important assumption

RangeKeeper **only provides liquidity** — it does not ensure price correctness. The project assumes that at least one active arbitrage trader exists in the market who keeps the pool price aligned with the true market price. Without external arbitrage, the pool price could drift and the bot would continue providing liquidity at an incorrect price.

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
      rangeWidthPercent: 3.0            # total range width (split across 7 bands)
      minRebalanceIntervalMinutes: 30    # min 30 min between rebalances
      maxGasCostUsd: 5.0                 # max gas cost per rebalance
      slippageTolerancePercent: 0.5      # max slippage
      expectedPriceRatio: 1.0            # expected price ratio (for depeg detection)
      depegThresholdPercent: 5           # max deviation before emergency stop
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

### 7-Band Model

The total range (`rangeWidthPercent`) is divided into 7 equal bands, each its own Uniswap V3 NFT position. Band width per band = `rangeWidthPercent / 7` (e.g. 3% total = ~0.43% per band).

| Band Index | Role | Action when price enters |
|------------|------|--------------------------|
| 0 | Outer lower | No direct trigger (beyond band 1) |
| 1 | **Lower trigger** | Dissolve band 6, swap, mint new band below 0 |
| 2–4 | **Safe zone** | No action |
| 5 | **Upper trigger** | Dissolve band 0, swap, mint new band above 6 |
| 6 | Outer upper | No direct trigger (beyond band 5) |

### Rebalance State Machine

```
IDLE → MONITORING → EVALUATING → WITHDRAWING → SWAPPING → MINTING → MONITORING
```

**Rebalance is triggered when:**
- Price enters band 1 (lower trigger) or band 5 (upper trigger)

**Rebalance is skipped when:**
- Price is in safe zone (bands 2–4)
- Minimum interval since last rebalance not yet reached

**Band rebalance flow:**
1. Dissolve opposite band: `decreaseLiquidity()` + `collect()` + `burn()`
2. Swap through own pool (6 remaining bands provide liquidity)
3. Mint new band at the direction the price is moving
4. Update BandManager state, persist to disk, send notification

Per rebalance: 1 remove + 1 swap + 1 mint. Always 7 bands after completion.

### Risk Management

| Condition | Threshold | Action |
|-----------|-----------|--------|
| Portfolio value loss | >10% from start | Close all bands, stop bot |
| Single rebalance loss | >2% | Pause, alert |
| Consecutive TX errors | >3 in a row | Pause, alert |
| Gas spike | >10x normal | Pause rebalancing |
| Token depeg | >5% from expected price | Emergency withdraw all bands, stop bot |

### Health Endpoints

- `GET /health` — Liveness check
- `GET /status` — Detailed bot status with band positions and active band index

## Project Structure

```
src/
├── main.ts                         # Entry point, multi-pool loop, graceful shutdown
├── config/                         # Env validation (zod), YAML pool config, chain addresses
├── core/
│   ├── band-manager.ts             # Band state, safe/trigger zone logic, rebalance decisions
│   ├── pool-monitor.ts             # Polls pool price, emits priceUpdate events
│   ├── position-manager.ts         # Mint, remove, collect, burn via NFT Manager
│   ├── dry-run-position-manager.ts # Virtual positions for dry-run mode
│   ├── range-calculator.ts         # Tick range and 7-band layout calculation
│   ├── rebalance-engine.ts         # State machine, orchestration, band lifecycle
│   └── balance-tracker.ts          # Portfolio value tracking
├── chain/                          # ethers.js provider, contract factories, gas oracle
├── swap/                           # Token swaps via SwapRouter02, ratio calculation
├── risk/                           # Emergency stop, slippage guard, IL tracker
├── notification/                   # Telegram, Discord, console notifier
├── persistence/                    # State (JSON) with band persistence, history (JSONL)
├── health/                         # Express /health + /status with band info
└── util/                           # Logger (pino), retry, tick math, formatting
```
