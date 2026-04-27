import express from 'express';
import { getLogger } from '../util/logger';

export interface BotStatus {
  uptime: number;
  pools: PoolStatus[];
  lastError?: string;
  dryRun: boolean;
}

export interface BandStatus {
  index: number;
  tokenId?: number;
  tickLower?: number;
  tickUpper?: number;
}

export interface PoolStatus {
  id: string;
  state: string;
  currentTick?: number;
  bands?: BandStatus[];
  activeBand?: number;
  lastRebalance?: string;
  portfolioValueUsd?: number;
  consecutiveErrors?: number;
  emergencyStopped?: boolean;
  emergencyReason?: string;
  walletAddress?: string;
  chainId?: number;
  poolAddress?: string;
  token0Symbol?: string;
  token1Symbol?: string;
}

const botStatus: BotStatus = {
  uptime: 0,
  pools: [],
  dryRun: false,
};

const startTime = Date.now();

export function updatePoolStatus(poolId: string, status: Partial<PoolStatus>): void {
  const existing = botStatus.pools.find((p) => p.id === poolId);
  if (existing) {
    Object.assign(existing, status);
  } else {
    botStatus.pools.push({ id: poolId, state: 'initializing', ...status });
  }
}

export function updateBotError(error: string): void {
  botStatus.lastError = error;
}

export function getBotStatus(): BotStatus {
  return { ...botStatus, uptime: Math.floor((Date.now() - startTime) / 1000) };
}

export function setDryRunMode(enabled: boolean): void {
  botStatus.dryRun = enabled;
}

export function startHealthServer(port: number): void {
  const logger = getLogger();
  const app = express();

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', uptime: Math.floor((Date.now() - startTime) / 1000) });
  });

  app.get('/status', (_req, res) => {
    res.json(getBotStatus());
  });

  app.get('/dashboard', (_req, res) => {
    res.type('html').send(getDashboardHtml());
  });

  app.listen(port, () => {
    logger.info({ port }, 'Health server listening');
  });
}

function getDashboardHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>RangeKeeper Dashboard</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif; background: #0a0a0a; color: #e0e0e0; padding: 24px; max-width: 960px; margin: 0 auto; }
  h1 { font-size: 1.5rem; margin-bottom: 8px; }
  .subtitle { color: #888; font-size: 0.85rem; margin-bottom: 24px; }
  .card { background: #161616; border: 1px solid #2a2a2a; border-radius: 8px; padding: 20px; margin-bottom: 16px; }
  .card h2 { font-size: 1.1rem; margin-bottom: 12px; color: #fff; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 12px; }
  .metric { background: #1a1a1a; border-radius: 6px; padding: 12px; }
  .metric .label { font-size: 0.75rem; color: #888; text-transform: uppercase; letter-spacing: 0.05em; }
  .metric .value { font-size: 1.3rem; font-weight: 600; margin-top: 4px; font-variant-numeric: tabular-nums; }
  .ok { color: #4ade80; }
  .warn { color: #fbbf24; }
  .error { color: #f87171; }
  .muted { color: #666; }
  .band-cell { width: 100%; height: 18px; border-radius: 3px; }
  .band-cell.buffer { background: #1e293b; }
  .band-cell.trigger { background: #312e81; }
  .band-cell.safe { background: #14532d; }
  .band-cell.active { outline: 2px solid #fff; outline-offset: -1px; }
  .links { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 8px; }
  .links a { color: #60a5fa; text-decoration: none; font-size: 0.85rem; padding: 4px 10px; background: #1e293b; border-radius: 4px; }
  .links a:hover { background: #2d3a4f; }
  table { width: 100%; border-collapse: collapse; font-size: 0.85rem; }
  th { text-align: left; color: #888; font-weight: 500; padding: 6px 8px; border-bottom: 1px solid #2a2a2a; }
  td { padding: 6px 8px; border-bottom: 1px solid #1a1a1a; font-variant-numeric: tabular-nums; }
  #error-banner { display: none; background: #7f1d1d; border: 1px solid #991b1b; border-radius: 8px; padding: 16px; margin-bottom: 16px; }
  #loading { color: #888; text-align: center; padding: 48px; }
  .refresh-info { color: #555; font-size: 0.75rem; text-align: right; margin-top: 8px; }
</style>
</head>
<body>
<div style="display:flex;align-items:center;justify-content:space-between">
<div><h1>RangeKeeper</h1><p class="subtitle">Autonomous Uniswap V3 Liquidity Provisioning</p></div>
<a href="https://github.com/DFXswiss/rangekeeper" style="color:#888;text-decoration:none" title="GitHub"><svg width="28" height="28" viewBox="0 0 16 16" fill="currentColor"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg></a>
</div>

<div id="error-banner"></div>
<div id="loading">Loading...</div>
<div id="content" style="display:none">

<div class="card">
  <h2>Bot Status</h2>
  <div class="grid">
    <div class="metric"><div class="label">Status</div><div class="value" id="bot-state">-</div></div>
    <div class="metric"><div class="label">Uptime</div><div class="value" id="bot-uptime">-</div></div>
    <div class="metric"><div class="label">Mode</div><div class="value" id="bot-mode">-</div></div>
    <div class="metric"><div class="label">Errors</div><div class="value" id="bot-errors">-</div></div>
  </div>
</div>

<div id="pools-container"></div>

</div>

<div class="refresh-info">Auto-refreshes every 30s</div>

<script>
const ZONE_LABELS = ['Buffer', 'Trigger', 'Safe', 'Safe', 'Safe', 'Trigger', 'Buffer'];
const ZONE_CLASSES = ['buffer', 'trigger', 'safe', 'safe', 'safe', 'trigger', 'buffer'];

function formatUptime(s) {
  if (s < 60) return s + 's';
  if (s < 3600) return Math.floor(s/60) + 'm ' + (s%60) + 's';
  const h = Math.floor(s/3600);
  const m = Math.floor((s%3600)/60);
  return h + 'h ' + m + 'm';
}

function tickToPrice(tick) {
  return Math.pow(1.0001, tick);
}

function formatNumber(n) {
  var parts = n.split('.');
  parts[0] = parts[0].replace(/\\B(?=(\\d{3})+(?!\\d))/g, "'");
  return parts.join('.');
}

function formatPrice(price) {
  if (price < 0.01) {
    var inv = 1 / price;
    return formatNumber(inv.toFixed(0));
  }
  if (price < 1) return price.toFixed(6);
  if (price < 1000) return formatNumber(price.toFixed(2));
  return formatNumber(price.toFixed(0));
}

function formatPriceLabel(pool) {
  const tick = pool.currentTick;
  if (tick === undefined) return '';
  const raw = tickToPrice(tick);
  if (raw < 0.01) return pool.token0Symbol + '/' + pool.token1Symbol;
  return pool.token1Symbol + '/' + pool.token0Symbol;
}

function explorerUrl(chainId, type, address) {
  if (chainId === 4114) return 'https://citreascan.com/' + type + '/' + address;
  return 'https://etherscan.io/' + type + '/' + address;
}

function poolUrl(chainId, poolAddress) {
  if (chainId === 4114) return 'https://juiceswap.com/explore/pools/citrea_mainnet/' + poolAddress;
  return 'https://app.uniswap.org/explore/pools/' + poolAddress;
}

function renderPool(pool) {
  const stopped = pool.emergencyStopped;
  const stateClass = stopped ? 'error' : pool.state === 'MONITORING' ? 'ok' : 'warn';
  const stateText = stopped ? 'STOPPED' : pool.state;
  const bandCount = (pool.bands || []).length;
  const wallet = pool.walletAddress || '-';
  const chainId = pool.chainId || 1;
  const poolAddr = pool.poolAddress || '';

  let html = '<div class="card"><h2>' + (pool.token0Symbol||'?') + ' / ' + (pool.token1Symbol||'?') + ' <span class="muted" style="font-size:0.8rem">(' + pool.id + ')</span></h2>';

  html += '<div class="grid">';
  html += '<div class="metric"><div class="label">Engine State</div><div class="value ' + stateClass + '">' + stateText + '</div></div>';
  html += '<div class="metric"><div class="label">Bands</div><div class="value ' + (bandCount===7?'ok':'warn') + '">' + bandCount + ' / 7</div></div>';
  html += '<div class="metric"><div class="label">Active Band</div><div class="value">' + (pool.activeBand !== undefined ? (pool.activeBand + 1) + ' (' + ZONE_LABELS[pool.activeBand] + ')' : '-') + '</div></div>';
  html += '<div class="metric"><div class="label">Current Price</div><div class="value">' + (pool.currentTick !== undefined ? formatPrice(tickToPrice(pool.currentTick)) + ' ' + formatPriceLabel(pool) : '-') + '</div></div>';
  html += '</div>';

  if (stopped && pool.emergencyReason) {
    html += '<div style="margin-top:12px;padding:10px;background:#7f1d1d;border-radius:4px;font-size:0.85rem">' + pool.emergencyReason + '</div>';
  }

  // Band table with integrated visualization
  if (bandCount > 0) {
    const priceLabel = formatPriceLabel(pool);
    html += '<table style="margin-top:16px"><thead><tr><th>Band</th><th>Zone</th><th></th><th>Price Range (' + priceLabel + ')</th><th class="muted">Tick Range</th></tr></thead><tbody>';
    for (let ri = bandCount - 1; ri >= 0; ri--) {
      const b = pool.bands[ri];
      const isActive = ri === pool.activeBand;
      const rawLower = tickToPrice(b.tickLower);
      const rawUpper = tickToPrice(b.tickUpper);
      const isInverted = rawLower < 0.01;
      const priceHigh = isInverted ? formatPrice(rawLower) : formatPrice(rawUpper);
      const priceLow = isInverted ? formatPrice(rawUpper) : formatPrice(rawLower);
      html += '<tr' + (isActive ? ' style="color:#fff;font-weight:600"' : '') + '>';
      html += '<td>' + (ri + 1) + '</td><td>' + ZONE_LABELS[ri] + '</td>';
      html += '<td><div class="band-cell ' + ZONE_CLASSES[ri] + (isActive ? ' active' : '') + '"></div></td>';
      html += '<td>' + priceHigh + ' — ' + priceLow + '</td>';
      html += '<td class="muted">[' + b.tickLower + ', ' + b.tickUpper + ']</td>';
      html += '</tr>';
    }
    html += '</tbody></table>';
  }

  // Links
  html += '<div class="links" style="margin-top:16px">';
  html += '<a href="' + explorerUrl(chainId, 'address', wallet) + '">Wallet on Explorer</a>';
  if (poolAddr) html += '<a href="' + poolUrl(chainId, poolAddr) + '">Pool on DEX</a>';
  if (poolAddr) html += '<a href="' + explorerUrl(chainId, 'address', poolAddr) + '">Pool Contract</a>';
  html += '</div>';

  html += '</div>';
  return html;
}

async function refresh() {
  try {
    const res = await fetch('/status');
    const data = await res.json();

    document.getElementById('loading').style.display = 'none';
    document.getElementById('content').style.display = 'block';

    const hasError = data.pools.some(p => p.emergencyStopped);
    document.getElementById('bot-state').textContent = hasError ? 'ERROR' : 'Running';
    document.getElementById('bot-state').className = 'value ' + (hasError ? 'error' : 'ok');
    document.getElementById('bot-uptime').textContent = formatUptime(data.uptime);
    document.getElementById('bot-mode').textContent = data.dryRun ? 'Dry Run' : 'Live';
    document.getElementById('bot-mode').className = 'value ' + (data.dryRun ? 'warn' : 'ok');

    const totalErrors = data.pools.reduce((s,p) => s + (p.consecutiveErrors||0), 0);
    document.getElementById('bot-errors').textContent = totalErrors;
    document.getElementById('bot-errors').className = 'value ' + (totalErrors > 0 ? 'warn' : 'ok');

    const banner = document.getElementById('error-banner');
    if (data.lastError) {
      banner.style.display = 'block';
      banner.textContent = data.lastError;
    } else {
      banner.style.display = 'none';
    }

    const container = document.getElementById('pools-container');
    container.innerHTML = data.pools.map(renderPool).join('');
  } catch (e) {
    document.getElementById('loading').textContent = 'Failed to load: ' + e.message;
  }
}

refresh();
setInterval(refresh, 30000);
</script>
</body>
</html>`;
}

