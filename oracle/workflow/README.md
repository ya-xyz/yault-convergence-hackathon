# Release Attestation CRE Workflow

Chainlink CRE workflow that submits **oracle** attestations to the `ReleaseAttestation` contract. Used as the primary authority; entity authorities are fallback.

## External Data Sources

Before submitting any attestation, the workflow queries **4 independent external data sources** and gates the attestation on their results:

| # | Data Source | Type | Purpose |
|---|-------------|------|---------|
| **A** | [drand](https://drand.love) beacon | External API | Fetches the latest BLS threshold randomness round as a verifiable cryptographic timestamp. The round number + randomness are mixed into the `evidenceHash`, anchoring each attestation to an independently verifiable wall-clock moment. |
| **B** | ERC-4626 vault `totalAssets()` | On-chain read (JSON-RPC `eth_call`) | Queries the Yault vault contract to confirm it holds non-zero assets. Prevents attesting releases on empty vaults. |
| **C** | Compliance screening API | External API | Calls `GET /api/compliance/screen` to run KYC/AML/sanctions checks on the wallet + recipient. In production this would proxy to Chainalysis or Elliptic; for the hackathon, the platform provides a built-in screening endpoint. |
| **D** | Chainlink Price Feed (`AggregatorV3`) | On-chain read (JSON-RPC `eth_call`) | Fetches latest market price for evidence enrichment and optional freshness/threshold gating. |

All checks run **in parallel** via `Promise.all`. If vault balance is zero, compliance screening fails, or configured price feed data is stale, the attestation is **aborted** before any on-chain write.

The final `evidenceHash` written on-chain is:

```
keccak256(original_evidence ‖ drand_round ‖ drand_randomness ‖ vault_totalAssets ‖ compliance_checkId ‖ price_components*)
```

`price_components*` are included when `priceFeedAddress` is configured.
This makes every attestation verifiably linked to external reality (time, asset state, compliance, and optionally market data).

## Requirements

- [CRE CLI](https://docs.chain.link/cre/getting-started/cli-installation) and account
- [Bun](https://bun.sh) or npm
- Deployed `ReleaseAttestation` contract with `oracleSubmitter` set to the CRE Forwarder address

## Setup

1. Install dependencies (from repo root or `oracle/workflow`):

   ```bash
   cd oracle/workflow && npm install
   # or: bun install
   ```

2. Copy `config.staging.json` and set:
   - `releaseAttestationAddress` — deployed `ReleaseAttestation` contract
   - `platformApiBaseUrl` — platform base URL (for optional GET /api/oracle/pending)
   - `rpcUrl` — EVM RPC for the chain where the contract is deployed
   - `drandUrl` — (optional) drand beacon endpoint, defaults to `https://drand.cloudflare.com`
   - `vaultAddress` — (optional) ERC-4626 vault contract address for balance gating
   - `complianceApiUrl` — (optional) compliance screening API base URL
   - `priceFeedAddress` — (optional) Chainlink Data Feed address for enrichment/gating
   - `maxStalenessSeconds` — (optional) max allowed price data age

3. Configure CRE (e.g. `cre login`, `cre whoami`). For simulation, a funded Sepolia (or target chain) private key may be required for writes.

## Workflow behaviour

- **Cron trigger**: Runs on a schedule (e.g. every 5 minutes). Optionally calls `GET {platformApiBaseUrl}/api/oracle/pending` to fetch pending attestation requests; if any, runs the 4 external data source checks, then builds `submitAttestation(SOURCE_ORACLE, ...)` and submits via CRE EVM Write to `ReleaseAttestation`.
- **HTTP trigger**: Receives a body `{ wallet_id, recipient_index, decision, reason_code?, evidence_hash }`, runs all pre-attestation checks, and submits that attestation to the contract (same EVM Write path).

After the CRE DON writes to the contract, the platform can:
- Create a trigger from oracle: `POST /api/trigger/from-oracle` with `{ wallet_id, recipient_index }`.
- Or poll `GET /api/trigger/attestation?wallet_id=...&recipient_index=...` and then create the trigger when attestation appears.

## Simulation

From the workflow directory (or project root with CRE project.yaml pointing here):

```bash
cre workflow simulate . --target staging
# With onchain write: add --broadcast
```

Choose the trigger (cron or HTTP) and provide inputs as required. See [CRE docs](https://docs.chain.link/cre/guides/operations/simulating-workflows).

## Files using Chainlink (for hackathon README)

- `oracle/workflow/src/main.ts` — CRE workflow (triggers, 4 external data sources, EVM write)
- `oracle/workflow/src/price-feed-enrichment.ts` — Data Source D (Chainlink price feed enrichment)
- `oracle/workflow/workflow.yaml` — CRE workflow config
- `oracle/workflow/config.*.json` — chain, contract, and external data source config
- `server/api/compliance/screen.js` — Compliance screening endpoint (Data Source C)
