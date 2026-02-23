/**
 * Entry for RWA credential mint adapter bundle.
 * Build with: npm run build:rwa-adapter
 *
 * Server-side mint flow: encrypt locally with xidentity, POST to upload-and-mint API.
 * No registry, signer, or client-side mint.
 *
 * Optional config on window.YAULT_RWA_CONFIG (before script loads or before first use):
 *   - dev?: boolean — when true, uses built-in dev endpoint
 *   - uploadAndMintApiUrl?: string — override API URL (takes precedence over dev)
 *   - getAuthHeaders?: () => Promise<Record<string,string>> — optional auth headers for API
 *
 * Contract: window.YaultRwaSdk.mintCredentialNft(recipientSolanaAddress, payload, options)
 *   options: { xidentity: string (required), ... } — xidentity from recipient-addresses API
 *
 * Contract: window.YaultRwaSdk.prepareCredentialNftPayload(recipientSolanaAddress, payload, options)
 *   Returns { body, recipientSolanaAddress } — body is the exact JSON to POST to upload-and-mint later (store-only; send after attestation).
 */
import { mintCredentialNftViaServer, prepareCredentialNftPayload } from '@yallet/rwa-sdk';

function getConfig() {
  return (typeof window !== 'undefined' && window.YAULT_RWA_CONFIG) || {};
}

const adapter = {
  async prepareCredentialNftPayload(recipientSolanaAddress, payload, options = {}) {
    const { xidentity } = options;
    if (!xidentity || !String(xidentity).trim()) {
      throw new Error('xidentity is required (from recipient-addresses API)');
    }
    const config = getConfig();
    return prepareCredentialNftPayload(recipientSolanaAddress, payload, {
      xidentity: String(xidentity).trim(),
      network: config.network ?? options.network ?? 'mainnet',
    });
  },

  async mintCredentialNft(recipientSolanaAddress, payload, options = {}) {
    const { xidentity } = options;
    if (!xidentity || !String(xidentity).trim()) {
      return { success: false, error: 'xidentity is required (from recipient-addresses API)' };
    }
    const config = getConfig();
    const mergedOptions = {
      xidentity: String(xidentity).trim(),
      dev: config.dev ?? options.dev ?? false,
      uploadAndMintApiUrl: config.uploadAndMintApiUrl ?? options.uploadAndMintApiUrl,
      network: config.network ?? options.network ?? 'mainnet',
      headers: options.headers,
    };
    if (typeof config.getAuthHeaders === 'function') {
      try {
        const authHeaders = await config.getAuthHeaders();
        mergedOptions.headers = { ...authHeaders, ...mergedOptions.headers };
      } catch (_) {}
    }
    return mintCredentialNftViaServer(recipientSolanaAddress, payload, mergedOptions);
  },
};

if (typeof window !== 'undefined') {
  window.YaultRwaSdk = adapter;
}
