// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console2} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ReleaseAttestation} from "../src/ReleaseAttestation.sol";
import {YaultPathClaim} from "../src/YaultPathClaim.sol";

contract MockERC20 is ERC20 {
    constructor() ERC20("Mock USDC", "USDC") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

contract YaultPathClaimTest is Test {
    YaultPathClaim public pool;
    ReleaseAttestation public attestation;
    MockERC20 public token;

    address public owner;
    address public walletOwnerAddr;  // owner of walletIdHash (deposits, registers paths)
    address public pathController;   // path-derived EVM key (recipient after activation)
    address public recipient;       // where to send claimed tokens
    address public fallbackSubmitter;

    uint256 public pathControllerPk = 0xA11CE;
    bytes32 public constant WALLET_HASH = keccak256("wallet-1");
    uint256 public constant PATH_INDEX = 1;
    uint256 public constant PATH_TOTAL_AMOUNT = 1000e6; // 1000 USDC (6 decimals)

    function setUp() public {
        owner = address(this);
        walletOwnerAddr = makeAddr("walletOwner");
        pathController = vm.addr(pathControllerPk);
        recipient = makeAddr("recipient");
        fallbackSubmitter = makeAddr("fallback");

        token = new MockERC20();
        token.mint(walletOwnerAddr, 10_000e6);

        attestation = new ReleaseAttestation(owner);
        attestation.setFallbackSubmitter(fallbackSubmitter, true);

        pool = new YaultPathClaim(owner, token, address(attestation));
    }

    function test_RegisterWallet_Deposit_RegisterPath() public {
        vm.startPrank(walletOwnerAddr);
        token.approve(address(pool), type(uint256).max);

        pool.registerWallet(WALLET_HASH);
        assertEq(pool.walletOwner(WALLET_HASH), walletOwnerAddr);

        pool.deposit(WALLET_HASH, PATH_TOTAL_AMOUNT);
        assertEq(pool.totalDeposited(WALLET_HASH), PATH_TOTAL_AMOUNT);

        pool.registerPath(WALLET_HASH, PATH_INDEX, pathController, PATH_TOTAL_AMOUNT);
        (address ctrl, uint256 total, uint256 claimed) = pool.pathInfo(WALLET_HASH, PATH_INDEX);
        assertEq(ctrl, pathController);
        assertEq(total, PATH_TOTAL_AMOUNT);
        assertEq(claimed, 0);
        assertEq(pool.remainingForPath(WALLET_HASH, PATH_INDEX), PATH_TOTAL_AMOUNT);
        vm.stopPrank();
    }

    function test_ClaimFailsWithoutAttestation() public {
        vm.startPrank(walletOwnerAddr);
        token.approve(address(pool), type(uint256).max);
        pool.registerWallet(WALLET_HASH);
        pool.deposit(WALLET_HASH, PATH_TOTAL_AMOUNT);
        pool.registerPath(WALLET_HASH, PATH_INDEX, pathController, PATH_TOTAL_AMOUNT);
        vm.stopPrank();

        (uint8 v, bytes32 r, bytes32 s) = _signClaim(PATH_TOTAL_AMOUNT, recipient, block.timestamp + 3600);
        vm.expectRevert(YaultPathClaim.NoAttestation.selector);
        pool.claim(WALLET_HASH, PATH_INDEX, PATH_TOTAL_AMOUNT, recipient, block.timestamp + 3600, v, r, s);
    }

    function test_ClaimFailsWhenAttestationNotRelease() public {
        vm.startPrank(walletOwnerAddr);
        token.approve(address(pool), type(uint256).max);
        pool.registerWallet(WALLET_HASH);
        pool.deposit(WALLET_HASH, PATH_TOTAL_AMOUNT);
        pool.registerPath(WALLET_HASH, PATH_INDEX, pathController, PATH_TOTAL_AMOUNT);
        vm.stopPrank();

        uint8 sourceFallback = attestation.SOURCE_FALLBACK();
        uint8 decisionHold = attestation.DECISION_HOLD();
        vm.prank(fallbackSubmitter);
        attestation.submitAttestation(
            sourceFallback,
            WALLET_HASH,
            PATH_INDEX,
            decisionHold, // HOLD, not RELEASE
            bytes32(0),
            keccak256("evidence")
        );

        (uint8 v, bytes32 r, bytes32 s) = _signClaim(PATH_TOTAL_AMOUNT, recipient, block.timestamp + 3600);
        vm.expectRevert(YaultPathClaim.AttestationNotRelease.selector);
        pool.claim(WALLET_HASH, PATH_INDEX, PATH_TOTAL_AMOUNT, recipient, block.timestamp + 3600, v, r, s);
    }

    function test_ClaimFullAmount() public {
        vm.startPrank(walletOwnerAddr);
        token.approve(address(pool), type(uint256).max);
        pool.registerWallet(WALLET_HASH);
        pool.deposit(WALLET_HASH, PATH_TOTAL_AMOUNT);
        pool.registerPath(WALLET_HASH, PATH_INDEX, pathController, PATH_TOTAL_AMOUNT);
        vm.stopPrank();

        _submitReleaseAttestation();

        uint256 deadline = block.timestamp + 3600;
        (uint8 v, bytes32 r, bytes32 s) = _signClaim(PATH_TOTAL_AMOUNT, recipient, deadline);

        pool.claim(WALLET_HASH, PATH_INDEX, PATH_TOTAL_AMOUNT, recipient, deadline, v, r, s);

        assertEq(token.balanceOf(recipient), PATH_TOTAL_AMOUNT);
        assertEq(pool.remainingForPath(WALLET_HASH, PATH_INDEX), 0);
    }

    function test_ClaimPartial_MultipleTimes() public {
        vm.startPrank(walletOwnerAddr);
        token.approve(address(pool), type(uint256).max);
        pool.registerWallet(WALLET_HASH);
        pool.deposit(WALLET_HASH, PATH_TOTAL_AMOUNT);
        pool.registerPath(WALLET_HASH, PATH_INDEX, pathController, PATH_TOTAL_AMOUNT);
        vm.stopPrank();

        _submitReleaseAttestation();

        // First claim: 300
        uint256 amount1 = 300e6;
        uint256 deadline1 = block.timestamp + 3600;
        (uint8 v1, bytes32 r1, bytes32 s1) = _signClaim(amount1, recipient, deadline1);
        pool.claim(WALLET_HASH, PATH_INDEX, amount1, recipient, deadline1, v1, r1, s1);
        assertEq(token.balanceOf(recipient), amount1);
        assertEq(pool.remainingForPath(WALLET_HASH, PATH_INDEX), PATH_TOTAL_AMOUNT - amount1);

        // Second claim: 200 (different recipient address to test)
        address recipient2 = makeAddr("recipient2");
        uint256 amount2 = 200e6;
        uint256 deadline2 = block.timestamp + 3600;
        (uint8 v2, bytes32 r2, bytes32 s2) = _signClaim(amount2, recipient2, deadline2);
        pool.claim(WALLET_HASH, PATH_INDEX, amount2, recipient2, deadline2, v2, r2, s2);
        assertEq(token.balanceOf(recipient2), amount2);
        assertEq(pool.remainingForPath(WALLET_HASH, PATH_INDEX), PATH_TOTAL_AMOUNT - amount1 - amount2);

        // Third claim: remaining 500
        uint256 amount3 = 500e6;
        uint256 deadline3 = block.timestamp + 3600;
        (uint8 v3, bytes32 r3, bytes32 s3) = _signClaim(amount3, recipient, deadline3);
        pool.claim(WALLET_HASH, PATH_INDEX, amount3, recipient, deadline3, v3, r3, s3);
        assertEq(token.balanceOf(recipient), amount1 + amount3);
        assertEq(pool.remainingForPath(WALLET_HASH, PATH_INDEX), 0);
    }

    /// Partial claim then second claim with signed amount > remaining → capped to remaining.
    function test_ClaimCapsAfterPartialClaim() public {
        vm.startPrank(walletOwnerAddr);
        token.approve(address(pool), type(uint256).max);
        pool.registerWallet(WALLET_HASH);
        pool.deposit(WALLET_HASH, PATH_TOTAL_AMOUNT);
        pool.registerPath(WALLET_HASH, PATH_INDEX, pathController, PATH_TOTAL_AMOUNT);
        vm.stopPrank();

        _submitReleaseAttestation();

        // First claim: 60% of total
        uint256 first = 600e6;
        uint256 deadline1 = block.timestamp + 3600;
        (uint8 v1, bytes32 r1, bytes32 s1) = _signClaim(first, recipient, deadline1);
        pool.claim(WALLET_HASH, PATH_INDEX, first, recipient, deadline1, v1, r1, s1);
        assertEq(token.balanceOf(recipient), first);
        assertEq(pool.remainingForPath(WALLET_HASH, PATH_INDEX), PATH_TOTAL_AMOUNT - first);

        // Second claim: sign for full totalAmount, should cap to remaining 40%
        uint256 deadline2 = block.timestamp + 3600;
        (uint8 v2, bytes32 r2, bytes32 s2) = _signClaim(PATH_TOTAL_AMOUNT, recipient, deadline2);
        pool.claim(WALLET_HASH, PATH_INDEX, PATH_TOTAL_AMOUNT, recipient, deadline2, v2, r2, s2);
        assertEq(token.balanceOf(recipient), PATH_TOTAL_AMOUNT, "recipient gets full total across both claims");
        assertEq(pool.remainingForPath(WALLET_HASH, PATH_INDEX), 0);
    }

    /// After "claim up to" change: signed amount can exceed remaining; we transfer min(amount, remaining).
    function test_ClaimCapsToRemainingWhenSignedAmountExceeds() public {
        vm.startPrank(walletOwnerAddr);
        token.approve(address(pool), type(uint256).max);
        pool.registerWallet(WALLET_HASH);
        pool.deposit(WALLET_HASH, PATH_TOTAL_AMOUNT);
        pool.registerPath(WALLET_HASH, PATH_INDEX, pathController, PATH_TOTAL_AMOUNT);
        vm.stopPrank();

        _submitReleaseAttestation();

        uint256 signedAmount = PATH_TOTAL_AMOUNT + 1; // more than remaining
        uint256 deadline = block.timestamp + 3600;
        (uint8 v, bytes32 r, bytes32 s) = _signClaim(signedAmount, recipient, deadline);
        pool.claim(WALLET_HASH, PATH_INDEX, signedAmount, recipient, deadline, v, r, s);
        assertEq(token.balanceOf(recipient), PATH_TOTAL_AMOUNT, "transfers only remaining");
        assertEq(pool.remainingForPath(WALLET_HASH, PATH_INDEX), 0);
    }

    function _submitReleaseAttestation() internal {
        uint8 sourceFallback = attestation.SOURCE_FALLBACK();
        uint8 decisionRelease = attestation.DECISION_RELEASE();
        vm.prank(fallbackSubmitter);
        attestation.submitAttestation(
            sourceFallback,
            WALLET_HASH,
            PATH_INDEX,
            decisionRelease,
            bytes32(0),
            keccak256("evidence")
        );
    }

    // -----------------------------------------------------------------------
    //  P2 FIX: claim reverts on to == address(0)
    // -----------------------------------------------------------------------

    function test_ClaimRevertsOnZeroReceiver() public {
        vm.startPrank(walletOwnerAddr);
        token.approve(address(pool), type(uint256).max);
        pool.registerWallet(WALLET_HASH);
        pool.deposit(WALLET_HASH, PATH_TOTAL_AMOUNT);
        pool.registerPath(WALLET_HASH, PATH_INDEX, pathController, PATH_TOTAL_AMOUNT);
        vm.stopPrank();

        _submitReleaseAttestation();

        uint256 deadline = block.timestamp + 3600;
        // Sign for address(0) — pathController is willing (simulating user error)
        (uint8 v, bytes32 r, bytes32 s) = _signClaim(PATH_TOTAL_AMOUNT, address(0), deadline);

        vm.expectRevert(YaultPathClaim.ZeroReceiver.selector);
        pool.claim(WALLET_HASH, PATH_INDEX, PATH_TOTAL_AMOUNT, address(0), deadline, v, r, s);
    }

    function _signClaim(uint256 amount, address to, uint256 deadline)
        internal
        view
        returns (uint8 v, bytes32 r, bytes32 s)
    {
        uint256 nonce = pool.claimNonce(WALLET_HASH, PATH_INDEX);
        bytes32 digest = pool.getClaimHash(WALLET_HASH, PATH_INDEX, amount, to, nonce, deadline);
        (v, r, s) = vm.sign(pathControllerPk, digest);
    }

    // -----------------------------------------------------------------------
    //  Threat-model: signature replay, deadline
    // -----------------------------------------------------------------------

    function testThreat_SignatureReplay_SameSignatureFailsSecondTime() public {
        vm.startPrank(walletOwnerAddr);
        token.approve(address(pool), type(uint256).max);
        pool.registerWallet(WALLET_HASH);
        pool.deposit(WALLET_HASH, PATH_TOTAL_AMOUNT);
        pool.registerPath(WALLET_HASH, PATH_INDEX, pathController, PATH_TOTAL_AMOUNT);
        vm.stopPrank();

        _submitReleaseAttestation();

        uint256 amount = 400e6;
        uint256 deadline = block.timestamp + 3600;
        (uint8 v, bytes32 r, bytes32 s) = _signClaim(amount, recipient, deadline);

        pool.claim(WALLET_HASH, PATH_INDEX, amount, recipient, deadline, v, r, s);
        assertEq(token.balanceOf(recipient), amount);

        // Replay same signature — nonce has incremented, so digest differs; signer would need to sign (nonce+1).
        // Same (v,r,s) was for nonce=0; now nonce=1, so getClaimHash returns different digest → invalid signature.
        vm.expectRevert(YaultPathClaim.InvalidSignature.selector);
        pool.claim(WALLET_HASH, PATH_INDEX, amount, recipient, deadline, v, r, s);
    }

    function testThreat_Claim_DeadlineExpiredReverts() public {
        vm.startPrank(walletOwnerAddr);
        token.approve(address(pool), type(uint256).max);
        pool.registerWallet(WALLET_HASH);
        pool.deposit(WALLET_HASH, PATH_TOTAL_AMOUNT);
        pool.registerPath(WALLET_HASH, PATH_INDEX, pathController, PATH_TOTAL_AMOUNT);
        vm.stopPrank();

        _submitReleaseAttestation();

        uint256 deadline = block.timestamp - 1; // already expired
        (uint8 v, bytes32 r, bytes32 s) = _signClaim(PATH_TOTAL_AMOUNT, recipient, deadline);

        vm.expectRevert(YaultPathClaim.DeadlineExpired.selector);
        pool.claim(WALLET_HASH, PATH_INDEX, PATH_TOTAL_AMOUNT, recipient, deadline, v, r, s);
    }

    function testThreat_Claim_WrongSignerReverts() public {
        vm.startPrank(walletOwnerAddr);
        token.approve(address(pool), type(uint256).max);
        pool.registerWallet(WALLET_HASH);
        pool.deposit(WALLET_HASH, PATH_TOTAL_AMOUNT);
        pool.registerPath(WALLET_HASH, PATH_INDEX, pathController, PATH_TOTAL_AMOUNT);
        vm.stopPrank();

        _submitReleaseAttestation();

        uint256 deadline = block.timestamp + 3600;
        (uint8 v, bytes32 r, bytes32 s) = _signClaim(PATH_TOTAL_AMOUNT, recipient, deadline);

        // Sign with a different key (not pathController)
        uint256 wrongPk = 0xB0B;
        bytes32 digest = pool.getClaimHash(
            WALLET_HASH, PATH_INDEX, PATH_TOTAL_AMOUNT, recipient,
            pool.claimNonce(WALLET_HASH, PATH_INDEX), deadline
        );
        (v, r, s) = vm.sign(wrongPk, digest);

        vm.expectRevert(YaultPathClaim.InvalidSignature.selector);
        pool.claim(WALLET_HASH, PATH_INDEX, PATH_TOTAL_AMOUNT, recipient, deadline, v, r, s);
    }
}
