export interface ChainAddresses {
  nftPositionManager: string;
  swapRouter02: string;
  quoterV2: string;
  factory: string;
}

const CHAIN_ADDRESSES: Record<number, ChainAddresses> = {
  // Ethereum Mainnet
  1: {
    nftPositionManager: '0xC36442b4a4522E871399CD717aBDD847Ab11FE88',
    swapRouter02: '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45',
    quoterV2: '0x61fFE014bA17989E743c5F6cB21bF9697530B21e',
    factory: '0x1F98431c8aD98523631AE4a59f267346ea31F984',
  },
  // Polygon
  137: {
    nftPositionManager: '0xC36442b4a4522E871399CD717aBDD847Ab11FE88',
    swapRouter02: '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45',
    quoterV2: '0x61fFE014bA17989E743c5F6cB21bF9697530B21e',
    factory: '0x1F98431c8aD98523631AE4a59f267346ea31F984',
  },
  // Arbitrum
  42161: {
    nftPositionManager: '0xC36442b4a4522E871399CD717aBDD847Ab11FE88',
    swapRouter02: '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45',
    quoterV2: '0x61fFE014bA17989E743c5F6cB21bF9697530B21e',
    factory: '0x1F98431c8aD98523631AE4a59f267346ea31F984',
  },
  // Optimism
  10: {
    nftPositionManager: '0xC36442b4a4522E871399CD717aBDD847Ab11FE88',
    swapRouter02: '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45',
    quoterV2: '0x61fFE014bA17989E743c5F6cB21bF9697530B21e',
    factory: '0x1F98431c8aD98523631AE4a59f267346ea31F984',
  },
  // Citrea Mainnet (JuiceSwap)
  4114: {
    nftPositionManager: '0x3D3821D358f56395d4053954f98aec0E1F0fa568',
    swapRouter02: '0x565eD3D57fe40f78A46f348C220121AE093c3cF8',
    quoterV2: '0x428f20dd8926Eabe19653815Ed0BE7D6c36f8425',
    factory: '0xd809b1285aDd8eeaF1B1566Bf31B2B4C4Bba8e82',
  },
};

export function getChainAddresses(chainId: number): ChainAddresses {
  const addresses = CHAIN_ADDRESSES[chainId];
  if (!addresses) {
    throw new Error(`No Uniswap V3 addresses configured for chainId: ${chainId}`);
  }
  return addresses;
}
