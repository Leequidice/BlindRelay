/**
 * verify-explorer.ts
 *
 * Submits BlindRelayAuction for source verification to the active network's
 * Blockscout explorer using the Standard JSON Input format.
 *
 * Usage:
 *   bun scripts/verify-explorer.ts <contractAddress>
 *
 * Example (testnet):
 *   bun scripts/verify-explorer.ts 0x27bcab80f486030dec9702d287e354a69bab186d
 *
 * The explorer URL is read from src/lib/blindrelay.ts (ACTIVE_ENV controls
 * testnet vs mainnet — change it there to switch networks).
 *
 * Two endpoints are tried in order:
 *   1. Blockscout v2 native REST API
 *      POST /api/v2/smart-contracts/<addr>/verification/via/standard-input
 *      Ref: https://docs.blockscout.com/devs/verification/blockscout-smart-contract-verification-api
 *      Ref: https://blockscout.mintlify.app/devs/verification/blockscout-smart-contract-verification-api
 *      (field names confirmed from https://github.com/blockscout/blockscout/issues/9372)
 *
 *   2. Etherscan-compatible v1 API (fallback)
 *      POST /api?module=contract&action=verifysourcecode
 *      Ref: https://docs.blockscout.com/devs/verification/blockscout-smart-contract-verification-api
 *
 * No private key is read or logged anywhere in this script.
 */

import { readFileSync } from 'fs'
import { resolve } from 'path'
import { encodeAbiParameters, isAddress } from 'viem'
import { CHAIN_CONFIG } from '../src/lib/blindrelay'

// ─── Constants ────────────────────────────────────────────────────────────────

// Matches SPDX-License-Identifier on line 1 of BlindRelayAuction.sol.
// v2 API expects the slug string; v1 API expects the numeric index.
// Full list: https://docs.blockscout.com/devs/verification/blockscout-smart-contract-verification-api
// 1=None 2=Unlicense 3=MIT 4=GPLv2 5=GPLv3 6=LGPLv2.1 7=LGPLv3
// 8=BSD-2-Clause 9=BSD-3-Clause 10=MPL-2.0 11=OSL-3.0 12=Apache-2.0
// 13=AGPLv3 14=BSL-1.1
const LICENSE_SLUG    = 'mit'  // v2 API: string slug
const LICENSE_NUMBER  = 3      // v1 API: numeric index

const COMPILER_VERSION = 'v0.8.28+commit.7893614a'
const EVM_VERSION      = 'paris'
const OPTIMIZER_RUNS   = 200
const CONTRACT_NAME    = 'BlindRelayAuction'
const CONTRACT_PATH    = 'contracts/BlindRelayAuction.sol'

// ─── Args ─────────────────────────────────────────────────────────────────────

const contractAddress = process.argv[2]
if (!contractAddress) {
  console.error('Usage: bun scripts/verify-explorer.ts <contractAddress>')
  process.exit(1)
}
if (!isAddress(contractAddress)) {
  console.error(`Error: "${contractAddress}" is not a valid address.`)
  process.exit(1)
}
const addr = contractAddress.toLowerCase() as `0x${string}`

// ─── Read standard-input JSON ─────────────────────────────────────────────────

const stdInputPath = resolve(
  process.cwd(),
  'contracts/verify-input/BlindRelayAuction-standard-input.json',
)
let stdInputRaw: string
try {
  stdInputRaw = readFileSync(stdInputPath, 'utf-8')
} catch {
  console.error(`Could not read: ${stdInputPath}`)
  process.exit(1)
}

// Parse once to validate, then use raw string in requests.
JSON.parse(stdInputRaw) // throws if malformed

// ─── Derive constructor args with viem ────────────────────────────────────────
//
// BlindRelayAuction constructor(address usdc_, address escrow_)
// Read both addresses from CHAIN_CONFIG so they always match ACTIVE_ENV.

const { usdcAddress, taskEscrowAddress, blindRelayAuctionAddress, explorerBase } = CHAIN_CONFIG

// encodeAbiParameters produces "0x" + 64 hex chars per address (32-byte padded).
// Per Blockscout v12 breaking change, constructor_args must be 0x-prefixed
// when sent to the v2 API.  The v1 "constructorArguements" field takes raw hex
// (no 0x prefix) — that is the Etherscan-compatible convention and Blockscout
// follows it for the v1 route.
const constructorArgsWith0x: `0x${string}` = encodeAbiParameters(
  [
    { name: 'usdc_',   type: 'address' },
    { name: 'escrow_', type: 'address' },
  ],
  [usdcAddress, taskEscrowAddress],
)
const constructorArgsNo0x = constructorArgsWith0x.slice(2)

// ─── Summary ─────────────────────────────────────────────────────────────────

console.log('\nVerification target')
console.log(`  Contract address : ${addr}`)
console.log(`  Explorer base    : ${explorerBase}`)
console.log(`  USDC (usdc_)     : ${usdcAddress}`)
console.log(`  TaskEscrow       : ${taskEscrowAddress}`)
console.log(`  Constructor args : ${constructorArgsWith0x}`)
console.log(`  Compiler version : ${COMPILER_VERSION}`)
console.log(`  EVM version      : ${EVM_VERSION}`)
console.log(`  Optimizer runs   : ${OPTIMIZER_RUNS}`)
console.log(`  License          : MIT (slug="${LICENSE_SLUG}", number=${LICENSE_NUMBER})`)
console.log(`  Standard input   : ${stdInputPath}`)

if (addr !== blindRelayAuctionAddress.toLowerCase()) {
  console.warn(
    `\nWarning: supplied address ${addr} does not match CHAIN_CONFIG.blindRelayAuctionAddress ` +
    `${blindRelayAuctionAddress}. Proceeding — verify the constructor args match your actual deployment.`,
  )
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}

/** POST a request, print full HTTP status and response body, return both. */
async function postWithLog(
  label: string,
  url: string,
  init: RequestInit,
): Promise<{ status: number; body: string }> {
  console.log(`\n${'─'.repeat(60)}`)
  console.log(`[${label}]  POST ${url}`)
  const res = await fetch(url, init)
  const body = await res.text()
  console.log(`HTTP ${res.status} ${res.statusText}`)
  console.log('Response body:')
  console.log(body)
  return { status: res.status, body }
}

/** GET a URL and return status + body (no logging). */
async function getQuiet(url: string): Promise<{ status: number; body: string }> {
  const res = await fetch(url)
  const body = await res.text()
  return { status: res.status, body }
}

/** Parse body as JSON; return null on error. */
function tryJson(body: string): Record<string, unknown> | null {
  try { return JSON.parse(body) as Record<string, unknown> } catch { return null }
}

// ─── Attempt 1: Blockscout v2 native REST API ─────────────────────────────────
//
// Endpoint (per docs + confirmed field names from GH issue #9372):
//   POST /api/v2/smart-contracts/<addr>/verification/via/standard-input
//
// Multipart fields:
//   files[0]                  – the standard-input .json file (Blob, content-type application/json)
//   compiler_version          – "v0.8.28+commit.7893614a"
//   contract_name             – "BlindRelayAuction"  (short name, no path prefix)
//   license_type              – "mit"
//   constructor_args          – 0x-prefixed ABI-encoded hex  (Blockscout v12+: must have 0x)
//   autodetect_constructor_args – "false"
//   is_optimization_enabled   – "true"
//   optimization_runs         – "200"
//   evm_version               – "paris"
//   is_via_ir                 – "false"
//
// The file Blob MUST be appended as files[0], not files.
// Using a bare "files" key (without the index) returns {"message":"JSON files not found"}.
// Source: https://github.com/blockscout/blockscout/issues/9372#issuecomment-*

const V2_FILE_FIELD    = 'files[0]'
const V2_FILE_NAME     = 'BlindRelayAuction-standard-input.json'

const v2FormData = new FormData()
v2FormData.append(V2_FILE_FIELD,                 new Blob([stdInputRaw], { type: 'application/json' }), V2_FILE_NAME)
v2FormData.append('compiler_version',            COMPILER_VERSION)
v2FormData.append('contract_name',               CONTRACT_NAME)
v2FormData.append('license_type',                LICENSE_SLUG)
v2FormData.append('constructor_args',            constructorArgsWith0x)       // 0x-prefixed
v2FormData.append('autodetect_constructor_args', 'false')
v2FormData.append('is_optimization_enabled',     'true')
v2FormData.append('optimization_runs',           String(OPTIMIZER_RUNS))
v2FormData.append('evm_version',                 EVM_VERSION)
v2FormData.append('is_via_ir',                   'false')

// Print the exact field names and filename we are about to send.
console.log('\nv2 multipart fields being sent:')
console.log(`  ${V2_FILE_FIELD.padEnd(35)} filename="${V2_FILE_NAME}"  content-type=application/json`)
console.log(`  ${'compiler_version'.padEnd(35)} ${COMPILER_VERSION}`)
console.log(`  ${'contract_name'.padEnd(35)} ${CONTRACT_NAME}`)
console.log(`  ${'license_type'.padEnd(35)} ${LICENSE_SLUG}`)
console.log(`  ${'constructor_args'.padEnd(35)} ${constructorArgsWith0x}`)
console.log(`  ${'autodetect_constructor_args'.padEnd(35)} false`)
console.log(`  ${'is_optimization_enabled'.padEnd(35)} true`)
console.log(`  ${'optimization_runs'.padEnd(35)} ${OPTIMIZER_RUNS}`)
console.log(`  ${'evm_version'.padEnd(35)} ${EVM_VERSION}`)
console.log(`  ${'is_via_ir'.padEnd(35)} false`)

const v2Url = `${explorerBase}/api/v2/smart-contracts/${addr}/verification/via/standard-input`

const v2Result = await postWithLog(
  'Blockscout v2 standard-input',
  v2Url,
  { method: 'POST', body: v2FormData },
)

// Success: 200 or 201.  Any other status means the endpoint rejected the request;
// do NOT poll — fall straight through to v1.
const v2Accepted = v2Result.status === 200 || v2Result.status === 201

if (!v2Accepted) {
  console.log(`\nv2 endpoint returned HTTP ${v2Result.status} — not polling; falling back to v1.`)
} else {
  // Check whether the body already contains a rejection message.
  const v2Json = tryJson(v2Result.body)
  const v2Message = typeof v2Json?.['message'] === 'string' ? v2Json['message'] : ''

  if (v2Message && v2Message !== 'OK' && v2Message !== '') {
    // Blockscout returns 200 with {"message":"..."} for some rejection cases.
    // "JSON files not found" means wrong field name — we've fixed that above.
    // Stop immediately and report; do not poll.
    console.log(`\nv2 returned a rejection message: "${v2Message}"`)
    console.log('Falling back to v1.')
  } else {
    // Accepted — poll the contract endpoint until is_verified flips.
    console.log('\nPolling /api/v2/smart-contracts/<addr> for verification result…')
    const pollUrl    = `${explorerBase}/api/v2/smart-contracts/${addr}`
    const POLL_MS    = 10_000
    const MAX_POLLS  = 18   // 3 minutes

    let verified = false
    for (let i = 1; i <= MAX_POLLS; i++) {
      await sleep(POLL_MS)
      console.log(`\nPoll ${i}/${MAX_POLLS}`)

      const { status, body } = await getQuiet(pollUrl)
      console.log(`  HTTP ${status}`)
      console.log(`  ${body.slice(0, 300)}${body.length > 300 ? '…' : ''}`)

      if (status !== 200) continue

      const j = tryJson(body)
      if (!j) continue

      if (j['is_verified'] === true) {
        console.log('\n✓ Verified via Blockscout v2!')
        console.log(`  ${explorerBase}/address/${addr}#code`)
        verified = true
        break
      }

      // is_verified === false during polling means still processing; keep waiting.
    }

    if (verified) process.exit(0)

    console.log('\nPolling timed out. The job may still be processing.')
    console.log(`Check manually: ${explorerBase}/address/${addr}`)
    console.log('Falling back to v1 API…')
  }
}

// ─── Attempt 2: Etherscan-compatible v1 API ───────────────────────────────────
//
// POST /api?module=contract&action=verifysourcecode
// Content-Type: application/x-www-form-urlencoded
//
// Field reference: https://docs.blockscout.com/devs/verification/blockscout-smart-contract-verification-api
//   contractaddress      – the address
//   sourceCode           – the standard-input JSON as a string
//   codeformat           – "solidity-standard-json-input"
//   contractname         – "contracts/BlindRelayAuction.sol:BlindRelayAuction"
//   compilerversion      – "v0.8.28+commit.7893614a"
//   optimizationUsed     – "1"
//   runs                 – "200"
//   evmversion           – "paris"
//   licenseType          – "3"  (MIT, numeric)
//   constructorArguements – raw hex WITHOUT 0x  (Etherscan convention, Blockscout v1 follows it)
//   Note: "constructorArguements" is the intentional Etherscan misspelling; both spellings
//         are accepted by Blockscout's v1 route, but the misspelled form is canonical.

const v1Url = `${explorerBase}/api?module=contract&action=verifysourcecode`

// Print v1 fields before sending.
console.log('\nv1 form fields being sent:')
console.log(`  ${'contractaddress'.padEnd(28)} ${addr}`)
console.log(`  ${'codeformat'.padEnd(28)} solidity-standard-json-input`)
console.log(`  ${'contractname'.padEnd(28)} ${CONTRACT_PATH}:${CONTRACT_NAME}`)
console.log(`  ${'compilerversion'.padEnd(28)} ${COMPILER_VERSION}`)
console.log(`  ${'optimizationUsed'.padEnd(28)} 1`)
console.log(`  ${'runs'.padEnd(28)} ${OPTIMIZER_RUNS}`)
console.log(`  ${'evmversion'.padEnd(28)} ${EVM_VERSION}`)
console.log(`  ${'licenseType'.padEnd(28)} ${LICENSE_NUMBER}`)
console.log(`  ${'constructorArguements'.padEnd(28)} ${constructorArgsNo0x}  (no 0x prefix)`)
console.log(`  ${'sourceCode'.padEnd(28)} <standard-input JSON, ${stdInputRaw.length} chars>`)

const v1Params = new URLSearchParams({
  apikey:                 'BLOCKSCOUT',
  module:                 'contract',
  action:                 'verifysourcecode',
  contractaddress:        addr,
  sourceCode:             stdInputRaw,
  codeformat:             'solidity-standard-json-input',
  contractname:           `${CONTRACT_PATH}:${CONTRACT_NAME}`,
  compilerversion:        COMPILER_VERSION,
  optimizationUsed:       '1',
  runs:                   String(OPTIMIZER_RUNS),
  evmversion:             EVM_VERSION,
  licenseType:            String(LICENSE_NUMBER),
  constructorArguements:  constructorArgsNo0x,  // no 0x — Etherscan/v1 convention
})

const v1Result = await postWithLog(
  'Etherscan-compatible v1',
  v1Url,
  {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: v1Params.toString(),
  },
)

// v1 returns { "status":"1", "message":"OK", "result":"<guid>" } on acceptance.
const v1Json = tryJson(v1Result.body)
if (!v1Json || v1Json['status'] !== '1' || typeof v1Json['result'] !== 'string') {
  console.log('\nv1 did not return an acceptance GUID. See raw response above.')
  diagnoseFailure(v1Json)
  process.exit(1)
}

const guid = v1Json['result']
console.log(`\nv1 accepted. GUID: ${guid}`)
console.log('Polling v1 checkverifystatus…')

const POLL_MS   = 10_000
const MAX_POLLS = 18   // 3 minutes

for (let i = 1; i <= MAX_POLLS; i++) {
  await sleep(POLL_MS)
  console.log(`\nPoll ${i}/${MAX_POLLS}`)

  const pollUrl = `${explorerBase}/api?module=contract&action=checkverifystatus&guid=${guid}`
  const { status, body } = await getQuiet(pollUrl)
  console.log(`  HTTP ${status}`)
  console.log(`  ${body.slice(0, 300)}${body.length > 300 ? '…' : ''}`)

  const j = tryJson(body)
  if (!j) continue

  const result = j['result']
  if (typeof result !== 'string') continue

  if (result === 'Pass - Verified') {
    console.log('\n✓ Verified via v1 API!')
    console.log(`  ${explorerBase}/address/${addr}#code`)
    process.exit(0)
  }

  if (result.startsWith('Fail')) {
    console.log('\n✗ Verification failed.')
    console.log(`  Result: ${result}`)
    diagnoseFailure(j)
    process.exit(1)
  }

  if (result === 'Pending in queue' || result === 'Already Verified') {
    console.log(`  Status: ${result}`)
  }
}

console.log('\nPolling timed out — status still pending.')
console.log(`Check manually: ${explorerBase}/address/${addr}`)
process.exit(1)

// ─── Failure diagnostics ──────────────────────────────────────────────────────
//
// Only mentions immutable-slot mismatch when the response explicitly says so.
// For all other failures, prints the raw response and actionable next steps.

function diagnoseFailure(json: Record<string, unknown> | null): void {
  const message = typeof json?.['message'] === 'string' ? json['message'] : ''
  const result  = typeof json?.['result']  === 'string' ? json['result']  : ''
  const text    = `${message} ${result}`.toLowerCase()

  console.log('\nDiagnosis:')

  if (text.includes('immutable') || text.includes('runtime bytecode')) {
    // Server explicitly named immutables as the cause.
    console.log(
      '  The server reported an immutable-slot mismatch. The v1 API compares full bytecode\n' +
      '  including immutable slots. Use the Blockscout UI "Solidity (Standard JSON Input)"\n' +
      '  flow, which handles immutable variables correctly.',
    )
    console.log(`  UI: ${explorerBase}/address/${addr}/contract-verification`)
    return
  }

  if (text.includes('constructor')) {
    console.log('  The server reported a constructor-argument error.')
    console.log(`  Expected (ABI-encoded, no 0x):`)
    console.log(`    ${constructorArgsNo0x}`)
    console.log(`  Decoded: usdc_ = ${usdcAddress}  /  escrow_ = ${taskEscrowAddress}`)
    return
  }

  // Generic failure — actionable next steps without guessing the cause.
  console.log('  Common causes:')
  console.log('  1. Rate-limiting: wait a few minutes and retry.')
  console.log('  2. Already verified: check the explorer.')
  console.log('  3. Constructor arguments wrong.')
  console.log(`     Expected (no 0x): ${constructorArgsNo0x}`)
  console.log(`     Decoded: usdc_ = ${usdcAddress}  /  escrow_ = ${taskEscrowAddress}`)
  console.log('  4. Source or compiler-settings mismatch.')
  console.log('     Run scripts/verify-bytecode.ts to compare bytecode byte-for-byte.')
  console.log(`  Explorer: ${explorerBase}/address/${addr}`)
  console.log(`  UI verify: ${explorerBase}/address/${addr}/contract-verification`)
}
