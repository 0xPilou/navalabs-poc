# Nava Guardian POC

## Summary

**What we did.** We tested Nava Guardian, a service that checks a proposed blockchain transaction
against a set of rules before it is signed. We wanted to see how hard it is to plug into, and
whether it could protect a wallet like the Superfluid Wallet.

**How we did it.** We built a small TypeScript program that sends Guardian a transaction and waits
for its verdict. Guardian never sees a private key. It only reads the transaction, checks it against
the policy set up in the Nava dashboard, and answers approved or rejected with a reason for each rule.
We then sent it a series of test transactions: Uniswap swaps on Sepolia, Ethereum mainnet, and Base,
with and without slippage protection; a Superfluid stream creation; and a plain ETH transfer.
Nothing was signed or broadcast. Every test was a question to Guardian, not a real transaction.

**What came out of it.**

- The integration is easy: two HTTP calls and about one second of waiting. The verdicts are detailed
  and readable, listing every rule that passed or failed, which is what you would show a user on an
  approval screen. Policy changes made in the dashboard apply on the very next request.
- Guardian understood every Uniswap transaction we sent, on all three chains. It correctly flagged the
  swap with no slippage protection, correctly rejected Base when the policy did not allow it, and
  correctly accepted mainnet once it was added to the policy.
- Two things stop it from ever saying "approved" right now, and both are on Nava's side: their
  sanctions list has not refreshed since late August 2026, and their test environment has no price
  feed for any token, so spending limits cannot be checked. Both should be reported to Nava.
- The key finding for Superfluid: Guardian only understands Uniswap and Hyperliquid today. It cannot
  read a Superfluid stream transaction and rejects them outright. Guardian would only be useful for
  the wallet if Nava adds support for Superfluid actions. That is the question to put to them.

The code, the test scenarios, and a full log of every result are below.

---

Small proof of concept against the Nava Guardian developer preview: submit a proposed
transaction, poll for a policy verdict, and gate execution on it. Zero Nava packages
(they are not on the public npm registry); this talks to the REST API directly.

- Docs: https://docs.navalabs.ai/guardian/overview
- Dashboard (testnet): https://testnet.navalabs.dev — Privy login; `/agents/new`, `/api-keys`
- API base: `https://internal.navalabs.dev/api` (found in the dashboard bundle; `/health` answers)

## Setup

```bash
cp .env.example .env   # fill NAVA_AGENT_API_KEY and NAVA_ESCROW_ADDRESS
pnpm install
pnpm test              # client unit tests (fake fetch)
```

In the dashboard: register an agent, attach the wallet address you will use as
`escrowAddress`, pick a Uniswap preset policy that allows Sepolia + WETH/USDC, activate it,
then create an agent API key.

## Run scenarios

```bash
pnpm verify swap           # Uniswap UR ETH->USDC exact-in with slippage guard (expect: approved if policy allows)
pnpm verify swap-noguard   # amountOutMin=0                                    (expect: rejected no_slippage_guard)
pnpm verify superfluid     # CFAv1Forwarder.createFlow                          (expect: rejected decode_failure)
pnpm verify transfer       # plain ETH send                                     (expect: rejected)
pnpm verify status <requestHash>   # re-read an envelope
pnpm verify swap --json    # raw verdict on stdout
```

Exit code 0 only when `outcome=approved` and `reasonCode=allowed`. Everything else is blocked.

## Files

| File | Purpose |
| --- | --- |
| `src/guardian-client.ts` | `GuardianClient` (`requestVerification`, `waitForVerification`, `getApprovalStatus`), `isApproved`, `explainVerdict`. Fail-closed by construction. |
| `src/actions.ts` | Builders for the sample `proposedTx` payloads (Universal Router calldata via viem, Superfluid createFlow, native transfer). |
| `src/cli.ts` | Scenario runner. |

## What this POC is meant to answer

1. Round-trip latency and verdict shape for a decodable Uniswap action.
2. Which Universal Router deployment Guardian's Sepolia manifest expects (v1.2 vs v2).
3. Confirmation that Superfluid stream operations fail closed with `decode_failure`, i.e. the
   coverage gap for the Superfluid Wallet use case.
4. How the verdict envelope would map onto the wallet's `eth_sendTransaction` approval UI.

## Findings from the first live run (2026-09-10)

- `proposedTx.value` must be a **decimal** wei string (`"1000000000000000"`). The docs' `"0x0"` example is
  rejected by the policy arbiter with `invalid_format`.
- Guardian's Sepolia manifest knows the **Universal Router v2** (`0x3A9D…F98b`) and decodes
  `WRAP_ETH + V3_SWAP_EXACT_IN` correctly (`actionType: v3_swap_exact_in`, slippage guard detected).
- Round trip (POST + first poll returning a terminal verdict): ~1.3 s; Guardian-side `latencyMs` ~10.
- Verdicts observed:

| Scenario | outcome / reasonCode | Notes |
| --- | --- | --- |
| swap | rejected / `data_unavailable` | sanctions list stale (ofac-2026-08-24), no USD price for Sepolia WETH, WETH not in policy asset universe |
| swap-noguard | rejected / `data_unavailable` | same, plus `slippage_guard: no_slippage_guard` correctly flagged |
| superfluid | rejected / `decode_failure` | `target … is not an allowed Uniswap V3-family contract` (CFAv1Forwarder) |
| transfer | rejected / `decode_failure` | `calldata too short for function selector` |

- Agent API keys cannot list agents (`403`) and the policy read route needs the agent id
  (`/agents/:id/policy`), not `me`.

## Mainnet / Base run (2026-09-10, policy version 1)

`pnpm verify swap --chain mainnet|base [--amount 1]`

| Scenario | outcome / reasonCode | Per-check detail |
| --- | --- | --- |
| mainnet swap (0.001 and 1 ETH) | rejected / `data_unavailable` | `chain_not_allowed` (allowlist is `[11155111]` only), asset universe **passed**, contract+selector **passed**, sanctions stale, no USD price for mainnet WETH |
| mainnet swap, no guard | same | plus `no_slippage_guard` |
| base swap | rejected / `data_unavailable` | `chain_not_allowed`, `asset_not_in_universe` for Base WETH, router not in contract allowlist; decoder still recognised the Base router |
| mainnet superfluid createFlow | rejected / `decode_failure` | same as Sepolia |

Takeaways: the active policy (v1) still allowlists Sepolia only even though mainnet assets and the
mainnet router are in the universe. The two remaining blockers are Nava-side: the OFAC list on the
devnet is 17 days old and treated as stale, and there is no USD price source for WETH on any chain.

## Policy version 2 (mainnet allowlisted)

`pnpm verify swap --chain mainnet` → `policyVersion: 2`, chain check **passed**. Every policy-level
check now passes (venue, chain, contract+selector, asset universe, sink recipient, slippage guard).
Still `rejected / data_unavailable` because of two Nava-side dependencies:

| Check | Failure | Root cause |
| --- | --- | --- |
| `sanctions` | `data_unavailable` | OFAC list `ofac-2026-08-24` is treated as stale |
| `per_tx_cap`, `outflow_24h` | `data_unavailable` | no USD price for WETH **or USDC** on mainnet (`swap-usdc-in` scenario), so the price source is absent, not asset-specific |

Policy changes are picked up on the next request (no key rotation, no restart).
