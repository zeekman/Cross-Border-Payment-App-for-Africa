#!/bin/bash
# Soroban Contract Upgrade Script
#
# Drives the ON-CHAIN timelocked upgrade flow (SC-172 / SC-173) that every
# contract exposes via its `governance` module:
#   1. build    — build the new contract WASM
#   2. propose  — upload the WASM and call propose_upgrade (starts 48h timelock)
#   3. status   — show get_pending_upgrade / get_contract_version
#   4. execute  — call execute_upgrade (panics on-chain before eta), then migrate
#   5. cancel   — call cancel_upgrade
#
# Usage: ./upgrade.sh <action> <contract-name>
#   Contracts: escrow | agent-escrow | dispute-resolution | fee-distributor |
#              kyc-attestation | loyalty-token | multisig-approval |
#              recurring-payments | savings-vault
#
# Required env: SOROBAN_ADMIN_KEYPAIR (identity/secret), ADMIN_ADDRESS.
# Contract IDs are read from <NAME>_CONTRACT_ID (env or contracts/.env, as
# written by deploy.sh).

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
NC='\033[0m'

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONTRACTS_DIR="$(dirname "$SCRIPT_DIR")"
NETWORK="${STELLAR_NETWORK:-testnet}"
CLI="${SOROBAN_CLI:-stellar}"
VALID_CONTRACTS="escrow agent-escrow dispute-resolution fee-distributor kyc-attestation loyalty-token multisig-approval recurring-payments savings-vault"

log_info() { echo -e "${BLUE}[INFO]${NC} $1" >&2; }
log_success() { echo -e "${GREEN}[SUCCESS]${NC} $1" >&2; }
log_error() { echo -e "${RED}[ERROR]${NC} $1" >&2; exit 1; }

check_prerequisites() {
  command -v "$CLI" >/dev/null 2>&1 || log_error "$CLI CLI not found (set SOROBAN_CLI)"
  [ -n "${SOROBAN_ADMIN_KEYPAIR:-}" ] || log_error "SOROBAN_ADMIN_KEYPAIR not set"
  [ -n "${ADMIN_ADDRESS:-}" ] || log_error "ADMIN_ADDRESS not set"
}

contract_id() {
  local var
  var="$(echo "$1" | tr '[:lower:]-' '[:upper:]_')_CONTRACT_ID"
  if [ -z "${!var:-}" ] && [ -f "$CONTRACTS_DIR/.env" ]; then
    # shellcheck disable=SC1091
    set -a; . "$CONTRACTS_DIR/.env"; set +a
  fi
  [ -n "${!var:-}" ] || log_error "$var not set (env or contracts/.env)"
  echo "${!var}"
}

invoke() {
  local id=$1; shift
  "$CLI" contract invoke --id "$id" --source "$SOROBAN_ADMIN_KEYPAIR" --network "$NETWORK" -- "$@"
}

build_contract() {
  local dir="$CONTRACTS_DIR/$1"
  [ -d "$dir" ] || log_error "Contract directory not found: $dir"
  log_info "Building contract: $1"
  (cd "$dir" && cargo build --target wasm32-unknown-unknown --release >&2)
  local wasm
  wasm=$(ls "$dir"/target/wasm32-unknown-unknown/release/*.wasm 2>/dev/null | head -1)
  [ -f "$wasm" ] || log_error "WASM build failed for $1"
  log_success "Contract built: $wasm"
  echo "$wasm"
}

main() {
  if [ $# -lt 2 ]; then
    echo "Usage: $0 <build|propose|status|execute|cancel> <contract-name>"
    echo "Contracts: $VALID_CONTRACTS"
    exit 1
  fi
  local action=$1 contract=$2
  [[ " $VALID_CONTRACTS " == *" $contract "* ]] || log_error "Unknown contract: $contract"

  if [ "$action" = "build" ]; then
    build_contract "$contract"
    return
  fi

  check_prerequisites
  local id
  id=$(contract_id "$contract")

  case "$action" in
    propose|announce)
      local wasm hash
      wasm=$(build_contract "$contract")
      log_info "Uploading WASM..."
      hash=$("$CLI" contract upload --source "$SOROBAN_ADMIN_KEYPAIR" --network "$NETWORK" --wasm "$wasm" | tail -1)
      log_info "WASM hash: $hash"
      invoke "$id" propose_upgrade --admin "$ADMIN_ADDRESS" --new_wasm_hash "$hash"
      log_success "Upgrade proposed; executable after the 48h on-chain timelock (eta above)"
      ;;
    status)
      invoke "$id" get_pending_upgrade
      invoke "$id" get_contract_version
      ;;
    execute)
      # execute_upgrade only schedules the WASM swap (it takes effect after the
      # invocation ends) and emits no version. migrate must run in the SAME
      # deployment run so the new code's per-version steps execute and the
      # on-chain ContractVersion is advanced.
      invoke "$id" execute_upgrade --admin "$ADMIN_ADDRESS"
      log_info "Running migrate in the new code..."
      invoke "$id" migrate --admin "$ADMIN_ADDRESS"
      local version
      version=$(invoke "$id" get_contract_version | tail -1)
      log_info "On-chain contract version after migrate: $version"
      log_success "Upgrade executed and migrated"
      ;;
    cancel)
      invoke "$id" cancel_upgrade --admin "$ADMIN_ADDRESS"
      log_success "Pending upgrade cancelled"
      ;;
    *)
      log_error "Unknown action: $action"
      ;;
  esac
}

main "$@"
