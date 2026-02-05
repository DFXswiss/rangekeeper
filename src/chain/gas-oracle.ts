import { providers, utils } from 'ethers';
import { getLogger } from '../util/logger';

export interface GasInfo {
  gasPriceGwei: number;
  maxFeePerGasGwei?: number;
  maxPriorityFeePerGasGwei?: number;
  isEip1559: boolean;
}

let baselineGasPrice: number | undefined;

export async function getGasInfo(provider: providers.JsonRpcProvider): Promise<GasInfo> {
  const logger = getLogger();

  try {
    const feeData = await provider.getFeeData();

    if (feeData.maxFeePerGas && feeData.maxPriorityFeePerGas) {
      const info: GasInfo = {
        gasPriceGwei: parseFloat(utils.formatUnits(feeData.maxFeePerGas, 'gwei')),
        maxFeePerGasGwei: parseFloat(utils.formatUnits(feeData.maxFeePerGas, 'gwei')),
        maxPriorityFeePerGasGwei: parseFloat(utils.formatUnits(feeData.maxPriorityFeePerGas, 'gwei')),
        isEip1559: true,
      };
      updateBaseline(info.gasPriceGwei);
      return info;
    }

    const gasPrice = feeData.gasPrice ?? (await provider.getGasPrice());
    const info: GasInfo = {
      gasPriceGwei: parseFloat(utils.formatUnits(gasPrice, 'gwei')),
      isEip1559: false,
    };
    updateBaseline(info.gasPriceGwei);
    return info;
  } catch (err) {
    logger.error({ err }, 'Failed to fetch gas info');
    throw err;
  }
}

function updateBaseline(currentGwei: number): void {
  if (!baselineGasPrice) {
    baselineGasPrice = currentGwei;
  } else {
    baselineGasPrice = baselineGasPrice * 0.95 + currentGwei * 0.05;
  }
}

export function isGasSpike(currentGwei: number, multiplier = 10): boolean {
  if (!baselineGasPrice) return false;
  return currentGwei > baselineGasPrice * multiplier;
}

export function estimateGasCostUsd(gasUsed: number, gasPriceGwei: number, ethPriceUsd: number): number {
  const gasCostEth = (gasUsed * gasPriceGwei) / 1e9;
  return gasCostEth * ethPriceUsd;
}
