import { useState, useEffect, useCallback } from 'react';
import { ethers } from 'ethers';
import { CHAIN_HEX, NETWORK_NAME, RPC_URL } from '../lib/constants';

declare global {
  interface Window {
    ethereum?: {
      request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
      on: (event: string, handler: (...args: unknown[]) => void) => void;
      removeListener: (event: string, handler: (...args: unknown[]) => void) => void;
      isMetaMask?: boolean;
    };
  }
}

export type WalletState = {
  address: string | null;
  isConnected: boolean;
  isConnecting: boolean;
  error: string | null;
  signer: ethers.JsonRpcSigner | null;
  connect: () => Promise<void>;
};

export function useWallet(): WalletState {
  const [address, setAddress] = useState<string | null>(null);
  const [isConnecting, setIsConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [signer, setSigner] = useState<ethers.JsonRpcSigner | null>(null);

  const connect = useCallback(async () => {
    if (!window.ethereum) {
      setError('MetaMask not detected. Please install MetaMask.');
      return;
    }
    setIsConnecting(true);
    setError(null);
    try {
      await window.ethereum.request({ method: 'eth_requestAccounts' });

      try {
        await window.ethereum.request({
          method: 'wallet_switchEthereumChain',
          params: [{ chainId: CHAIN_HEX }],
        });
      } catch (switchErr: unknown) {
        if ((switchErr as { code?: number }).code === 4902) {
          await window.ethereum.request({
            method: 'wallet_addEthereumChain',
            params: [{
              chainId: CHAIN_HEX,
              chainName: NETWORK_NAME,
              rpcUrls: [RPC_URL],
              nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 },
            }],
          });
        } else {
          throw switchErr;
        }
      }

      const provider = new ethers.BrowserProvider(window.ethereum as ethers.Eip1193Provider);
      const s = await provider.getSigner();
      const addr = await s.getAddress();
      setSigner(s);
      setAddress(addr);
    } catch (err: unknown) {
      setError((err as Error).message ?? 'Failed to connect wallet');
    } finally {
      setIsConnecting(false);
    }
  }, []);

  useEffect(() => {
    if (!window.ethereum) return;

    const onAccountsChanged = (accounts: unknown) => {
      const accs = accounts as string[];
      if (accs.length === 0) {
        setAddress(null);
        setSigner(null);
      } else {
        setAddress(accs[0]);
      }
    };

    const onChainChanged = () => window.location.reload();

    window.ethereum.on('accountsChanged', onAccountsChanged as (...args: unknown[]) => void);
    window.ethereum.on('chainChanged', onChainChanged);

    return () => {
      window.ethereum?.removeListener('accountsChanged', onAccountsChanged as (...args: unknown[]) => void);
      window.ethereum?.removeListener('chainChanged', onChainChanged);
    };
  }, []);

  return { address, isConnected: !!address, isConnecting, error, signer, connect };
}
