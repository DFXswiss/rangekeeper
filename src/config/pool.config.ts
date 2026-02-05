import { readFileSync } from 'fs';
import { parse } from 'yaml';
import { z } from 'zod';
import path from 'path';

const tokenSchema = z.object({
  address: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  symbol: z.string().min(1),
  decimals: z.number().int().min(0).max(18),
});

const chainSchema = z.object({
  name: z.string().min(1),
  chainId: z.number().int().positive(),
  rpcUrl: z.string(),
  backupRpcUrls: z.array(z.string()).optional().default([]),
});

const poolSchema = z.object({
  token0: tokenSchema,
  token1: tokenSchema,
  feeTier: z.number().int().refine((v) => [100, 500, 3000, 10000].includes(v), {
    message: 'feeTier must be one of: 100, 500, 3000, 10000',
  }),
  nftManagerAddress: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  swapRouterAddress: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
});

const strategySchema = z.object({
  rangeWidthPercent: z.number().positive().max(50),
  rebalanceThresholdPercent: z.number().min(50).max(100),
  minRebalanceIntervalMinutes: z.number().nonnegative(),
  maxGasCostUsd: z.number().positive(),
  slippageTolerancePercent: z.number().positive().max(5),
  expectedPriceRatio: z.number().positive().optional(),
  depegThresholdPercent: z.number().positive().max(50).optional(),
});

const monitoringSchema = z.object({
  checkIntervalSeconds: z.number().int().min(5).max(3600),
});

const poolConfigSchema = z.object({
  id: z.string().min(1),
  chain: chainSchema,
  pool: poolSchema,
  strategy: strategySchema,
  monitoring: monitoringSchema,
});

const poolsFileSchema = z.object({
  pools: z.array(poolConfigSchema).min(1),
});

export type TokenConfig = z.infer<typeof tokenSchema>;
export type ChainConfig = z.infer<typeof chainSchema>;
export type PoolConfig = z.infer<typeof poolSchema>;
export type StrategyConfig = z.infer<typeof strategySchema>;
export type MonitoringConfig = z.infer<typeof monitoringSchema>;
export type PoolEntry = z.infer<typeof poolConfigSchema>;

const UNRESOLVED = Symbol('unresolved');

function resolveEnvVars(value: string, optional = false): string | typeof UNRESOLVED {
  let unresolved = false;
  const resolved = value.replace(/\$\{(\w+)\}/g, (match, key) => {
    const envVal = process.env[key];
    if (!envVal) {
      if (optional) {
        unresolved = true;
        return match;
      }
      throw new Error(`Environment variable ${key} is not set (referenced in pools.yaml)`);
    }
    return envVal;
  });
  return unresolved ? UNRESOLVED : resolved;
}

function deepResolveEnvVars(obj: unknown, parentKey?: string): unknown {
  const isOptionalArray = parentKey === 'backupRpcUrls';

  if (typeof obj === 'string') {
    const result = resolveEnvVars(obj, isOptionalArray);
    return result === UNRESOLVED ? undefined : result;
  }
  if (Array.isArray(obj)) {
    return obj
      .map((item) => deepResolveEnvVars(item, parentKey))
      .filter((item) => item !== undefined);
  }
  if (obj !== null && typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      result[k] = deepResolveEnvVars(v, k);
    }
    return result;
  }
  return obj;
}

export function loadPoolConfigs(configPath?: string): PoolEntry[] {
  const filePath = configPath ?? path.resolve(process.cwd(), 'config', 'pools.yaml');
  const raw = readFileSync(filePath, 'utf-8');
  const parsed = parse(raw);
  const resolved = deepResolveEnvVars(parsed);

  const result = poolsFileSchema.safeParse(resolved);
  if (!result.success) {
    const formatted = result.error.issues
      .map((i) => `  ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Pool config validation failed:\n${formatted}`);
  }

  return result.data.pools;
}
