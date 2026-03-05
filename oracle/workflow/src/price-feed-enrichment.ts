/**
 * CRE Workflow Extension: Chainlink Data Feed Price Enrichment
 *
 * Extends the existing attestation workflow with real-time price data from
 * Chainlink Data Feeds. Before submitting an attestation, the workflow:
 *
 *   1. Fetches the vault's underlying asset price from Chainlink Data Feeds
 *   2. Calculates the real-time USD value of the recipient's allocation
 *   3. Enriches the evidence hash with the price data
 *   4. Optionally gates attestation if portfolio value drops below threshold
 *
 * This module is imported by the main CRE workflow (main.ts) as an additional
 * external data source (Data Source D: Chainlink Price Feed).
 */

import { Runtime } from "@chainlink/cre-sdk";

// ---------------------------------------------------------------------------
// Chainlink Data Feed ABI (latestRoundData only)
// ---------------------------------------------------------------------------

const AGGREGATOR_ABI = [
  {
    inputs: [],
    name: "latestRoundData",
    outputs: [
      { name: "roundId", type: "uint80" },
      { name: "answer", type: "int256" },
      { name: "startedAt", type: "uint256" },
      { name: "updatedAt", type: "uint256" },
      { name: "answeredInRound", type: "uint80" },
    ],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "decimals",
    outputs: [{ name: "", type: "uint8" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

// latestRoundData() selector: 0xfeaf968c
const LATEST_ROUND_DATA_SELECTOR = "0xfeaf968c";
// decimals() selector: 0x313ce567
const DECIMALS_SELECTOR = "0x313ce567";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PriceFeedConfig = {
  rpcUrl: string;
  priceFeedAddress: string;   // Chainlink AggregatorV3 address (e.g., ETH/USD)
  minPriceUSD?: number;       // Minimum acceptable price (optional gate)
  maxStalenessSeconds?: number; // Max age of price data (default: 3600)
};

export type PriceFeedResult = {
  price: bigint;
  decimals: number;
  roundId: bigint;
  updatedAt: bigint;
  priceUSD: string;           // Human-readable price string
  isFresh: boolean;
};

// ---------------------------------------------------------------------------
// Data Source D: Chainlink Price Feed
// ---------------------------------------------------------------------------

/**
 * Fetch the latest price from a Chainlink Data Feed via JSON-RPC.
 *
 * @param runtime - CRE Runtime for HTTP calls.
 * @param config - Price feed configuration.
 * @returns PriceFeedResult with the latest price data.
 */
export async function fetchPriceFeed(
  runtime: Runtime<any>,
  config: PriceFeedConfig
): Promise<PriceFeedResult> {
  const maxStaleness = config.maxStalenessSeconds || 3600;

  // Fetch decimals
  const decimalsRes = await runtime.http.post(config.rpcUrl, {
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_call",
      params: [
        { to: config.priceFeedAddress, data: DECIMALS_SELECTOR },
        "latest",
      ],
    }),
    headers: { "Content-Type": "application/json" },
  });

  const decimalsResult = decimalsRes.body as { result?: string; error?: { message: string } };
  if (decimalsResult.error) {
    throw new Error(`Price feed decimals RPC error: ${decimalsResult.error.message}`);
  }
  const decimals = Number(BigInt(decimalsResult.result || "0x8"));

  // Fetch latest round data
  const roundRes = await runtime.http.post(config.rpcUrl, {
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "eth_call",
      params: [
        { to: config.priceFeedAddress, data: LATEST_ROUND_DATA_SELECTOR },
        "latest",
      ],
    }),
    headers: { "Content-Type": "application/json" },
  });

  const roundResult = roundRes.body as { result?: string; error?: { message: string } };
  if (roundResult.error) {
    throw new Error(`Price feed latestRoundData RPC error: ${roundResult.error.message}`);
  }

  // Decode ABI-encoded response (5 × 32 bytes)
  const data = roundResult.result || "0x";
  if (data.length < 2 + 320) {
    throw new Error("Invalid latestRoundData response length");
  }

  const roundId = BigInt("0x" + data.slice(2, 66));
  const answer = BigInt("0x" + data.slice(66, 130));
  // startedAt = data.slice(130, 194)
  const updatedAt = BigInt("0x" + data.slice(194, 258));
  // answeredInRound = data.slice(258, 322)

  // Check staleness
  const nowSeconds = BigInt(Math.floor(Date.now() / 1000));
  const isFresh = (nowSeconds - updatedAt) <= BigInt(maxStaleness);

  // Convert to human-readable price
  const priceUSD = (Number(answer) / 10 ** decimals).toFixed(decimals > 4 ? 4 : decimals);

  // Validate price
  if (answer <= 0n) {
    throw new Error(`Negative or zero price from feed: ${answer.toString()}`);
  }

  if (config.minPriceUSD !== undefined) {
    const priceNum = Number(answer) / 10 ** decimals;
    if (priceNum < config.minPriceUSD) {
      throw new Error(
        `Asset price $${priceUSD} below minimum $${config.minPriceUSD}. Attestation gated.`
      );
    }
  }

  return {
    price: answer,
    decimals,
    roundId,
    updatedAt,
    priceUSD,
    isFresh,
  };
}

/**
 * Enrich evidence hash with price feed data.
 *
 * @param originalEvidence - The original evidence hash (hex string).
 * @param priceFeed - Price feed result.
 * @returns Hex string of enriched evidence components (to be included in hash).
 */
export async function enrichEvidenceWithPrice(
  originalEvidence: string,
  priceFeed: PriceFeedResult
): Promise<string[]> {
  const { toHex } = await import("viem");

  return [
    toHex(priceFeed.price, { size: 32 }),        // 32 bytes: price
    toHex(BigInt(priceFeed.decimals), { size: 32 }), // 32 bytes: decimals
    toHex(priceFeed.roundId, { size: 32 }),       // 32 bytes: round ID
    toHex(priceFeed.updatedAt, { size: 32 }),     // 32 bytes: updated timestamp
  ];
}
