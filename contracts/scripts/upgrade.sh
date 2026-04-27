#!/bin/bash
# Soroban Contract Upgrade Script
# 
# This script manages the complete lifecycle of a Soroban contract upgrade:
# 1. Build the new contract WASM
# 2. Upload the WASM to the Stellar ledger
# 3. Announce the upgrade with timelock
# 4. Monitor the timelock period
# 5. Execute the upgrade after timelock expires
#
# Usage: ./upgrade.sh <action> <contract-name> [options]
#   Actions: build | announce | execute | verify | status
#
# Examples:
#   ./upgrade.sh build escrow
#   ./upgrade.sh announce escrow --description "Security fix for..."
#   ./upgrade.sh execute escrow
#   ./upgrade.sh verify escrow
#   ./upgrade.sh status escrow

set -e

# Color output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration
NETWORK="${STELLAR_NETWORK:-testnet}"
SOROBAN_RPC="${SOROBAN_RPC:-https://soroban-testnet.stellar.org}"
ADMIN_KEYPAIR="${SOROBAN_ADMIN_KEYPAIR}"
API_BASE="${API_BASE:-http://localhost:5000}"
API_TOKEN="${API_TOKEN}"
TIMELOCK_HOURS=48

# Logging functions
log_info() { echo -e "${BLUE}[INFO]${NC} $1"; }
log_success() { echo -e "${GREEN}[SUCCESS]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; exit 1; }
log_warning() { echo -e "${YELLOW}[WARNING]${NC} $1"; }

# Check prerequisites
check_prerequisites() {
  if [ -z "$ADMIN_KEYPAIR" ]; then
    log_error "SOROBAN_ADMIN_KEYPAIR environment variable not set"
  fi
  
  if [ -z "$API_TOKEN" ]; then
    log_warning "API_TOKEN not set, some operations may fail"
  fi
  
  # Check for required tools
  command -v soroban >/dev/null 2>&1 || log_error "soroban CLI not found"
  command -v cargo >/dev/null 2>&1 || log_error "cargo not found"
  command -v curl >/dev/null 2>&1 || log_error "curl not found"
}

# Build contract WASM
build_contract() {
  local contract_name=$1
  local contract_dir="./contracts/$contract_name"
  
  if [ ! -d "$contract_dir" ]; then
    log_error "Contract directory not found: $contract_dir"
  fi
  
  log_info "Building contract: $contract_name"
  cd "$contract_dir"
  cargo build --target wasm32-unknown-unknown --release
  cd - > /dev/null
  
  local wasm_path="$contract_dir/target/wasm32-unknown-unknown/release/${contract_name}.wasm"
  if [ ! -f "$wasm_path" ]; then
    log_error "WASM build failed, binary not found at $wasm_path"
  fi
  
  log_success "Contract built: $wasm_path"
  echo "$wasm_path"
}

# Calculate WASM hash
get_wasm_hash() {
  local wasm_path=$1
  sha256sum "$wasm_path" | awk '{print $1}'
}

# Upload WASM to Stellar ledger
upload_wasm() {
  local wasm_path=$1
  local contract_name=$2
  
  log_info "Uploading WASM to ledger..."
  
  local wasm_hash=$(get_wasm_hash "$wasm_path")
  log_info "WASM Hash: $wasm_hash"
  
  # This would invoke soroban to upload - actual implementation depends on contract structure
  soroban contract install \
    --source "$ADMIN_KEYPAIR" \
    --network "$NETWORK" \
    --rpc-url "$SOROBAN_RPC" \
    --wasm "$wasm_path" || log_error "WASM upload failed"
  
  log_success "WASM uploaded to ledger"
  echo "$wasm_hash"
}

# Announce upgrade via admin API
announce_upgrade() {
  local contract_name=$1
  local wasm_hash=$2
  local description="${3:-}"
  
  if [ -z "$API_TOKEN" ]; then
    log_error "API_TOKEN required to announce upgrade"
  fi
  
  log_info "Announcing upgrade for contract: $contract_name"
  
  local payload=$(cat <<EOF
{
  "wasmHash": "$wasm_hash",
  "description": "$description"
}
EOF
)
  
  local response=$(curl -s -X POST \
    "$API_BASE/api/admin/contracts/$contract_name/upgrade" \
    -H "Authorization: Bearer $API_TOKEN" \
    -H "Content-Type: application/json" \
    -d "$payload")
  
  if echo "$response" | grep -q "error"; then
    log_error "Upgrade announcement failed: $response"
  fi
  
  local scheduled_time=$(echo "$response" | grep -o '"scheduledFor":"[^"]*"' | cut -d'"' -f4)
  log_success "Upgrade announced"
  log_info "Scheduled for execution at: $scheduled_time"
  
  echo "$response"
}

# Execute upgrade after timelock
execute_upgrade() {
  local contract_name=$1
  local wasm_hash=$2
  
  if [ -z "$API_TOKEN" ]; then
    log_error "API_TOKEN required to execute upgrade"
  fi
  
  log_info "Checking timelock status for: $contract_name"
  
  # Check if timelock has expired
  local status=$(check_upgrade_status "$contract_name")
  if echo "$status" | grep -q "TimeRemaining"; then
    log_error "Timelock still active, upgrade cannot be executed yet"
  fi
  
  log_info "Executing upgrade..."
  
  local payload=$(cat <<EOF
{
  "wasmHash": "$wasm_hash"
}
EOF
)
  
  local response=$(curl -s -X POST \
    "$API_BASE/api/admin/contracts/$contract_name/upgrade/execute" \
    -H "Authorization: Bearer $API_TOKEN" \
    -H "Content-Type: application/json" \
    -d "$payload")
  
  if echo "$response" | grep -q "error"; then
    log_error "Upgrade execution failed: $response"
  fi
  
  log_success "Upgrade executed successfully"
  echo "$response"
}

# Verify upgrade
verify_upgrade() {
  local contract_id=$1
  
  log_info "Verifying upgrade for contract: $contract_id"
  
  # Would retrieve contract info from Soroban
  soroban contract read \
    --network "$NETWORK" \
    --rpc-url "$SOROBAN_RPC" \
    --contract-id "$contract_id" || log_error "Contract verification failed"
  
  log_success "Contract upgrade verified"
}

# Check upgrade status
check_upgrade_status() {
  local contract_name=$1
  
  if [ -z "$API_TOKEN" ]; then
    log_warning "API_TOKEN not set, cannot check status via API"
    return
  fi
  
  curl -s -X GET \
    "$API_BASE/api/admin/contracts/$contract_name/upgrade/status" \
    -H "Authorization: Bearer $API_TOKEN" \
    -H "Content-Type: application/json"
}

# Show upgrade status
show_status() {
  local contract_name=$1
  
  log_info "Upgrade Status for: $contract_name"
  check_upgrade_status "$contract_name"
}

# Main script logic
main() {
  if [ $# -lt 2 ]; then
    echo "Usage: $0 <action> <contract-name> [options]"
    echo ""
    echo "Actions:"
    echo "  build <contract>        - Build contract WASM"
    echo "  announce <contract>     - Announce upgrade"
    echo "  execute <contract>      - Execute upgrade after timelock"
    echo "  verify <contract>       - Verify upgrade"
    echo "  status <contract>       - Show upgrade status"
    exit 1
  fi
  
  check_prerequisites
  
  local action=$1
  local contract=$2
  shift 2
  
  case "$action" in
    build)
      build_contract "$contract"
      ;;
    announce)
      local wasm_path=$(build_contract "$contract")
      local wasm_hash=$(get_wasm_hash "$wasm_path")
      upload_wasm "$wasm_path" "$contract"
      announce_upgrade "$contract" "$wasm_hash" "$@"
      ;;
    execute)
      # Get the pending wasm hash from status
      local status=$(check_upgrade_status "$contract")
      local wasm_hash=$(echo "$status" | grep -o '"wasmHash":"[^"]*"' | cut -d'"' -f4)
      execute_upgrade "$contract" "$wasm_hash"
      ;;
    verify)
      verify_upgrade "$contract"
      ;;
    status)
      show_status "$contract"
      ;;
    *)
      log_error "Unknown action: $action"
      ;;
  esac
}

main "$@"
