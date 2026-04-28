import express from 'express';
import { writeFileSync, readFileSync, existsSync } from 'fs';
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
  vaultRate?: number;
}

const botStatus: BotStatus = {
  uptime: 0,
  pools: [],
  dryRun: false,
};

const startTime = Date.now();

// Price history ring buffer (7 days at 30s intervals = ~20160 entries)
const MAX_HISTORY = 20160;
const priceHistory: Map<string, { time: number; poolPrice: number; refPrice: number | null; vaultRate: number }[]> = new Map();
let cachedRefPrice: number | null = null;
let lastRefFetch = 0;

async function fetchRefPrice(): Promise<void> {
  if (Date.now() - lastRefFetch < 60_000) return;
  lastRefFetch = Date.now();
  try {
    const res = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd');
    const data = (await res.json()) as { bitcoin?: { usd?: number } };
    cachedRefPrice = data.bitcoin?.usd ?? null;
  } catch {
    // keep previous value
  }
}

export async function recordPrice(poolId: string, tick: number, vaultRate = 1): Promise<void> {
  await fetchRefPrice();
  if (!priceHistory.has(poolId)) priceHistory.set(poolId, []);
  const history = priceHistory.get(poolId)!;
  const rawPrice = Math.pow(1.0001, tick);
  // Multiply by vaultRate to convert from svJUSD to USD (1 svJUSD > 1 JUSD due to vault interest)
  const poolPrice = (rawPrice < 0.01 ? 1 / rawPrice : rawPrice) * vaultRate;
  history.push({ time: Math.floor(Date.now() / 1000), poolPrice, refPrice: cachedRefPrice, vaultRate });
  if (history.length > MAX_HISTORY) history.shift();
}

export function getPriceHistory(poolId: string): { time: number; poolPrice: number; refPrice: number | null; vaultRate: number }[] {
  return priceHistory.get(poolId) ?? [];
}

export function importPriceHistory(
  poolId: string,
  data: { time: number; poolPrice: number; refPrice: number | null; vaultRate?: number }[],
): void {
  const existing = priceHistory.get(poolId) ?? [];
  // Prepend imported data (default vaultRate to 1 for legacy entries), then append existing
  const normalized = data.map((d) => ({ ...d, vaultRate: d.vaultRate ?? 1 }));
  const merged = [...normalized, ...existing];
  // Deduplicate by time, keep last
  const seen = new Map<number, typeof merged[0]>();
  for (const entry of merged) seen.set(entry.time, entry);
  const sorted = [...seen.values()].sort((a, b) => a.time - b.time);
  priceHistory.set(poolId, sorted.slice(-MAX_HISTORY));
}

// Band lifecycle tracking
export interface BandEvent {
  tokenId: number;
  tickLower: number;
  tickUpper: number;
  openTime: number;
  closeTime: number | null;
}

const bandEvents: Map<string, BandEvent[]> = new Map();

export function recordBandOpen(poolId: string, tokenId: number, tickLower: number, tickUpper: number, openTime?: number): void {
  if (!bandEvents.has(poolId)) bandEvents.set(poolId, []);
  const events = bandEvents.get(poolId)!;
  if (!events.find((e) => e.tokenId === tokenId && e.closeTime === null)) {
    events.push({ tokenId, tickLower, tickUpper, openTime: openTime ?? Math.floor(Date.now() / 1000), closeTime: null });
  }
}

export function recordBandClose(poolId: string, tokenId: number): void {
  const events = bandEvents.get(poolId);
  if (!events) return;
  const band = events.find((e) => e.tokenId === tokenId && e.closeTime === null);
  if (band) band.closeTime = Math.floor(Date.now() / 1000);
}

export function importBandEvents(poolId: string, data: BandEvent[]): void {
  const existing = bandEvents.get(poolId) ?? [];
  // Merge: imported entries take priority over existing ones with the same tokenId+closeTime
  const importedIds = new Set(data.map((e) => `${e.tokenId}:${e.closeTime}`));
  const filtered = existing.filter((e) => !importedIds.has(`${e.tokenId}:${e.closeTime}`));
  bandEvents.set(poolId, [...data, ...filtered]);
}

export function getBandEvents(poolId: string): BandEvent[] {
  return bandEvents.get(poolId) ?? [];
}

// --- Persistence: save/load price history and band events to disk ---
let dataDir = '';
let persistTimer: ReturnType<typeof setInterval> | null = null;

export function setDataDir(dir: string): void {
  dataDir = dir;
}

export function loadPersistedData(): void {
  if (!dataDir) return;
  const logger = getLogger();

  const pricePath = dataDir + '/price-history.json';
  if (existsSync(pricePath)) {
    try {
      const raw = JSON.parse(readFileSync(pricePath, 'utf-8'));
      for (const [poolId, entries] of Object.entries(raw)) {
        importPriceHistory(poolId, entries as { time: number; poolPrice: number; refPrice: number | null; vaultRate?: number }[]);
      }
      logger.info({ path: pricePath }, 'Loaded persisted price history');
    } catch (err) {
      logger.warn({ err }, 'Failed to load persisted price history');
    }
  }

  const bandPath = dataDir + '/band-events.json';
  if (existsSync(bandPath)) {
    try {
      const raw = JSON.parse(readFileSync(bandPath, 'utf-8'));
      for (const [poolId, entries] of Object.entries(raw)) {
        importBandEvents(poolId, entries as BandEvent[]);
      }
      logger.info({ path: bandPath }, 'Loaded persisted band events');
    } catch (err) {
      logger.warn({ err }, 'Failed to load persisted band events');
    }
  }
}

function persistData(): void {
  if (!dataDir) return;
  try {
    const priceObj: Record<string, unknown[]> = {};
    for (const [poolId, entries] of priceHistory.entries()) {
      priceObj[poolId] = entries;
    }
    writeFileSync(dataDir + '/price-history.json', JSON.stringify(priceObj));

    const bandObj: Record<string, unknown[]> = {};
    for (const [poolId, entries] of bandEvents.entries()) {
      bandObj[poolId] = entries;
    }
    writeFileSync(dataDir + '/band-events.json', JSON.stringify(bandObj));
  } catch {
    // non-critical, will retry next interval
  }
}

export function startPersistTimer(): void {
  if (persistTimer) return;
  persistTimer = setInterval(persistData, 5 * 60 * 1000); // every 5 minutes
}

export function persistNow(): void {
  persistData();
}

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

  app.get('/api/history/:poolId', (req, res) => {
    res.json(getPriceHistory(req.params.poolId));
  });

  app.get('/api/bands/:poolId', (req, res) => {
    res.json(getBandEvents(req.params.poolId));
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
<script src="https://unpkg.com/lightweight-charts@4.1.0/dist/lightweight-charts.standalone.production.js"></script>
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
  .range-btn { background: #1a1a1a; border: 1px solid #2a2a2a; color: #888; padding: 4px 12px; border-radius: 4px; cursor: pointer; font-size: 0.8rem; }
  .range-btn:hover { background: #2a2a2a; color: #e0e0e0; }
  .range-btn.active { background: #14532d; color: #4ade80; border-color: #4ade80; }
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

<div class="card" id="chart-card" style="display:none">
  <div style="display:flex;align-items:center;justify-content:space-between">
    <h2>Price History</h2>
    <div id="chart-range-btns" style="display:flex;gap:4px">
      <button onclick="setChartRange(3600, this)" class="range-btn">1h</button>
      <button onclick="setChartRange(86400, this)" class="range-btn">24h</button>
      <button onclick="setChartRange(604800, this)" class="range-btn active">7d</button>
    </div>
  </div>
  <div id="chart-container" style="height:400px;position:relative"></div>
  <div class="muted" style="font-size:0.75rem;margin-top:4px">Blue: BTC/USD (CoinGecko) &middot; Red: BTC/USD (Pool, vault-rate adjusted)</div>
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
  html += '<div class="metric"><div class="label">Current Price</div><div class="value" id="pool-price-' + pool.id + '">-</div></div>';
  html += '</div>';

  if (stopped && pool.emergencyReason) {
    html += '<div style="margin-top:12px;padding:10px;background:#7f1d1d;border-radius:4px;font-size:0.85rem">' + pool.emergencyReason + '</div>';
  }

  // Band table with integrated visualization
  if (bandCount > 0) {
    const priceLabel = formatPriceLabel(pool);
    var vr = pool.vaultRate || 1;
    html += '<table style="margin-top:16px"><thead><tr><th>Band</th><th>Zone</th><th></th><th>Price Range (' + priceLabel + ' in USD)</th><th class="muted">Tick Range</th></tr></thead><tbody>';
    for (let ri = 0; ri < bandCount; ri++) {
      const b = pool.bands[ri];
      const isActive = ri === pool.activeBand;
      const rawLower = tickToPrice(b.tickLower);
      const rawUpper = tickToPrice(b.tickUpper);
      const isInverted = rawLower < 0.01;
      const priceHigh = isInverted ? formatPrice(1 / rawLower * vr) : formatPrice(rawUpper * vr);
      const priceLow = isInverted ? formatPrice(1 / rawUpper * vr) : formatPrice(rawLower * vr);
      html += '<tr' + (isActive ? ' style="color:#fff;font-weight:600"' : '') + '>';
      html += '<td>' + (ri + 1) + '</td><td>' + ZONE_LABELS[ri] + '</td>';
      html += '<td><div class="band-cell ' + ZONE_CLASSES[ri] + (isActive ? ' active' : '') + '"></div></td>';
      html += '<td>' + priceLow + ' — ' + priceHigh + '</td>';
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

    // Update price display from local history (includes refPrice)
    data.pools.forEach(async function(pool) {
      const el = document.getElementById('pool-price-' + pool.id);
      if (!el || pool.currentTick === undefined) return;
      const rawPrice = tickToPrice(pool.currentTick);
      const pvr = pool.vaultRate || 1;
      const adjustedPrice = rawPrice < 0.01 ? (1 / rawPrice) * pvr : rawPrice * pvr;
      var html = '$' + formatPrice(adjustedPrice) + ' BTC/USD';
      try {
        var hRes = await fetch('/api/history/' + pool.id);
        var hist = await hRes.json();
        var last = hist.length > 0 ? hist[hist.length - 1] : null;
        var lastRef = null;
        for (var i = hist.length - 1; i >= 0; i--) { if (hist[i].refPrice) { lastRef = hist[i]; break; } }
        if (last && rawPrice < 0.01) {
          var vr = last.vaultRate || 1;
          if (lastRef) html += '<div style="font-size:0.7rem;color:#888;margin-top:2px">CoinGecko BTC: $' + formatNumber(lastRef.refPrice.toFixed(0)) + '</div>';
          html += '<div style="font-size:0.7rem;color:#888">Pool BTC: $' + formatNumber(last.poolPrice.toFixed(0)) + '</div>';
          html += '<div style="font-size:0.7rem;color:#888">1 ' + pool.token0Symbol + ' = $' + formatNumber(vr.toFixed(4)) + '</div>';
        }
      } catch(e) {}
      el.innerHTML = html;
    });
  } catch (e) {
    document.getElementById('loading').textContent = 'Failed to load: ' + e.message;
  }
}

refresh();
setInterval(refresh, 30000);

// Price chart
var chart = null;
var poolSeries = null;
var cgSeries = null;
var chartRangeSeconds = 604800;
var allHistory = [];
var allBands = [];

async function initChart() {
  var LWC = window.LightweightCharts || window.lwc;
  if (!LWC) { console.log('LightweightCharts not loaded'); return; }
  var container = document.getElementById('chart-container');
  chart = LWC.createChart(container, {
    layout: { background: { color: '#161616' }, textColor: '#888' },
    grid: { vertLines: { color: '#1a1a1a' }, horzLines: { color: '#1a1a1a' } },
    timeScale: { timeVisible: true, secondsVisible: false },
    rightPriceScale: { borderColor: '#2a2a2a' },
    localization: { priceFormatter: function(p) { return formatNumber(Math.round(p).toString()); } },
    crosshair: { mode: 0 },
  });
  poolSeries = chart.addLineSeries({ color: '#ef4444', lineWidth: 2, title: 'Pool' });
  cgSeries = chart.addLineSeries({ color: '#3b82f6', lineWidth: 1, title: 'CoinGecko' });
  chart.timeScale().fitContent();
  chart.timeScale().subscribeVisibleLogicalRangeChange(renderBandOverlays);
  chart.subscribeCrosshairMove(renderBandOverlays);
}

async function refreshChart() {
  try {
    var poolId = 'svjusd-wcbtc-citrea';
    var res = await fetch('/api/history/' + poolId);
    allHistory = await res.json();
    if (allHistory.length < 2) return;

    document.getElementById('chart-card').style.display = 'block';
    if (!chart) { await initChart(); if (!chart) return; }

    // Load band events
    var bRes = await fetch('/api/bands/' + poolId);
    allBands = await bRes.json();

    applyChartRange();
  } catch(e) { console.error('Chart error:', e); }
}

function setChartRange(seconds, btn) {
  chartRangeSeconds = seconds;
  document.querySelectorAll('.range-btn').forEach(function(b) { b.classList.remove('active'); });
  btn.classList.add('active');
  applyChartRange();
}

function applyChartRange() {
  if (!chart || allHistory.length === 0) return;
  var now = Math.floor(Date.now() / 1000);
  var cutoff = now - chartRangeSeconds;
  var filtered = allHistory.filter(function(h) { return h.time >= cutoff; });
  if (filtered.length < 1) filtered = allHistory;

  // Downsample to max ~1500 points for chart performance
  var maxPoints = 1500;
  var step = filtered.length > maxPoints ? Math.ceil(filtered.length / maxPoints) : 1;
  var sampled = step === 1 ? filtered : filtered.filter(function(_, i) { return i % step === 0 || i === filtered.length - 1; });

  poolSeries.setData(sampled.map(function(h) { return { time: h.time, value: h.poolPrice }; }));
  var cgPoints = sampled.filter(function(h) { return h.refPrice !== null; });
  cgSeries.setData(cgPoints.map(function(h) { return { time: h.time, value: h.refPrice }; }));
  chart.timeScale().fitContent();
  renderBandOverlays();
}

function renderBandOverlays() {
  var container = document.getElementById('chart-container');
  // Remove old overlays
  container.querySelectorAll('.band-overlay').forEach(function(el) { el.remove(); });
  if (!chart || !poolSeries || allBands.length === 0) return;

  var colors = ['rgba(30,41,59,0.3)', 'rgba(49,46,129,0.3)', 'rgba(20,83,45,0.3)', 'rgba(20,83,45,0.4)', 'rgba(20,83,45,0.3)', 'rgba(49,46,129,0.3)', 'rgba(30,41,59,0.3)'];
  var latestVaultRate = allHistory.length > 0 ? (allHistory[allHistory.length - 1].vaultRate || 1) : 1;

  allBands.forEach(function(band, idx) {
    var rawLower = Math.pow(1.0001, band.tickLower);
    var rawUpper = Math.pow(1.0001, band.tickUpper);
    var priceTop = (rawLower < 0.01 ? 1 / rawLower : rawUpper) * latestVaultRate;
    var priceBottom = (rawLower < 0.01 ? 1 / rawUpper : rawLower) * latestVaultRate;

    var yTop = poolSeries.priceToCoordinate(priceTop);
    var yBottom = poolSeries.priceToCoordinate(priceBottom);
    if (yTop === null || yBottom === null) return;

    var xLeft = chart.timeScale().timeToCoordinate(band.openTime);
    var xRight = band.closeTime ? chart.timeScale().timeToCoordinate(band.closeTime) : container.clientWidth;
    if (xLeft === null) xLeft = 0;
    if (xRight === null) xRight = container.clientWidth;

    var div = document.createElement('div');
    div.className = 'band-overlay';
    div.style.cssText = 'position:absolute;pointer-events:none;z-index:1;' +
      'left:' + Math.min(xLeft, xRight) + 'px;' +
      'top:' + Math.min(yTop, yBottom) + 'px;' +
      'width:' + Math.abs(xRight - xLeft) + 'px;' +
      'height:' + Math.max(Math.abs(yBottom - yTop), 2) + 'px;' +
      'background:' + (colors[idx % colors.length]) + ';' +
      'border:1px solid rgba(255,255,255,0.15);';
    container.appendChild(div);
  });
}

refreshChart();
setInterval(refreshChart, 60000);
</script>
</body>
</html>`;
}

