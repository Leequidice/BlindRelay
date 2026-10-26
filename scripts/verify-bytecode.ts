#!/usr/bin/env bun
/**
 * verify-bytecode.ts
 *
 * Compiles each contract from its standard JSON input file using the installed
 * solc binary (same version used at deploy time: 0.8.28+commit.7893614a),
 * then compares the resulting deployed bytecode — with immutable slots masked —
 * against:
 *   1. The committed artifact in contracts/bytecode/
 *   2. The live on-chain code at the testnet deployment address
 *
 * Usage:
 *   bun run scripts/verify-bytecode.ts
 *
 * Requires: solc 0.8.28+commit.7893614a on PATH (pre-installed in sandbox).
 */

import { readFileSync } from 'fs'
import { spawnSync } from 'child_process'

// ─── On-chain addresses ────────────────────────────────────────────────────

const RPC = 'https://rpc.testnet.arc.io'

interface ContractSpec {
  name: string
  inputFile: string
  artifactFile: string
  onChainAddress: string
}

const CONTRACTS: ContractSpec[] = [
  {
    name: 'TaskEscrow',
    inputFile: 'contracts/verify-input/TaskEscrow-standard-input.json',
    artifactFile: 'contracts/bytecode/TaskEscrow.json',
    onChainAddress: '0xe7c20bd2834814e160f7cef8fd2cfe8fc6a0f59d',
  },
  {
    name: 'BlindRelayAuction',
    inputFile: 'contracts/verify-input/BlindRelayAuction-standard-input.json',
    artifactFile: 'contracts/bytecode/BlindRelayAuction.json',
    onChainAddress: '0x27bcab80f486030dec9702d287e354a69bab186d',
  },
]

// ─── Types for solc standard JSON output ─────────────────────────────────

interface ImmutableRef { start: number; length: number }

interface SolcOutput {
  errors?: Array<{ severity: string; formattedMessage: string }>
  contracts?: Record<string, Record<string, {
    evm: {
      deployedBytecode: {
        object: string
        immutableReferences?: Record<string, ImmutableRef[]>
      }
    }
  }>>
}

interface ArtifactFile {
  deployedBytecode: string  // hex, no 0x prefix
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function hexToBytes(hex: string): Buffer {
  return Buffer.from(hex.replace(/^0x/i, ''), 'hex')
}

function maskImmutables(
  hexBytecode: string,
  immutableRefs: Record<string, ImmutableRef[]>,
): string {
  const buf = hexToBytes(hexBytecode)
  for (const refs of Object.values(immutableRefs)) {
    for (const { start, length } of refs) {
      buf.fill(0, start, start + length)
    }
  }
  return buf.toString('hex')
}

function diff(labelA: string, hexA: string, labelB: string, hexB: string): { match: boolean; report: string } {
  if (hexA === hexB) return { match: true, report: `MATCH  (${hexA.length / 2} bytes)` }
  const lenA = hexA.length / 2
  const lenB = hexB.length / 2
  const diffs: string[] = []
  const minLen = Math.min(hexA.length, hexB.length)
  for (let i = 0; i < minLen; i += 2) {
    if (hexA[i] !== hexB[i] || hexA[i + 1] !== hexB[i + 1]) {
      diffs.push(`    offset 0x${(i / 2).toString(16).padStart(4, '0')}: ${labelA}=${hexA.slice(i, i + 2)}, ${labelB}=${hexB.slice(i, i + 2)}`)
    }
  }
  if (lenA !== lenB) diffs.push(`    length: ${labelA}=${lenA}B, ${labelB}=${lenB}B`)
  const shown = diffs.slice(0, 30)
  const extra = diffs.length > 30 ? `\n    … (${diffs.length - 30} more)` : ''
  return { match: false, report: `MISMATCH  ${diffs.length} diff(s):\n${shown.join('\n')}${extra}` }
}

async function getOnChainCode(address: string): Promise<string> {
  const body = JSON.stringify({ jsonrpc: '2.0', method: 'eth_getCode', params: [address, 'latest'], id: 1 })
  const res = await fetch(RPC, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })
  const json = await res.json() as { result: string }
  return json.result.replace(/^0x/i, '').toLowerCase()
}

// ─── Check solc version ───────────────────────────────────────────────────

const solcVer = spawnSync('solc', ['--version'], { encoding: 'utf8' })
if (solcVer.status !== 0) {
  console.error('solc not found on PATH'); process.exit(1)
}
const verLine = solcVer.stdout.split('\n').find(l => l.includes('Version:')) ?? ''
console.log(`\nsolc: ${verLine.trim()}`)
if (!verLine.includes('0.8.28+commit.7893614a')) {
  console.warn('WARNING: solc version does not match deploy version (0.8.28+commit.7893614a)')
}
console.log('='.repeat(70))

// ─── Process each contract ────────────────────────────────────────────────

for (const spec of CONTRACTS) {
  console.log(`\n▶  ${spec.name}`)
  console.log(`   input:    ${spec.inputFile}`)
  console.log(`   artifact: ${spec.artifactFile}`)
  console.log(`   on-chain: ${spec.onChainAddress}`)

  // 1. Compile via solc --standard-json
  const standardInput = readFileSync(spec.inputFile, 'utf8')
  const result = spawnSync('solc', ['--standard-json'], { input: standardInput, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  if (result.status !== 0 || !result.stdout) {
    console.error(`   solc error: ${result.stderr}`)
    continue
  }

  const output = JSON.parse(result.stdout) as unknown as SolcOutput
  const errors = (output.errors ?? []).filter(e => e.severity === 'error')
  if (errors.length > 0) {
    console.error('   Compile errors:')
    for (const e of errors) console.error(`     ${e.formattedMessage}`)
    continue
  }

  // 2. Extract deployed bytecode + immutable references
  let compiledHex: string | undefined
  let immRefs: Record<string, ImmutableRef[]> = {}

  outer:
  for (const [, contracts] of Object.entries(output.contracts ?? {})) {
    for (const [name, data] of Object.entries(contracts)) {
      if (name === spec.name) {
        compiledHex = data.evm.deployedBytecode.object.toLowerCase()
        immRefs = data.evm.deployedBytecode.immutableReferences ?? {}
        break outer
      }
    }
  }

  if (!compiledHex) { console.error(`   ${spec.name} not found in solc output`); continue }

  // 3. Report immutable slots
  const totalRefs = Object.values(immRefs).reduce((s, r) => s + r.length, 0)
  if (totalRefs > 0) {
    console.log(`   Immutable slots (${totalRefs} occurrence(s)):`)
    for (const [astId, refs] of Object.entries(immRefs)) {
      for (const r of refs) {
        console.log(`     astId ${astId}: byte offset 0x${r.start.toString(16).padStart(4,'0')}, ${r.length} byte(s)`)
      }
    }
  } else {
    console.log('   No immutable slots')
  }

  // 4. Read committed artifact
  const artifact = JSON.parse(readFileSync(spec.artifactFile, 'utf8')) as unknown as ArtifactFile
  const committedHex = artifact.deployedBytecode.toLowerCase().replace(/^0x/, '')

  // 5. Fetch on-chain code
  process.stdout.write('   Fetching on-chain code… ')
  const onChainHex = await getOnChainCode(spec.onChainAddress)
  console.log(`${onChainHex.length / 2} bytes`)

  console.log(`   compiled  length: ${compiledHex.length / 2} bytes`)
  console.log(`   committed length: ${committedHex.length / 2} bytes`)

  // 6. Mask immutables in all three
  const cmpMasked = maskImmutables(compiledHex,  immRefs)
  const artMasked = maskImmutables(committedHex, immRefs)
  const ocMasked  = maskImmutables(onChainHex,   immRefs)

  // 7. Compare
  console.log()
  const r1 = diff('compiled', cmpMasked, 'committed', artMasked)
  console.log(`   compiled  vs committed:  ${r1.report}`)
  const r2 = diff('compiled', cmpMasked, 'on-chain',  ocMasked)
  console.log(`   compiled  vs on-chain:   ${r2.report}`)
  const r3 = diff('committed', artMasked, 'on-chain', ocMasked)
  console.log(`   committed vs on-chain:   ${r3.report}`)

  if (r1.match && r2.match && r3.match) {
    console.log(`\n   ✓  ALL THREE MATCH — source + artifact + on-chain are consistent`)
  } else {
    console.log(`\n   ✗  MISMATCH — details above`)
  }

  console.log('-'.repeat(70))
}

console.log('\nDone.')
