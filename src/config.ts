/**
 * wagmi configuration
 * Built with Arc Studio — https://studio.arc.io
 *
 * Chain order, RPC URLs, contract addresses and explorer URLs are all derived
 * from CHAIN_CONFIG in src/lib/blindrelay.ts.  Switch ACTIVE_ENV there to flip
 * every file between testnet and mainnet in one place.
 */

import { http, createConfig } from 'wagmi'
import { mainnet } from 'wagmi/chains'
import { arcTestnet, arc } from 'viem/chains'
import { injected } from 'wagmi/connectors'
import { CHAIN_CONFIG } from './lib/blindrelay'
import { registerChain } from './tracing'

// Pre-register chain RPC URLs so trace events show correct chain names immediately.
registerChain(arcTestnet.id, 'https://rpc.testnet.arc.io')
registerChain(arc.id, 'https://rpc.mainnet.arc.io')

/**
 * The active chain (matching CHAIN_CONFIG.chainId) is listed first so wagmi's
 * usePublicClient() with no explicit chainId always resolves to the configured
 * network.  The other Arc chain is kept in the list so the wrong-network banner
 * and switchChain() can target it, and mainnet is retained for ENS resolution.
 *
 * WalletConnect is NOT used — injected wallets work without a project ID.
 */
const activeChain   = CHAIN_CONFIG.chainId === arc.id ? arc : arcTestnet
const inactiveChain = CHAIN_CONFIG.chainId === arc.id ? arcTestnet : arc

export const config = createConfig({
  chains: [activeChain, inactiveChain, mainnet],
  connectors: [
    injected(), // MetaMask, Rabby, Coinbase Wallet, etc. — no project ID needed
  ],
  transports: {
    [arcTestnet.id]: http('https://rpc.testnet.arc.io'),
    [arc.id]:        http('https://rpc.mainnet.arc.io'),
    [mainnet.id]:    http(), // ENS resolution only
  },
})
