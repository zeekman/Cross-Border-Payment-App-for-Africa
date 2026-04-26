# Requirements Document

## Introduction

The Agent Registration System enables AfriPay users to apply as payout agents who handle fiat distribution to recipients off-chain. Agents are a core part of the escrow-based remittance model: once a sender deposits funds into escrow on Stellar, a registered and approved agent confirms the fiat payout, triggering fund release. This feature adds the agent lifecycle — application, admin approval, and discovery — to the existing AfriPay backend.

## Glossary

- **Agent**: A registered AfriPay user who has been approved to handle fiat payouts in a specific country and currency.
- **Agent_Registration_System**: The backend subsystem responsible for agent applications, approval, and discovery.
- **Admin**: A user with `role = 'admin'` in the AfriPay platform.
- **Applicant**: An authenticated AfriPay user who has submitted an agent registration request.
- **Commission_Rate**: A decimal percentage (e.g., `1.50` for 1.5%) representing the agent's fee for completing a payout.
- **Agent_Status**: The lifecycle state of an agent record. One of: `pending`, `approved`, `rejected`.
- **Country_Code**: An ISO 3166-1 alpha-2 country code (e.g., `NG`, `KE`, `GH`).
- **Currency_Code**: An ISO 4217 currency code (e.g., `NGN`, `KES`, `GHS`).

---

## Requirements

### Requirement 1: Agent Application

**User Story:** As an authenticated user, I want to apply to become a payout agent, so that I can earn commissions by handling fiat payouts in my country.

#### Acceptance Criteria

1. WHEN a POST request is made to `/api/agents/register` with a valid JWT and a body containing `country`, `currency`, and `commission_rate`, THE Agent_Registration_System SHALL create an agent record with `status = 'pending'` and return HTTP 201 with the created agent object.
2. WHEN a POST request is made to `/api/agents/register` and the authenticated user already has an agent record, THE Agent_Registration_System SHALL return HTTP 409 with an error message indicating a duplicate application.
3. WHEN a POST request is made to `/api/agents/register` with a missing or invalid `country` field (not a 2-letter ISO 3166-1 alpha-2 code), THE Agent_Registration_System SHALL return HTTP 400 with a descriptive validation error.
4. WHEN a POST request is made to `/api/agents/register` with a missing or invalid `currency` field (not a 3-letter ISO 4217 code), THE Agent_Registration_System SHALL return HTTP 400 with a descriptive validation error.
5. WHEN a POST request is made to `/api/agents/register` with a `commission_rate` outside the range of 0.00 to 20.00 (inclusive), THE Agent_Registration_System SHALL return HTTP 400 with a descriptive validation error.
6. IF a POST request is made to `/api/agents/register` without a valid JWT, THEN THE Agent_Registration_System SHALL return HTTP 401.

---

### Requirement 2: Agent Discovery

**User Story:** As a sender, I want to browse available agents by country, so that I can select an agent to handle my recipient's fiat payout.

#### Acceptance Criteria

1. WHEN a GET request is made to `/api/agents` with a `country` query parameter, THE Agent_Registration_System SHALL return HTTP 200 with a list of agents whose `status = 'approved'` and `country` matches the provided value.
2. WHEN a GET request is made to `/api/agents` without a `country` query parameter, THE Agent_Registration_System SHALL return HTTP 200 with a list of all agents whose `status = 'approved'`.
3. THE Agent_Registration_System SHALL include `id`, `country`, `currency`, `commission_rate`, and `created_at` in each agent object returned by the listing endpoint, and SHALL NOT include the agent's `user_id` or any personal user data.
4. WHEN a GET request is made to `/api/agents` and no approved agents match the filter, THE Agent_Registration_System SHALL return HTTP 200 with an empty array.

---

### Requirement 3: Admin Agent Approval

**User Story:** As an admin, I want to approve or reject agent applications, so that only vetted users can act as payout agents on the platform.

#### Acceptance Criteria

1. WHEN a PUT request is made to `/api/admin/agents/:id/approve` by an authenticated Admin, THE Agent_Registration_System SHALL update the agent record's `status` to `'approved'` and return HTTP 200 with the updated agent object.
2. WHEN a PUT request is made to `/api/admin/agents/:id/reject` by an authenticated Admin, THE Agent_Registration_System SHALL update the agent record's `status` to `'rejected'` and return HTTP 200 with the updated agent object.
3. WHEN a PUT request is made to `/api/admin/agents/:id/approve` or `/api/admin/agents/:id/reject` and the agent record does not exist, THE Agent_Registration_System SHALL return HTTP 404.
4. WHEN a PUT request is made to `/api/admin/agents/:id/approve` or `/api/admin/agents/:id/reject` and the agent record already has `status = 'approved'` or `status = 'rejected'`, THE Agent_Registration_System SHALL return HTTP 409 with an error indicating the status cannot be changed.
5. IF a PUT request is made to `/api/admin/agents/:id/approve` or `/api/admin/agents/:id/reject` by a user whose `role` is not `'admin'`, THEN THE Agent_Registration_System SHALL return HTTP 403.
6. IF a PUT request is made to `/api/admin/agents/:id/approve` or `/api/admin/agents/:id/reject` without a valid JWT, THEN THE Agent_Registration_System SHALL return HTTP 401.

---

### Requirement 4: Admin Agent Listing

**User Story:** As an admin, I want to view all agent applications with their statuses, so that I can manage the approval queue.

#### Acceptance Criteria

1. WHEN a GET request is made to `/api/admin/agents` by an authenticated Admin, THE Agent_Registration_System SHALL return HTTP 200 with a paginated list of all agent records regardless of status.
2. WHEN a GET request is made to `/api/admin/agents` with a `status` query parameter, THE Agent_Registration_System SHALL return only agent records matching that status value.
3. THE Agent_Registration_System SHALL include `id`, `user_id`, `country`, `currency`, `commission_rate`, `status`, and `created_at` in each agent object returned by the admin listing endpoint.
4. IF a GET request is made to `/api/admin/agents` by a user whose `role` is not `'admin'`, THEN THE Agent_Registration_System SHALL return HTTP 403.

---

### Requirement 5: Database Schema

**User Story:** As a developer, I want a well-structured agents table, so that agent data is stored consistently and can be queried efficiently.

#### Acceptance Criteria

1. THE Agent_Registration_System SHALL store each agent record with the fields: `id` (UUID, primary key), `user_id` (UUID, foreign key to `users.id`), `country` (VARCHAR(2)), `currency` (VARCHAR(3)), `commission_rate` (DECIMAL(5,2)), `status` (VARCHAR(10), default `'pending'`), `created_at` (TIMESTAMPTZ), `updated_at` (TIMESTAMPTZ).
2. THE Agent_Registration_System SHALL enforce a UNIQUE constraint on `user_id` in the `agents` table so that one user can hold at most one agent record.
3. THE Agent_Registration_System SHALL enforce a CHECK constraint on `status` limiting values to `'pending'`, `'approved'`, and `'rejected'`.
4. THE Agent_Registration_System SHALL enforce a CHECK constraint on `commission_rate` limiting values to the range 0.00 to 20.00 inclusive.
5. THE Agent_Registration_System SHALL create an index on `agents(country)` and `agents(status)` to support efficient filtering queries.
