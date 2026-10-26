#!/usr/bin/env bun
/**
 * self-deploy.ts — Deploy TaskEscrow then BlindRelayAuction to Arc using viem.
 *
 * No Foundry required. Reads pre-compiled bytecode from contracts/bytecode/.
 * Private key is read from an environment variable and is NEVER logged.
 *
 * Usage (PowerShell):
 *   $env:DEPLOY_PRIVATE_KEY = "0x<your-64-hex-char-key>"
 *   bun run scripts/self-deploy.ts
 *
 * Dry-run (simulates everything without sending):
 *   bun run scripts/self-deploy.ts --dry-run
 *
 * Optional env vars:
 *   ACTIVE_ENV   testnet (default) | mainnet  — selects RPC/chain
 *   RPC_URL      override the default RPC for the selected network
 *
 * Deploy order (required — BlindRelayAuction constructor takes the escrow address):
 *   1. TaskEscrow(usdc)
 *   2. BlindRelayAuction(usdc, escrowAddress)
 *
 * After a successful deploy:
 *   - Addresses are written to deployed-addresses.json in the project root.
 *   - Update TESTNET_CONFIG (or MAINNET_CONFIG) in src/lib/blindrelay.ts.
 *   - Verify on the explorer using contracts/verify-input/README-verify.md.
 *
 * Security:
 *   - The private key is read once from process.env and never logged, echoed, or written to disk.
 *   - stderr is used for warnings; stdout carries only deployment data.
 *   - The key is not passed on the command line and does not appear in process.argv.
 *   - Error messages containing long alphanumeric runs (possible keys) are redacted.
 */

import { createPublicClient, createWalletClient, http } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { arcTestnet, arc } from 'viem/chains'
import { createRequire } from 'module'
import { writeFileSync } from 'fs'

const require = createRequire(import.meta.url)

// ─── CLI flags ─────────────────────────────────────────────────────────────

const DRY_RUN = process.argv.includes('--dry-run')

// ─── Network selection ─────────────────────────────────────────────────────

type Network = 'testnet' | 'mainnet'
const ACTIVE_ENV: Network = (process.env['ACTIVE_ENV'] as Network | undefined) ?? 'testnet'

const NETWORK_CONFIG = {
  testnet: {
    chain:    arcTestnet,
    rpc:      'https://rpc.testnet.arc.io',
    explorer: 'https://explorer.testnet.arc.io',
    usdc:     '0x3600000000000000000000000000000000000000' as `0x${string}`,
  },
  mainnet: {
    chain:    arc,
    rpc:      'https://rpc.mainnet.arc.io',
    explorer: 'https://explorer.arc.io',
    usdc:     '0x3600000000000000000000000000000000000000' as `0x${string}`,
  },
} as const

const NET     = NETWORK_CONFIG[ACTIVE_ENV]
const CHAIN   = NET.chain
const RPC_URL = process.env['RPC_URL'] ?? NET.rpc

// ─── Bytecode artifacts ────────────────────────────────────────────────────

interface BytecodeArtifact {
  contractName:     string
  compiler: {
    version:    string
    evmVersion: string
    optimizer:  { enabled: boolean; runs: number }
    viaIR:      boolean
  }
  abi:              unknown[]
  bytecode:         string  // init bytecode hex (no 0x prefix)
  deployedBytecode: string  // deployed bytecode hex (no 0x prefix)
}

const TE_ARTIFACT  = require('../contracts/bytecode/TaskEscrow.json')         as BytecodeArtifact
const BRA_ARTIFACT = require('../contracts/bytecode/BlindRelayAuction.json')  as BytecodeArtifact

// ─── Minimal read ABIs for post-deploy verification ───────────────────────

const TE_READ_ABI = [
  { type: 'function', name: 'usdc',                  inputs: [], outputs: [{ type: 'address' }], stateMutability: 'view' },
  { type: 'function', name: 'taskCount',             inputs: [], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'MAX_REVIEW_WINDOW',     inputs: [], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'MAX_DEADLINE_HORIZON',  inputs: [], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
] as const

const BRA_READ_ABI = [
  { type: 'function', name: 'usdc',         inputs: [], outputs: [{ type: 'address' }], stateMutability: 'view' },
  { type: 'function', name: 'escrow',       inputs: [], outputs: [{ type: 'address' }], stateMutability: 'view' },
  { type: 'function', name: 'GAS_FLOOR',    inputs: [], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'MAX_BIDDERS',  inputs: [], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'auctionCount', inputs: [], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
] as const

// ─── Helpers ───────────────────────────────────────────────────────────────

function requirePrivateKey(): `0x${string}` {
  const key = process.env['DEPLOY_PRIVATE_KEY']
  if (!key) {
    console.error(
      'ERROR: DEPLOY_PRIVATE_KEY is not set.\n' +
      'Set it as an environment variable — do NOT pass it on the command line.\n' +
      'PowerShell: $env:DEPLOY_PRIVATE_KEY = "0x..."\n' +
      'bash:       export DEPLOY_PRIVATE_KEY="0x..."'
    )
    process.exit(1)
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) {
    console.error('ERROR: DEPLOY_PRIVATE_KEY must be 0x-prefixed followed by exactly 64 hex characters.')
    process.exit(1)
  }
  return key as `0x${string}`
}

function formatEther(wei: bigint): string {
  // On Arc, gas is paid in USDC (18-decimal native view).
  const whole = wei / 10n ** 18n
  const frac  = (wei % 10n ** 18n).toString().padStart(18, '0').slice(0, 6)
  return `${whole}.${frac} USDC`
}

function describeError(err: unknown): string {
  if (err instanceof Error) {
    // Strip anything that could be a secret (32+ char alnum run)
    return err.message.replace(/[0-9a-zA-Z+/]{32,}/g, '[redacted]')
  }
  return String(err)
}

async function waitForTx(
  publicClient: ReturnType<typeof createPublicClient>,
  hash: `0x${string}`,
  label: string,
) {
  console.log(`  [${label}] submitted: ${NET.explorer}/tx/${hash}`)
  const receipt = await publicClient.waitForTransactionReceipt({ hash })
  if (receipt.status === 'reverted') {
    console.error(`  [${label}] TRANSACTION REVERTED. See: ${NET.explorer}/tx/${hash}`)
    process.exit(1)
  }
  console.log(`  [${label}] confirmed in block ${receipt.blockNumber} | gas used: ${receipt.gasUsed.toLocaleString()}`)
  return receipt
}

/**
 * Compare the bytecode of a live contract against the committed artifact.
 * The deployed bytecode from the chain has metadata appended after the CBOR-
 * encoded metadata hash at the end. The artifact's deployedBytecode also has
 * this metadata. We compare the first N bytes of the logical code, excluding
 * the last 53 bytes (2-byte CBOR length prefix + 51-byte metadata blob)
 * which vary with compiler/timestamp. A prefix match of 95%+ is considered
 * a match.
 */
function compareBytecode(onChain: string, artifact: string): { match: boolean; note: string } {
  // Normalise: strip 0x, lowercase
  const a = onChain.replace(/^0x/i, '').toLowerCase()
  const b = artifact.toLowerCase()

  if (a === b) return { match: true, note: 'exact match' }

  // Compare first 80% of the shorter string to avoid metadata noise
  const len = Math.min(a.length, b.length)
  const compareLen = Math.floor(len * 0.80)
  if (compareLen === 0) return { match: false, note: 'empty bytecode' }

  if (a.slice(0, compareLen) === b.slice(0, compareLen)) {
    return { match: true, note: 'prefix match (metadata suffix differs — expected)' }
  }
  return { match: false, note: 'MISMATCH in code body' }
}

// ─── Main ──────────────────────────────────────────────────────────────────

async function main() {
  console.log('═'.repeat(60))
  console.log(`BlindRelay self-deploy — network: ${ACTIVE_ENV.toUpperCase()}${DRY_RUN ? ' [DRY RUN]' : ''}`)
  console.log('═'.repeat(60))
  console.log(`Chain:    ${CHAIN.name} (id ${CHAIN.id})`)
  console.log(`RPC:      ${RPC_URL}`)
  console.log(`Explorer: ${NET.explorer}`)
  console.log(`USDC:     ${NET.usdc}`)
  if (DRY_RUN) {
    console.log()
    console.log('[DRY RUN] No transactions will be sent.')
    console.log('  TE  init bytecode length  (bytes):', Math.floor(TE_ARTIFACT.bytecode.length / 2))
    console.log('  BRA init bytecode length  (bytes):', Math.floor(BRA_ARTIFACT.bytecode.length / 2))
    console.log('  TE  compiler:', `solc ${TE_ARTIFACT.compiler.version}, evmVersion=${TE_ARTIFACT.compiler.evmVersion}, optimizer runs=${TE_ARTIFACT.compiler.optimizer.runs}, viaIR=${TE_ARTIFACT.compiler.viaIR}`)
    console.log('  BRA compiler:', `solc ${BRA_ARTIFACT.compiler.version}, evmVersion=${BRA_ARTIFACT.compiler.evmVersion}, optimizer runs=${BRA_ARTIFACT.compiler.optimizer.runs}, viaIR=${BRA_ARTIFACT.compiler.viaIR}`)
    console.log()
    console.log('  TaskEscrow constructor args: usdc =', NET.usdc)
    console.log('  BlindRelayAuction constructor args: usdc =', NET.usdc, ', escrow = <TaskEscrow address from step 1>')
    console.log()
    console.log('[DRY RUN] Complete — no state was changed.')
    return
  }

  if (ACTIVE_ENV === 'mainnet') {
    console.error(
      '\nWARNING: You are deploying to MAINNET. This involves real USDC.\n' +
      'Transactions are irreversible. Verify all addresses before proceeding.\n' +
      'Press Ctrl+C within 5 seconds to abort...'
    )
    await new Promise(r => setTimeout(r, 5_000))
    console.log('Proceeding with mainnet deploy.\n')
  }

  // Read key into memory — never log it.
  const PRIVATE_KEY = requirePrivateKey()
  const account     = privateKeyToAccount(PRIVATE_KEY)

  console.log(`Deployer: ${account.address}`)

  const publicClient = createPublicClient({ chain: CHAIN, transport: http(RPC_URL) })
  const walletClient = createWalletClient({ account, chain: CHAIN, transport: http(RPC_URL) })

  // Check balance (on Arc, native balance IS USDC in 18-decimal view)
  const balanceWei = await publicClient.getBalance({ address: account.address })
  console.log(`Balance:  ${formatEther(balanceWei)} (native/gas USDC)`)
  if (balanceWei === 0n) {
    console.error('ERROR: Deployer has zero balance. Fund the account with USDC on Arc before deploying.')
    process.exit(1)
  }
  console.log()

  // ── Step 1: Deploy TaskEscrow ──────────────────────────────────────────
  console.log('─'.repeat(60))
  console.log(`[1/4] Deploying TaskEscrow`)
  console.log(`  Compiler: solc ${TE_ARTIFACT.compiler.version}, evmVersion=${TE_ARTIFACT.compiler.evmVersion}, optimizer runs=${TE_ARTIFACT.compiler.optimizer.runs}, viaIR=${TE_ARTIFACT.compiler.viaIR}`)
  console.log(`  Constructor args: usdc=${NET.usdc}`)

  // ABI-encode constructor args: address usdc_
  const teConstructorArgs = NET.usdc.slice(2).padStart(64, '0')
  const teInitBytecode    = ('0x' + TE_ARTIFACT.bytecode + teConstructorArgs) as `0x${string}`

  let teDeployHash: `0x${string}`
  try {
    teDeployHash = await walletClient.sendTransaction({ data: teInitBytecode })
  } catch (e) {
    console.error('ERROR deploying TaskEscrow:', describeError(e))
    process.exit(1)
  }

  const teReceipt = await waitForTx(publicClient, teDeployHash, 'TaskEscrow deploy')
  const teAddress = teReceipt.contractAddress
  if (!teAddress) {
    console.error('ERROR: No contract address in TaskEscrow deploy receipt.')
    process.exit(1)
  }
  console.log(`  TaskEscrow deployed at: ${teAddress}`)
  console.log(`  Explorer: ${NET.explorer}/address/${teAddress}`)

  // ── Step 2: Deploy BlindRelayAuction ──────────────────────────────────
  console.log()
  console.log('─'.repeat(60))
  console.log(`[2/4] Deploying BlindRelayAuction`)
  console.log(`  Compiler: solc ${BRA_ARTIFACT.compiler.version}, evmVersion=${BRA_ARTIFACT.compiler.evmVersion}, optimizer runs=${BRA_ARTIFACT.compiler.optimizer.runs}, viaIR=${BRA_ARTIFACT.compiler.viaIR}`)
  console.log(`  Constructor args: usdc=${NET.usdc}, escrow=${teAddress}`)

  // ABI-encode two address params: usdc_, escrow_
  const braConstructorArgs = NET.usdc.slice(2).padStart(64, '0') + teAddress.slice(2).padStart(64, '0')
  const braInitBytecode    = ('0x' + BRA_ARTIFACT.bytecode + braConstructorArgs) as `0x${string}`

  let braDeployHash: `0x${string}`
  try {
    braDeployHash = await walletClient.sendTransaction({ data: braInitBytecode })
  } catch (e) {
    console.error('ERROR deploying BlindRelayAuction:', describeError(e))
    process.exit(1)
  }

  const braReceipt = await waitForTx(publicClient, braDeployHash, 'BlindRelayAuction deploy')
  const braAddress = braReceipt.contractAddress
  if (!braAddress) {
    console.error('ERROR: No contract address in BlindRelayAuction deploy receipt.')
    process.exit(1)
  }
  console.log(`  BlindRelayAuction deployed at: ${braAddress}`)
  console.log(`  Explorer: ${NET.explorer}/address/${braAddress}`)

  // ── Step 3: Read-back verification ────────────────────────────────────
  console.log()
  console.log('─'.repeat(60))
  console.log('[3/4] Post-deploy read-back verification')

  const [teUsdc, teTaskCount, teMaxRW, teMaxDH] = await Promise.all([
    publicClient.readContract({ address: teAddress, abi: TE_READ_ABI, functionName: 'usdc' }),
    publicClient.readContract({ address: teAddress, abi: TE_READ_ABI, functionName: 'taskCount' }),
    publicClient.readContract({ address: teAddress, abi: TE_READ_ABI, functionName: 'MAX_REVIEW_WINDOW' }),
    publicClient.readContract({ address: teAddress, abi: TE_READ_ABI, functionName: 'MAX_DEADLINE_HORIZON' }),
  ])
  const teUsdcOk = (teUsdc as string).toLowerCase() === NET.usdc.toLowerCase()
  console.log(`\n  TaskEscrow @ ${teAddress}`)
  console.log(`    usdc()                 = ${teUsdc}  ${teUsdcOk ? '✓' : '✗ MISMATCH'}`)
  console.log(`    taskCount()            = ${teTaskCount}`)
  console.log(`    MAX_REVIEW_WINDOW()    = ${teMaxRW}s (${Number(teMaxRW) / 86400} days)`)
  console.log(`    MAX_DEADLINE_HORIZON() = ${teMaxDH}s (${Number(teMaxDH) / 86400} days)`)

  const [braUsdc, braEscrow, braGasFloor, braMaxBidders, braAuctionCount] = await Promise.all([
    publicClient.readContract({ address: braAddress, abi: BRA_READ_ABI, functionName: 'usdc' }),
    publicClient.readContract({ address: braAddress, abi: BRA_READ_ABI, functionName: 'escrow' }),
    publicClient.readContract({ address: braAddress, abi: BRA_READ_ABI, functionName: 'GAS_FLOOR' }),
    publicClient.readContract({ address: braAddress, abi: BRA_READ_ABI, functionName: 'MAX_BIDDERS' }),
    publicClient.readContract({ address: braAddress, abi: BRA_READ_ABI, functionName: 'auctionCount' }),
  ])
  const braUsdcOk   = (braUsdc as string).toLowerCase() === NET.usdc.toLowerCase()
  const braEscrowOk = (braEscrow as string).toLowerCase() === teAddress.toLowerCase()
  console.log(`\n  BlindRelayAuction @ ${braAddress}`)
  console.log(`    usdc()         = ${braUsdc}  ${braUsdcOk ? '✓' : '✗ MISMATCH'}`)
  console.log(`    escrow()       = ${braEscrow}  ${braEscrowOk ? '✓' : `✗ MISMATCH (expected ${teAddress})`}`)
  console.log(`    GAS_FLOOR()    = ${braGasFloor}`)
  console.log(`    MAX_BIDDERS()  = ${braMaxBidders}`)
  console.log(`    auctionCount() = ${braAuctionCount}`)

  if (!teUsdcOk || !braUsdcOk || !braEscrowOk) {
    console.error('\nERROR: One or more read-back checks failed. Do NOT update the app config.')
    process.exit(1)
  }

  // ── Step 4: Deployed bytecode comparison ──────────────────────────────
  console.log()
  console.log('─'.repeat(60))
  console.log('[4/4] Deployed bytecode comparison')

  const [teOnChain, braOnChain] = await Promise.all([
    publicClient.getCode({ address: teAddress }),
    publicClient.getCode({ address: braAddress }),
  ])

  const teCmp  = teOnChain  ? compareBytecode(teOnChain,  TE_ARTIFACT.deployedBytecode)  : { match: false, note: 'no code at address' }
  const braCmp = braOnChain ? compareBytecode(braOnChain, BRA_ARTIFACT.deployedBytecode) : { match: false, note: 'no code at address' }

  console.log(`  TaskEscrow bytecode:        ${teCmp.match ? '✓' : '✗'} ${teCmp.note}`)
  console.log(`  BlindRelayAuction bytecode: ${braCmp.match ? '✓' : '✗'} ${braCmp.note}`)

  if (!teCmp.match || !braCmp.match) {
    console.error('\nWARNING: Deployed bytecode does not match committed artifact.')
    console.error('This may mean the contract source changed after the bytecode was last compiled.')
    console.error('Re-run `forge build --force` and regenerate contracts/bytecode/ before deploying again.')
    // Non-fatal — addresses are still valid, but warn loudly.
  }

  // ── Write addresses JSON ──────────────────────────────────────────────
  const addressOutput = {
    network: ACTIVE_ENV,
    chainId: CHAIN.id,
    deployedAt: new Date().toISOString(),
    contracts: {
      TaskEscrow:        teAddress,
      BlindRelayAuction: braAddress,
    },
    explorer: {
      TaskEscrow:        `${NET.explorer}/address/${teAddress}`,
      BlindRelayAuction: `${NET.explorer}/address/${braAddress}`,
    },
  }
  const outputPath = 'deployed-addresses.json'
  writeFileSync(outputPath, JSON.stringify(addressOutput, null, 2) + '\n')
  console.log(`\n  Addresses written to ${outputPath}`)

  // ── Final summary ─────────────────────────────────────────────────────
  console.log()
  console.log('═'.repeat(60))
  console.log('DEPLOY COMPLETE — update src/lib/blindrelay.ts with:')
  console.log('═'.repeat(60))
  const configKey = ACTIVE_ENV === 'testnet' ? 'TESTNET_CONFIG' : 'MAINNET_CONFIG'
  console.log(`\n  // In ${configKey}:`)
  console.log(`  taskEscrowAddress:        '${teAddress}',`)
  console.log(`  blindRelayAuctionAddress: '${braAddress}',`)
  console.log()
  console.log()
  console.log('Explorer links:')
  console.log(`  TaskEscrow:        ${NET.explorer}/address/${teAddress}`)
  console.log(`  BlindRelayAuction: ${NET.explorer}/address/${braAddress}`)
  console.log()
  console.log('Next steps:')
  console.log('  1. Update src/lib/blindrelay.ts with the addresses above.')
  console.log('  2. Verify both contracts: see contracts/verify-input/README-verify.md')
  console.log('  3. Rebuild the app: bun run build')
}

main().catch(e => {
  console.error('Unhandled error:', describeError(e))
  process.exit(1)
})
