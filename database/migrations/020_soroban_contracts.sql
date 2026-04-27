-- Migration: Add contract events table for Soroban contract event indexing
-- Stores indexed events from Soroban contracts for fast querying and display

CREATE TABLE IF NOT EXISTS contract_events (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  contract_id         VARCHAR(56) NOT NULL,
  contract_name       VARCHAR(100),
  event_type          VARCHAR(100) NOT NULL,
  event_data          JSONB NOT NULL,
  ledger_sequence     BIGINT NOT NULL,
  ledger_close_time   TIMESTAMPTZ,
  transaction_hash    VARCHAR(64),
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  indexed_at          TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for efficient querying
CREATE INDEX idx_contract_events_contract_id ON contract_events(contract_id);
CREATE INDEX idx_contract_events_event_type ON contract_events(event_type);
CREATE INDEX idx_contract_events_ledger_sequence ON contract_events(ledger_sequence);
CREATE INDEX idx_contract_events_created_at ON contract_events(created_at DESC);
CREATE INDEX idx_contract_events_indexed_at ON contract_events(indexed_at DESC);

-- Composite index for common queries
CREATE INDEX idx_contract_events_contract_type ON contract_events(contract_id, event_type, created_at DESC);

-- Add tracking for event indexing progress
CREATE TABLE IF NOT EXISTS contract_event_indexer_state (
  id                      UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  contract_id             VARCHAR(56) NOT NULL UNIQUE,
  last_indexed_ledger     BIGINT NOT NULL DEFAULT 0,
  gaps                    JSONB DEFAULT '[]'::jsonb,
  last_update             TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(contract_id)
);

-- Index for state lookup
CREATE INDEX idx_indexer_state_contract_id ON contract_event_indexer_state(contract_id);

-- Add table for contract upgrade timelock tracking
CREATE TABLE IF NOT EXISTS contract_upgrades (
  id                      UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  contract_id             VARCHAR(56) NOT NULL,
  contract_name           VARCHAR(100),
  old_wasm_hash           VARCHAR(64),
  new_wasm_hash           VARCHAR(64) NOT NULL,
  status                  VARCHAR(20) DEFAULT 'announced' CHECK (status IN ('announced', 'scheduled', 'executed', 'cancelled')),
  announced_at            TIMESTAMPTZ NOT NULL,
  scheduled_for           TIMESTAMPTZ NOT NULL,
  executed_at             TIMESTAMPTZ,
  description             TEXT,
  event_ledger_sequence   BIGINT,
  created_at              TIMESTAMPTZ DEFAULT NOW(),
  updated_at              TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for upgrade tracking
CREATE INDEX idx_contract_upgrades_contract_id ON contract_upgrades(contract_id);
CREATE INDEX idx_contract_upgrades_status ON contract_upgrades(status);
CREATE INDEX idx_contract_upgrades_scheduled_for ON contract_upgrades(scheduled_for);
CREATE INDEX idx_contract_upgrades_created_at ON contract_upgrades(created_at DESC);
