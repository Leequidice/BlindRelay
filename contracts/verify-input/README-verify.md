# Source Verification Instructions

## Background

Both contracts use Solidity `immutable` variables (`usdc`, and for BlindRelayAuction also `escrow`).
The Solidity compiler embeds zeroes for immutables in the artifact's `deployedBytecode`, replacing them
with the real values only at deploy time. The Etherscan-compatible v1 API does not support this;
only the Blockscout v2 native "Solidity Standard JSON Input" UI flow handles immutables correctly.

**Always use the Blockscout UI, not the API or forge verify-contract, for these contracts.**

---

## Compiler settings

| Field | Value |
|---|---|
| Compiler | solc `v0.8.28+commit.7893614a` |
| EVM version | `paris` |
| Optimizer | enabled, 200 runs |
| viaIR | false |

---

## TaskEscrow — `0xe7c20bd2834814e160f7cef8fd2cfe8fc6a0f59d`

**Constructor args:** `usdc = 0x3600000000000000000000000000000000000000`

ABI-encoded (hex, no `0x` prefix):
```
0000000000000000000000003600000000000000000000000000000000000000
```

**Steps:**
1. Open https://explorer.testnet.arc.io/address/0xe7c20bd2834814e160f7cef8fd2cfe8fc6a0f59d
2. Click the **Contract** tab.
3. Click **Verify & Publish**.
4. Choose **Solidity (Standard JSON Input)**.
5. Upload `TaskEscrow-standard-input.json` from this folder.
6. Set **Contract name:** `contracts/TaskEscrow.sol:TaskEscrow`
7. Set **Compiler version:** `v0.8.28+commit.7893614a`
8. Check **Optimization enabled**, set runs to `200`.
9. In **Constructor arguments**, paste the ABI-encoded hex above (no `0x`).
10. Click **Verify & Publish**.

---

## BlindRelayAuction — `0x27bcab80f486030dec9702d287e354a69bab186d`

**Constructor args:**
- `usdc_  = 0x3600000000000000000000000000000000000000`
- `escrow_ = 0xe7c20bd2834814e160f7cef8fd2cfe8fc6a0f59d`

ABI-encoded (hex, no `0x` prefix):
```
0000000000000000000000003600000000000000000000000000000000000000
000000000000000000000000e7c20bd2834814e160f7cef8fd2cfe8fc6a0f59d
```

**Steps:**
1. Open https://explorer.testnet.arc.io/address/0x27bcab80f486030dec9702d287e354a69bab186d
2. Click the **Contract** tab.
3. Click **Verify & Publish**.
4. Choose **Solidity (Standard JSON Input)**.
5. Upload `BlindRelayAuction-standard-input.json` from this folder.
6. Set **Contract name:** `contracts/BlindRelayAuction.sol:BlindRelayAuction`
7. Set **Compiler version:** `v0.8.28+commit.7893614a`
8. Check **Optimization enabled**, set runs to `200`.
9. In **Constructor arguments**, paste the ABI-encoded hex above (the two lines concatenated with no space or newline):
   `0000000000000000000000003600000000000000000000000000000000000000000000000000000000000000e7c20bd2834814e160f7cef8fd2cfe8fc6a0f59d`
10. Click **Verify & Publish**.

---

## Why the Etherscan-compat API does not work

The `usdc` and `escrow` fields are declared `immutable` in Solidity. The compiler leaves zeroes for
those slots in the `deployedBytecode` artifact; the EVM deployer fills them in with actual addresses
at deploy time. When Blockscout's v1 API verifier recompiles the source it gets zeroes in those slots,
which doesn't match the on-chain bytecode that has real addresses. The Blockscout v2 "Standard JSON
Input" UI verifier correctly identifies and strips immutable slots before comparing, so the
verification succeeds. `forge verify-contract` and the v1 `verifysourcecode` API endpoint both
produce "Fail - Unable to verify" for these contracts.

---

## Verifying after a new deploy

After deploying to a new address, you will have new constructor args. For mainnet:
- `usdc_` is always `0x3600000000000000000000000000000000000000`.
- `escrow_` is the new TaskEscrow address from that deploy.

Encode them with:
```powershell
# PowerShell (requires cast from Foundry)
cast abi-encode "constructor(address,address)" "0x3600000000000000000000000000000000000000" "<new-TaskEscrow-address>"
```

Then follow the UI steps above, substituting the new address and constructor args.
