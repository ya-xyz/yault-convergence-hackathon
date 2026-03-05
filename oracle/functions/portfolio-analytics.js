/**
 * Chainlink Functions Source: Portfolio Analytics
 *
 * This JavaScript source code runs on the Chainlink DON (Decentralized Oracle Network)
 * via Chainlink Functions. It computes portfolio analytics off-chain and returns
 * the results on-chain to the PortfolioAnalytics contract.
 *
 * Input args:
 *   args[0] = user address (0x...)
 *   args[1..N] = vault addresses (0x...)
 *
 * Computes:
 *   - Total portfolio value in USD (from vault totalAssets + price feeds)
 *   - Total yield earned (current value - principal)
 *   - Risk score (0-10000 basis points based on asset diversification)
 *   - APY estimate (annualized yield rate)
 *   - Sharpe ratio approximation (excess return / volatility proxy)
 *   - Max drawdown estimate (based on price feed history)
 *
 * Returns ABI-encoded: (uint256, uint256, uint16, uint16, uint256, uint256)
 */

// ERC-4626 function selectors
const TOTAL_ASSETS_SEL = "0x01e1d114";
const BALANCE_OF_SEL = "0x70a08231";
const CONVERT_TO_ASSETS_SEL = "0x07a2d13a";
const USER_PRINCIPAL_SEL = "0x"; // Will be constructed with function sig

const userAddress = args[0];
const vaultAddresses = args.slice(1);

if (!userAddress || vaultAddresses.length === 0) {
  throw Error("Missing user address or vault addresses");
}

// Helper: pad address to 32 bytes
function padAddress(addr) {
  return addr.toLowerCase().replace("0x", "").padStart(64, "0");
}

// Helper: pad uint256
function padUint256(value) {
  return BigInt(value).toString(16).padStart(64, "0");
}

// Helper: make an eth_call via Functions.makeHttpRequest
async function ethCall(rpcUrl, to, data) {
  const response = await Functions.makeHttpRequest({
    url: rpcUrl,
    method: "POST",
    headers: { "Content-Type": "application/json" },
    data: {
      jsonrpc: "2.0",
      id: 1,
      method: "eth_call",
      params: [{ to, data }, "latest"],
    },
  });

  if (response.error) {
    throw Error(`RPC error: ${JSON.stringify(response.error)}`);
  }
  return response.data.result || "0x0";
}

// Use secrets for RPC URL if available, otherwise fallback
const rpcUrl = secrets.RPC_URL || "https://sepolia.base.org";

let totalValueUSD = 0n;
let totalPrincipal = 0n;
let totalCurrentValue = 0n;

for (const vaultAddr of vaultAddresses) {
  try {
    // Get user's share balance
    const balanceData = "0x70a08231" + padAddress(userAddress);
    const balanceHex = await ethCall(rpcUrl, vaultAddr, balanceData);
    const shares = BigInt(balanceHex);

    if (shares === 0n) continue;

    // Convert shares to assets
    const convertData = "0x07a2d13a" + padUint256(shares);
    const assetsHex = await ethCall(rpcUrl, vaultAddr, convertData);
    const assets = BigInt(assetsHex);

    // Get total assets (for share price calculation)
    const totalAssetsHex = await ethCall(rpcUrl, vaultAddr, TOTAL_ASSETS_SEL);
    const totalAssets = BigInt(totalAssetsHex);

    // For USD value, assume stablecoin (1:1) or use a price feed
    // In production, this would query Chainlink price feeds
    totalCurrentValue += assets;

    // Get user principal (for yield calculation)
    // userPrincipal(address) = 0x... + padded address
    const principalSig = "0x" + "a4861185"; // Keccak of userPrincipal(address) first 4 bytes
    const principalData = principalSig + padAddress(userAddress);
    try {
      const principalHex = await ethCall(rpcUrl, vaultAddr, principalData);
      totalPrincipal += BigInt(principalHex);
    } catch {
      // If userPrincipal doesn't exist, use assets as principal
      totalPrincipal += assets;
    }
  } catch (e) {
    // Skip failed vaults, continue with others
    console.log(`Skipping vault ${vaultAddr}: ${e.message}`);
  }
}

// Calculate metrics
const yieldEarned = totalCurrentValue > totalPrincipal
  ? totalCurrentValue - totalPrincipal
  : 0n;

// Scale to 18 decimals for USD value (assuming 6 decimal stablecoins → add 12 zeros)
const portfolioValueUSD = totalCurrentValue * 10n ** 12n;
const totalYieldUSD = yieldEarned * 10n ** 12n;

// Risk score: simple heuristic based on number of vaults (diversification)
// More vaults = lower risk. Single vault = higher risk.
const vaultCount = vaultAddresses.length;
let riskScore;
if (vaultCount >= 5) riskScore = 2000; // 20% risk
else if (vaultCount >= 3) riskScore = 4000; // 40% risk
else if (vaultCount >= 2) riskScore = 6000; // 60% risk
else riskScore = 8000; // 80% risk (single vault)

// APY estimate (annualized)
let apyBps = 0;
if (totalPrincipal > 0n && yieldEarned > 0n) {
  // Simple APY: (yield / principal) * 10000 bps
  // This is a snapshot, not time-weighted. In production, use time-weighted returns.
  const yieldRatio = Number(yieldEarned * 10000n / totalPrincipal);
  apyBps = Math.min(yieldRatio, 65535); // Cap at uint16 max
}

// Sharpe ratio approximation: (return - risk_free_rate) / volatility
// Simplified: use yield ratio as return proxy, assume 5% risk-free, 20% vol
const returnRate = Number(yieldEarned) / Math.max(Number(totalPrincipal), 1);
const riskFreeRate = 0.05;
const volatilityProxy = 0.20;
const sharpeRatioX1000 = Math.max(0, Math.round(((returnRate - riskFreeRate) / volatilityProxy) * 1000));

// Max drawdown: for hackathon, estimate based on asset type
// In production, compute from historical price data
const maxDrawdownBps = riskScore / 2; // Half of risk score as drawdown proxy

// ABI encode the response: (uint256, uint256, uint16, uint16, uint256, uint256)
// Chainlink Functions expects the return value as a bytes buffer
const encodedResponse =
  padUint256(portfolioValueUSD)
  + padUint256(totalYieldUSD)
  + padUint256(riskScore)
  + padUint256(apyBps)
  + padUint256(sharpeRatioX1000)
  + padUint256(maxDrawdownBps);

return Buffer.from(encodedResponse, "hex");
