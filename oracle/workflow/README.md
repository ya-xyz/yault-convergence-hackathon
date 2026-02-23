# Release Attestation CRE Workflow

Chainlink CRE workflow that submits **oracle** attestations to the `ReleaseAttestation` contract. Used as the primary authority; entity authorities are fallback.

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

3. Configure CRE (e.g. `cre login`, `cre whoami`). For simulation, a funded Sepolia (or target chain) private key may be required for writes.

## Workflow behaviour

- **Cron trigger**: Runs on a schedule (e.g. every 5 minutes). Optionally calls `GET {platformApiBaseUrl}/api/oracle/pending` to fetch pending attestation requests; if any, builds `submitAttestation(SOURCE_ORACLE, ...)` and submits via CRE EVM Write to `ReleaseAttestation`.
- **HTTP trigger**: Receives a body `{ wallet_id, recipient_index, decision, reason_code?, evidence_hash }` and submits that attestation to the contract (same EVM Write path).

After the CRE DON writes to the contract, the platform can:
- Create a trigger from oracle: `POST /api/trigger/from-oracle` with `{ wallet_id, recipient_index }`.
- Or poll `GET /api/trigger/attestation?wallet_id=...&recipient_index=...` and then create the trigger when attestation appears.

## Simulation

From the workflow directory (or project root with CRE project.yaml pointing here):

```bash
cre workflow simulate . --target staging-settings
# With onchain write: add --broadcast
```

Choose the trigger (cron or HTTP) and provide inputs as required. See [CRE docs](https://docs.chain.link/cre/guides/operations/simulating-workflows).

## Files using Chainlink (for hackathon README)

- `oracle/workflow/src/main.ts` — CRE workflow (triggers, callback, EVM write)
- `oracle/workflow/workflow.yaml` — CRE workflow config
- `oracle/workflow/config.*.json` — chain and contract config
