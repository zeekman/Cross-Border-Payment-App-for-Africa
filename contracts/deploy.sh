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

# Configuration
NETWORK="${STELLAR_NETWORK:-testnet}"
CONTRACT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Default to escrow for backwards compatibility; override with CONTRACT=recurring-payments
TARGET_CONTRACT="${CONTRACT:-escrow}"

case "$TARGET_CONTRACT" in
  escrow)
    CONTRACT_NAME="escrow_contract"
    CONTRACT_SUBDIR="escrow"
    ;;
  recurring-payments)
    CONTRACT_NAME="recurring_payments_contract"
    CONTRACT_SUBDIR="recurring-payments"
    ;;
  agent-escrow)
    CONTRACT_NAME="agent_escrow_contract"
    CONTRACT_SUBDIR="agent-escrow"
    ;;
  kyc-attestation)
    CONTRACT_NAME="kyc_attestation_contract"
    CONTRACT_SUBDIR="kyc-attestation"
    ;;
  fee-distributor)
    CONTRACT_NAME="fee_distributor_contract"
    CONTRACT_SUBDIR="fee-distributor"
    ;;
  *)
    echo -e "${RED}Unknown contract: $TARGET_CONTRACT. Valid options: escrow, recurring-payments, agent-escrow, kyc-attestation, fee-distributor${NC}"
    exit 1
    ;;
esac

BUILTIN_CONTRACT_DIR="$HOME/.soroban"

echo -e "${YELLOW}=== Soroban ${TARGET_CONTRACT} Contract Deployment ===${NC}"
echo "Network: $NETWORK"
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
  "wasm_hash": "$(sha256sum "$WASM_FILE" | awk '{print $1}')"
}
EOF

echo -e "${GREEN}✓ Deployment info saved to $DEPLOYMENT_FILE${NC}"

# Step 5b: Write contract ID to .deployed_ids.env for backend configuration
DEPLOYED_IDS_FILE="${CONTRACT_DIR}/.deployed_ids.env"

# Derive the env var name from the contract name (uppercase + _CONTRACT_ID)
ENV_VAR_NAME=$(echo "${TARGET_CONTRACT}" | tr '[:lower:]-' '[:upper:]_')_CONTRACT_ID

# Append or update the entry
if [ -f "$DEPLOYED_IDS_FILE" ] && grep -q "^${ENV_VAR_NAME}=" "$DEPLOYED_IDS_FILE"; then
    sed -i.bak "s|^${ENV_VAR_NAME}=.*|${ENV_VAR_NAME}=${CONTRACT_ID}|" "$DEPLOYED_IDS_FILE" && rm -f "${DEPLOYED_IDS_FILE}.bak"
else
    echo "${ENV_VAR_NAME}=${CONTRACT_ID}" >> "$DEPLOYED_IDS_FILE"
fi

echo -e "${GREEN}✓ Contract ID written to $DEPLOYED_IDS_FILE${NC}"

# Step 6: Output Stellar Explorer link
echo -e "\n${YELLOW}Step 6: Verification${NC}"

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
echo "  1. Source the deployed IDs into your backend .env:"
echo "       cat contracts/.deployed_ids.env >> backend/.env"
echo "     Or manually copy: ${ENV_VAR_NAME}=${CONTRACT_ID}"
echo "  2. Call initialize() with admin address and USDC contract address"
echo "  3. Restart the backend service to pick up the new contract ID"
echo "  4. Verify the contract on Stellar Expert: $EXPLORER_URL"
echo ""
