# Soroban contract error codes (BE-220)

Contract failures are translated by `src/utils/sorobanErrors.js` using
`src/config/contractErrors.json`. Responses look like
`{ "error": "<message>", "code": "<CODE>" }`. Raw diagnostics are logged at
`warn` with the request id and never returned.

| HTTP | Code | Endpoints |
|---|---|---|
| 503 | CONTRACT_PAUSED | all contract-backed endpoints |
| 503 | CONTRACT_NOT_INITIALIZED | all contract-backed endpoints |
| 403 | CONTRACT_UNAUTHORIZED | all contract-backed endpoints |
| 409 | CONTRACT_ALREADY_INITIALIZED | admin contract setup |
| 409 | INSUFFICIENT_BALANCE | escrow, fees, loyalty |
| 400 | INVALID_AMOUNT | escrow, fees, loyalty |
| 409 | ESCROW_ALREADY_EXISTS | `POST /api/agents/escrow*` |
| 404 | ESCROW_NOT_FOUND | escrow endpoints, `/api/contracts/escrow/:id/partial-release` |
| 409 | ESCROW_EXPIRED | escrow confirm/release |
| 409 | ESCROW_NOT_PENDING | escrow confirm/cancel/release |
| 409 | ESCROW_NOT_EXPIRED | escrow cancel/refund |
| 403 | KYC_REQUIRED | escrow, KYC attestation |
| 403 | KYC_EXPIRED / KYC_REVOKED | KYC attestation |
| 404 | DISPUTE_NOT_FOUND | dispute endpoints |
| 409 | DISPUTE_ALREADY_EXISTS / DISPUTE_ALREADY_RESOLVED | dispute endpoints |
| 409 | INSUFFICIENT_POOL_BALANCE / NO_FEE_RECIPIENTS | fee distributor |
| 409 | INSUFFICIENT_POINTS | loyalty redeem |
| 502 | CONTRACT_ERROR | any unknown contract failure |
