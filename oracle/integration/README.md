# Oracle integration with platform

This folder documents how the **oracle** layer plugs into the existing server and contracts.

## Flow: Oracle first, entity fallback

1. **Oracle path**
   - CRE workflow is triggered (cron or HTTP).
   - Workflow optionally fetches pending requests from `GET /api/oracle/pending`.
   - Workflow calls `ReleaseAttestation.submitAttestation(SOURCE_ORACLE, ...)` via CRE EVM Write.
   - Platform or a cron job calls `POST /api/trigger/from-oracle` with `{ wallet_id, recipient_index }`.
   - Server reads chain; if oracle attestation with `decision=release` exists, creates a trigger with `authority_id = oracle` and status `cooldown` (then finalized after cooldown).

2. **Fallback path**
   - When there is no oracle attestation (or CRE has not run yet), the entity authority (law firm / court) uses the existing API:
   - `POST /api/trigger/initiate` (with auth) and `POST /api/trigger/:id/decision`.
   - If the server has oracle enabled and finds an existing **oracle** release attestation for the same (wallet_id, recipient_index), it returns `409 Oracle already attested release` so the entity does not duplicate.

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

## Contract deployment

1. Deploy `ReleaseAttestation` (see `contracts/src/ReleaseAttestation.sol`).
2. Call `setOracleSubmitter(forwarderAddress)` with the CRE Forwarder address (from CRE deployment).
3. Call `setFallbackSubmitter(relayerOrBackendAddress, true)` for any address that may submit fallback attestations (e.g. platform backend).
4. Set `RELEASE_ATTESTATION_ADDRESS` and optional `ORACLE_RPC_URL` in the server env.
