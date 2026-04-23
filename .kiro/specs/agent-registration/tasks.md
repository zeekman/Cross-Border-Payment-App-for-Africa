# Implementation Plan: Agent Registration

## Overview

Implement the agent lifecycle (application, discovery, admin approval) on the existing Node.js/Express backend. The work follows the established controller/route/middleware pattern and adds one new migration, one controller, two route files, and mounts them in `app.js`.

## Tasks

- [ ] 1. Create the agents table migration
  - Create `database/migrations/005_add_agents_table.js` using node-pg-migrate style (matching `002_kyc_verification.js`)
  - `exports.up` creates the `agents` table with columns: `id` (UUID PK), `user_id` (UUID FK → users.id ON DELETE CASCADE), `country` (VARCHAR(2)), `currency` (VARCHAR(3)), `commission_rate` (DECIMAL(5,2)), `status` (VARCHAR(10) DEFAULT 'pending'), `created_at` (TIMESTAMPTZ DEFAULT NOW()), `updated_at` (TIMESTAMPTZ DEFAULT NOW())
  - Add CHECK constraint: `status IN ('pending', 'approved', 'rejected')`
  - Add CHECK constraint: `commission_rate >= 0.00 AND commission_rate <= 20.00`
  - Add UNIQUE constraint on `user_id`
  - Create indexes `idx_agents_country` on `agents(country)` and `idx_agents_status` on `agents(status)`
  - `exports.down` drops the table
  - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5_

- [ ] 2. Implement `agentController.js`
  - [ ] 2.1 Implement `registerAgent`
    - Create `backend/src/controllers/agentController.js`
    - Query for existing agent row by `req.user.userId`; return 409 `{ error: 'Agent application already exists' }` if found
    - INSERT new agent row with `status = 'pending'`; return 201 with the created agent object (all columns)
    - _Requirements: 1.1, 1.2_

  - [ ]* 2.2 Write property test for `registerAgent` — Property 1 & 2
    - File: `backend/src/__tests__/agentRegistration.property.test.js`
    - **Property 1: Registration creates a pending agent** — generate valid `{ country, currency, commission_rate }` via fast-check; assert 201 and `status = 'pending'`
    - **Property 2: Duplicate registration is rejected** — call register twice for same user; assert second call returns 409 and DB has exactly one row
    - **Validates: Requirements 1.1, 1.2**

  - [ ] 2.3 Implement `listAgents`
    - SELECT `id, country, currency, commission_rate, created_at` WHERE `status = 'approved'`
    - If `req.query.country` is present, add `AND country = $n` (uppercased)
    - Return 200 with array (empty array when no matches)
    - _Requirements: 2.1, 2.2, 2.3, 2.4_

  - [ ]* 2.4 Write property test for `listAgents` — Property 6 & 7
    - **Property 6: Public listing returns only approved agents, filtered by country when provided**
    - **Property 7: Public listing response excludes user_id and personal data**
    - **Validates: Requirements 2.1, 2.2, 2.3**

  - [ ] 2.5 Implement `adminListAgents`
    - SELECT `id, user_id, country, currency, commission_rate, status, created_at` from agents
    - Support optional `req.query.status` filter
    - Support pagination via `page` / `limit` query params (default limit 20, max 100)
    - Return `{ data, total, page, limit }`
    - _Requirements: 4.1, 4.2, 4.3_

  - [ ]* 2.6 Write property test for `adminListAgents` — Property 10 & 11
    - **Property 10: Admin listing returns all agents with optional status filter**
    - **Property 11: Admin listing response includes all required fields**
    - **Validates: Requirements 4.1, 4.2, 4.3**

  - [ ] 2.7 Implement `approveAgent` and `rejectAgent`
    - Both handlers: SELECT agent by `req.params.id`; return 404 `{ error: 'Agent not found' }` if missing
    - If `status` is already `'approved'` or `'rejected'`, return 409 `{ error: 'Agent status cannot be changed' }`
    - UPDATE `status` (and `updated_at = NOW()`) to `'approved'` or `'rejected'` respectively; return 200 with updated admin agent object
    - _Requirements: 3.1, 3.2, 3.3, 3.4_

  - [ ]* 2.8 Write property test for `approveAgent`/`rejectAgent` — Property 8 & 9
    - **Property 8: Admin status transition is correct** — pending agent → approve sets 'approved'; pending agent → reject sets 'rejected'
    - **Property 9: Already-decided agent cannot be re-decided** — approved or rejected agent → PUT returns 409, status unchanged
    - **Validates: Requirements 3.1, 3.2, 3.4**

- [ ] 3. Checkpoint — Ensure all controller logic and property tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 4. Create route files and wire validation
  - [ ] 4.1 Create `backend/src/routes/agents.js`
    - Mount at `/api/agents` (done in step 5)
    - `POST /register` — `auth` middleware, express-validator rules for `country` (2-letter alpha, toUpperCase), `currency` (3-letter alpha, toUpperCase), `commission_rate` (float 0–20), then `registerAgent`
    - `GET /` — no auth, `listAgents`
    - Use the same `validate` helper pattern as existing route files (collect `validationResult` errors and return 400)
    - _Requirements: 1.1, 1.3, 1.4, 1.5, 1.6, 2.1, 2.2_

  - [ ] 4.2 Create `backend/src/routes/adminAgents.js`
    - Apply `router.use(auth, isAdmin)` at the top of the router (same pattern as existing admin routes)
    - `GET /agents` → `adminListAgents`
    - `PUT /agents/:id/approve` → `approveAgent`
    - `PUT /agents/:id/reject` → `rejectAgent`
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 4.1, 4.2, 4.3, 4.4_

- [ ] 5. Mount new routes in `app.js`
  - Require `./routes/agents` and `./routes/adminAgents` in `backend/src/app.js`
  - Add `app.use('/api/agents', agentRoutes)` after existing route mounts
  - Add `app.use('/api/admin', adminAgentRoutes)` after the existing `app.use('/api/admin', adminRoutes)` line
  - _Requirements: 1.1, 2.1, 3.1, 4.1_

- [ ] 6. Write integration tests
  - [ ]* 6.1 Write integration tests for agent registration endpoint
    - File: `backend/tests/agents.test.js`
    - Cover: 201 on valid input, 409 on duplicate, 400 for each invalid field (country, currency, commission_rate), 401 without JWT
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6_

  - [ ]* 6.2 Write integration tests for public agent listing
    - Cover: 200 with approved agents only, country filter, empty array when no matches, `user_id` absent from response
    - _Requirements: 2.1, 2.2, 2.3, 2.4_

  - [ ]* 6.3 Write integration tests for admin approval/rejection endpoints
    - Cover: 200 on approve/reject of pending agent, 404 for missing agent, 409 for already-decided agent, 403 for non-admin, 401 without JWT
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6_

  - [ ]* 6.4 Write integration tests for admin agent listing
    - Cover: paginated list of all agents, status filter for each value, required fields present, 403 for non-admin
    - _Requirements: 4.1, 4.2, 4.3, 4.4_

- [ ] 7. Final checkpoint — Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for a faster MVP
- Property tests live in `backend/src/__tests__/agentRegistration.property.test.js`; install fast-check with `npm install --save-dev fast-check` if not already present
- Integration tests follow the pattern in `backend/tests/auth.test.js`
- Each task references specific requirements for traceability
