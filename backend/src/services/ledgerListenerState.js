'use strict';

/**
 * Shared liveness state for the ledger listener (BE-198).
 *
 * `ledgerListener.js` writes it (on stream events and caught-up polls) and
 * `health.js` reads it for `/health/deep`. It lives in its own dependency-free
 * module so neither side has to import the other (the listener pulls in the
 * Horizon SDK, the database and the cache; health pulls in half the app).
 */

const state = {
  startedAt: null,
  lastEventAt: null,
  lastLedgerSequence: null,
  horizonLatestLedger: null,
  lagLedgers: null,
  sampledAt: null,
};

const isNumber = (value) => typeof value === 'number' && Number.isFinite(value);

function applyDetails(info = {}) {
  // The highest ledger seen on any stream; streams can interleave out of order.
  if (isNumber(info.lastLedgerSequence)) {
    state.lastLedgerSequence = Math.max(state.lastLedgerSequence ?? 0, info.lastLedgerSequence);
  }
  if (isNumber(info.horizonLatestLedger)) state.horizonLatestLedger = info.horizonLatestLedger;
  if (isNumber(info.lagLedgers)) state.lagLedgers = info.lagLedgers;
  if (isNumber(info.sampledAt)) state.sampledAt = info.sampledAt;
}

/** The listener was started: lets health report `degraded` if it never produces an event. */
function markLedgerListenerStarted(ts = Date.now()) {
  state.startedAt = ts;
}

/** Proof of life: a stream message arrived, or a poll found the stream fully caught up. */
function setLastLedgerEvent(ts = Date.now(), info = {}) {
  state.lastEventAt = ts;
  applyDetails(info);
}

/** Update lag details from a poll without counting it as proof of life. */
function updateLedgerDetails(info) {
  applyDetails(info);
}

function getLedgerListenerState() {
  return { ...state };
}

function resetLedgerListenerState() {
  state.startedAt = null;
  state.lastEventAt = null;
  state.lastLedgerSequence = null;
  state.horizonLatestLedger = null;
  state.lagLedgers = null;
  state.sampledAt = null;
}

module.exports = {
  markLedgerListenerStarted,
  setLastLedgerEvent,
  updateLedgerDetails,
  getLedgerListenerState,
  resetLedgerListenerState,
};
