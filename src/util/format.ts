import { BigNumber, utils } from 'ethers';

export function formatTokenAmount(amount: BigNumber, decimals: number, displayDecimals = 4): string {
  const formatted = utils.formatUnits(amount, decimals);
  const num = parseFloat(formatted);
  return num.toFixed(displayDecimals);
}

export function parseTokenAmount(amount: string, decimals: number): BigNumber {
  return utils.parseUnits(amount, decimals);
}

export function formatUsd(amount: number): string {
  return `$${amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function formatPercent(value: number): string {
  return `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`;
}

export function shortenAddress(address: string): string {
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

export function formatTick(tick: number): string {
  return `tick=${tick} (price=${tickToApproxPrice(tick)})`;
}

function tickToApproxPrice(tick: number): string {
  return Math.pow(1.0001, tick).toFixed(6);
}
