/**
 * Yault Release Attestation — CRE Workflow (Oracle as primary authority).
 *
 * Trigger: HTTP (or Cron) with input { wallet_id, recipient_index, decision, reason_code?, evidence_hash }.
 * Callback: Optionally validate via platform API, then submit attestation to ReleaseAttestation contract
 *           via EVM Write (source = ORACLE). Only CRE DON/Forwarder can submit oracle attestations.
 *
 * Chainlink CRE docs: https://docs.chain.link/cre
 * - Triggers: https://docs.chain.link/cre/guides/workflow/using-triggers/overview
 * - EVM Write: https://docs.chain.link/cre/guides/workflow/using-evm-client/onchain-write/overview
 */

import { handler, Runner, Runtime, getNetwork } from "@chainlink/cre-sdk";
import { cron } from "@chainlink/cre-sdk/triggers";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Config schema (CRE uses Zod for validation)
// ---------------------------------------------------------------------------

const ConfigSchema = z.object({
  chainSelectorName: z.string(),
  rpcUrl: z.string().url(),
  releaseAttestationAddress: z.string(),
  platformApiBaseUrl: z.string().url().optional(),
});

type Config = z.infer<typeof ConfigSchema>;

// ---------------------------------------------------------------------------
// Trigger payload: for HTTP trigger, input is in trigger payload; for cron, we could poll platform API.
// ---------------------------------------------------------------------------

// #SUGGESTION: Use a string-based enum for decision to improve readability and type safety.
const DECISION_MAP = {
  release: 0,
  hold: 1,
  reject: 2,
} as const;

type DecisionString = keyof typeof DECISION_MAP;

export type AttestationInput = {
  wallet_id: string;
  recipient_index: number;
  decision: DecisionString; // "release" | "hold" | "reject"
  reason_code?: string;
  evidence_hash: string; // 32-byte hex
};

// ---------------------------------------------------------------------------
// ReleaseAttestation contract ABI (submitAttestation only for write)
// ---------------------------------------------------------------------------

const RELEASE_ATTESTATION_ABI = [
  {
    inputs: [
      { name: "source", type: "uint8" },
      { name: "walletIdHash", type: "bytes32" },
      { name: "recipientIndex", type: "uint256" },
      { name: "decision", type: "uint8" },
      { name: "reasonCode", type: "bytes32" },
      { name: "evidenceHash", type: "bytes32" },
    ],
    name: "submitAttestation",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
] as const;

const SOURCE_ORACLE = 0;

// ---------------------------------------------------------------------------
// Cron-triggered path: e.g. poll platform for "pending oracle" requests, then submit attestation.
// Satisfies "at least one blockchain + one external API" for hackathon.
// ---------------------------------------------------------------------------

async function onCronTrigger(
  config: Config,
  runtime: Runtime<Config>,
  _trigger: { ScheduledExecutionTime: string }
): Promise<string> {
  // 1) Optional: call platform API to get pending attestation requests (external API integration).
  // #4 FIX: Added retry with exponential backoff for platform API calls
  let input: AttestationInput | null = null;
  if (config.platformApiBaseUrl) {
    const MAX_RETRIES = 3;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        const res = await runtime.http.get(`${config.platformApiBaseUrl}/api/oracle/pending`);
        const data = res.body as { requests?: AttestationInput[] };
        if (data?.requests?.length) input = data.requests[0];
        break; // success
      } catch (err) {
        if (attempt < MAX_RETRIES) {
          // Exponential backoff: 1s, 2s, 4s
          const delayMs = Math.pow(2, attempt - 1) * 1000;
          await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
        } else {
          // All retries exhausted — skip this run
          return "platform_api_unavailable_after_retries";
        }
      }
    }
  }
  if (!input) return "no_pending_requests";

  return doSubmitAttestation(runtime, config, input);
}

// ---------------------------------------------------------------------------
// Shared: build calldata and submit to chain via CRE EVM Write (report + writeReport).
// ---------------------------------------------------------------------------

async function keccak256WalletId(walletId: string): Promise<`0x${string}`> {
  // #1 FIX: Added async keyword — await import() requires async function
  if (!walletId || typeof walletId !== 'string') {
    throw new Error('Invalid wallet_id: must be a non-empty string');
  }
  // #4 FIX: Validate wallet_id format (hex, 40-42 chars for EVM addresses)
  const trimmed = walletId.replace(/^0x/i, '');
  if (!/^[0-9a-fA-F]{40,64}$/.test(trimmed)) {
    throw new Error('Invalid wallet_id format: expected 40-64 hex chars (with optional 0x prefix)');
  }
  const { keccak256, toUtf8Bytes } = await import("viem");
  return keccak256(toUtf8Bytes(walletId));
}

async function reasonCodeToBytes32(reasonCode?: string): Promise<`0x${string}`> {
  // #1 FIX: Added async keyword — await import() requires async function
  if (!reasonCode) return "0x0000000000000000000000000000000000000000000000000000000000000000";
  const { keccak256, toUtf8Bytes } = await import("viem");
  return keccak256(toUtf8Bytes(reasonCode));
}

async function doSubmitAttestation(
  runtime: Runtime<Config>,
  config: Config,
  input: AttestationInput
): Promise<string> {
  const { encodeFunctionData } = await import("viem");

  // #SUGGESTION: Map decision string to contract uint8 and validate.
  const decisionValue = DECISION_MAP[input.decision];
  if (decisionValue === undefined) {
    throw new Error(`Invalid decision: "${input.decision}". Must be one of [${Object.keys(DECISION_MAP).join(", ")}]`);
  }

  const walletIdHash = await keccak256WalletId(input.wallet_id);
  const reasonCodeHash = await reasonCodeToBytes32(input.reason_code);
  const evidenceHash = input.evidence_hash.startsWith("0x")
    ? (input.evidence_hash as `0x${string}`)
    : (`0x${input.evidence_hash}` as `0x${string}`);

  const calldata = encodeFunctionData({
    abi: RELEASE_ATTESTATION_ABI,
    functionName: "submitAttestation",
    args: [
      SOURCE_ORACLE,
      walletIdHash,
      BigInt(input.recipient_index),
      decisionValue,
      reasonCodeHash,
      evidenceHash as `0x${string}`,
    ],
  });

  const network = getNetwork({
    chainFamily: "evm",
    chainSelectorName: config.chainSelectorName,
    isTestnet: true,
  });
  const evmClient = runtime.evm(network.chainSelector.selector);

  // CRE two-step write: generate signed report, then write via Forwarder.
  const report = await runtime.report(calldata);
  // #4 FIX: Add gasLimit config to prevent out-of-gas failures
  const txHash = await evmClient.writeReport(report, config.releaseAttestationAddress, { gasLimit: 500_000 });
  return txHash ?? "write_report_submitted";
}

// ---------------------------------------------------------------------------
// HTTP-triggered path: input comes from request body (for simulation / direct invoke).
// ---------------------------------------------------------------------------

async function onHttpTrigger(
  config: Config,
  runtime: Runtime<Config>,
  trigger: { body: AttestationInput }
): Promise<string> {
  const input = trigger.body;
  // #SUGGESTION: Added 'decision' to the validation check.
  if (!input?.wallet_id || input.recipient_index == null || !input.evidence_hash || !input.decision) {
    throw new Error("Missing wallet_id, recipient_index, evidence_hash, or decision");
  }
  return doSubmitAttestation(runtime, config, input);
}

// ---------------------------------------------------------------------------
// Workflow entry: register handlers (cron + HTTP).
// ---------------------------------------------------------------------------

function initWorkflow(config: Config) {
  const cronTrigger = cron.Trigger({ schedule: "0 */5 * * * *" }); // every 5 min
  return [
    handler(cronTrigger, (runtime, trigger) => onCronTrigger(config, runtime, trigger)),
    handler(
      { http: {} },
      (runtime, trigger) => onHttpTrigger(config, runtime, trigger as { body: AttestationInput })
    ),
  ];
}

const runner = Runner.newRunner(ConfigSchema);
runner.run(initWorkflow);
