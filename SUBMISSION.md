# BlindRelay — Submission

## Project description

BlindRelay is a sealed-bid reverse auction protocol with USDC escrow, deployed on Arc Testnet.
Buyers post a task with a USDC budget; service providers compete by submitting sealed bids
backed by a refundable bond; the lowest revealed price wins and a fully on-chain TaskEscrow
task is created automatically with the winner as provider. The entire lifecycle — commit,
reveal, finalize, deliver, accept — runs through smart contracts with no trusted intermediary.
USDC is the only token in the system, which is natural on Arc where USDC is the native gas token.

## How Arc Studio was used

**Contracts:** Both `TaskEscrow.sol` and `BlindRelayAuction.sol` were written iteratively in Arc
Studio through a multi-round conversation. The process covered: two-stage requirements
clarification; a design doc for each contract; multiple rounds of security review (both a
rule-corpus auditor and a functional auditor at the `max` severity level); Slither static
analysis; 140 Foundry unit and fork tests (written and run by Arc Studio); gas profiling
(worst-case finalize with 100 bidders: ~2.5 M gas, well under Arc's 30 M block limit); and
deployment with source-verification attempts on Arc Testnet Blockscout.

**Web app:** The six-page React frontend was scaffolded and wired up in Arc Studio, including
wagmi/ConnectKit integration, hash-based routing for shareable auction links, per-page
balance/allowance pre-flight checks, live countdown timers, receipt-status checking with
decoded revert messages on every write, and an error boundary with wallet-detection state.

**Tooling:** The viem-based self-deploy script (no Foundry required), agent bidder scripts with
on-chain commitment verification on restart, and all E2E integration scripts were generated
and debugged in Arc Studio.

## Contract addresses

| Network | Contract | Address |
|---|---|---|
| Arc Testnet | TaskEscrow | `0xe7c20bd2834814e160f7cef8fd2cfe8fc6a0f59d` |
| Arc Testnet | BlindRelayAuction | `0x27bcab80f486030dec9702d287e354a69bab186d` |
| Arc Mainnet | TaskEscrow | *(not yet deployed — see README mainnet runbook)* |
| Arc Mainnet | BlindRelayAuction | *(not yet deployed)* |

Testnet explorer: https://explorer.testnet.arc.io

## Example transaction hashes (to fill in)

| Action | Tx hash |
|---|---|
| TaskEscrow deploy | *(fill in from explorer)* |
| BlindRelayAuction deploy | *(fill in from explorer)* |
| createAuction | *(fill in after running the app)* |
| commitBid (bidder A) | *(fill in)* |
| commitBid (bidder B) | *(fill in)* |
| revealBid (bidder A) | *(fill in)* |
| revealBid (bidder B) | *(fill in)* |
| finalize | *(fill in)* |
| withdraw (buyer surplus) | *(fill in)* |
| submitDelivery | *(fill in)* |
| accept | *(fill in)* |

## Potential to go further

- **On-chain dispute resolution:** Replace the current permanently-locked Disputed state with a
  simple arbitration step — e.g. a mutually-agreed third-party address that can split the funds.
- **Multi-round auctions:** Allow buyers to re-open a Cancelled auction (e.g. no reveals) rather
  than creating a new one, preserving the task hash and bidder history.
- **Reputation layer:** Record auction outcomes on-chain per address (win rate, on-time delivery
  rate) so buyers can filter bidders by reputation. This is a natural fit for the ERC-8004 agent
  identity and reputation registries on Arc.
- **CCTP cross-chain funding:** Let buyers fund an auction from any CCTP chain using the Bridge
  Kit, so capital held on Ethereum or Base does not need to be bridged first.
- **Streaming payments:** Replace lump-sum acceptance with a milestone-based streaming payment
  using a protocol like Superfluid or Sablier, allowing the buyer to claw back unearned amounts
  if delivery is partial.
- **Agent-to-agent commerce:** Register both buyer and provider agents in the ERC-8004 identity
  registry; use ERC-8183 escrowed jobs as the off-chain coordination layer alongside the
  on-chain BlindRelayAuction commitment and settlement.
