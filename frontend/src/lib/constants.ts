export const RELAYER_URL = 'https://relayer-production-0e4e.up.railway.app';

export const CHAIN_ID = 9746;
export const CHAIN_HEX = '0x2612';
export const NETWORK_NAME = 'Plasma Testnet';
export const RPC_URL = 'https://plasma-testnet.g.alchemy.com/v2/3zFAX-i0bLU7ZfCipH2EuDW02tB51Mt9';

export const CANTON_BRIDGE_ADDRESS = '0x59acb2967cc50c25b9d12b4b329e4da94054a897';
export const EVM_TOKEN_ADDRESS = '0x8b9e96d678808ef4f01ca03b6935c56cabecf1ad';

export const CANTON_BRIDGE_ABI = [
  'function depositToCanton(address token, uint256 amount, bytes32 fingerprint) external',
];

export const ERC20_ABI = [
  'function approve(address spender, uint256 amount) external returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
];

export const TOKEN_DECIMALS = 6;
