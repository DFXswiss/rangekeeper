import { BigNumber, Contract, ContractTransaction, Wallet } from 'ethers';
import { getLogger } from '../util/logger';
import { NonceTracker } from './nonce-tracker';
import { withRetry } from '../util/retry';

const logger = getLogger();

const WETH_ABI = [
  'function deposit() payable',
  'function withdraw(uint256 amount)',
  'function balanceOf(address owner) view returns (uint256)',
];

const ERC4626_ABI = [
  'function deposit(uint256 assets, address receiver) returns (uint256 shares)',
  'function withdraw(uint256 assets, address receiver, address owner) returns (uint256 shares)',
  'function asset() view returns (address)',
  'function balanceOf(address owner) view returns (uint256)',
];

const ERC20_ABI = [
  'function balanceOf(address owner) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
];

export interface WrapConfig {
  /** Address of the wrapped token used in the pool (e.g. WCBTC, svJUSD) */
  wrappedToken: string;
  /** 'native' for cBTC→WCBTC (WETH-style), 'erc4626' for JUSD→svJUSD (vault deposit) */
  type: 'native' | 'erc4626';
  /** For erc4626: address of the underlying token (e.g. JUSD). Not needed for native. */
  underlyingToken?: string;
  /** Minimum amount to keep as native gas (only for native wrapping). Default: 0.0001 */
  gasReserve?: string;
}

export class TokenWrapper {
  private readonly wallet: () => Wallet;
  private readonly nonceTracker?: NonceTracker;

  constructor(wallet: () => Wallet, nonceTracker?: NonceTracker) {
    this.wallet = wallet;
    this.nonceTracker = nonceTracker;
  }

  async wrapIfNeeded(config: WrapConfig): Promise<void> {
    if (config.type === 'native') {
      await this.wrapNative(config);
    } else if (config.type === 'erc4626') {
      await this.wrapErc4626(config);
    }
  }

  private async wrapNative(config: WrapConfig): Promise<void> {
    const wallet = this.wallet();
    const balance = await wallet.getBalance();
    const gasReserve = BigNumber.from(config.gasReserve ?? '100000000000000'); // 0.0001 default

    if (balance.lte(gasReserve)) {
      return;
    }

    const amountToWrap = balance.sub(gasReserve);
    if (amountToWrap.lte(0)) return;

    logger.info(
      { amount: amountToWrap.toString(), token: config.wrappedToken },
      'Wrapping native token',
    );

    const weth = new Contract(config.wrappedToken, WETH_ABI, wallet);
    const nonceOverride = this.nonceTracker ? { nonce: this.nonceTracker.getNextNonce() } : {};
    const tx: ContractTransaction = await withRetry(
      () => weth.deposit({ value: amountToWrap, ...nonceOverride }),
      'wrapNative',
    );
    await tx.wait();
    this.nonceTracker?.confirmNonce();

    logger.info({ amount: amountToWrap.toString() }, 'Native token wrapped');
  }

  private async wrapErc4626(config: WrapConfig): Promise<void> {
    if (!config.underlyingToken) {
      throw new Error('erc4626 wrap requires underlyingToken address');
    }

    const wallet = this.wallet();
    const underlying = new Contract(config.underlyingToken, ERC20_ABI, wallet);
    const balance: BigNumber = await underlying.balanceOf(wallet.address);

    if (balance.lte(0)) return;

    logger.info(
      { amount: balance.toString(), underlying: config.underlyingToken, vault: config.wrappedToken },
      'Depositing into ERC4626 vault',
    );

    // Ensure approval
    const allowance: BigNumber = await underlying.allowance(wallet.address, config.wrappedToken);
    if (allowance.lt(balance)) {
      const nonceOverride = this.nonceTracker ? { nonce: this.nonceTracker.getNextNonce() } : {};
      const approveTx: ContractTransaction = await withRetry(
        () => underlying.approve(config.wrappedToken, BigNumber.from(2).pow(256).sub(1), nonceOverride),
        'approveVault',
      );
      await approveTx.wait();
      this.nonceTracker?.confirmNonce();
    }

    // Deposit into vault
    const vault = new Contract(config.wrappedToken, ERC4626_ABI, wallet);
    const vaultNonce = this.nonceTracker ? { nonce: this.nonceTracker.getNextNonce() } : {};
    const tx: ContractTransaction = await withRetry(
      () => vault['deposit(uint256,address)'](balance, wallet.address, vaultNonce),
      'depositVault',
    );
    await tx.wait();
    this.nonceTracker?.confirmNonce();

    logger.info({ amount: balance.toString() }, 'Deposited into vault');
  }
}
