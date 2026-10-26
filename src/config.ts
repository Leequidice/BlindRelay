/**
 * wagmi configuration
 * Built with Arc Studio — https://studio.arc.io
 *
 * Chain, RPC, contract addresses and explorer URLs live in src/lib/blindrelay.ts.
 * Switch between testnet and mainnet by changing ACTIVE_ENV there.
 */

import { http, createConfig } from 'wagmi'
import { mainnet } from 'wagmi/chains'
import { arcTestnet, arc } from 'viem/chains'
import { injected } from 'wagmi/connectors'
import { registerChain } from './tracing'

// Pre-register chain RPC URLs so trace events show correct chain names immediately
registerChain(arcTestnet.id, 'https://rpc.testnet.arc.io')
registerChain(arc.id, 'https://rpc.mainnet.arc.io')

/**
 * Both Arc Testnet and Arc mainnet are included so the app works when
 * ACTIVE_ENV is switched in src/lib/blindrelay.ts without rebuilding the
 * wagmi config. The injected() connector supports MetaMask, Rabby, and any
 * EIP-1193 browser wallet without a WalletConnect project ID.
 *
 * WalletConnect is NOT used — injected wallets work without a project ID.
 * If you want WalletConnect support, add walletConnect({ projectId: '...' })
 * to the connectors array and supply VITE_WC_PROJECT_ID in .env.
 */
export const config = createConfig({
  chains: [arcTestnet, arc, mainnet],
  connectors: [
    injected(), // MetaMask, Rabby, Coinbase Wallet, etc. — no project ID needed
  ],
  transports: {
    [arcTestnet.id]: http('https://rpc.testnet.arc.io'),
    [arc.id]:        http('https://rpc.mainnet.arc.io'),
    [mainnet.id]:    http(), // ENS resolution only
  },
})
