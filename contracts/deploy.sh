#!/bin/bash

# Soroban Contract Deployment Script
# Supports: escrow, recurring-payments
# Usage: [CONTRACT=recurring-payments] STELLAR_NETWORK=testnet SOROBAN_SECRET_KEY=<key> ./deploy.sh

set -e

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

# Check if a deploy key is provided
if [ -z "$SOROBAN_SECRET_KEY" ]; then
    echo -e "${YELLOW}Note: SOROBAN_SECRET_KEY not set. Please provide it to deploy.${NC}"
    echo "Usage: export SOROBAN_SECRET_KEY='your-secret-key'; $0"
    exit 1
fi

# Deploy using soroban CLI
CONTRACT_ID=$($SOROBAN_CLI contract deploy \
    --wasm "$WASM_FILE" \
    --source "$SOROBAN_SECRET_KEY" \
    --network "$NETWORK" 2>&1 | tail -1 || true)

if [ -z "$CONTRACT_ID" ]; then
    echo -e "${RED}Error: Failed to deploy contract${NC}"
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

# Step 6 (security — fix #336): Initialize immediately after deployment.
# Eliminates the front-running window: anyone who calls initialize() first
# becomes admin. We call it here so there is no manual gap.
echo -e "\n${YELLOW}Step 6: Initializing contract (front-running prevention — fix #336)...${NC}"

INIT_OK=false

case "$TARGET_CONTRACT" in
  escrow|fee-distributor)
    if [ -n "${ADMIN_ADDRESS:-}" ] && [ -n "${USDC_ADDRESS:-}" ]; then
        $SOROBAN_CLI contract invoke \
            --id "$CONTRACT_ID" \
            --source "$SOROBAN_SECRET_KEY" \
            --network "$NETWORK" \
            -- initialize \
            --admin "$ADMIN_ADDRESS" \
            --usdc_address "$USDC_ADDRESS"
        INIT_OK=true
    else
        echo -e "${RED}WARNING: Set ADMIN_ADDRESS and USDC_ADDRESS, then run:${NC}"
        echo "  $SOROBAN_CLI contract invoke --id $CONTRACT_ID --source \$SOROBAN_SECRET_KEY --network $NETWORK -- initialize --admin \$ADMIN_ADDRESS --usdc_address \$USDC_ADDRESS"
    fi
    ;;
  savings-vault)
    if [ -n "${ADMIN_ADDRESS:-}" ] && [ -n "${USDC_ADDRESS:-}" ]; then
        PENALTY="${PENALTY_BPS:-1000}"
        $SOROBAN_CLI contract invoke \
            --id "$CONTRACT_ID" \
            --source "$SOROBAN_SECRET_KEY" \
            --network "$NETWORK" \
            -- initialize \
            --admin "$ADMIN_ADDRESS" \
            --token_address "$USDC_ADDRESS" \
            --penalty_bps "$PENALTY"
        INIT_OK=true
    else
        echo -e "${RED}WARNING: Set ADMIN_ADDRESS, USDC_ADDRESS, and optionally PENALTY_BPS (default 1000), then run:${NC}"
        echo "  $SOROBAN_CLI contract invoke --id $CONTRACT_ID --source \$SOROBAN_SECRET_KEY --network $NETWORK -- initialize --admin \$ADMIN_ADDRESS --token_address \$USDC_ADDRESS --penalty_bps \${PENALTY_BPS:-1000}"
    fi
    ;;
  recurring-payments)
    if [ -n "${ADMIN_ADDRESS:-}" ] && [ -n "${USDC_ADDRESS:-}" ]; then
        FEE="${FEE_BPS:-0}"
        $SOROBAN_CLI contract invoke \
            --id "$CONTRACT_ID" \
            --source "$SOROBAN_SECRET_KEY" \
            --network "$NETWORK" \
            -- initialize \
            --admin "$ADMIN_ADDRESS" \
            --token_address "$USDC_ADDRESS" \
            --fee_bps "$FEE"
        INIT_OK=true
    else
        echo -e "${RED}WARNING: Set ADMIN_ADDRESS and USDC_ADDRESS (and optionally FEE_BPS, default 0), then run:${NC}"
        echo "  $SOROBAN_CLI contract invoke --id $CONTRACT_ID --source \$SOROBAN_SECRET_KEY --network $NETWORK -- initialize --admin \$ADMIN_ADDRESS --token_address \$USDC_ADDRESS --fee_bps \${FEE_BPS:-0}"
    fi
    ;;
  kyc-attestation)
    if [ -n "${ADMIN_ADDRESS:-}" ]; then
        $SOROBAN_CLI contract invoke \
            --id "$CONTRACT_ID" \
            --source "$SOROBAN_SECRET_KEY" \
            --network "$NETWORK" \
            -- initialize \
            --admin "$ADMIN_ADDRESS"
        INIT_OK=true
    else
        echo -e "${RED}WARNING: Set ADMIN_ADDRESS, then run:${NC}"
        echo "  $SOROBAN_CLI contract invoke --id $CONTRACT_ID --source \$SOROBAN_SECRET_KEY --network $NETWORK -- initialize --admin \$ADMIN_ADDRESS"
    fi
    ;;
  agent-escrow)
    if [ -n "${ADMIN_ADDRESS:-}" ] && [ -n "${USDC_ADDRESS:-}" ]; then
        CANCEL_WINDOW="${CANCEL_WINDOW_SECONDS:-86400}"
        $SOROBAN_CLI contract invoke \
            --id "$CONTRACT_ID" \
            --source "$SOROBAN_SECRET_KEY" \
            --network "$NETWORK" \
            -- initialize \
            --admin "$ADMIN_ADDRESS" \
            --usdc_address "$USDC_ADDRESS" \
            --cancel_window_seconds "$CANCEL_WINDOW"
        INIT_OK=true
    else
        echo -e "${RED}WARNING: Set ADMIN_ADDRESS, USDC_ADDRESS, and optionally CANCEL_WINDOW_SECONDS (default 86400), then run:${NC}"
        echo "  $SOROBAN_CLI contract invoke --id $CONTRACT_ID --source \$SOROBAN_SECRET_KEY --network $NETWORK -- initialize --admin \$ADMIN_ADDRESS --usdc_address \$USDC_ADDRESS --cancel_window_seconds \${CANCEL_WINDOW_SECONDS:-86400}"
    fi
    ;;
  dispute-resolution)
    if [ -n "${ADMIN_ADDRESS:-}" ] && [ -n "${ARBITRATOR_ADDRESS:-}" ] && [ -n "${USDC_ADDRESS:-}" ]; then
        MAX_EVIDENCE="${MAX_EVIDENCE_BYTES:-65536}"
        $SOROBAN_CLI contract invoke \
            --id "$CONTRACT_ID" \
            --source "$SOROBAN_SECRET_KEY" \
            --network "$NETWORK" \
            -- initialize \
            --admin "$ADMIN_ADDRESS" \
            --arbitrator "$ARBITRATOR_ADDRESS" \
            --usdc_address "$USDC_ADDRESS" \
            --max_evidence_bytes "$MAX_EVIDENCE"
        INIT_OK=true
    else
        echo -e "${RED}WARNING: Set ADMIN_ADDRESS, ARBITRATOR_ADDRESS, USDC_ADDRESS, and optionally MAX_EVIDENCE_BYTES (default 65536), then run:${NC}"
        echo "  $SOROBAN_CLI contract invoke --id $CONTRACT_ID --source \$SOROBAN_SECRET_KEY --network $NETWORK -- initialize --admin \$ADMIN_ADDRESS --arbitrator \$ARBITRATOR_ADDRESS --usdc_address \$USDC_ADDRESS --max_evidence_bytes \${MAX_EVIDENCE_BYTES:-65536}"
    fi
    ;;
  multisig-approval)
    if [ -n "${ADMIN_ADDRESS:-}" ] && [ -n "${APPROVERS:-}" ] && [ -n "${QUORUM:-}" ]; then
        $SOROBAN_CLI contract invoke \
            --id "$CONTRACT_ID" \
            --source "$SOROBAN_SECRET_KEY" \
            --network "$NETWORK" \
            -- initialize \
            --admin "$ADMIN_ADDRESS" \
            --approvers "$APPROVERS" \
            --quorum "$QUORUM"
        INIT_OK=true
    else
        echo -e "${RED}WARNING: Set ADMIN_ADDRESS, APPROVERS (JSON array of addresses), and QUORUM, then run:${NC}"
        echo "  $SOROBAN_CLI contract invoke --id $CONTRACT_ID --source \$SOROBAN_SECRET_KEY --network $NETWORK -- initialize --admin \$ADMIN_ADDRESS --approvers \$APPROVERS --quorum \$QUORUM"
    fi
    ;;
  loyalty-token)
    if [ -n "${ADMIN_ADDRESS:-}" ] && [ -n "${MAX_SUPPLY:-}" ]; then
        $SOROBAN_CLI contract invoke \
            --id "$CONTRACT_ID" \
            --source "$SOROBAN_SECRET_KEY" \
            --network "$NETWORK" \
            -- initialize \
            --admin "$ADMIN_ADDRESS" \
            --max_supply "$MAX_SUPPLY"
        INIT_OK=true
    else
        echo -e "${RED}WARNING: Set ADMIN_ADDRESS and MAX_SUPPLY, then run:${NC}"
        echo "  $SOROBAN_CLI contract invoke --id $CONTRACT_ID --source \$SOROBAN_SECRET_KEY --network $NETWORK -- initialize --admin \$ADMIN_ADDRESS --max_supply \$MAX_SUPPLY"
    fi
    ;;
esac

if [ "$INIT_OK" = true ]; then
    echo -e "${GREEN}✓ Contract initialized. Admin: ${ADMIN_ADDRESS:-N/A}${NC}"

    if [ "$TARGET_CONTRACT" = "escrow" ] && [ -n "${ADMIN_ADDRESS:-}" ]; then
        echo -e "\n${YELLOW}Step 6a: Running escrow migration hook...${NC}"
        $SOROBAN_CLI contract invoke \
            --id "$CONTRACT_ID" \
            --source "$SOROBAN_SECRET_KEY" \
            --network "$NETWORK" \
            -- migrate \
            --admin "$ADMIN_ADDRESS"
        echo -e "${GREEN}✓ Escrow migration hook executed${NC}"
    fi
else
    echo -e "${RED}Do not share this contract ID until initialize() has been called.${NC}"
fi

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
echo "  2. initialize() was called automatically in Step 6 (if ADMIN_ADDRESS/USDC_ADDRESS were set)"
echo "  3. Restart the backend service to pick up the new contract ID"
echo "  4. Verify the contract on Stellar Expert: $EXPLORER_URL"
echo ""
