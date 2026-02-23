#!/usr/bin/env node
/**
 * Bundle RWA credential adapter for browser.
 * Requires: npm install @yallet/rwa-sdk esbuild (or npm install file:../dev.yallet.rwa-sdk; npm install -D esbuild)
 * Output: webapp/public/js/rwa-credential-mint.js
 */
import * as esbuild from 'esbuild';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const entry = path.join(root, 'scripts', 'rwa-adapter-entry.mjs');
const outfile = path.join(root, 'webapp', 'public', 'js', 'rwa-credential-mint.js');

const fetchStub = path.join(__dirname, 'browser-fetch-stub.mjs');

// ECIES patch: rwa-sdk may ship HKDF+XOR; extension WASM expects SHA256(shared_secret)+AES-GCM for encrypted_aes_key. Apply after bundle.
const OLD_ECIES_BLOCK = `const sharedSecretKey = await crypto.subtle.importKey("raw", sharedSecret, "HKDF", false, ["deriveKey"]);
      const aesKey = await crypto.subtle.deriveKey({
        name: "HKDF",
        hash: "SHA-256",
        salt: new Uint8Array(32),
        // Zero salt for compatibility
        info: new TextEncoder().encode("yallet-rwa-encryption")
      }, sharedSecretKey, { name: "AES-GCM", length: 256 }, true, ["encrypt"]);
      const aesKeyRaw = await crypto.subtle.exportKey("raw", aesKey);
      const aesKeyBytes = new Uint8Array(aesKeyRaw);
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const encryptedDataRaw = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, aesKey, plaintext);
      const encryptedData = new Uint8Array(encryptedDataRaw);
      const encryptedAesKey = xorBytes(aesKeyBytes, sharedSecret);`;

const NEW_ECIES_BLOCK = `const dhKeyHash = await crypto.subtle.digest("SHA-256", sharedSecret);
      const dhKey = new Uint8Array(dhKeyHash);
      const aesKeyBytes = crypto.getRandomValues(new Uint8Array(32));
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const masterKey = await crypto.subtle.importKey("raw", dhKey, { name: "AES-GCM" }, false, ["encrypt"]);
      const aesKey = await crypto.subtle.importKey("raw", aesKeyBytes, { name: "AES-GCM" }, false, ["encrypt"]);
      const encryptedAesKeyRaw = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, masterKey, aesKeyBytes);
      const encryptedAesKey = new Uint8Array(encryptedAesKeyRaw);
      const encryptedDataRaw = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, aesKey, plaintext);
      const encryptedData = new Uint8Array(encryptedDataRaw);`;

function applyEciesPatch(filePath) {
  let content = fs.readFileSync(filePath, 'utf8');
  if (content.includes('xorBytes(aesKeyBytes, sharedSecret)') && content.includes(OLD_ECIES_BLOCK)) {
    content = content.replace(OLD_ECIES_BLOCK, NEW_ECIES_BLOCK);
    fs.writeFileSync(filePath, content);
    console.log('Applied ECIES patch (SHA256+AES-GCM) to match extension WASM.');
  } else if (!content.includes('xorBytes(aesKeyBytes, sharedSecret)')) {
    console.log('ECIES already patched or from patched SDK, skip.');
  }
}

async function main() {
  try {
    await esbuild.build({
      entryPoints: [entry],
      bundle: true,
      format: 'iife',
      outfile,
      platform: 'browser',
      target: ['es2020'],
      minify: false,
      sourcemap: true,
      define: { 'process.env.NODE_ENV': '"production"' },
      mainFields: ['module', 'main'],
      // Replace node-fetch with browser fetch so Node builtins (stream, http, etc.) are not pulled in
      alias: { 'node-fetch': fetchStub, 'node-fetch-native': fetchStub },
    });
    console.log('Built:', outfile);
    applyEciesPatch(outfile);
  } catch (err) {
    console.error('Build failed:', err.message);
    process.exit(1);
  }
}

main();
