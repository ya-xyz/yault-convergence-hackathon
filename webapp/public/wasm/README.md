# ACE-GF WASM (acegf-wallet)

Files in this directory are compiled artifacts from **dev.acegf-wallet**, used to integrate ACE-GF (dormant path Seal/Unseal, key derivation) in the webapp.

## Files

| File | Description |
|------|-------------|
| `acegf.js` | WASM glue code, ES module; `init()` loads `acegf_bg.wasm` in the browser |
| `acegf_bg.wasm` | ACE-GF core WASM binary |
| `acegf.d.ts` / `acegf_bg.wasm.d.ts` | TypeScript type definitions (optional) |

## Loading

- When loaded via `<script type="module">` or a bundler from **`/wasm/acegf.js`**, the default `new URL('acegf_bg.wasm', import.meta.url)` loads the WASM file from the same directory — no path changes needed.
- If the entry point is not in `/wasm/`, pass the WASM path when calling `init()`:
  `init('/wasm/acegf_bg.wasm')`.
