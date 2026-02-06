# RangeKeeper

Autonomous Uniswap V3 Liquidity Provisioning Bot. Ensures that a specific token (e.g. ZCHF) is always liquid and tradeable on decentralized exchanges.

## Why does this project exist?

For a token to be meaningfully tradeable on a DEX, it needs liquidity. Without sufficient liquidity near the current price, trades suffer from high slippage or are simply not possible. RangeKeeper solves this by permanently providing liquidity within a tight price range around the current market price.

**The goal is not profit maximization — the goal is tradeability.**

## The core problem

On Uniswap V3, liquidity is provided as **positions** — each one an NFT that covers a specific price range. When the market price moves outside that range, the position stops earning fees and the tokens must be repositioned.

A naive approach is: withdraw the position, swap the tokens to the right ratio, open a new position at the current price. But this breaks when the bot is the **sole liquidity provider** in the pool: after withdrawing the single position, the pool has zero liquidity. The swap step becomes impossible because there is nothing to swap against.

**RangeKeeper solves this with the 7-band model.**

## How does it work?

### 1. Initial setup

The wallet is funded once with both tokens of the pair (e.g. USDT + ZCHF). On first start, the bot splits the total price range into **7 contiguous bands** (each its own Uniswap V3 NFT position) and mints all 7:

```
 Lower                                                        Upper
   [Band 0] [Band 1] [Band 2] [Band 3] [Band 4] [Band 5] [Band 6]
                                   ↑
                              Current Price
```

Each band covers `rangeWidthPercent / 7` of the total range. Example: 3% total range = ~0.43% per band.

### 2. Monitoring

The bot polls the pool price at a configurable interval. Depending on which band the price is in, it decides:

| Price location | Action |
|----------------|--------|
| **Bands 2–4** (safe zone) | Do nothing. Price is near center. |
| **Band 1** (lower trigger) | Rebalance: price is drifting down. |
| **Band 5** (upper trigger) | Rebalance: price is drifting up. |
| **Bands 0 or 6** (buffer) | Already handled — rebalance was triggered at band 1/5. These exist as buffer in case the price moves fast between two polling cycles. |

### 3. Rebalancing

When the price enters a trigger band, the bot dissolves the band on the **opposite end** — the one furthest from where the price is heading. That band is the least useful: it covers a price range the market is moving away from.

Example — price drifts down into Band 1:

```
 Before:  [0] [1] [2] [3] [4] [5] [6]
                ↑ price here              → dissolve Band 6 (furthest away)

 Step 1:  [0] [1] [2] [3] [4] [5]        Band 6 removed, tokens in wallet
 Step 2:  Swap token0 → token1            6 remaining bands provide liquidity!
 Step 3:  [new] [0] [1] [2] [3] [4] [5]  Mint new band below Band 0

 After:   7 bands again, shifted one position lower
```

This is the key insight: **6 out of 7 bands remain in the pool during the swap**, so the pool always has liquidity. Per rebalance, only 1 band is removed and 1 is minted.

### 4. Closed loop

The tokens never leave the system. They are continuously recycled between positions. Accrued trading fees flow back into the next position. No additional capital is ever injected — only the ratio between the two tokens changes depending on the current market price.

As long as the token price moves within an economically reasonable range, the bot can run indefinitely.

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
      feeTier: 100                        # 0.01% fee tier (Uniswap V3 convention: 100 = 0.01%)
      nftManagerAddress: "0xC36442b4a4522E871399CD717aBDD847Ab11FE88"
      swapRouterAddress: "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45"
    strategy:
      rangeWidthPercent: 3.0              # total range width (split across 7 bands)
      minRebalanceIntervalMinutes: 30     # min 30 min between rebalances
      maxGasCostUsd: 5.0                  # max gas cost per rebalance
      slippageTolerancePercent: 0.5       # max slippage for swaps
      expectedPriceRatio: 1.0             # expected price ratio (e.g. 1.0 for stablecoin pairs)
      depegThresholdPercent: 5            # max deviation from expected ratio before emergency stop
    monitoring:
      checkIntervalSeconds: 30            # poll pool price every 30s
```

## Running

### Development

```bash
npm run dev
```

### Dry run (no on-chain transactions)

```bash
DRY_RUN=true npm run dev
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

### Lifecycle overview

```
First start          Normal operation              Price drifts into trigger band
     │                      │                                │
     ▼                      ▼                                ▼
 Mint 7 bands  ──▶  MONITORING  ──▶  Price in safe zone? ── yes ──▶ do nothing
                         ▲               │
                         │              no
                         │               │
                         │               ▼
                         │         EVALUATING (gas check)
                         │               │
                         │               ▼
                         │         WITHDRAWING (dissolve opposite band)
                         │               │
                         │               ▼
                         │         SWAPPING (through own pool, 6 bands active)
                         │               │
                         │               ▼
                         │         MINTING (new band on price-moving side)
                         │               │
                         └───────────────┘
                              7 bands again
```

### 7-Band Model

The total range (`rangeWidthPercent`) is divided into 7 equal bands, each its own Uniswap V3 NFT position. Band width per band = `rangeWidthPercent / 7` (e.g. 3% total = ~0.43% per band).

| Band Index | Role | When price enters |
|------------|------|-------------------|
| 0 | Buffer lower | Already handled — rebalance triggered at band 1 |
| 1 | **Lower trigger** | Dissolve band 6, swap, mint new band below 0 |
| 2–4 | **Safe zone** | No action needed |
| 5 | **Upper trigger** | Dissolve band 0, swap, mint new band above 6 |
| 6 | Buffer upper | Already handled — rebalance triggered at band 5 |

### Band rebalance flow

1. **Dissolve** opposite band: `decreaseLiquidity()` + `collect()` + `burn()`
2. **Swap** through own pool (6 remaining bands provide liquidity)
3. **Mint** new band at the direction the price is moving
4. **Persist** state to disk, send notification

Per rebalance: 1 remove + 1 swap + 1 mint. Always 7 bands after completion.

### Risk Management

| Condition | Threshold | Action |
|-----------|-----------|--------|
| Portfolio value loss | >10% from start | Close all 7 bands, stop bot |
| Single rebalance loss | >2% | Pause, alert |
| Consecutive TX errors | >3 in a row | Pause, alert |
| Gas spike | >10x normal | Pause rebalancing |
| Token depeg | >5% from expected ratio | Emergency withdraw all bands, stop bot |

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
