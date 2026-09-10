/**
 * Sample proposed actions to throw at Guardian.
 *
 * Guardian evaluates decoded calldata, so the interesting cases are:
 *   1. a real Uniswap Universal Router swap (decodable, should get a per-check verdict)
 *   2. a Superfluid stream operation (NOT decodable today -> expect decode_failure / fail closed)
 *   3. a plain ETH transfer (out of venue -> expect venue/decode rejection)
 */
import { encodeAbiParameters, encodeFunctionData, parseAbi, parseEther, type Address, type Hex } from "viem";
import type { ProposedTx } from "./guardian-client.js";

export const SEPOLIA = 11155111;
export const MAINNET = 1;
export const BASE = 8453;

export interface ChainConfig {
  chainId: number;
  name: string;
  /** Uniswap Universal Router (v2, V2/V3/V4-capable). */
  universalRouter: Address;
  weth: Address;
  usdc: Address;
  /** Deepest WETH/USDC V3 fee tier. */
  fee: number;
}

export const CHAINS: Record<"sepolia" | "mainnet" | "base", ChainConfig> = {
  sepolia: {
    chainId: SEPOLIA,
    name: "Sepolia",
    // v1.2 (V2/V3 only) is 0x3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD; Guardian's manifest knows v2.
    universalRouter: "0x3A9D48AB9751398BbFa63ad67599Bb04e4BdF98b",
    weth: "0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14",
    usdc: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
    fee: 3000,
  },
  mainnet: {
    chainId: MAINNET,
    name: "Ethereum",
    universalRouter: "0x66a9893cC07D91D95644AEDD05D03f95e1dBA8Af",
    weth: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
    usdc: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    fee: 500,
  },
  base: {
    chainId: BASE,
    name: "Base",
    universalRouter: "0x6fF5693b99212Da76ad316178A184AB56D299b43",
    weth: "0x4200000000000000000000000000000000000006",
    usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    fee: 500,
  },
};
export type ChainKey = keyof typeof CHAINS;

const urAbi = parseAbi(["function execute(bytes commands, bytes[] inputs, uint256 deadline) payable"]);

// Universal Router command ids
const V3_SWAP_EXACT_IN = 0x00;
const WRAP_ETH = 0x0b;
const ADDRESS_THIS = "0x0000000000000000000000000000000000000002" as const; // router constant
const MSG_SENDER = "0x0000000000000000000000000000000000000001" as const; // router constant

function v3Path(tokenIn: Address, fee: number, tokenOut: Address): Hex {
  return `0x${tokenIn.slice(2)}${fee.toString(16).padStart(6, "0")}${tokenOut.slice(2)}` as Hex;
}

/**
 * ETH -> WETH -> USDC, exact input, via Universal Router:
 *   WRAP_ETH(recipient=router, amount)
 *   V3_SWAP_EXACT_IN(recipient=msg.sender, amountIn, amountOutMin, path, payerIsUser=false)
 * `amountOutMin` is the slippage guard Guardian checks for (`no_slippage_guard` otherwise).
 */
export function uniswapEthToUsdcExactIn(opts: {
  chain: ChainConfig;
  amountInEth: string;
  amountOutMinUsdc6: bigint;
  deadlineSec?: number;
  fee?: number;
}): ProposedTx {
  const { chain } = opts;
  const amountIn = parseEther(opts.amountInEth);
  const fee = opts.fee ?? chain.fee;
  const deadline = BigInt(opts.deadlineSec ?? Math.floor(Date.now() / 1000) + 20 * 60);

  const wrapInput = encodeAbiParameters(
    [{ type: "address" }, { type: "uint256" }],
    [ADDRESS_THIS, amountIn],
  );
  const swapInput = encodeAbiParameters(
    [{ type: "address" }, { type: "uint256" }, { type: "uint256" }, { type: "bytes" }, { type: "bool" }],
    [MSG_SENDER, amountIn, opts.amountOutMinUsdc6, v3Path(chain.weth, fee, chain.usdc), false],
  );
  const commands = `0x${WRAP_ETH.toString(16).padStart(2, "0")}${V3_SWAP_EXACT_IN.toString(16).padStart(2, "0")}` as Hex;

  const data = encodeFunctionData({
    abi: urAbi,
    functionName: "execute",
    args: [commands, [wrapInput, swapInput], deadline],
  });

  return {
    protocol: "uniswap",
    chainId: chain.chainId,
    to: chain.universalRouter,
    data,
    value: amountIn.toString(),
  };
}

/**
 * USDC -> WETH exact-in (payerIsUser=true, no wrap). Tests whether Guardian has a USD price
 * for the stablecoin leg when it has none for WETH.
 */
export function uniswapUsdcToWethExactIn(opts: {
  chain: ChainConfig;
  amountInUsdc6: bigint;
  amountOutMinWei: bigint;
  deadlineSec?: number;
}): ProposedTx {
  const { chain } = opts;
  const deadline = BigInt(opts.deadlineSec ?? Math.floor(Date.now() / 1000) + 20 * 60);
  const swapInput = encodeAbiParameters(
    [{ type: "address" }, { type: "uint256" }, { type: "uint256" }, { type: "bytes" }, { type: "bool" }],
    [MSG_SENDER, opts.amountInUsdc6, opts.amountOutMinWei, v3Path(chain.usdc, chain.fee, chain.weth), true],
  );
  const commands = `0x${V3_SWAP_EXACT_IN.toString(16).padStart(2, "0")}` as Hex;
  const data = encodeFunctionData({ abi: urAbi, functionName: "execute", args: [commands, [swapInput], deadline] });
  return { protocol: "uniswap", chainId: chain.chainId, to: chain.universalRouter, data, value: "0" };
}

/** Same swap but with amountOutMin = 0: should trip `no_slippage_guard`. */
export function uniswapEthToUsdcNoSlippageGuard(chain: ChainConfig, amountInEth: string): ProposedTx {
  return uniswapEthToUsdcExactIn({ chain, amountInEth, amountOutMinUsdc6: 0n });
}

// Superfluid CFAv1Forwarder (same address on all chains).
export const CFA_FORWARDER: Address = "0xcfA132E353cB4E398080B9700609bb008eceB125";
const cfaFwdAbi = parseAbi([
  "function createFlow(address token, address sender, address receiver, int96 flowrate, bytes userData) returns (bool)",
]);

/**
 * A Superfluid `createFlow` through the CFAv1 forwarder.
 * Guardian has no Superfluid decoder in preview; we expect `decode_failure` (fail closed).
 * This is the key gap to demonstrate for the Superfluid Wallet use case.
 */
export function superfluidCreateFlow(opts: {
  superToken: Address;
  sender: Address;
  receiver: Address;
  flowRateWeiPerSec: bigint;
  chainId?: number;
}): ProposedTx {
  const data = encodeFunctionData({
    abi: cfaFwdAbi,
    functionName: "createFlow",
    args: [opts.superToken, opts.sender, opts.receiver, opts.flowRateWeiPerSec, "0x"],
  });
  return {
    protocol: "uniswap", // deliberately mislabeled: see how Guardian reacts to non-router calldata
    chainId: opts.chainId ?? SEPOLIA,
    to: CFA_FORWARDER,
    data,
    value: "0",
  };
}

/** Plain ETH transfer to an arbitrary recipient. */
export function nativeTransfer(to: Address, amountEth: string, chainId = SEPOLIA): ProposedTx {
  return { protocol: "uniswap", chainId, to, data: "0x", value: parseEther(amountEth).toString() };
}
