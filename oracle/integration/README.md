# Oracle integration with platform

This folder documents how the **oracle** layer plugs into the existing server and contracts.

## Flow: Oracle first, entity fallback

1. **Oracle path** (with 4 external data source checks)
   - CRE workflow is triggered (cron or HTTP).
   - Workflow optionally fetches pending requests from `GET /api/oracle/pending`.
   - **Before attesting**, workflow runs 4 external data source checks in parallel:
     - **A) drand beacon** — fetches latest round from `https://drand.cloudflare.com` as verifiable timestamp proof
     - **B) Vault balance** — queries `totalAssets()` on the ERC-4626 vault via `eth_call` to confirm non-zero holdings
     - **C) Compliance screening** — calls `GET /api/compliance/screen` for KYC/AML/sanctions check
     - **D) Chainlink price feed** — reads latest AggregatorV3 data for enrichment and freshness gating
   - If vault is empty or compliance fails → attestation is **aborted**.
   - Otherwise, enriches `evidenceHash` with drand round + randomness + vault state + compliance checkId.
   - Workflow calls `ReleaseAttestation.submitAttestation(SOURCE_ORACLE, ...)` via CRE EVM Write.
   - Platform or a cron job calls `POST /api/trigger/from-oracle` with `{ wallet_id, recipient_index }`.
   - Server reads chain; if oracle attestation with `decision=release` exists, creates a trigger with `authority_id = oracle` and status `cooldown` (then finalized after cooldown).

2. **Fallback path**
   - When there is no oracle attestation (or CRE has not run yet), the entity authority (law firm / court) uses the existing API:
   - `POST /api/trigger/initiate` (with auth) and `POST /api/trigger/:id/decision`.
   - If the server has oracle enabled and finds an existing **oracle** release attestation for the same (wallet_id, recipient_index), it returns `409 Oracle already attested release` so the entity does not duplicate.

## External data sources in CRE workflow

```
                   ┌─────────────────────┐
                   │  CRE Workflow Entry  │
                   │  (Cron or HTTP)      │
                   └────────┬────────────┘
                            │
              ┌─────────────┼─────────────┐
              ▼             ▼             ▼
     ┌────────────┐ ┌────────────┐ ┌────────────┐ ┌────────────┐
     │ A) drand   │ │ B) Vault   │ │ C) Comply  │ │ D) Price   │
     │ beacon     │ │ eth_call   │ │ screen API │ │ feed       │
     │ (ext API)  │ │ (on-chain) │ │ (ext API)  │ │ (on-chain) │
     └─────┬──────┘ └─────┬──────┘ └─────┬──────┘ └─────┬──────┘
           │              │              │              │
           └──────────────┼──────────────┼──────────────┘
                          ▼
              ┌───────────────────────┐
              │ Gate: balance > 0 ?   │──No──▶ ABORT
              │       cleared ?       │
              └───────────┬───────────┘
                          │ Yes
                          ▼
              ┌───────────────────────┐
              │ Enrich evidenceHash   │
              │ = keccak256(evidence  │
              │   ‖ drand_round       │
              │   ‖ drand_randomness  │
              │   ‖ vault_totalAssets │
              │   ‖ compliance_id     │
              │   ‖ price_components*)│
              └───────────┬───────────┘
                          ▼
              ┌───────────────────────┐
              │ CRE EVM Write         │
              │ submitAttestation()   │
              └───────────────────────┘
```

`price_components*` are included when `priceFeedAddress` is configured in workflow config.

## Server config (env)

- `ORACLE_ATTESTATION_ENABLED=true` — turn on oracle checks and from-oracle endpoint.
- `RELEASE_ATTESTATION_ADDRESS` — `ReleaseAttestation` contract address.
- `ORACLE_RPC_URL` — RPC for the chain where the contract is deployed (optional; default Sepolia).
- `ORACLE_AUTHORITY_ID` — optional; if unset, server uses a deterministic id for "oracle" triggers.

## API summary

| Method | Path | Description |
|--------|------|-------------|
| GET | /api/trigger/attestation?wallet_id=&recipient_index= | Read attestation from chain (oracle or fallback). |
| POST | /api/trigger/from-oracle | Create trigger from chain oracle attestation (body: wallet_id, recipient_index). |
| GET | /api/oracle/pending | Stub for CRE workflow; returns `{ requests: [] }`. Extend to feed pending queue. |
| GET | /api/compliance/screen?wallet_id=&recipient_index= | Compliance screening (CRE external data source C). |

## Contract deployment

1. Deploy `ReleaseAttestation` (see `contracts/src/ReleaseAttestation.sol`).
2. Call `setOracleSubmitter(forwarderAddress)` with the CRE Forwarder address (from CRE deployment).
3. Call `setFallbackSubmitter(relayerOrBackendAddress, true)` for any address that may submit fallback attestations (e.g. platform backend).
4. Set `RELEASE_ATTESTATION_ADDRESS` and optional `ORACLE_RPC_URL` in the server env.
