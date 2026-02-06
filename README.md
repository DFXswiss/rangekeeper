# RangeKeeper

Autonomous Uniswap V3 Liquidity Provisioning Bot. Ensures that a specific token (e.g. ZCHF) is always liquid and tradeable on decentralized exchanges.

## Why does this project exist?

For a token to be meaningfully tradeable on a DEX, it needs liquidity. Without sufficient liquidity near the current price, trades suffer from high slippage or are simply not possible.

RangeKeeper exists for a specific scenario: **a token issuer wants their token to be tradeable on Uniswap V3, and is willing to provide liquidity themselves.** The typical case is a stablecoin (e.g. ZCHF) paired with another stablecoin (e.g. USDT). The issuer funds a wallet once, and the bot takes over from there — keeping liquidity available 24/7, indefinitely, without manual intervention.

**The goal is not profit maximization — the goal is tradeability.** The bot accepts impermanent loss and swap fees as the cost of keeping the token liquid. Accrued trading fees partially offset these costs, but the economic model is not designed around profit.

## The core problem

On Uniswap V3, liquidity is provided as **positions** — each one an NFT that covers a specific price range. When the market price moves outside that range, the position stops earning fees and the tokens must be repositioned.

A naive rebalance approach would be:
1. Withdraw the single position (get all tokens back)
2. Swap the tokens to the correct ratio for the new price range
3. Open a new position centered around the current price

This works if other liquidity providers exist in the pool. But RangeKeeper is designed for pools where the **bot is the only LP** — a common situation for newly launched or niche tokens. In this case, step 2 fails: after withdrawing the single position, the pool has zero liquidity, and there is nothing to swap against.

Using an external pool or DEX aggregator for the swap is not an option either — the token we're providing liquidity for may not have meaningful liquidity elsewhere. That's precisely why we're running this bot.

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

**Why 7 bands?** This is a trade-off between three factors:

- **Too few bands** (e.g. 3): After dissolving 1, only 2 remain. That leaves very thin liquidity for the swap step, increasing slippage.
- **Too many bands** (e.g. 15): Initial setup costs more gas (15 mint transactions). Each band holds less liquidity, making individual bands very thin. Diminishing returns on the safety margin.
- **7 bands** is the sweet spot: dissolving 1 leaves 6 active (85% of liquidity intact), the safe zone (3 bands) provides a comfortable buffer before rebalancing, and initial gas costs stay reasonable (7 mints).

**Why contiguous (gapless) bands?** Every price point within the total range is covered by exactly one band. This means traders always find liquidity regardless of where the price is within the range — there are no dead zones.

### 2. Monitoring

The bot polls the pool price at a configurable interval (default: every 30 seconds). Depending on which band the price is in, it decides:

| Price location | Action |
|----------------|--------|
| **Bands 2–4** (safe zone) | Do nothing. Price is near center. |
| **Band 1** (lower trigger) | Rebalance: price is drifting down. |
| **Band 5** (upper trigger) | Rebalance: price is drifting up. |
| **Bands 0 or 6** (buffer) | Already handled — rebalance was triggered at band 1/5. |

**Why 3 safe bands and 2 trigger bands?** The safe zone (bands 2–4) needs to be wide enough that normal price fluctuations don't trigger unnecessary rebalances — each rebalance costs gas and introduces slippage. Three center bands provide a comfortable margin: the price can fluctuate by ~1.3% (at 3% total range) without any action.

**Why buffer bands (0 and 6)?** The bot polls at intervals (e.g. every 30s). If the price jumps from the safe zone past the trigger band in one interval, it lands in the buffer band. Without the buffer, the price would be outside the total range entirely — meaning zero liquidity for trades. Bands 0 and 6 ensure the pool still has liquidity even if the price moves faster than the polling interval.

**Why poll-based instead of on-chain events?** Simplicity and reliability. Event-based monitoring requires a persistent WebSocket connection and complex retry logic. Polling at 30-second intervals is good enough for stablecoin pairs where the price moves slowly, and it recovers naturally from RPC outages — the next poll simply picks up the current state.

### 3. Rebalancing

When the price enters a trigger band, the bot dissolves the band on the **opposite end** — the one furthest from where the price is heading.

**Why the opposite band?** Three reasons:

1. **It's the least useful.** If the price is in band 1 (drifting down), band 6 covers the highest price range — exactly where the market is moving *away* from. Dissolving it has no impact on current trading.
2. **It provides the right tokens.** On Uniswap V3, a band far above the current price holds mostly token0 (the "base" token). A band far below holds mostly token1. Dissolving the opposite band yields exactly the tokens we need to swap for the new band on the other side.
3. **It avoids disruption.** All bands near the current price (where trading happens) remain untouched.

Example — price drifts down into Band 1:

```
 Before:  [0] [1] [2] [3] [4] [5] [6]
                ↑ price here              → dissolve Band 6 (furthest away)

 Step 1:  [0] [1] [2] [3] [4] [5]        Band 6 removed, tokens in wallet
 Step 2:  Swap token0 → token1            6 remaining bands provide liquidity!
 Step 3:  [new] [0] [1] [2] [3] [4] [5]  Mint new band below Band 0

 After:   7 bands again, shifted one position lower
```

**Why swap through the own pool?** This is the entire point of the 7-band architecture. After dissolving 1 band, 6 remain active in the pool. These 6 bands provide enough liquidity for the swap. No external DEX, no aggregator, no dependency on third-party liquidity. The system is fully self-contained.

The swap does create temporary price impact in the pool. This is by design — the assumption is that external arbitrage traders will correct the price shortly after. See [Important assumption](#important-assumption) below.

**What about gas costs?** Each rebalance is 3 transactions: 1 remove + 1 swap + 1 mint. This is the same cost as the naive single-position approach — the 7-band model adds no overhead per rebalance. The only additional cost is the initial setup (7 mints instead of 1), which is a one-time expense.

### 4. Closed loop

The tokens never leave the system. They are continuously recycled between positions. Accrued trading fees flow back into the next position. No additional capital is ever injected — only the ratio between the two tokens changes depending on the current market price.

**What degrades over time?** Impermanent loss. Every rebalance involves a swap, and every swap has slippage. Over many rebalances, the total value of the portfolio slowly decreases compared to simply holding both tokens. This is acceptable because the goal is tradeability, not profit. The `MAX_TOTAL_LOSS_PERCENT` parameter (default: 10%) defines when the bot stops to prevent excessive loss.

As long as the token price moves within an economically reasonable range, the bot can run indefinitely.

### Important assumption

RangeKeeper **only provides liquidity** — it does not ensure price correctness. The project assumes that at least one active arbitrage trader exists in the market who keeps the pool price aligned with the true market price.

This matters especially during rebalancing: the swap step creates temporary price impact in the pool. If no arbitrageur corrects this, the pool price drifts from the market price, and subsequent trades happen at an incorrect price. For popular stablecoin pairs, this assumption holds — arbitrage bots operate on all major DEX pools. For very niche tokens, this risk should be considered.

### Depeg protection

For stablecoin pairs, the bot monitors the price ratio against an expected value (e.g. 1.0 for USDT/ZCHF). If the price deviates beyond a threshold (default: 5%), the bot assumes a **depeg event** — one of the tokens has lost its peg. In this case, continuing to provide liquidity would mean accepting trades at a broken price.

The bot responds by immediately withdrawing all 7 bands and stopping. This is a safety measure to protect the remaining capital. Manual intervention is required to restart after a depeg event.

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

The dry-run mode simulates all on-chain operations (mint, remove, swap) without actually sending transactions. Useful for verifying configuration and monitoring behavior before going live.

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

### Crash recovery

The bot persists its state (band positions, rebalance stage, pending TX hashes) to disk after every operation. If the bot crashes mid-rebalance, it recovers on restart:

- **Crash after withdraw, before mint**: State shows stage `WITHDRAWN`. The bot detects this, clears the stale bands, and mints fresh 7 bands on the next price update.
- **Crash after swap, before mint**: State shows stage `SWAPPED`. Same recovery — clear and re-mint.
- **Pending transactions**: On startup, the bot checks pending TX hashes against on-chain receipts to determine if they were confirmed or reverted.

This ensures no funds are lost even in worst-case crash scenarios. The trade-off is that a crash during rebalance may result in a brief period without liquidity until the bot restarts and re-mints.

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
