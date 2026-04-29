# Requirements Document

## Introduction

Users can currently view their profile (name, email, phone) in `Profile.jsx` but have no way to update that information. This feature adds an inline edit mode to the Profile page and a corresponding `PUT /api/auth/profile` backend endpoint so users can correct their full name or phone number. Email changes are explicitly out of scope and will be blocked at the API level.

## Glossary

- **Profile_Page**: The `Profile.jsx` React component that displays and edits user profile information.
- **Profile_API**: The `PUT /api/auth/profile` REST endpoint that persists profile changes.
- **Auth_Middleware**: The existing JWT-based middleware (`backend/src/middleware/auth.js`) that authenticates requests.
- **AuthContext**: The React context (`AuthContext.jsx`) that holds the authenticated user object and exposes an update mechanism.
- **Toast**: The `react-hot-toast` notification shown to the user after a save attempt.
- **Edit_Mode**: The UI state in which profile fields become editable input controls.

---

## Requirements

### Requirement 1: Enter and Exit Edit Mode

**User Story:** As a logged-in user, I want to toggle an edit mode on my profile page, so that I can choose when to modify my information without accidentally changing it while browsing.

#### Acceptance Criteria

1. THE Profile_Page SHALL display an "Edit" button when Edit_Mode is inactive.
2. WHEN the user activates Edit_Mode, THE Profile_Page SHALL replace the read-only name and phone display with pre-populated input fields containing the current values.
3. WHEN the user activates Edit_Mode, THE Profile_Page SHALL display a "Cancel" button and a "Save" button.
4. WHEN the user clicks "Cancel", THE Profile_Page SHALL exit Edit_Mode and restore the original field values without making any API call.
5. WHILE Edit_Mode is active, THE Profile_Page SHALL keep the email field read-only and display a note indicating that email changes are not supported.

---

### Requirement 2: Validate Profile Input

**User Story:** As a logged-in user, I want the form to validate my input before submitting, so that I receive immediate feedback on invalid data.

#### Acceptance Criteria

1. WHEN the user attempts to save with an empty full_name field, THE Profile_Page SHALL display an inline validation error and SHALL NOT submit the form.
2. WHEN the user provides a phone value, THE Profile_Page SHALL accept only strings matching the E.164-compatible pattern `^\+?[0-9\s\-().]{7,20}$`.
3. IF the phone value does not match the accepted pattern, THEN THE Profile_Page SHALL display an inline validation error and SHALL NOT submit the form.
4. THE Profile_Page SHALL trim leading and trailing whitespace from full_name before validation and submission.

---

### Requirement 3: Persist Profile Changes via API

**User Story:** As a logged-in user, I want my profile changes saved to the server, so that my updated name and phone number are reflected everywhere in the application.

#### Acceptance Criteria

1. WHEN the user submits valid profile data, THE Profile_Page SHALL send a `PUT` request to `/api/auth/profile` with a JSON body containing `full_name` and `phone`.
2. THE Profile_API SHALL require a valid JWT bearer token; IF the token is absent or invalid, THEN THE Profile_API SHALL return HTTP 401.
3. WHEN a valid request is received, THE Profile_API SHALL update the `full_name` and `phone` columns for the authenticated user in the `users` table.
4. WHEN the update succeeds, THE Profile_API SHALL return HTTP 200 with a JSON body containing the updated `full_name`, `email`, and `phone` fields.
5. IF the request body contains an `email` field, THEN THE Profile_API SHALL ignore it and SHALL NOT modify the user's email.
6. WHEN the `PUT /api/auth/profile` request body fails server-side validation, THE Profile_API SHALL return HTTP 400 with a JSON body describing the validation errors.

---

### Requirement 4: Update Client State After Save

**User Story:** As a logged-in user, I want the profile page to reflect my saved changes immediately, so that I do not need to refresh the page to see the updated information.

#### Acceptance Criteria

1. WHEN THE Profile_API returns HTTP 200, THE AuthContext SHALL update the in-memory user object with the new `full_name` and `phone` values.
2. WHEN THE Profile_API returns HTTP 200, THE Profile_Page SHALL exit Edit_Mode and display the updated values in the read-only view.
3. WHEN THE Profile_API returns HTTP 200, THE Profile_Page SHALL display a success Toast.

---

### Requirement 5: Handle Save Errors

**User Story:** As a logged-in user, I want to be informed when saving my profile fails, so that I can retry or correct my input.

#### Acceptance Criteria

1. IF THE Profile_API returns a non-2xx response, THEN THE Profile_Page SHALL remain in Edit_Mode and SHALL NOT discard the user's input.
2. IF THE Profile_API returns a non-2xx response, THEN THE Profile_Page SHALL display an error Toast containing a human-readable message.
3. IF a network error occurs during the save request, THEN THE Profile_Page SHALL display an error Toast and SHALL remain in Edit_Mode.

---

### Requirement 6: Server-Side Input Validation

**User Story:** As a system operator, I want the API to validate all inputs independently of the client, so that malformed data cannot be persisted through direct API calls.

#### Acceptance Criteria

1. THE Profile_API SHALL reject a request where `full_name` is absent or blank with HTTP 400.
2. THE Profile_API SHALL reject a request where `full_name` exceeds 100 characters with HTTP 400.
3. WHEN `phone` is provided, THE Profile_API SHALL reject values that do not match `^\+?[0-9\s\-().]{7,20}$` with HTTP 400.
4. THE Profile_API SHALL sanitize `full_name` by trimming leading and trailing whitespace before persisting.
