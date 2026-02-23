/**
 * arweave-nft.js — Arweave NFT Operations for Release
 *
 * Upload, fetch, and manage Trigger NFTs and Recovery NFTs on Arweave.
 * Uses the Arweave SDK for transaction creation and GraphQL for querying.
 *
 * Tags Convention:
 *   App-Name       = "Yault"
 *   Type           = "YALLET_TRIGGER_NFT" | "YALLET_RECOVERY_NFT" | "YALLET_RELEASE_RECORD"
 *   Wallet-Id      = owner wallet identifier
 *   Recipient-Index = 1-based recipient path index
 *   Authority-Id   = authority identifier
 *   Tlock-Round    = drand round number (Trigger NFTs only)
 *   Superseded-By  = tx id of replacement NFT (if superseded)
 *   Content-Type   = "application/json"
 *
 * Dependencies: arweave (npm package, already in Yallet)
 */

import Arweave from 'arweave';

// ─── Constants ───

const ARWEAVE_GATEWAY = 'https://arweave.net';
const GRAPHQL_ENDPOINT = 'https://arweave.net/graphql';
const APP_NAME = 'Yault';

const NFT_TYPE = {
  TRIGGER: 'YALLET_TRIGGER_NFT',
  RECOVERY: 'YALLET_RECOVERY_NFT',
  RELEASE: 'YALLET_RELEASE_RECORD',
  SUPERSEDE: 'YALLET_SUPERSEDE_RECORD',
};

// ─── Arweave Client Singleton ───

let _arweave = null;

/**
 * Get or create the Arweave client instance.
 * @returns {Arweave}
 */
function _getArweave() {
  if (!_arweave) {
    _arweave = Arweave.init({
      host: 'arweave.net',
      port: 443,
      protocol: 'https',
    });
  }
  return _arweave;
}

// ─── Internal Helpers ───

/**
 * Build an Arweave transaction with standard tags.
 *
 * @param {object} data - JSON-serializable data for the transaction body.
 * @param {Array<{name: string, value: string}>} tags - Arweave tags.
 * @param {object} wallet - JWK wallet object for signing.
 * @returns {Promise<import('arweave/node/lib/transaction').default>}
 */
async function _createAndSignTx(data, tags, wallet) {
  const arweave = _getArweave();
  const dataStr = JSON.stringify(data);

  const tx = await arweave.createTransaction({ data: dataStr }, wallet);

  tx.addTag('Content-Type', 'application/json');
  tx.addTag('App-Name', APP_NAME);

  for (const tag of tags) {
    tx.addTag(tag.name, String(tag.value));
  }

  await arweave.transactions.sign(tx, wallet);
  return tx;
}

/**
 * Post a signed transaction to Arweave.
 *
 * @param {import('arweave/node/lib/transaction').default} tx
 * @returns {Promise<{ txId: string, status: number }>}
 */
async function _postTx(tx) {
  const arweave = _getArweave();
  const response = await arweave.transactions.post(tx);

  if (response.status !== 200 && response.status !== 202) {
    throw new Error(`Arweave upload failed with status ${response.status}: ${response.statusText || ''}`);
  }

  return { txId: tx.id, status: response.status };
}

/**
 * Run an Arweave GraphQL query and return the edges.
 *
 * @param {string} query - GraphQL query string.
 * @param {object} [variables] - Query variables.
 * @returns {Promise<Array>} Array of edge nodes.
 */
async function _graphql(query, variables = {}) {
  const response = await fetch(GRAPHQL_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });

  if (!response.ok) {
    throw new Error(`Arweave GraphQL error: ${response.status} ${response.statusText}`);
  }

  const json = await response.json();

  if (json.errors && json.errors.length > 0) {
    throw new Error(`Arweave GraphQL error: ${json.errors[0].message}`);
  }

  return json.data?.transactions?.edges || [];
}

/**
 * Build a GraphQL query to search for NFTs by type, wallet, and optional extra tags.
 *
 * @param {string} type - NFT_TYPE value.
 * @param {string} walletId - Owner wallet ID.
 * @param {Array<{name: string, values: string[]}>} [extraTags] - Additional tag filters.
 * @returns {{ query: string, variables: object }}
 */
function _buildQuery(type, walletId, extraTags = []) {
  const tags = [
    { name: 'App-Name', values: [APP_NAME] },
    { name: 'Type', values: [type] },
    { name: 'Wallet-Id', values: [walletId] },
    ...extraTags,
  ];

  const query = `
    query($tags: [TagFilter!]!) {
      transactions(
        tags: $tags
        sort: HEIGHT_DESC
        first: 100
      ) {
        edges {
          node {
            id
            tags { name value }
            block { height timestamp }
          }
        }
      }
    }
  `;

  return { query, variables: { tags } };
}

/**
 * Fetch the data content of an Arweave transaction.
 *
 * @param {string} txId - Arweave transaction ID.
 * @returns {Promise<object>} Parsed JSON data.
 */
async function _fetchTxData(txId) {
  // Validate txId format (Arweave tx IDs are 43-character base64url strings)
  if (!txId || typeof txId !== 'string' || !/^[a-zA-Z0-9_-]{43}$/.test(txId)) {
    throw new Error(`Invalid Arweave transaction ID: ${txId}`);
  }
  const resp = await fetch(`${ARWEAVE_GATEWAY}/${txId}`);
  if (!resp.ok) {
    throw new Error(`Failed to fetch Arweave data for ${txId}: ${resp.status}`);
  }
  return resp.json();
}

/**
 * Parse tags from a GraphQL edge node into a plain object.
 *
 * @param {Array<{name: string, value: string}>} tags
 * @returns {object}
 */
function _tagsToObject(tags) {
  const obj = {};
  for (const tag of tags) {
    obj[tag.name] = tag.value;
  }
  return obj;
}

// ─── Exported Functions ───

/**
 * Upload a Trigger NFT to Arweave.
 *
 * A Trigger NFT contains a tlock-encrypted release request. When the drand
 * round is reached, the ciphertext becomes decryptable and the authority
 * is notified to initiate the release process.
 *
 * @param {string} walletId - Owner's wallet ID.
 * @param {number} recipientIndex - 1-based recipient path index.
 * @param {string} authorityId - Authority identifier.
 * @param {string} tlockCiphertext - Base64-encoded tlock ciphertext.
 * @param {number} tlockRound - The drand round for the deadline.
 * @param {object} wallet - Arweave JWK wallet for signing/paying.
 * @returns {Promise<{ txId: string }>} The Arweave transaction ID.
 */
export async function uploadTriggerNFT(walletId, recipientIndex, authorityId, tlockCiphertext, tlockRound, wallet) {
  if (!walletId || !authorityId || !tlockCiphertext) {
    throw new Error('walletId, authorityId, and tlockCiphertext are required');
  }

  const data = {
    version: 1,
    type: NFT_TYPE.TRIGGER,
    walletId,
    recipientIndex,
    authorityId,
    tlockCiphertext,
    tlockRound,
    createdAt: new Date().toISOString(),
  };

  const tags = [
    { name: 'Type', value: NFT_TYPE.TRIGGER },
    { name: 'Wallet-Id', value: walletId },
    { name: 'Recipient-Index', value: String(recipientIndex) },
    { name: 'Authority-Id', value: authorityId },
    { name: 'Tlock-Round', value: String(tlockRound) },
  ];

  const tx = await _createAndSignTx(data, tags, wallet);
  const result = await _postTx(tx);
  return { txId: result.txId };
}

/**
 * Upload a Recovery NFT to Arweave.
 *
 * A Recovery NFT contains the AES-GCM-SIV encrypted AdminFactor, keyed by
 * a backup key derived from the owner's REV. This allows the owner to recover
 * the AdminFactor if they lose their device (but are still alive and know
 * their seed phrase).
 *
 * @param {string} walletId - Owner's wallet ID.
 * @param {number} recipientIndex - 1-based recipient path index.
 * @param {string} encryptedAdminFactor - Hex-encoded encrypted AdminFactor.
 * @param {string} adminFactorFingerprint - Hex-encoded SHA-256 fingerprint.
 * @param {object} wallet - Arweave JWK wallet.
 * @returns {Promise<{ txId: string }>}
 */
export async function uploadRecoveryNFT(walletId, recipientIndex, encryptedAdminFactor, adminFactorFingerprint, wallet) {
  if (!walletId || !encryptedAdminFactor) {
    throw new Error('walletId and encryptedAdminFactor are required');
  }

  const data = {
    version: 1,
    type: NFT_TYPE.RECOVERY,
    walletId,
    recipientIndex,
    encryptedAdminFactor,
    adminFactorFingerprint,
    createdAt: new Date().toISOString(),
  };

  const tags = [
    { name: 'Type', value: NFT_TYPE.RECOVERY },
    { name: 'Wallet-Id', value: walletId },
    { name: 'Recipient-Index', value: String(recipientIndex) },
    { name: 'AF-Fingerprint', value: adminFactorFingerprint },
  ];

  const tx = await _createAndSignTx(data, tags, wallet);
  const result = await _postTx(tx);
  return { txId: result.txId };
}

/**
 * Upload a Release Record to Arweave after an authority releases shares.
 *
 * This creates an immutable on-chain record of the release event, including
 * the authority's decision, reason, and optional evidence hash.
 *
 * @param {string} walletId - Owner's wallet ID.
 * @param {number} recipientIndex - 1-based recipient path index.
 * @param {string} authorityId - Authority identifier.
 * @param {string} reason - Reason for release (e.g. "verified_event_confirmed").
 * @param {string} evidenceHash - SHA-256 hash of supporting evidence (hex).
 * @param {string} signature - Authority's signature over the release record.
 * @param {object} wallet - Arweave JWK wallet.
 * @returns {Promise<{ txId: string }>}
 */
export async function uploadReleaseRecord(walletId, recipientIndex, authorityId, reason, evidenceHash, signature, wallet) {
  if (!walletId || !authorityId || !reason) {
    throw new Error('walletId, authorityId, and reason are required');
  }

  const data = {
    version: 1,
    type: NFT_TYPE.RELEASE,
    walletId,
    recipientIndex,
    authorityId,
    reason,
    evidenceHash: evidenceHash || null,
    signature,
    releasedAt: new Date().toISOString(),
  };

  const tags = [
    { name: 'Type', value: NFT_TYPE.RELEASE },
    { name: 'Wallet-Id', value: walletId },
    { name: 'Recipient-Index', value: String(recipientIndex) },
    { name: 'Authority-Id', value: authorityId },
  ];

  const tx = await _createAndSignTx(data, tags, wallet);
  const result = await _postTx(tx);
  return { txId: result.txId };
}

/**
 * Fetch all Trigger NFTs for a given wallet from Arweave.
 *
 * @param {string} walletId - Owner's wallet ID.
 * @returns {Promise<Array<{ txId: string, tags: object, block: object|null }>>}
 */
export async function fetchTriggerNFTs(walletId) {
  if (!walletId) throw new Error('walletId is required');

  const { query, variables } = _buildQuery(NFT_TYPE.TRIGGER, walletId);
  const edges = await _graphql(query, variables);

  return edges.map((edge) => ({
    txId: edge.node.id,
    tags: _tagsToObject(edge.node.tags),
    block: edge.node.block || null,
  }));
}

/**
 * Fetch all Recovery NFTs for a given wallet from Arweave.
 *
 * @param {string} walletId - Owner's wallet ID.
 * @returns {Promise<Array<{ txId: string, tags: object, block: object|null }>>}
 */
export async function fetchRecoveryNFTs(walletId) {
  if (!walletId) throw new Error('walletId is required');

  const { query, variables } = _buildQuery(NFT_TYPE.RECOVERY, walletId);
  const edges = await _graphql(query, variables);

  return edges.map((edge) => ({
    txId: edge.node.id,
    tags: _tagsToObject(edge.node.tags),
    block: edge.node.block || null,
  }));
}

/**
 * Fetch all Release Records for a given wallet from Arweave.
 *
 * @param {string} walletId - Owner's wallet ID.
 * @returns {Promise<Array<{ txId: string, tags: object, block: object|null }>>}
 */
export async function fetchReleaseRecords(walletId) {
  if (!walletId) throw new Error('walletId is required');

  const { query, variables } = _buildQuery(NFT_TYPE.RELEASE, walletId);
  const edges = await _graphql(query, variables);

  return edges.map((edge) => ({
    txId: edge.node.id,
    tags: _tagsToObject(edge.node.tags),
    block: edge.node.block || null,
  }));
}

/**
 * Mark an existing NFT as superseded by uploading a supersede record.
 *
 * This is used when a path is revoked and replaced, or when a Trigger NFT
 * needs to be superseded for any reason.
 *
 * @param {string} oldTxId - Transaction ID of the NFT being superseded.
 * @param {string} newTxId - Transaction ID of the replacement NFT.
 * @param {string} walletId - Owner's wallet ID.
 * @param {object} wallet - Arweave JWK wallet.
 * @returns {Promise<{ txId: string }>}
 */
export async function markNFTSuperseded(oldTxId, newTxId, walletId, wallet) {
  if (!oldTxId || !newTxId || !walletId) {
    throw new Error('oldTxId, newTxId, and walletId are required');
  }

  const data = {
    version: 1,
    type: NFT_TYPE.SUPERSEDE,
    oldTxId,
    newTxId,
    walletId,
    supersededAt: new Date().toISOString(),
  };

  const tags = [
    { name: 'Type', value: NFT_TYPE.SUPERSEDE },
    { name: 'Wallet-Id', value: walletId },
    { name: 'Superseded-Tx', value: oldTxId },
    { name: 'Superseded-By', value: newTxId },
  ];

  const tx = await _createAndSignTx(data, tags, wallet);
  const result = await _postTx(tx);
  return { txId: result.txId };
}

/**
 * Get the latest (non-superseded) Trigger NFT for a specific recipient path.
 *
 * Queries all Trigger NFTs for the wallet+index, then filters out any that
 * have been superseded. Returns the most recent valid one, or null.
 *
 * @param {string} walletId - Owner's wallet ID.
 * @param {number} recipientIndex - 1-based recipient path index.
 * @returns {Promise<{ txId: string, tags: object, data: object } | null>}
 */
export async function getLatestTriggerNFT(walletId, recipientIndex) {
  if (!walletId) throw new Error('walletId is required');

  // Fetch Trigger NFTs for this specific recipient
  const extraTags = [
    { name: 'Recipient-Index', values: [String(recipientIndex)] },
  ];
  const { query, variables } = _buildQuery(NFT_TYPE.TRIGGER, walletId, extraTags);
  const triggerEdges = await _graphql(query, variables);

  if (triggerEdges.length === 0) return null;

  // Fetch supersede records to know which triggers have been replaced
  const supersedeTags = [
    { name: 'App-Name', values: [APP_NAME] },
    { name: 'Type', values: [NFT_TYPE.SUPERSEDE] },
    { name: 'Wallet-Id', values: [walletId] },
  ];

  const supersedeQuery = `
    query($tags: [TagFilter!]!) {
      transactions(tags: $tags, sort: HEIGHT_DESC, first: 100) {
        edges {
          node {
            id
            tags { name value }
          }
        }
      }
    }
  `;
  const supersedeEdges = await _graphql(supersedeQuery, { tags: supersedeTags });

  // Build a set of superseded transaction IDs
  const supersededIds = new Set();
  for (const edge of supersedeEdges) {
    const tags = _tagsToObject(edge.node.tags);
    if (tags['Superseded-Tx']) {
      supersededIds.add(tags['Superseded-Tx']);
    }
  }

  // Find the latest non-superseded Trigger NFT
  for (const edge of triggerEdges) {
    if (!supersededIds.has(edge.node.id)) {
      // Fetch full data
      let data = null;
      try {
        data = await _fetchTxData(edge.node.id);
      } catch {
        // Data may not be available yet (pending confirmation)
      }

      return {
        txId: edge.node.id,
        tags: _tagsToObject(edge.node.tags),
        data,
      };
    }
  }

  return null;
}
