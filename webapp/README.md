# Unified Web App

Combines **Client**, **Authority**, and **Ops** portals into a single frontend application, deployed co-origin with the backend API.

## PQC Ready

The cryptographic layer is **post-quantum ready**. All client-side key derivation, signing, and encryption run inside ACE-GF WASM modules that support **ML-DSA (FIPS 204)** digital signatures alongside classical Ed25519/X25519 curves, providing a hybrid migration path toward quantum-resistant custody.

## Usage

- **Development**: Run `npm run dev` from the project root; both backend and frontend are served by `server/index.js`.
  - Frontend: <http://localhost:3001/>
  - API: <http://localhost:3001/api>
- **Portal switching**: Select portal via URL parameter
  - Client: `/?portal=client` (default)
  - Authority: `/?portal=authority`
  - Ops: `/?portal=ops`

## Internationalization (i18n)

- Supports **English / Chinese / Korean / Japanese**. Switch via the language dropdown in the top-right; preference is saved in `localStorage` (`yault_locale`).
- Translation keys are in `public/js/i18n.js`; each portal uses `window.t('key')` for text, and re-renders when the language changes.

## Directory Structure

- `public/index.html` — Unified entry point with portal tabs at the top
- `public/js/main.js` — Dynamically loads the corresponding portal script based on `?portal=` and calls `init`
- `public/js/wallet-connect.js` — Wallet connection (shared across portals)
- `public/js/e2e-client.js` — E2E client (used by Client and Authority portals)
- `public/js/client-portal.js` — Client portal logic
- `public/js/authority-portal.js` — Authority portal logic
- `public/js/ops-portal.js` — Ops portal logic
- `public/js/i18n.js` — Multilingual text (en/zh/ko/ja)

## Backend API

All APIs are unified in **one** Express app: `server/index.js`. The same process serves both `/api/*` and static frontend assets (this directory's `public/`).
