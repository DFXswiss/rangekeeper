# RangeKeeper

Autonomous Uniswap V3 Concentrated Liquidity Management Bot. Platziert Liquidität in einer engen Price Range (±2-5%) um den aktuellen Marktpreis und repositioniert automatisch wenn sich der Preis bewegt.

**Ziel:** Kapitalerhalt (~$200k bleiben ~$200k), nicht Gewinnmaximierung.

## Setup

### Voraussetzungen

- Node.js 20+
- Docker (für Produktion)

### Installation

```bash
npm install
cp .env.example .env
```

### Konfiguration

#### `.env`

| Variable | Beschreibung | Pflicht |
|----------|-------------|---------|
| `PRIVATE_KEY` | Wallet Private Key (0x...) | Ja |
| `ETHEREUM_RPC_URL` | Ethereum RPC Endpoint | Je nach Pool |
| `POLYGON_RPC_URL` | Polygon RPC Endpoint | Je nach Pool |
| `TELEGRAM_BOT_TOKEN` | Telegram Bot Token | Nein |
| `TELEGRAM_CHAT_ID` | Telegram Chat ID | Nein |
| `DISCORD_WEBHOOK_URL` | Discord Webhook URL | Nein |
| `LOG_LEVEL` | Log Level (trace/debug/info/warn/error) | Nein (default: info) |
| `HEALTH_PORT` | Health Server Port | Nein (default: 3000) |
| `MAX_TOTAL_LOSS_PERCENT` | Max Portfolio-Verlust bevor Bot stoppt | Nein (default: 10) |

#### `config/pools.yaml`

Pool-Konfigurationen mit Token-Adressen, Fee Tier, Strategy-Parametern und Monitoring-Intervallen. Umgebungsvariablen können mit `${VAR_NAME}` referenziert werden.

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
      rangeWidthPercent: 3.0            # ±1.5% um aktuellen Preis
      rebalanceThresholdPercent: 80      # Rebalance bei 80% der Range
      minRebalanceIntervalMinutes: 30    # Min. 30 Min zwischen Rebalances
      maxGasCostUsd: 5.0                 # Max Gas-Kosten pro Rebalance
      slippageTolerancePercent: 0.5      # Max Slippage
    monitoring:
      checkIntervalSeconds: 30           # Pool-Preis alle 30s prüfen
```

## Betrieb

### Development

```bash
npm run dev
```

### Produktion (Docker)

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

## Architektur

### Rebalance State Machine

```
IDLE → MONITORING → EVALUATING → WITHDRAWING → SWAPPING → MINTING → MONITORING
```

**Rebalance wird getriggert wenn:**
- Preis 80% der Range-Grenze erreicht (konfigurierbar)
- Preis komplett out of range ist

**Rebalance wird übersprungen wenn:**
- Gas-Kosten zu hoch UND nicht komplett out of range
- Min. Intervall seit letztem Rebalance nicht erreicht

**Rebalance-Ablauf:**
1. `decreaseLiquidity()` + `collect()` + `burn()`
2. Neuen Pool State lesen, neue Range berechnen
3. Token-Ratio berechnen, ggf. Swap
4. `mint()` mit neuer Range
5. State persistieren, Notification senden

### Risk Management

| Bedingung | Schwelle | Aktion |
|-----------|----------|--------|
| Portfolio-Wertverlust | >10% vom Start | Position schliessen, Bot stoppen |
| Einzelner Rebalance-Verlust | >2% | Pausieren, Alert |
| Konsekutive TX-Fehler | >3 in Folge | Pausieren, Alert |
| Gas-Spike | >10x normal | Rebalancing pausieren |

### Health Endpoints

- `GET /health` — Liveness Check
- `GET /status` — Detaillierter Bot-Status mit allen Pool-Positionen

## Projektstruktur

```
src/
├── main.ts                     # Entry Point, Multi-Pool Loop, Graceful Shutdown
├── config/                     # Env Validation (zod), YAML Pool Config, Chain Addresses
├── core/
│   ├── pool-monitor.ts         # Pollt Pool-Preis, erkennt Out-of-Range
│   ├── position-manager.ts     # Mint, Remove, Collect, Burn via NFT Manager
│   ├── range-calculator.ts     # Berechnet optimale Tick Range
│   ├── rebalance-engine.ts     # State Machine, Orchestrierung
│   └── balance-tracker.ts      # Portfolio-Wert Tracking
├── chain/                      # ethers.js Provider, Contract Factories, Gas Oracle
├── swap/                       # Token Swaps via SwapRouter02, Ratio Berechnung
├── risk/                       # Emergency Stop, Slippage Guard, IL Tracker
├── notification/               # Telegram, Discord, Console Notifier
├── persistence/                # State (JSON), History (JSONL)
├── health/                     # Express /health + /status
└── util/                       # Logger (pino), Retry, Tick Math, Formatting
```
