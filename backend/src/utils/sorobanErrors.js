/**
 * BE-220: translate Soroban contract failures into stable API error codes.
 *
 * Extracts `Error(Contract, #N)` or a panic string from an SDK error /
 * simulation response and maps it via config/contractErrors.json.
 * Unknown contract failures become 502 CONTRACT_ERROR with no internal text.
 */
const table = require('../config/contractErrors.json');

const CONTRACT_CODE_RE = /Error\(Contract,\s*#(\d+)\)/i;
const SOROBAN_HINT_RE = /HostError|Error\((WasmVm|Contract|Context|Storage|Auth|Budget|Value|Object|Crypto|Events)|simulat|contract|soroban|Transaction failed|errorResult/i;

function collectText(input) {
  if (input == null) return '';
  if (typeof input === 'string') return input;
  const parts = [input.message, input.error, input.errorResult, input.resultXdr];
  const diag = input.events || input.diagnosticEvents || input.simulation?.events;
  if (Array.isArray(diag)) {
    for (const e of diag) parts.push(typeof e === 'string' ? e : safeStringify(e));
  }
  if (input.response?.data) parts.push(safeStringify(input.response.data));
  return parts.filter(Boolean).map(String).join(' | ');
}

function safeStringify(v) {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/** Is this error plausibly a Soroban/contract failure? */
function isSorobanError(err) {
  if (!err) return false;
  if (err.contractError || err.sorobanError) return true;
  return SOROBAN_HINT_RE.test(collectText(err));
}

function matchPanics(panics, lower) {
  if (!panics) return null;
  // Longest keys first so specific messages win over generic ones
  const keys = Object.keys(panics).sort((a, b) => b.length - a.length);
  const hit = keys.find((k) => lower.includes(k));
  return hit ? panics[hit] : null;
}

/**
 * @param {Error|object|string} err
 * @param {string} [contract] key in contractErrors.json (e.g. 'agentEscrow')
 * @returns {{ http: number, code: string, message: string, raw: string }}
 */
function mapSorobanError(err, contract) {
  const raw = collectText(err);
  const lower = raw.toLowerCase();
  const contracts = contract ? [contract] : Object.keys(table).filter((k) => !k.startsWith('_') && k !== 'common');

  const codeMatch = raw.match(CONTRACT_CODE_RE);
  if (codeMatch && contract && table[contract]?.codes?.[codeMatch[1]]) {
    return { ...table[contract].codes[codeMatch[1]], raw };
  }

  for (const c of contracts) {
    const m = matchPanics(table[c]?.panics, lower);
    if (m) return { ...m, raw };
  }
  const common = matchPanics(table.common.panics, lower);
  if (common) return { ...common, raw };

  return { http: 502, code: 'CONTRACT_ERROR', message: 'The contract call failed', raw };
}

/** Wrap a contract error so it carries status/code for the error handler. */
function toApiError(err, contract) {
  const m = mapSorobanError(err, contract);
  return Object.assign(new Error(m.message), {
    status: m.http,
    code: m.code,
    contractError: true,
    rawDiagnostic: m.raw,
  });
}

module.exports = { mapSorobanError, toApiError, isSorobanError };
