import { Contract, Wallet, BigNumber } from 'ethers';

const ERC20_ABI = [
  'function balanceOf(address owner) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
];

const UNISWAP_V3_POOL_ABI = [
  'function slot0() external view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)',
  'function liquidity() external view returns (uint128)',
  'function token0() external view returns (address)',
  'function token1() external view returns (address)',
  'function fee() external view returns (uint24)',
  'function tickSpacing() external view returns (int24)',
];

const NFT_POSITION_MANAGER_ABI = [
  'function positions(uint256 tokenId) external view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)',
  'function mint(tuple(address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint256 amount0Desired, uint256 amount1Desired, uint256 amount0Min, uint256 amount1Min, address recipient, uint256 deadline)) external payable returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)',
  'function decreaseLiquidity(tuple(uint256 tokenId, uint128 liquidity, uint256 amount0Min, uint256 amount1Min, uint256 deadline)) external payable returns (uint256 amount0, uint256 amount1)',
  'function collect(tuple(uint256 tokenId, address recipient, uint128 amount0Max, uint128 amount1Max)) external payable returns (uint256 amount0, uint256 amount1)',
  'function burn(uint256 tokenId) external payable',
  'function balanceOf(address owner) external view returns (uint256)',
  'function tokenOfOwnerByIndex(address owner, uint256 index) external view returns (uint256)',
  'function multicall(bytes[] calldata data) external payable returns (bytes[] memory results)',
];

const SWAP_ROUTER_02_ABI = [
  'function exactInputSingle(tuple(address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) external payable returns (uint256 amountOut)',
];

const UNISWAP_V3_FACTORY_ABI = [
  'function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address pool)',
];

export function getErc20Contract(address: string, wallet: Wallet): Contract {
  return new Contract(address, ERC20_ABI, wallet);
}

export function getPoolContract(address: string, wallet: Wallet): Contract {
  return new Contract(address, UNISWAP_V3_POOL_ABI, wallet);
}

export function getNftManagerContract(address: string, wallet: Wallet): Contract {
  return new Contract(address, NFT_POSITION_MANAGER_ABI, wallet);
}

export function getSwapRouterContract(address: string, wallet: Wallet): Contract {
  return new Contract(address, SWAP_ROUTER_02_ABI, wallet);
}

export function getFactoryContract(address: string, wallet: Wallet): Contract {
  return new Contract(address, UNISWAP_V3_FACTORY_ABI, wallet);
}

export async function ensureApproval(
  tokenContract: Contract,
  spender: string,
  owner: string,
  amount: BigNumber,
): Promise<void> {
  const allowance: BigNumber = await tokenContract.allowance(owner, spender);
  if (allowance.lt(amount)) {
    const tx = await tokenContract.approve(spender, BigNumber.from(2).pow(256).sub(1));
    await tx.wait();
  }
}
