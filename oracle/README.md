# Oracle Authority Layer

This directory implements **Chainlink oracle as the primary authority node, with existing entity authorities as fallback**.

## Design Overview

- **Primary Path (Oracle)**: The CRE Workflow writes attestations to the on-chain `ReleaseAttestation` contract when conditions are met; the platform prioritizes on-chain oracle results as the source for trigger/decision.
- **Fallback**: When no oracle attestation exists on-chain (timeout, not triggered, or disputed), the existing flow is used: law firms/courts submit decisions via `POST /api/trigger/initiate` and `POST /api/trigger/:id/decision`.

## Directory Structure

```
oracle/
  README.md                 # This file
  workflow/                 # Chainlink CRE Workflow
    src/
      main.ts               # Workflow entry: Trigger + Callback → EVM Write
    workflow.yaml           # CRE Workflow configuration
    package.json
    config.*.json           # Environment config (RPC, contract addresses, etc.)
  integration/              # Integration docs and scripts for existing server
```

The contract `ReleaseAttestation.sol` is located in the repository root under `contracts/src/`, shared by this layer and CRE.

## Workflow Behavior

1. **Trigger**: HTTP or Cron (or EVM event). For example: receiving a request to create a release attestation for (wallet_id, recipient_index).
2. **Callback**: Optionally calls an external API for validation, then uses CRE's EVM Write capability to call `ReleaseAttestation.submitAttestation(..., source=ORACLE)`.
3. **On-chain**: Only the CRE-designated DON/Forwarder address can write `source == oracle` attestations; the fallback address can only write `source == fallback`.

## Platform Integration

- **Reading on-chain attestations**: `server/services/attestationClient.js` queries `ReleaseAttestation.getAttestation(...)` by `wallet_id` (or its hash) and `recipient_index`.
- **Trigger Flow**:
  - If there's a request to create a trigger from oracle (e.g., `POST /api/trigger/from-oracle`), check on-chain first; if an oracle release attestation exists, create the trigger and adopt that decision (or enter cooling period).
  - Entity authorities can still call `POST /api/trigger/initiate` and `POST /api/trigger/:id/decision` as usual; serves as fallback when no oracle result is available or manual adjudication is needed.

## Running and Testing

- **CRE Workflow**: Install dependencies in `workflow/` and use the CRE CLI to simulate or deploy. See `workflow/README.md`.
- **Contracts**: Compile and test with Foundry in `contracts/`; after deployment, fill in addresses in `workflow` and `server` configs.
- **Integration Tests**: Start the server, configure `RELEASE_ATTESTATION_ADDRESS` and chain RPC, then call attestation query and trigger APIs to verify "oracle-first, fallback-backup".

### Automated Tests (No Chain Required)

- **JS Unit + Integration**: `npm run test:js` runs `tests/unit/attestation-client.test.js` and `tests/integration/oracle-api.test.js` (oracle API uses mock chain, no real RPC needed).
- **Contracts**: `cd contracts && forge test --match-contract ReleaseAttestationTest` runs the `ReleaseAttestation` Foundry tests.
