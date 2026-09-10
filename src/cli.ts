/**
 * Usage:
 *   pnpm verify <scenario> [--chain sepolia|mainnet|base] [--amount <eth>] [--json]
 *
 * Scenarios:
 *   swap            ETH->USDC exact-in on Uniswap Universal Router (Sepolia), with slippage guard
 *   swap-usdc-in    USDC->WETH exact-in (tests stablecoin pricing)
 *   swap-noguard    same swap with amountOutMin=0 (expect no_slippage_guard)
 *   superfluid      Superfluid createFlow via CFAv1Forwarder (expect decode_failure)
 *   transfer        plain ETH transfer (expect venue/decode rejection)
 *   status <hash>   re-read the approval status of an existing requestHash
 */
import "dotenv/config";
import { GuardianClient, GuardianError, explainVerdict, isApproved } from "./guardian-client.js";
import {
  CHAINS,
  type ChainKey,
  nativeTransfer,
  superfluidCreateFlow,
  uniswapEthToUsdcExactIn,
  uniswapEthToUsdcNoSlippageGuard,
  uniswapUsdcToWethExactIn,
} from "./actions.js";
import { getAddress, type Address } from "viem";

const env = (k: string): string => {
  const v = process.env[k];
  if (!v) {
    console.error(`missing env ${k} (see .env.example)`);
    process.exit(2);
  }
  return v;
};

const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const positional = argv.filter((a, i) => !a.startsWith("--") && !(i > 0 && argv[i - 1] === "--chain") && !(i > 0 && argv[i - 1] === "--amount"));
const [scenario = "swap", arg] = positional;
const asJson = argv.includes("--json");
const chainKey = (flag("chain") ?? "sepolia") as ChainKey;
const chain = CHAINS[chainKey];
if (!chain) {
  console.error(`unknown --chain ${chainKey} (${Object.keys(CHAINS).join(", ")})`);
  process.exit(2);
}
const amountEth = flag("amount") ?? "0.001";

const client = new GuardianClient({
  baseUrl: process.env.NAVA_BASE_URL ?? "https://internal.navalabs.dev/api",
  apiKey: env("NAVA_AGENT_API_KEY"),
});
const escrowAddress = env("NAVA_ESCROW_ADDRESS") as Address;

async function main() {
  if (scenario === "status") {
    if (!arg) throw new Error("status needs a requestHash");
    const envelope = await client.getApprovalStatus(arg);
    console.log(JSON.stringify(envelope, null, 2));
    return;
  }

  const scenarios: Record<string, () => { prompt: string; proposedTx: ReturnType<typeof nativeTransfer> }> = {
    swap: () => ({
      prompt: `Swap ${amountEth} ETH for USDC on Uniswap (${chain.name}), min out 1 USDC.`,
      proposedTx: uniswapEthToUsdcExactIn({ chain, amountInEth: amountEth, amountOutMinUsdc6: 1_000_000n }),
    }),
    "swap-usdc-in": () => ({
      prompt: `Swap 10 USDC for WETH on Uniswap (${chain.name}), min out 0.001 WETH.`,
      proposedTx: uniswapUsdcToWethExactIn({ chain, amountInUsdc6: 10_000_000n, amountOutMinWei: 1_000_000_000_000_000n }),
    }),
    "swap-noguard": () => ({
      prompt: `Swap ${amountEth} ETH for USDC on Uniswap (${chain.name}) with no minimum output.`,
      proposedTx: uniswapEthToUsdcNoSlippageGuard(chain, amountEth),
    }),
    superfluid: () => ({
      prompt: "Open a Superfluid stream of 1 ETHx/month to a receiver (Sepolia).",
      proposedTx: superfluidCreateFlow({
        superToken: getAddress("0x30a6933ca9230361972e413786b9a2d8e9ee7d1a"), // ETHx on Sepolia
        sender: escrowAddress,
        receiver: "0x000000000000000000000000000000000000dEaD",
        flowRateWeiPerSec: 385_802_469_135_802n, // ~1 token / 30 days
        chainId: chain.chainId,
      }),
    }),
    transfer: () => ({
      prompt: `Send ${amountEth} ETH to a random address (${chain.name}).`,
      proposedTx: nativeTransfer("0x000000000000000000000000000000000000dEaD", amountEth, chain.chainId),
    }),
  };

  const build = scenarios[scenario];
  if (!build) throw new Error(`unknown scenario "${scenario}" (${Object.keys(scenarios).join(", ")}, status)`);
  const { prompt, proposedTx } = build();

  console.error(`▶ scenario=${scenario} chain=${chain.name}`);
  console.error(`  to=${proposedTx.to} chainId=${proposedTx.chainId} value=${proposedTx.value} data=${proposedTx.data.slice(0, 20)}…(${(proposedTx.data.length - 2) / 2} bytes)`);

  const t0 = Date.now();
  const submitted = await client.requestVerification({
    escrowAddress,
    prompt,
    proposedTx,
    metadata: { environment: "poc", scenario, source: "superfluid-wallet-poc" },
    arbiter: "policy",
  });
  console.error(`  submitted: id=${submitted.id} requestHash=${submitted.requestHash} status=${submitted.status}`);

  const verdict = await client.waitForVerification(submitted.requestHash, {
    deadlineMs: 90_000,
    onPoll: (n, env) => console.error(`  poll #${n}: ${env?.verdict?.outcome ?? "no verdict yet"}`),
  });
  console.error(`  terminal verdict after ${Date.now() - t0}ms\n`);

  if (asJson) console.log(JSON.stringify({ requestHash: submitted.requestHash, verdict }, null, 2));
  else console.log(explainVerdict(verdict));

  if (isApproved(verdict)) {
    console.error("\n✅ APPROVED — caller may now sign & submit the exact same bytes.");
    process.exit(0);
  } else {
    console.error("\n⛔ BLOCKED — do not execute.");
    process.exit(1);
  }
}

main().catch((e) => {
  if (e instanceof GuardianError) {
    console.error(`⛔ GuardianError[${e.kind}${e.httpStatus ? ` ${e.httpStatus}` : ""}]: ${e.message}`);
    if (e.body) console.error(JSON.stringify(e.body, null, 2));
  } else {
    console.error(e);
  }
  process.exit(1);
});
