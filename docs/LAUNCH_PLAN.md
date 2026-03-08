# Yault Launch Plan

Pre-mainnet checklist from testnet-ready to production launch.

---

## Phase 0 — Foundation (Done)

- [x] Core smart contracts deployed to Sepolia testnet
- [x] ERC-4626 vault with 3-way revenue split
- [x] E2E encryption (X25519 + ChaCha20-Poly1305) via Rust WASM
- [x] Chainlink CRE workflow, Data Feeds, Automation, CCIP, Functions
- [x] Server API (44 route handlers, 18 services)
- [x] Three-portal web app (Client, Authority, Ops)
- [x] Unit, integration, and Forge test suites
- [x] Docker + Fly.io deployment config
- [x] ESLint configuration + GitHub Actions CI pipeline

---

## Phase 1 — Code Quality & Developer Infrastructure

### 1.1 Lint Cleanup
- [ ] Fix 254 ESLint warnings (mostly unused vars, no-undef edge cases)
- [ ] Tighten ESLint rules: `no-undef` → error, `no-redeclare` → error
- [ ] Lower CI `--max-warnings` from 999 → 0

### 1.2 API Documentation
- [ ] Add OpenAPI/Swagger spec for all 44 route handlers
- [ ] Generate API reference from spec (Redoc or Swagger UI)
- [ ] Version the API (v1 prefix)

### 1.3 Database Schema Management
- [ ] Adopt a migration tool (e.g., node-pg-migrate or Knex migrations)
- [ ] Write migration files for all current tables
- [ ] Add migration step to CI and deploy pipeline
- [ ] Remove ad-hoc SQLite-to-Postgres script after migration tool is in place

### 1.4 Staging Environment
- [ ] Add `env/staging.json` profile
- [ ] Deploy staging instance on Fly.io (separate app, separate DB)
- [ ] Route staging to Sepolia testnet
- [ ] Gate mainnet deploy behind staging validation

---

## Phase 2 — Security Hardening

### 2.1 Smart Contract Audit
- [ ] Complete internal threat model review (extend `YaultVaultThreatModel.t.sol`)
- [ ] Fix all findings from `docs/security-audit-report.md`
- [ ] Engage external auditor (Trail of Bits, OpenZeppelin, or equivalent)
- [ ] Implement audit remediation
- [ ] Publish final audit report

### 2.2 WASM / Rust Supply Chain
- [ ] Add `cargo audit` to CI
- [ ] Pin cryptographic dependency versions (no `^` ranges for crypto crates)
- [ ] Add WASM binary reproducibility check (compare local build hash to deployed)

### 2.3 Server Security
- [ ] Enforce `ADMIN_SESSION_IP_PINNING=true` in production
- [ ] Add CORS allowlist (remove `CORS_ORIGIN=*`)
- [ ] Add Content-Security-Policy headers to webapp
- [ ] Rate-limit all public endpoints (not just admin)
- [ ] Add request signing for authority API calls
- [ ] Review and harden JWT token expiry and refresh flow

### 2.4 Key Management
- [ ] Move `RELEASE_ATTESTATION_RELAYER_PRIVATE_KEY` to HSM or KMS
- [ ] Rotate all secrets on every environment promotion
- [ ] Add secret scanning to CI (e.g., gitleaks)

---

## Phase 3 — Reliability & Observability

### 3.1 Immutable Audit Trail
- [ ] Replace in-memory `recordActivity()` with append-only audit log
- [ ] Store audit log on-chain or on Arweave (tamper-proof)
- [ ] Add log export for compliance review

### 3.2 Monitoring & Alerting
- [ ] Add structured logging (JSON format, request IDs)
- [ ] Integrate APM (Datadog, Sentry, or Grafana Cloud)
- [ ] Set up alerts: vault balance anomalies, failed attestations, oracle timeouts
- [ ] Add uptime monitoring for API and oracle endpoints

### 3.3 Disaster Recovery
- [ ] Document RTO/RPO targets
- [ ] Implement automated PostgreSQL backups (daily + WAL archiving)
- [ ] Test full restore procedure quarterly
- [ ] Multi-region failover for API (Fly.io region expansion)
- [ ] Arweave data recovery procedure (multi-gateway fallback)

### 3.4 Error Handling
- [ ] Add circuit breakers for external dependencies (RPC, Arweave, drand, Chainlink)
- [ ] Graceful degradation when oracle is unavailable (fallback attestation path)
- [ ] Add health check endpoints per dependency (`/health/rpc`, `/health/arweave`)

---

## Phase 4 — User Experience & Documentation

### 4.1 End-User Documentation
- [ ] Write user guide: Client portal (deposit, configure, distribute)
- [ ] Write user guide: Authority portal (trigger, review, release)
- [ ] Write user guide: Recipient claim flow
- [ ] Add in-app contextual help / tooltips

### 4.2 Onboarding
- [ ] Build guided setup wizard for first-time clients
- [ ] Authority onboarding flow (KYC, profile, fee setup)
- [ ] Recipient claim walkthrough (non-crypto-native friendly)

### 4.3 Accessibility
- [ ] WCAG 2.1 AA compliance audit
- [ ] Keyboard navigation for all portals
- [ ] Screen reader support for critical flows

---

## Phase 5 — Mainnet Readiness

### 5.1 Contract Deployment
- [ ] Deploy all contracts to mainnet (or target L2: Arbitrum, Base, etc.)
- [ ] Verify all contract source on Etherscan
- [ ] Set up multisig owner (Gnosis Safe) for all admin functions
- [ ] Configure timelock on admin operations (24h minimum for critical changes)

### 5.2 Oracle Infrastructure
- [ ] Register CRE workflow on mainnet DON
- [ ] Fund Automation upkeep (LINK)
- [ ] Fund Functions subscription (LINK)
- [ ] Verify CCIP lane availability for target chains

### 5.3 Legal & Compliance
- [ ] Terms of Service
- [ ] Privacy Policy
- [ ] Regulatory review for target jurisdictions
- [ ] OFAC/sanctions screening validation (data source C)
- [ ] Insurance coverage evaluation

### 5.4 Performance
- [ ] Load test API (target: 100 concurrent users, <500ms p95 latency)
- [ ] Optimize WASM bundle size (current: check with `wc -c`)
- [ ] CDN for static assets (Cloudflare or similar)
- [ ] Database connection pooling (PgBouncer or built-in pg pool)

---

## Phase 6 — Post-Launch

### 6.1 Growth
- [ ] Analytics dashboard for platform metrics (TVL, users, vaults)
- [ ] Affiliate/sub-vault model (see `docs/strategy-and-thoughts/affiliate-sub-vault-model.md`)
- [ ] Multi-protocol yield strategy (see `docs/strategy-and-thoughts/multi-protocol-yield-strategy.md`)

### 6.2 Multi-Chain Expansion
- [ ] Deploy vaults on additional chains via CCIP bridge
- [ ] Chain-specific gas optimization
- [ ] Cross-chain portfolio view

### 6.3 Governance
- [ ] Transition admin functions to DAO governance
- [ ] Token-based voting for fee parameter changes
- [ ] Community bug bounty program

---

## Priority Matrix

| Priority | Item | Blocking Launch? |
|----------|------|-----------------|
| P0 | Smart contract audit | Yes |
| P0 | Key management (HSM/KMS) | Yes |
| P0 | Database migrations | Yes |
| P0 | CORS + CSP hardening | Yes |
| P1 | Staging environment | No, but risky without |
| P1 | Monitoring & alerting | No, but risky without |
| P1 | Disaster recovery plan | No, but risky without |
| P1 | API documentation | No, but slows integrations |
| P1 | Lint cleanup to zero warnings | No |
| P2 | End-user documentation | No, but hurts adoption |
| P2 | Load testing | No, but unknown risk |
| P2 | Accessibility audit | No |
| P3 | Multi-chain expansion | No |
| P3 | DAO governance | No |
