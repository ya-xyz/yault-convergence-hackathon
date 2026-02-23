/**
 * Unit tests for webapp/public/js/yault-escrow.js
 *
 * Tests the IIFE-exported transaction builder functions.
 * These are pure functions that build EVM transaction objects —
 * no network calls needed.
 */

'use strict';

const ethers = require('ethers');
global.ethers = ethers;
const YaultEscrow = require('../../webapp/public/js/yault-escrow');

// ---------------------------------------------------------------------------
//  Constants used across tests
// ---------------------------------------------------------------------------

const VAULT_ADDR = '0x' + 'aa'.repeat(20);
const ESCROW_ADDR = '0x' + 'bb'.repeat(20);
const RECIPIENT_ADDR = '0x' + 'cc'.repeat(20);
const SHARES_WEI = '1000000000000000000'; // 1e18

// ERC-20 approve(address,uint256) selector = 0x095ea7b3
const APPROVE_SELECTOR = '0x095ea7b3';
// registerWallet(bytes32) selector
const REGISTER_WALLET_SELECTOR = ethers.id('registerWallet(bytes32)').slice(0, 10);
// deposit(bytes32,uint256,uint256[],uint256[]) selector
const DEPOSIT_SELECTOR = ethers.id('deposit(bytes32,uint256,uint256[],uint256[])').slice(0, 10);
// claim(bytes32,uint256,address,uint256,bool) selector
const CLAIM_SELECTOR = ethers.id('claim(bytes32,uint256,address,uint256,bool)').slice(0, 10);

// ---------------------------------------------------------------------------
//  walletIdHash
// ---------------------------------------------------------------------------

describe('YaultEscrow.walletIdHash', () => {
  test('returns keccak256(toUtf8Bytes(input))', () => {
    const input = 'test-wallet';
    const expected = ethers.keccak256(ethers.toUtf8Bytes(input));
    expect(YaultEscrow.walletIdHash(input)).toBe(expected);
  });

  test('returns 0x-prefixed 64-char hex', () => {
    const out = YaultEscrow.walletIdHash('hello');
    expect(out).toMatch(/^0x[0-9a-f]{64}$/);
  });

  test('is deterministic', () => {
    expect(YaultEscrow.walletIdHash('abc')).toBe(YaultEscrow.walletIdHash('abc'));
  });

  test('different inputs produce different hashes', () => {
    expect(YaultEscrow.walletIdHash('a')).not.toBe(YaultEscrow.walletIdHash('b'));
  });

  test('empty string produces valid bytes32', () => {
    const out = YaultEscrow.walletIdHash('');
    expect(out).toMatch(/^0x[0-9a-f]{64}$/);
    expect(out).toBe(ethers.keccak256(ethers.toUtf8Bytes('')));
  });
});

// ---------------------------------------------------------------------------
//  buildApproveTx
// ---------------------------------------------------------------------------

describe('YaultEscrow.buildApproveTx', () => {
  test('returns tx with correct to, value, and chainId', () => {
    const tx = YaultEscrow.buildApproveTx(VAULT_ADDR, ESCROW_ADDR, SHARES_WEI, 11155111);
    expect(tx.to).toBe(VAULT_ADDR);
    expect(tx.value).toBe('0x0');
    expect(tx.chainId).toBe('0xaa36a7');
  });

  test('data starts with approve selector', () => {
    const tx = YaultEscrow.buildApproveTx(VAULT_ADDR, ESCROW_ADDR, SHARES_WEI, 1);
    expect(tx.data.startsWith(APPROVE_SELECTOR)).toBe(true);
  });

  test('data contains escrow address in encoded params', () => {
    const tx = YaultEscrow.buildApproveTx(VAULT_ADDR, ESCROW_ADDR, SHARES_WEI, 1);
    // The spender address is left-padded to 32 bytes; check the lowercased form
    const escrowNoPre = ESCROW_ADDR.slice(2).toLowerCase();
    expect(tx.data.toLowerCase()).toContain(escrowNoPre);
  });
});

// ---------------------------------------------------------------------------
//  buildRegisterWalletTx
// ---------------------------------------------------------------------------

describe('YaultEscrow.buildRegisterWalletTx', () => {
  const walletHash = YaultEscrow.walletIdHash('owner-1');

  test('returns tx with correct to, value, and chainId', () => {
    const tx = YaultEscrow.buildRegisterWalletTx(ESCROW_ADDR, walletHash, 11155111);
    expect(tx.to).toBe(ESCROW_ADDR);
    expect(tx.value).toBe('0x0');
    expect(tx.chainId).toBe('0xaa36a7');
  });

  test('data starts with registerWallet selector', () => {
    const tx = YaultEscrow.buildRegisterWalletTx(ESCROW_ADDR, walletHash, 1);
    expect(tx.data.startsWith(REGISTER_WALLET_SELECTOR)).toBe(true);
  });

  test('data contains walletIdHash in encoded params', () => {
    const tx = YaultEscrow.buildRegisterWalletTx(ESCROW_ADDR, walletHash, 1);
    const hashNoPre = walletHash.slice(2).toLowerCase();
    expect(tx.data.toLowerCase()).toContain(hashNoPre);
  });
});

// ---------------------------------------------------------------------------
//  buildDepositTx
// ---------------------------------------------------------------------------

describe('YaultEscrow.buildDepositTx', () => {
  const walletHash = YaultEscrow.walletIdHash('owner-1');
  const recipientIndices = [1, 2, 3];
  const amounts = ['300000000000000000', '300000000000000000', '400000000000000000'];
  const totalShares = '1000000000000000000';

  test('returns tx with correct to, value, and chainId', () => {
    const tx = YaultEscrow.buildDepositTx(ESCROW_ADDR, walletHash, totalShares, recipientIndices, amounts, 11155111);
    expect(tx.to).toBe(ESCROW_ADDR);
    expect(tx.value).toBe('0x0');
    expect(tx.chainId).toBe('0xaa36a7');
  });

  test('data starts with deposit selector', () => {
    const tx = YaultEscrow.buildDepositTx(ESCROW_ADDR, walletHash, totalShares, recipientIndices, amounts, 1);
    expect(tx.data.startsWith(DEPOSIT_SELECTOR)).toBe(true);
  });

  test('data is a valid hex string', () => {
    const tx = YaultEscrow.buildDepositTx(ESCROW_ADDR, walletHash, totalShares, recipientIndices, amounts, 1);
    expect(tx.data).toMatch(/^0x[0-9a-fA-F]+$/);
  });

  test('handles single recipient', () => {
    const tx = YaultEscrow.buildDepositTx(ESCROW_ADDR, walletHash, totalShares, [1], [totalShares], 1);
    expect(tx.data.startsWith(DEPOSIT_SELECTOR)).toBe(true);
    expect(tx.to).toBe(ESCROW_ADDR);
  });
});

// ---------------------------------------------------------------------------
//  buildClaimTx
// ---------------------------------------------------------------------------

describe('YaultEscrow.buildClaimTx', () => {
  const walletHash = YaultEscrow.walletIdHash('owner-1');

  test('returns tx with correct to, value, and chainId', () => {
    const tx = YaultEscrow.buildClaimTx(ESCROW_ADDR, walletHash, 1, RECIPIENT_ADDR, SHARES_WEI, true, 11155111);
    expect(tx.to).toBe(ESCROW_ADDR);
    expect(tx.value).toBe('0x0');
    expect(tx.chainId).toBe('0xaa36a7');
  });

  test('data starts with claim selector', () => {
    const tx = YaultEscrow.buildClaimTx(ESCROW_ADDR, walletHash, 1, RECIPIENT_ADDR, SHARES_WEI, true, 1);
    expect(tx.data.startsWith(CLAIM_SELECTOR)).toBe(true);
  });

  test('redeemToAsset=true is encoded differently than false', () => {
    const txTrue = YaultEscrow.buildClaimTx(ESCROW_ADDR, walletHash, 1, RECIPIENT_ADDR, SHARES_WEI, true, 1);
    const txFalse = YaultEscrow.buildClaimTx(ESCROW_ADDR, walletHash, 1, RECIPIENT_ADDR, SHARES_WEI, false, 1);
    expect(txTrue.data).not.toBe(txFalse.data);
  });

  test('throws when toAddress is invalid', () => {
    expect(() => {
      YaultEscrow.buildClaimTx(ESCROW_ADDR, walletHash, 1, 'not-an-address', SHARES_WEI, true, 1);
    }).toThrow();
  });

  test('throws when toAddress is empty', () => {
    expect(() => {
      YaultEscrow.buildClaimTx(ESCROW_ADDR, walletHash, 1, '', SHARES_WEI, true, 1);
    }).toThrow();
  });
});

// ---------------------------------------------------------------------------
//  Chain ID formatting
// ---------------------------------------------------------------------------

describe('YaultEscrow chain ID formatting', () => {
  test('chainId 11155111 formats to 0xaa36a7', () => {
    const tx = YaultEscrow.buildApproveTx(VAULT_ADDR, ESCROW_ADDR, SHARES_WEI, 11155111);
    expect(tx.chainId).toBe('0xaa36a7');
  });

  test('chainId 1 formats to 0x1', () => {
    const tx = YaultEscrow.buildApproveTx(VAULT_ADDR, ESCROW_ADDR, SHARES_WEI, 1);
    expect(tx.chainId).toBe('0x1');
  });

  test('chainId as string is handled correctly', () => {
    const tx = YaultEscrow.buildApproveTx(VAULT_ADDR, ESCROW_ADDR, SHARES_WEI, '137');
    expect(tx.chainId).toBe('0x89');
  });

  test('chainId formatting is consistent across all tx builders', () => {
    const walletHash = YaultEscrow.walletIdHash('owner');
    const chainId = 11155111;
    const expectedHex = '0xaa36a7';

    const approve = YaultEscrow.buildApproveTx(VAULT_ADDR, ESCROW_ADDR, SHARES_WEI, chainId);
    const register = YaultEscrow.buildRegisterWalletTx(ESCROW_ADDR, walletHash, chainId);
    const deposit = YaultEscrow.buildDepositTx(ESCROW_ADDR, walletHash, SHARES_WEI, [1], [SHARES_WEI], chainId);
    const claim = YaultEscrow.buildClaimTx(ESCROW_ADDR, walletHash, 1, RECIPIENT_ADDR, SHARES_WEI, true, chainId);

    expect(approve.chainId).toBe(expectedHex);
    expect(register.chainId).toBe(expectedHex);
    expect(deposit.chainId).toBe(expectedHex);
    expect(claim.chainId).toBe(expectedHex);
  });
});
