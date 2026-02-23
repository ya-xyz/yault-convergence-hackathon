#!/usr/bin/env bash
set -u

# Demo preflight checks for Chainlink hackathon recording.
# - Loads .env
# - Validates required env vars
# - Checks RPC reachability and chainId
# - Verifies contract bytecode exists at configured addresses

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ENV_FILE:-$ROOT_DIR/.env}"

PASS_COUNT=0
WARN_COUNT=0
FAIL_COUNT=0

RED="\033[31m"
GREEN="\033[32m"
YELLOW="\033[33m"
BLUE="\033[34m"
RESET="\033[0m"

pass() {
  PASS_COUNT=$((PASS_COUNT + 1))
  printf "${GREEN}[PASS]${RESET} %s\n" "$1"
}

warn() {
  WARN_COUNT=$((WARN_COUNT + 1))
  printf "${YELLOW}[WARN]${RESET} %s\n" "$1"
}

fail() {
  FAIL_COUNT=$((FAIL_COUNT + 1))
  printf "${RED}[FAIL]${RESET} %s\n" "$1"
}

section() {
  printf "\n${BLUE}== %s ==${RESET}\n" "$1"
}

require_cmd() {
  local cmd="$1"
  if command -v "$cmd" >/dev/null 2>&1; then
    pass "Command available: $cmd"
  else
    fail "Missing command: $cmd"
  fi
}

check_nonempty_env() {
  local key="$1"
  local value="${!key:-}"
  if [ -n "$value" ]; then
    pass "$key is set"
  else
    fail "$key is missing"
  fi
}

load_env_file() {
  local file="$1"
  local line key value
  while IFS= read -r line || [ -n "$line" ]; do
    # Trim leading spaces
    line="${line#"${line%%[![:space:]]*}"}"
    # Skip empty and comment lines
    [ -z "$line" ] && continue
    [[ "$line" =~ ^# ]] && continue
    # Accept KEY=VALUE only
    if [[ ! "$line" =~ ^[A-Za-z_][A-Za-z0-9_]*= ]]; then
      continue
    fi
    key="${line%%=*}"
    value="${line#*=}"
    # Drop trailing inline comment if present
    value="${value%%#*}"
    # Trim surrounding spaces
    value="${value#"${value%%[![:space:]]*}"}"
    value="${value%"${value##*[![:space:]]}"}"
    # Strip matching quotes
    if [[ "$value" =~ ^\".*\"$ ]]; then
      value="${value:1:${#value}-2}"
    elif [[ "$value" =~ ^\'.*\'$ ]]; then
      value="${value:1:${#value}-2}"
    fi
    # If value has trailing annotations separated by spaces, keep first token.
    if [[ "$value" =~ [[:space:]] ]]; then
      local first_token="${value%%[[:space:]]*}"
      warn "Env value for $key contains spaces; using first token only"
      value="$first_token"
    fi
    export "$key=$value"
  done < "$file"
}

json_rpc() {
  local rpc_url="$1"
  local payload="$2"
  curl -sS --max-time 10 -H "Content-Type: application/json" -d "$payload" "$rpc_url"
}

normalize_hex() {
  local v="$1"
  printf "%s" "$v" | tr '[:upper:]' '[:lower:]'
}

extract_json_field() {
  # Very small JSON field extraction without jq:
  # expects field present as: "result":"...".
  local json="$1"
  local field="$2"
  printf "%s" "$json" | sed -n "s/.*\"$field\"[[:space:]]*:[[:space:]]*\"\\([^\"]*\\)\".*/\\1/p"
}

check_rpc_chainid() {
  local rpc_url="$1"
  local expect_chainid="${2:-}"
  local resp result

  resp="$(json_rpc "$rpc_url" '{"jsonrpc":"2.0","method":"eth_chainId","params":[],"id":1}' 2>/dev/null || true)"
  result="$(extract_json_field "$resp" "result")"

  if [ -z "$result" ]; then
    fail "RPC unreachable or invalid eth_chainId response: $rpc_url"
    return
  fi

  pass "RPC reachable: $rpc_url (eth_chainId=$result)"

  if [ -n "$expect_chainid" ]; then
    local expected_hex
    if [[ "$expect_chainid" =~ ^[0-9]+$ ]]; then
      expected_hex="$(printf "0x%x" "$expect_chainid")"
    else
      expected_hex="$(normalize_hex "$expect_chainid")"
    fi
    local got_hex
    got_hex="$(normalize_hex "$result")"
    if [ "$expected_hex" = "$got_hex" ]; then
      pass "CHAIN_ID matches RPC ($got_hex)"
    else
      fail "CHAIN_ID mismatch: expected $expected_hex, got $got_hex"
    fi
  fi
}

check_contract_code() {
  local rpc_url="$1"
  local addr="$2"
  local label="$3"

  if [[ ! "$addr" =~ ^0x[0-9a-fA-F]{40}$ ]]; then
    fail "$label address invalid: $addr"
    return
  fi

  local payload resp code
  payload="{\"jsonrpc\":\"2.0\",\"method\":\"eth_getCode\",\"params\":[\"$addr\",\"latest\"],\"id\":1}"
  resp="$(json_rpc "$rpc_url" "$payload" 2>/dev/null || true)"
  code="$(extract_json_field "$resp" "result")"

  if [ -z "$code" ]; then
    fail "$label eth_getCode failed for $addr"
    return
  fi

  if [ "$code" = "0x" ] || [ "$code" = "0x0" ]; then
    fail "$label has no bytecode on current RPC: $addr"
  else
    pass "$label bytecode found: $addr"
  fi
}

section "Tooling"
require_cmd "curl"
require_cmd "node"

section "Environment"
if [ -f "$ENV_FILE" ]; then
  pass "Using env file: $ENV_FILE"
  load_env_file "$ENV_FILE"
else
  fail ".env file not found at $ENV_FILE"
fi

check_nonempty_env "NODE_ENV"
check_nonempty_env "DATABASE_PATH"

section "Demo-critical vars"
check_nonempty_env "ORACLE_ATTESTATION_ENABLED"
check_nonempty_env "RELEASE_ATTESTATION_ADDRESS"
check_nonempty_env "PATH_CLAIM_ADDRESS"
check_nonempty_env "ORACLE_INTERNAL_API_KEY"
check_nonempty_env "CLIENT_SESSION_SECRET"

if [ "${ORACLE_ATTESTATION_ENABLED:-}" = "true" ]; then
  pass "ORACLE_ATTESTATION_ENABLED=true"
else
  fail "ORACLE_ATTESTATION_ENABLED should be true for demo"
fi

section "RPC and chain checks"
RPC_URL="${ORACLE_RPC_URL:-${RPC_ETHEREUM:-${EVM_RPC_URL:-}}}"
CHAIN_ID_EXPECT="${PATH_CLAIM_CHAIN_ID:-${VAULT_CHAIN_ID:-${CHAIN_ID:-}}}"

if [ -z "$RPC_URL" ]; then
  fail "No RPC URL set (ORACLE_RPC_URL / RPC_ETHEREUM / EVM_RPC_URL)"
else
  check_rpc_chainid "$RPC_URL" "$CHAIN_ID_EXPECT"
fi

section "Contract bytecode checks"
if [ -n "${RPC_URL:-}" ]; then
  if [ -n "${RELEASE_ATTESTATION_ADDRESS:-}" ]; then
    check_contract_code "$RPC_URL" "$RELEASE_ATTESTATION_ADDRESS" "ReleaseAttestation"
  fi

  if [ -n "${PATH_CLAIM_ADDRESS:-}" ]; then
    check_contract_code "$RPC_URL" "$PATH_CLAIM_ADDRESS" "PathClaim"
  fi

  if [ -n "${VAULT_ADDRESS:-}" ]; then
    check_contract_code "$RPC_URL" "$VAULT_ADDRESS" "Vault"
  else
    warn "VAULT_ADDRESS not set (ok if your demo does not include vault txs)"
  fi
fi

section "Filesystem checks"
if [ -n "${DATABASE_PATH:-}" ]; then
  DB_DIR="$(dirname "$DATABASE_PATH")"
  if [ -d "$DB_DIR" ]; then
    pass "Database directory exists: $DB_DIR"
  else
    warn "Database directory missing (server may create it): $DB_DIR"
  fi
fi

if [ -d "$ROOT_DIR/node_modules" ]; then
  pass "node_modules present"
else
  warn "node_modules missing. Run: npm install"
fi

section "Summary"
printf "PASS: %d  WARN: %d  FAIL: %d\n" "$PASS_COUNT" "$WARN_COUNT" "$FAIL_COUNT"

if [ "$FAIL_COUNT" -gt 0 ]; then
  printf "${RED}Preflight failed.${RESET}\n"
  exit 1
fi

printf "${GREEN}Preflight passed.${RESET}\n"
exit 0
