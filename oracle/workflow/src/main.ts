/**
 * Yault Release Attestation — CRE Workflow (Oracle as primary authority).
 *
 * Trigger: HTTP (or Cron) with input { wallet_id, recipient_index, decision, reason_code?, evidence_hash }.
 * Callback: Optionally validate via platform API, then submit attestation to ReleaseAttestation contract
 *           via EVM Write (source = ORACLE). Only CRE DON/Forwarder can submit oracle attestations.
 *
 * External data sources (3):
 *   A) drand beacon — fetch latest round as cryptographic timestamp proof
 *   B) On-chain vault balance — verify vault holds assets before attesting
 *   C) Compliance API — external KYC/sanctions screening before release
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
  // --- External data source configs ---
  drandUrl: z.string().url().optional(),           // A: drand beacon endpoint
  vaultAddress: z.string().optional(),              // B: ERC-4626 vault for balance check
  complianceApiUrl: z.string().url().optional(),    // C: External KYC/compliance API
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
// Cron-triggered path: poll platform for "pending oracle" requests, then run
// 3 external data source checks (drand beacon, vault balance, compliance API)
// before submitting attestation via CRE EVM Write.
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

// ===========================================================================
// External Data Source A: drand Beacon (cryptographic timestamp proof)
// ===========================================================================

const DRAND_DEFAULT_URL = "https://drand.cloudflare.com";
const DRAND_CHAIN_HASH = "dbd506d6ef76e5f386f41c651dcb808c5bcbd75471cc4eafa3f4df7ad4e4c493";

type DrandBeacon = {
  round: number;
  randomness: string;
  signature: string;
};

/**
 * Fetch the latest drand beacon round. Used as a verifiable timestamp proof
 * embedded into the evidence hash so attestations are anchored to wall-clock time.
 */
async function fetchDrandBeacon(
  runtime: Runtime<Config>,
  config: Config
): Promise<DrandBeacon> {
  const baseUrl = config.drandUrl || DRAND_DEFAULT_URL;
  const url = `${baseUrl}/${DRAND_CHAIN_HASH}/public/latest`;
  const res = await runtime.http.get(url);
  const data = res.body as { round?: number; randomness?: string; signature?: string };
  if (!data?.round || !data?.randomness) {
    throw new Error("Invalid drand beacon response");
  }
  return {
    round: data.round,
    randomness: data.randomness,
    signature: data.signature || "",
  };
}

// ===========================================================================
// External Data Source B: On-chain Vault Balance Check
// ===========================================================================

// ERC-4626 totalAssets() selector: 0x01e1d114
const TOTAL_ASSETS_SELECTOR = "0x01e1d114";
// Minimum vault balance (in underlying asset smallest unit) to proceed with attestation.
// Prevents attesting releases on empty vaults.
const MIN_VAULT_BALANCE = BigInt(1);

type VaultBalanceResult = {
  totalAssets: bigint;
  sufficient: boolean;
};

/**
 * Query the ERC-4626 vault's totalAssets() to verify it holds funds before attesting.
 * This is an on-chain read via JSON-RPC (eth_call) — a genuine external data source.
 */
async function checkVaultBalance(
  runtime: Runtime<Config>,
  config: Config
): Promise<VaultBalanceResult> {
  if (!config.vaultAddress) {
    // No vault configured — skip check, assume sufficient
    return { totalAssets: BigInt(0), sufficient: true };
  }

  const rpcUrl = config.rpcUrl;
  const res = await runtime.http.post(rpcUrl, {
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_call",
      params: [
        { to: config.vaultAddress, data: TOTAL_ASSETS_SELECTOR },
        "latest",
      ],
    }),
    headers: { "Content-Type": "application/json" },
  });

  const rpcResult = res.body as { result?: string; error?: { message: string } };
  if (rpcResult.error) {
    throw new Error(`Vault balance RPC error: ${rpcResult.error.message}`);
  }

  const totalAssets = BigInt(rpcResult.result || "0x0");
  return {
    totalAssets,
    sufficient: totalAssets >= MIN_VAULT_BALANCE,
  };
}

// ===========================================================================
// External Data Source C: Compliance / KYC Screening API
// ===========================================================================

type ComplianceResult = {
  cleared: boolean;
  provider: string;
  checkId: string;
  riskScore: number;
};

/**
 * Call an external compliance API to screen the wallet/recipient before release.
 * In production this would be a real KYC/AML provider (e.g. Chainalysis, Elliptic).
 * For hackathon, the platform exposes GET /api/compliance/screen as a proxy.
 */
async function checkCompliance(
  runtime: Runtime<Config>,
  config: Config,
  walletId: string,
  recipientIndex: number
): Promise<ComplianceResult> {
  if (!config.complianceApiUrl) {
    // No compliance API configured — default pass
    return { cleared: true, provider: "none", checkId: "skip", riskScore: 0 };
  }

  const url = `${config.complianceApiUrl}/screen?wallet_id=${encodeURIComponent(walletId)}&recipient_index=${recipientIndex}`;
  const res = await runtime.http.get(url);
  const data = res.body as {
    cleared?: boolean;
    provider?: string;
    check_id?: string;
    risk_score?: number;
  };

  return {
    cleared: data?.cleared ?? true,
    provider: data?.provider || "unknown",
    checkId: data?.check_id || "unknown",
    riskScore: data?.risk_score ?? 0,
  };
}

// ===========================================================================
// Pre-Attestation Gate: run all 3 external checks before submitting
// ===========================================================================

type PreAttestationContext = {
  drand: DrandBeacon;
  vault: VaultBalanceResult;
  compliance: ComplianceResult;
};

/**
 * Run all external data source checks in parallel. Returns aggregated context
 * used to enrich evidence_hash and gate the attestation.
 */
async function runPreAttestationChecks(
  runtime: Runtime<Config>,
  config: Config,
  input: AttestationInput
): Promise<PreAttestationContext> {
  const [drand, vault, compliance] = await Promise.all([
    fetchDrandBeacon(runtime, config),
    checkVaultBalance(runtime, config),
    checkCompliance(runtime, config, input.wallet_id, input.recipient_index),
  ]);

  // Gate: vault must hold assets
  if (!vault.sufficient) {
    throw new Error(
      `Vault has insufficient assets (totalAssets=${vault.totalAssets.toString()}). Attestation aborted.`
    );
  }

  // Gate: compliance must be cleared
  if (!compliance.cleared) {
    throw new Error(
      `Compliance check failed (provider=${compliance.provider}, riskScore=${compliance.riskScore}). Attestation aborted.`
    );
  }

  return { drand, vault, compliance };
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
  const { encodeFunctionData, keccak256: viemKeccak256, toHex } = await import("viem");

  // -----------------------------------------------------------------------
  // Step 1: Run all 3 external data source checks (drand + vault + compliance)
  // -----------------------------------------------------------------------
  const ctx = await runPreAttestationChecks(runtime, config, input);

  // #SUGGESTION: Map decision string to contract uint8 and validate.
  const decisionValue = DECISION_MAP[input.decision];
  if (decisionValue === undefined) {
    throw new Error(`Invalid decision: "${input.decision}". Must be one of [${Object.keys(DECISION_MAP).join(", ")}]`);
  }

  const walletIdHash = await keccak256WalletId(input.wallet_id);
  const reasonCodeHash = await reasonCodeToBytes32(input.reason_code);

  // -----------------------------------------------------------------------
  // Step 2: Enrich evidence hash with external data source attestation context.
  //   Final evidence = keccak256(original_evidence || drand_round || drand_randomness
  //                               || vault_totalAssets || compliance_checkId)
  //   This anchors the attestation to a verifiable drand timestamp, on-chain vault
  //   state, and compliance screening result — all from independent external sources.
  // -----------------------------------------------------------------------
  const rawEvidence = input.evidence_hash.startsWith("0x")
    ? input.evidence_hash
    : `0x${input.evidence_hash}`;

  const enrichedEvidencePreimage = [
    rawEvidence,
    toHex(BigInt(ctx.drand.round), { size: 32 }),
    `0x${ctx.drand.randomness}`,
    toHex(ctx.vault.totalAssets, { size: 32 }),
    toHex(new TextEncoder().encode(ctx.compliance.checkId)),
  ].join("");

  // keccak256 of concatenated preimage gives a single bytes32 evidence hash
  const enrichedEvidence = viemKeccak256(enrichedEvidencePreimage as `0x${string}`);

  const calldata = encodeFunctionData({
    abi: RELEASE_ATTESTATION_ABI,
    functionName: "submitAttestation",
    args: [
      SOURCE_ORACLE,
      walletIdHash,
      BigInt(input.recipient_index),
      decisionValue,
      reasonCodeHash,
      enrichedEvidence,
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
