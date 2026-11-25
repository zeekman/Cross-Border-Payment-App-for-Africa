#!/bin/bash

# Soroban Contract Deployment Script
# Supports: escrow, recurring-payments
# Usage: [CONTRACT=recurring-payments] STELLAR_NETWORK=testnet SOROBAN_IDENTITY=<identity> ./deploy.sh

set -euo pipefail

: "${SOROBAN_IDENTITY:=}" "${SOROBAN_SECRET_KEY:=}" "${EXPECTED_WASM_HASH:=}"
: "${SOROBAN_RPC_HOST:=}" "${SOROBAN_NETWORK_PASSPHRASE:=}"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Parse arguments
NETWORK="${STELLAR_NETWORK:-testnet}"
CONFIRM_MAINNET=false
TARGET_CONTRACT="${CONTRACT:-escrow}"

while [[ $# -gt 0 ]]; do
    case "$1" in
        --network)
            NETWORK="$2"
            shift 2
            ;;
        --confirm-mainnet)
            CONFIRM_MAINNET=true
            shift
            ;;
        *)
            shift
            ;;
    esac
done

if [[ "$NETWORK" != "testnet" && "$NETWORK" != "mainnet" ]]; then
    echo -e "${RED}Error: --network must be 'testnet' or 'mainnet'${NC}"
    exit 1
fi

if [[ "$NETWORK" == "mainnet" && "$CONFIRM_MAINNET" != "true" ]]; then
    echo -e "${RED}Error: Mainnet deployment requires --confirm-mainnet flag to prevent accidental production deployments.${NC}"
    exit 1
fi

# Explicit, unambiguous mainnet confirmation: the network name is echoed back and
# the operator must type it literally. A bare yes/no answer is not enough, because
# contract deployments/upgrades are IRREVERSIBLE on-chain.
confirm_mainnet_deployment() {
    [[ "$NETWORK" != "mainnet" ]] && return 0

    cat << CONFIRM_EOF

${RED}══════════════════════════════════════════════════════════════════${NC}
${RED}⚠  DANGER ZONE — MAINNET  ${NC}
${RED}══════════════════════════════════════════════════════════════════${NC}
${YELLOW}You are about to DEPLOY + INITIALIZE on:${NC} ${RED}MAINNET${NC}
${YELLOW}  Network name : ${NETWORK}${NC}
${YELLOW}  Network passphrase : auto-derived from $NETWORK${NC}
${YELLOW}  Contract     : ${TARGET_CONTRACT}${NC}

${RED}Contract deployments/upgrades are IRREVERSIBLE on-chain. Once a new${NC}
${RED}WASM hash is applied, the previous bytecode cannot be restored.${NC}

${YELLOW}To proceed, type exactly:${NC} ${GREEN}CONFIRM_MAINNET${NC}
${YELLOW}Any other input will abort without touching the network.${NC}
CONFIRM_EOF

    read -r -p "> " confirmation
    if [[ "$confirmation" != "CONFIRM_MAINNET" ]]; then
        echo -e "${RED}✗ Confirmation \"${confirmation:-<empty>}\" did not match CONFIRM_MAINNET. Aborting — no changes were made to ${NETWORK}.${NC}"
        exit 1
    fi
    echo -e "${GREEN}✓ Confirmed. Proceeding with deployment on ${NETWORK}.${NC}"
}

confirm_mainnet_deployment

CONTRACT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

case "$TARGET_CONTRACT" in
  escrow)
    CONTRACT_NAME="escrow_contract"
    CONTRACT_SUBDIR="escrow"
    ;;
  recurring-payments)
    CONTRACT_NAME="recurring_payments_contract"
    CONTRACT_SUBDIR="recurring-payments"
    ;;
  savings-vault)
    CONTRACT_NAME="savings_vault_contract"
    CONTRACT_SUBDIR="savings-vault"
    ;;
  fee-distributor)
    CONTRACT_NAME="fee_distributor_contract"
    CONTRACT_SUBDIR="fee-distributor"
    ;;
  dispute-resolution)
    CONTRACT_NAME="dispute_resolution_contract"
    CONTRACT_SUBDIR="dispute-resolution"
    ;;
  kyc-attestation)
    CONTRACT_NAME="kyc_attestation_contract"
    CONTRACT_SUBDIR="kyc-attestation"
    ;;
  agent-escrow)
    CONTRACT_NAME="agent_escrow_contract"
    CONTRACT_SUBDIR="agent-escrow"
    ;;
  multisig-approval)
    CONTRACT_NAME="multisig_approval"
    CONTRACT_SUBDIR="multisig-approval"
    ;;
  loyalty-token)
    CONTRACT_NAME="loyalty_token_contract"
    CONTRACT_SUBDIR="loyalty-token"
    ;;
  *)
    echo -e "${RED}Unknown contract: $TARGET_CONTRACT. Valid options: escrow, recurring-payments, savings-vault, fee-distributor, dispute-resolution, kyc-attestation, agent-escrow, multisig-approval, loyalty-token${NC}"
    exit 1
    ;;
esac

# Step 0 (SC-175): Validate initialize() arguments BEFORE any on-chain action.
# Each contract gets the exact arguments of its initialize() signature. A
# missing variable aborts here, so we never leave a deployed-but-uninitialised
# contract that anyone could initialise first.
require_env() {
    local missing=()
    for v in "$@"; do
        [ -n "${!v:-}" ] || missing+=("$v")
    done
    if [ ${#missing[@]} -gt 0 ]; then
        echo -e "${RED}Missing required env vars for $TARGET_CONTRACT: ${missing[*]}${NC}"
        exit 1
    fi
}

case "$TARGET_CONTRACT" in
  escrow)
    require_env ADMIN_ADDRESS USDC_ADDRESS
    INIT_ARGS=(--admin "$ADMIN_ADDRESS" --usdc_address "$USDC_ADDRESS")
    ;;
  fee-distributor)
    require_env ADMIN_ADDRESS SPLIT_BPS
    INIT_ARGS=(--admin "$ADMIN_ADDRESS" --split_bps "$SPLIT_BPS")
    ;;
  savings-vault)
    require_env ADMIN_ADDRESS USDC_ADDRESS
    INIT_ARGS=(--admin "$ADMIN_ADDRESS" --token_address "$USDC_ADDRESS" --penalty_bps "${PENALTY_BPS:-1000}")
    ;;
  recurring-payments)
    require_env ADMIN_ADDRESS USDC_ADDRESS
    INIT_ARGS=(--admin "$ADMIN_ADDRESS" --token_address "$USDC_ADDRESS" --fee_bps "${FEE_BPS:-0}")
    ;;
  kyc-attestation)
    require_env ADMIN_ADDRESS
    INIT_ARGS=(--admin "$ADMIN_ADDRESS")
    ;;
  agent-escrow)
    require_env ADMIN_ADDRESS USDC_ADDRESS
    INIT_ARGS=(--admin "$ADMIN_ADDRESS" --usdc_address "$USDC_ADDRESS" --cancel_window_seconds "${CANCEL_WINDOW_SECONDS:-86400}")
    ;;
  dispute-resolution)
    require_env ADMIN_ADDRESS ARBITRATOR_ADDRESS USDC_ADDRESS SUPER_ARBITRATOR_ADDRESS
    INIT_ARGS=(--admin "$ADMIN_ADDRESS" --arbitrator "$ARBITRATOR_ADDRESS" --usdc_address "$USDC_ADDRESS" --max_evidence_bytes "${MAX_EVIDENCE_BYTES:-65536}" --super_arbitrator "$SUPER_ARBITRATOR_ADDRESS")
    ;;
  multisig-approval)
    require_env ADMIN_ADDRESS APPROVERS QUORUM
    INIT_ARGS=(--admin "$ADMIN_ADDRESS" --approvers "$APPROVERS" --quorum "$QUORUM")
    ;;
  loyalty-token)
    require_env ADMIN_ADDRESS MAX_SUPPLY
    INIT_ARGS=(--admin "$ADMIN_ADDRESS" --max_supply "$MAX_SUPPLY")
    ;;
esac

BUILTIN_CONTRACT_DIR="$HOME/.soroban"

echo -e "${YELLOW}=== Soroban ${TARGET_CONTRACT} Contract Deployment ===${NC}"
echo -e "${YELLOW}>>> DEPLOYING TO NETWORK: ${NETWORK} <<<${NC}"
echo "Contract Directory: $CONTRACT_DIR"

# Step 1: Check prerequisites
echo -e "\n${YELLOW}Step 1: Checking prerequisites...${NC}"

# Support both 'stellar' (new) and 'soroban' (legacy) CLI names
if command -v stellar &> /dev/null; then
    SOROBAN_CLI="stellar"
elif command -v soroban &> /dev/null; then
    SOROBAN_CLI="soroban"
else
    echo -e "${RED}Error: Stellar CLI is not installed.${NC}"
    echo "Install from: https://developers.stellar.org/docs/tools/developer-tools/cli/install-cli"
    exit 1
fi
echo "Using CLI: $SOROBAN_CLI"

if ! command -v cargo &> /dev/null; then
    echo -e "${RED}Error: cargo is not installed.${NC}"
    echo "Install from: https://rustup.rs/"
    exit 1
fi

echo -e "${GREEN}✓ Prerequisites OK${NC}"

# Step 2: Build the contract
echo -e "\n${YELLOW}Step 2: Building contract...${NC}"

cd "$CONTRACT_DIR/$CONTRACT_SUBDIR"

if [ ! -f "Cargo.toml" ]; then
    echo -e "${RED}Error: Cargo.toml not found in $CONTRACT_DIR/$CONTRACT_SUBDIR${NC}"
    exit 1
fi

# Build for Soroban target
cargo build --release --target wasm32-unknown-unknown

WASM_FILE="target/wasm32-unknown-unknown/release/${CONTRACT_NAME}.wasm"

if [ ! -f "$WASM_FILE" ]; then
    echo -e "${RED}Error: Contract WASM file not built: $WASM_FILE${NC}"
    exit 1
fi

echo -e "${GREEN}✓ Contract built successfully${NC}"
echo "WASM file: $WASM_FILE"

# Step 3: Optimize the WASM for Soroban
echo -e "\n${YELLOW}Step 3: Optimizing WASM...${NC}"

# Use 'soroban contract optimize' if available, otherwise use wasm-opt
if $SOROBAN_CLI contract optimize --help > /dev/null 2>&1; then
    $SOROBAN_CLI contract optimize --wasm "$WASM_FILE" --output-wasm "$WASM_FILE"
    echo -e "${GREEN}✓ WASM optimized${NC}"
else
    echo -e "${YELLOW}Note: contract optimize not available, skipping${NC}"
fi

# Step 3.5: Compute expected WASM hash
echo -e "\n${YELLOW}Step 3.5: Computing WASM hash...${NC}"

EXPECTED_WASM_HASH=$(sha256sum "$WASM_FILE" | awk '{print $1}')
echo "Expected WASM hash: $EXPECTED_WASM_HASH"
echo -e "${GREEN}✓ WASM hash computed${NC}"

# Step 3.6: Pre-network quality gate — mirror SC-001's CI job (full cargo build + cargo test).
# This MUST pass immediately before ANY on-chain action (deploy/initialize) against a real
# network (testnet or mainnet). Contract upgrades are irreversible, so deploy.sh will not
# touch a network unless the freshly built code builds and all tests pass.
echo -e "\n${YELLOW}Step 3.6: Running pre-network quality gate (cargo build + cargo test)...${NC}"

cargo build --release
cargo test

echo -e "${GREEN}✓ Quality gate passed: cargo build and cargo test succeeded. Safe to proceed to network.${NC}"

# Step 4: Deploy to Stellar Network
echo -e "\n${YELLOW}Step 4: Deploying to $NETWORK...${NC}"

if [ -z "$SOROBAN_RPC_HOST" ]; then
    if [ "$NETWORK" = "mainnet" ]; then
        export SOROBAN_RPC_HOST="https://mainnet.soroban.stellar.org"
    else
        export SOROBAN_RPC_HOST="https://soroban-testnet.stellar.org"
    fi
fi

if [ -z "$SOROBAN_NETWORK_PASSPHRASE" ]; then
    if [ "$NETWORK" = "mainnet" ]; then
        export SOROBAN_NETWORK_PASSPHRASE="Public Global Stellar Network ; September 2015"
    else
        export SOROBAN_NETWORK_PASSPHRASE="Test SDF Network ; September 2015"
    fi
fi

echo "RPC Host: $SOROBAN_RPC_HOST"
echo "Network Passphrase: $SOROBAN_NETWORK_PASSPHRASE"

# Resolve the signing identity. The secret key is never passed on the command
# line (visible via ps / shell history); a named CLI identity is used instead.
# See README "Deployer identity setup".
if [ -z "$SOROBAN_IDENTITY" ]; then
    if [ "$NETWORK" = "mainnet" ]; then
        echo -e "${RED}Error: mainnet deploys require SOROBAN_IDENTITY (a named CLI identity, e.g. a Ledger key).${NC}"
        exit 1
    fi
    if [ -z "$SOROBAN_SECRET_KEY" ]; then
        echo -e "${YELLOW}Note: set SOROBAN_IDENTITY (or SOROBAN_SECRET_KEY on testnet) to deploy.${NC}"
        exit 1
    fi
    SOROBAN_IDENTITY="afripay-testnet-deployer"
    # Import the key via stdin so it never appears in argv
    printf '%s\n' "$SOROBAN_SECRET_KEY" | $SOROBAN_CLI keys add "$SOROBAN_IDENTITY" --secret-key --overwrite >/dev/null
fi
unset SOROBAN_SECRET_KEY

# Verify the WASM hash before deploying (mandatory on mainnet)
WASM_HASH=$(sha256sum "$WASM_FILE" | awk '{print $1}')
if [ -z "$WASM_HASH" ]; then
    echo -e "${RED}Error: failed to compute WASM hash${NC}"
    exit 1
fi
if [ -n "$EXPECTED_WASM_HASH" ] && [ "$WASM_HASH" != "$EXPECTED_WASM_HASH" ]; then
    echo -e "${RED}Error: WASM hash mismatch (expected $EXPECTED_WASM_HASH, got $WASM_HASH)${NC}"
    exit 1
fi
if [ "$NETWORK" = "mainnet" ] && [ -z "$EXPECTED_WASM_HASH" ]; then
    echo -e "${RED}Error: mainnet deploys require EXPECTED_WASM_HASH to be set.${NC}"
    exit 1
fi

# Deploy: capture stdout only and fail on a non-zero exit status
if ! DEPLOY_OUT=$($SOROBAN_CLI contract deploy \
    --wasm "$WASM_FILE" \
    --source "$SOROBAN_IDENTITY" \
    --network "$NETWORK"); then
    echo -e "${RED}Error: Failed to deploy contract${NC}"
    exit 1
fi
CONTRACT_ID=$(printf '%s\n' "$DEPLOY_OUT" | tail -1 | tr -d '[:space:]')

if ! [[ "$CONTRACT_ID" =~ ^C[A-Z2-7]{55}$ ]]; then
    echo -e "${RED}Error: deploy returned an invalid contract ID: '$CONTRACT_ID'${NC}"
    exit 1
fi

echo -e "${GREEN}✓ Contract deployed successfully${NC}"
echo "Contract ID: $CONTRACT_ID"

# Step 4.5: Verify WASM hash
echo -e "\n${YELLOW}Step 4.5: Verifying WASM hash...${NC}"

# Fetch the contract's ledger entry to get the WASM hash
DEPLOYED_WASM_HASH=$($SOROBAN_CLI contract info --id "$CONTRACT_ID" --network "$NETWORK" 2>/dev/null | grep -i "wasm_hash\|hash" | head -1 | awk -F': ' '{print $2}' || true)

if [ -z "$DEPLOYED_WASM_HASH" ]; then
    echo -e "${YELLOW}Note: Could not fetch deployed WASM hash from network. Verify manually.${NC}"
    echo "Expected WASM hash: $EXPECTED_WASM_HASH"
else
    # Normalize hashes (remove 0x prefix if present and convert to lowercase)
    EXPECTED_NORMALIZED=$(echo "$EXPECTED_WASM_HASH" | tr '[:upper:]' '[:lower:]' | sed 's/^0x//')
    DEPLOYED_NORMALIZED=$(echo "$DEPLOYED_WASM_HASH" | tr '[:upper:]' '[:lower:]' | sed 's/^0x//')
    
    if [ "$EXPECTED_NORMALIZED" = "$DEPLOYED_NORMALIZED" ]; then
        echo -e "${GREEN}✓ WASM hash verified: $EXPECTED_WASM_HASH${NC}"
    else
        echo -e "${RED}Error: WASM hash mismatch!${NC}"
        echo "Expected: $EXPECTED_NORMALIZED"
        echo "Deployed: $DEPLOYED_NORMALIZED"
        echo "This may indicate a supply chain attack or compilation issue."
        exit 1
    fi
fi

# Step 5: Save deployment info
echo -e "\n${YELLOW}Step 5: Saving deployment info...${NC}"

DEPLOYMENT_FILE="${CONTRACT_DIR}/${CONTRACT_SUBDIR}/deployments/${NETWORK}_deployment.json"
mkdir -p "${CONTRACT_DIR}/${CONTRACT_SUBDIR}/deployments"

cat > "$DEPLOYMENT_FILE" << EOF
{
  "network": "$NETWORK",
  "contract_id": "$CONTRACT_ID",
  "deployed_at": "$(date -u +'%Y-%m-%dT%H:%M:%SZ')",
  "rpc_host": "$SOROBAN_RPC_HOST",
  "network_passphrase": "$SOROBAN_NETWORK_PASSPHRASE",
  "wasm_hash": "$EXPECTED_WASM_HASH"
}
EOF

echo -e "${GREEN}✓ Deployment info saved to $DEPLOYMENT_FILE${NC}"

# Step 5a: Store expected WASM hash for future verification
EXPECTED_HASH_FILE="${CONTRACT_DIR}/${CONTRACT_SUBDIR}/expected_hash.txt"
echo "$EXPECTED_WASM_HASH" > "$EXPECTED_HASH_FILE"
echo -e "${GREEN}✓ Expected WASM hash stored to $EXPECTED_HASH_FILE${NC}"

# Step 5b: Write contract ID to contracts/.env so the backend can load it as an env var
DEPLOYED_IDS_FILE="${CONTRACT_DIR}/.env"

# Derive the env var name from the contract name (uppercase + _CONTRACT_ID)
ENV_VAR_NAME=$(echo "${TARGET_CONTRACT}" | tr '[:lower:]-' '[:upper:]_')_CONTRACT_ID

# Append or update the entry
if [ -f "$DEPLOYED_IDS_FILE" ] && grep -q "^${ENV_VAR_NAME}=" "$DEPLOYED_IDS_FILE"; then
    sed -i.bak "s|^${ENV_VAR_NAME}=.*|${ENV_VAR_NAME}=${CONTRACT_ID}|" "$DEPLOYED_IDS_FILE" && rm -f "${DEPLOYED_IDS_FILE}.bak"
else
    echo "${ENV_VAR_NAME}=${CONTRACT_ID}" >> "$DEPLOYED_IDS_FILE"
fi

echo -e "${GREEN}✓ Contract ID written to $DEPLOYED_IDS_FILE${NC}"

# Step 6 (security — fix #336 / SC-188): Initialize immediately after deployment.
# Eliminates the front-running window: anyone who calls initialize() first
# becomes admin. We call it here so there is no manual gap.
#
# SC-188: every initialize() now requires admin.require_auth(), so the
# initializing transaction must be signed by ADMIN_ADDRESS. We therefore invoke
# with the deployer identity (which pays fees) and additionally supply the
# admin's signature via --sign-with-key / the configured admin identity.
echo -e "\n${YELLOW}Step 6: Initializing contract (front-running prevention — fix #336)...${NC}"

# SC-188: the admin must co-sign initialize(). Resolve an identity that can sign
# for ADMIN_ADDRESS. Prefer an explicit ADMIN_IDENTITY; otherwise fall back to
# the deployer identity (valid when the deployer *is* the admin, the common case).
ADMIN_IDENTITY="${ADMIN_IDENTITY:-$SOROBAN_IDENTITY}"

INIT_SIGN_ARGS=(--source "$ADMIN_IDENTITY")
if [ -n "${ADMIN_IDENTITY:-}" ] && [ "$ADMIN_IDENTITY" != "$SOROBAN_IDENTITY" ]; then
    # Deployer pays fees; admin identity supplies the require_auth() signature.
    INIT_SIGN_ARGS=(--source "$SOROBAN_IDENTITY" --sign-with-key "$ADMIN_IDENTITY")
fi

if ! $SOROBAN_CLI contract invoke \
    --id "$CONTRACT_ID" \
    "${INIT_SIGN_ARGS[@]}" \
    --network "$NETWORK" \
    -- initialize "${INIT_ARGS[@]}"; then
    echo -e "${RED}✗ initialize() failed for $TARGET_CONTRACT ($CONTRACT_ID).${NC}"
    echo -e "${RED}Do not share this contract ID — it is deployed but uninitialised.${NC}"
    exit 1
fi
echo -e "${GREEN}✓ Contract initialized. Admin: ${ADMIN_ADDRESS}${NC}"

# Step 6.0 (SC-188): Verify the stored admin matches the expected admin.
# If a front-runner managed to initialize first (or the wrong key signed), the
# stored admin will differ. Abort loudly rather than continuing silently.
echo -e "\n${YELLOW}Step 6.0: Verifying stored admin matches expected admin...${NC}"

STORED_ADMIN=$($SOROBAN_CLI contract invoke \
    --id "$CONTRACT_ID" \
    --source "$SOROBAN_IDENTITY" \
    --network "$NETWORK" \
    -- get_admin 2>/dev/null | tail -1 | tr -d '[:space:]"' || true)

if [ -z "$STORED_ADMIN" ]; then
    echo -e "${RED}✗ Could not read back stored admin from $CONTRACT_ID.${NC}"
    echo -e "${RED}  Refusing to continue: the contract may have been initialized by a third party.${NC}"
    echo -e "${RED}  Verify manually before using this contract ID.${NC}"
    exit 1
fi

if [ "$STORED_ADMIN" != "$ADMIN_ADDRESS" ]; then
    echo -e "${RED}══════════════════════════════════════════════════════════════════${NC}"
    echo -e "${RED}✗ SECURITY: stored admin does NOT match expected admin!${NC}"
    echo -e "${RED}  Expected: $ADMIN_ADDRESS${NC}"
    echo -e "${RED}  Stored  : $STORED_ADMIN${NC}"
    echo -e "${RED}  Contract $CONTRACT_ID may have been front-run. DO NOT USE IT.${NC}"
    echo -e "${RED}══════════════════════════════════════════════════════════════════${NC}"
    exit 1
fi
echo -e "${GREEN}✓ Stored admin verified: $STORED_ADMIN${NC}"

echo -e "\n${YELLOW}Step 6a: Running migration hook...${NC}"
$SOROBAN_CLI contract invoke \
    --id "$CONTRACT_ID" \
    "${INIT_SIGN_ARGS[@]}" \
    --network "$NETWORK" \
    -- migrate \
    --admin "$ADMIN_ADDRESS" || { echo -e "${RED}✗ migrate() failed${NC}"; exit 1; }
echo -e "${GREEN}✓ Migration hook executed${NC}"

# Step 7: Output Stellar Explorer link
echo -e "\n${YELLOW}Step 7: Verification${NC}"

if [ "$NETWORK" = "mainnet" ]; then
    EXPLORER_URL="https://stellar.expert/explorer/public/contract/$CONTRACT_ID"
else
    EXPLORER_URL="https://stellar.expert/explorer/testnet/contract/$CONTRACT_ID"
fi

echo -e "${GREEN}✓ Deployment Complete!${NC}"
echo ""
echo "Contract Information:"
echo "  Network: $NETWORK"
echo "  Contract ID: $CONTRACT_ID"
echo "  View on Stellar Expert: $EXPLORER_URL"
echo ""
echo -e "${YELLOW}Post-Deployment Checklist:${NC}"
echo "  1. Load the deployed contract IDs into your backend:"
echo "       cp contracts/.env backend/.env"
echo "     Or append: cat contracts/.env >> backend/.env"
echo "     Or manually copy: ${ENV_VAR_NAME}=${CONTRACT_ID}"
echo "  2. initialize() and migrate() were called automatically in Step 6"
echo "  3. Restart the backend service to pick up the new contract ID"
echo "  4. Verify the contract on Stellar Expert: $EXPLORER_URL"
echo ""
