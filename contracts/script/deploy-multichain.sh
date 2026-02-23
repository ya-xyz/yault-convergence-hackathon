#!/usr/bin/env bash
#
# deploy-multichain.sh — Deploy YaultVault to all supported EVM chains
#
# Prerequisites:
#   - DEPLOYER_PRIVATE_KEY set in .env
#   - PLATFORM_FEE_RECIPIENT set in .env
#   - forge installed (Foundry)
#
# Usage:
#   ./script/deploy-multichain.sh [chain1 chain2 ...]
#   ./script/deploy-multichain.sh                    # deploy to all chains
#   ./script/deploy-multichain.sh ethereum arbitrum  # deploy to specific chains
#
# Deployed addresses are saved to deployments/<chain>.json
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
DEPLOYMENTS_DIR="$ROOT_DIR/deployments"

mkdir -p "$DEPLOYMENTS_DIR"

# ── Chain configurations: RPC URL + USDC address ─────────────────────────

declare -A CHAIN_RPC
declare -A CHAIN_USDC
declare -A CHAIN_VERIFY_URL
declare -A CHAIN_NAME

CHAIN_NAME[ethereum]="Ethereum"
CHAIN_RPC[ethereum]="${RPC_ETHEREUM:-https://eth.llamarpc.com}"
CHAIN_USDC[ethereum]="0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"
CHAIN_VERIFY_URL[ethereum]="https://api.etherscan.io/api"

CHAIN_NAME[arbitrum]="Arbitrum One"
CHAIN_RPC[arbitrum]="${RPC_ARBITRUM:-https://arb1.arbitrum.io/rpc}"
CHAIN_USDC[arbitrum]="0xaf88d065e77c8cC2239327C5EDb3A432268e5831"
CHAIN_VERIFY_URL[arbitrum]="https://api.arbiscan.io/api"

CHAIN_NAME[optimism]="Optimism"
CHAIN_RPC[optimism]="${RPC_OPTIMISM:-https://mainnet.optimism.io}"
CHAIN_USDC[optimism]="0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85"
CHAIN_VERIFY_URL[optimism]="https://api-optimistic.etherscan.io/api"

CHAIN_NAME[base]="Base"
CHAIN_RPC[base]="${RPC_BASE:-https://mainnet.base.org}"
CHAIN_USDC[base]="0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
CHAIN_VERIFY_URL[base]="https://api.basescan.org/api"

CHAIN_NAME[polygon]="Polygon"
CHAIN_RPC[polygon]="${RPC_POLYGON:-https://polygon-rpc.com}"
CHAIN_USDC[polygon]="0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359"
CHAIN_VERIFY_URL[polygon]="https://api.polygonscan.com/api"

CHAIN_NAME[bsc]="BNB Smart Chain"
CHAIN_RPC[bsc]="${RPC_BSC:-https://bsc-dataseed.binance.org}"
CHAIN_USDC[bsc]="0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d"
CHAIN_VERIFY_URL[bsc]="https://api.bscscan.com/api"

CHAIN_NAME[avalanche]="Avalanche C-Chain"
CHAIN_RPC[avalanche]="${RPC_AVALANCHE:-https://api.avax.network/ext/bc/C/rpc}"
CHAIN_USDC[avalanche]="0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E"
CHAIN_VERIFY_URL[avalanche]="https://api.snowtrace.io/api"

ALL_CHAINS=(ethereum arbitrum optimism base polygon bsc avalanche)

# ── Parse arguments ──────────────────────────────────────────────────────

if [ $# -eq 0 ]; then
  DEPLOY_CHAINS=("${ALL_CHAINS[@]}")
else
  DEPLOY_CHAINS=("$@")
fi

echo "╔══════════════════════════════════════════════════╗"
echo "║     Yallet Vault — Multi-Chain Deployment        ║"
echo "╚══════════════════════════════════════════════════╝"
echo ""
echo "Chains to deploy: ${DEPLOY_CHAINS[*]}"
echo ""

# ── Deploy to each chain ─────────────────────────────────────────────────

SUCCESSFUL=()
FAILED=()

for chain in "${DEPLOY_CHAINS[@]}"; do
  if [ -z "${CHAIN_RPC[$chain]+x}" ]; then
    echo "❌ Unknown chain: $chain (skipping)"
    FAILED+=("$chain")
    continue
  fi

  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "Deploying to ${CHAIN_NAME[$chain]} ($chain)..."
  echo "  RPC:  ${CHAIN_RPC[$chain]}"
  echo "  USDC: ${CHAIN_USDC[$chain]}"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

  # Set chain-specific USDC address
  export USDC_ADDRESS="${CHAIN_USDC[$chain]}"

  # Run the deployment
  if USDC_ADDRESS="$USDC_ADDRESS" forge script \
    "$SCRIPT_DIR/Deploy.s.sol:Deploy" \
    --rpc-url "${CHAIN_RPC[$chain]}" \
    --broadcast \
    --json \
    2>&1 | tee "$DEPLOYMENTS_DIR/${chain}_deploy.log"; then

    echo "✅ ${CHAIN_NAME[$chain]} deployment complete"
    SUCCESSFUL+=("$chain")

    # Extract deployed addresses from forge broadcast output
    BROADCAST_FILE=$(find "$ROOT_DIR/broadcast/Deploy.s.sol" -name "run-latest.json" 2>/dev/null | head -1)
    if [ -n "$BROADCAST_FILE" ] && [ -f "$BROADCAST_FILE" ]; then
      cp "$BROADCAST_FILE" "$DEPLOYMENTS_DIR/${chain}.json"
      echo "  Deployment artifacts saved to deployments/${chain}.json"
    fi
  else
    echo "❌ ${CHAIN_NAME[$chain]} deployment FAILED"
    FAILED+=("$chain")
  fi

  echo ""
done

# ── Summary ──────────────────────────────────────────────────────────────

echo "╔══════════════════════════════════════════════════╗"
echo "║              Deployment Summary                  ║"
echo "╚══════════════════════════════════════════════════╝"
echo ""
echo "Successful: ${#SUCCESSFUL[@]}/${#DEPLOY_CHAINS[@]}"
for chain in "${SUCCESSFUL[@]}"; do
  echo "  ✅ ${CHAIN_NAME[$chain]} ($chain)"
done

if [ ${#FAILED[@]} -gt 0 ]; then
  echo ""
  echo "Failed: ${#FAILED[@]}/${#DEPLOY_CHAINS[@]}"
  for chain in "${FAILED[@]}"; do
    echo "  ❌ $chain"
  done
fi

echo ""
echo "Deployment artifacts: $DEPLOYMENTS_DIR/"
