# Implementation Plan: Profile Edit

## Overview

Implement inline profile editing on `Profile.jsx` with a new `PUT /api/auth/profile` backend endpoint. Changes touch four files: `authController.js`, `auth.js` (routes), `AuthContext.jsx`, and `Profile.jsx`.

## Tasks

- [ ] 1. Add `updateProfile` controller function to `backend/src/controllers/authController.js`
  - Add an `updateProfile` async function that reads `req.user.userId`, trims `full_name`, runs `UPDATE users SET full_name = $1, phone = $2 WHERE id = $3 RETURNING full_name, email, phone`, and returns HTTP 200 with the updated fields
  - Do not read `email` from the request body
  - Export `updateProfile` alongside the existing exports
  - _Requirements: 3.3, 3.4, 3.5, 6.4_

  - [ ]* 1.1 Write unit tests for `updateProfile` in `backend/tests/auth.test.js`
    - Test successful update returns 200 with `full_name`, `email`, `phone`
    - Test that an `email` field in the body is ignored and the DB email is unchanged
    - Test that `full_name` is trimmed before persisting
    - _Requirements: 3.3, 3.4, 3.5, 6.4_

  - [ ]* 1.2 Write property test for `updateProfile` — Property 9: Profile update round-trip
    - **Property 9: Profile update round-trip**
    - **Validates: Requirements 3.3, 3.4**
    - Use `fc.record({ full_name: fc.string({minLength:1, maxLength:100}), phone: validPhoneArb })` — PUT then GET `/auth/me` returns the same values

  - [ ]* 1.3 Write property test for `updateProfile` — Property 10: Email field is ignored by the API
    - **Property 10: Email field is ignored by the API**
    - **Validates: Requirements 3.5**
    - Include an arbitrary `email` field in the PUT body; assert DB email is unchanged after the request

  - [ ]* 1.4 Write property test for `updateProfile` — Property 12: API trims full_name before persisting
    - **Property 12: API trims full_name before persisting**
    - **Validates: Requirements 6.4**
    - Generate names with leading/trailing whitespace; assert stored and returned value equals `input.trim()`

- [ ] 2. Register `PUT /profile` route in `backend/src/routes/auth.js`
  - Import `updateProfile` from `authController`
  - Add `router.put('/profile', authMiddleware, [...validators], validate, updateProfile)` with `express-validator` rules: `full_name` trim + notEmpty + maxLength(100); `phone` optional + matches phone regex
  - _Requirements: 3.1, 3.2, 6.1, 6.2, 6.3_

  - [ ]* 2.1 Write property test for route validation — Property 8: API rejects unauthenticated requests
    - **Property 8: API rejects unauthenticated requests**
    - **Validates: Requirements 3.2**
    - For any PUT to `/api/auth/profile` without a token or with an invalid token, assert HTTP 401

  - [ ]* 2.2 Write property test for route validation — Property 11: API rejects invalid inputs with HTTP 400
    - **Property 11: API rejects invalid inputs with HTTP 400**
    - **Validates: Requirements 3.6, 6.1, 6.2, 6.3**
    - Generate blank names, names > 100 chars, and phone strings not matching the regex; assert HTTP 400 with error body

- [ ] 3. Checkpoint — Ensure all backend tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 4. Add `updateUser` to `frontend/src/context/AuthContext.jsx`
  - Add `const updateUser = (patch) => setUser(prev => ({ ...prev, ...patch }));` inside `AuthProvider`
  - Expose `updateUser` in the context value object
  - _Requirements: 4.1_

  - [ ]* 4.1 Write unit test for `updateUser` in `frontend/src/context/AuthContext.test.jsx`
    - Test that calling `updateUser({ full_name: 'New Name' })` merges the patch into the existing user state without discarding other fields
    - _Requirements: 4.1_

- [ ] 5. Implement edit mode UI and form logic in `frontend/src/pages/Profile.jsx`
  - Add state variables: `isEditing`, `formData` (`{full_name, phone}`), `formErrors` (`{full_name?, phone?}`), `saving`
  - Implement `handleEdit()` — sets `isEditing = true`, copies `user.full_name` / `user.phone` into `formData`
  - Implement `handleCancel()` — sets `isEditing = false`, clears `formErrors`
  - Implement `validateForm()` — trims `full_name`, checks non-empty and max 100 chars; validates phone regex if provided; populates `formErrors` and returns `false` on failure
  - Implement `handleSave()` — calls `validateForm()`, sends `PUT /api/auth/profile`, calls `updateUser()`, exits edit mode, shows success toast on 200; on error stays in edit mode and shows error toast
  - Render the user info card conditionally: show read-only view + "Edit" button when `!isEditing`; show controlled inputs + "Cancel"/"Save" buttons when `isEditing`
  - Keep the email field read-only in both modes; display a note that email changes are not supported when in edit mode
  - Disable the "Save" button while `saving` is true
  - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 2.1, 2.2, 2.3, 2.4, 3.1, 4.2, 4.3, 5.1, 5.2, 5.3_

  - [ ]* 5.1 Write unit tests for Profile edit mode in `frontend/src/pages/Profile.test.jsx`
    - "Edit" button present in read-only mode, no inputs visible
    - Clicking "Edit" shows pre-populated inputs, "Cancel" and "Save" buttons
    - Clicking "Cancel" restores original values and makes no API call
    - Submitting with empty `full_name` shows inline error, does not call API
    - Submitting with whitespace-only `full_name` shows inline error
    - Submitting with invalid phone shows inline error
    - Successful save: toast shown, edit mode exited, updated values displayed
    - API error: toast shown, edit mode preserved, input preserved
    - Email field is read-only and note is visible in edit mode
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 2.1, 2.3, 4.2, 4.3, 5.1, 5.2_

  - [ ]* 5.2 Write property test — Property 1: Edit mode pre-populates current values
    - **Property 1: Edit mode pre-populates current values**
    - **Validates: Requirements 1.2**
    - For any `full_name` and `phone`, entering edit mode should set input values to exactly those values

  - [ ]* 5.3 Write property test — Property 2: Cancel is a no-op round-trip
    - **Property 2: Cancel is a no-op round-trip**
    - **Validates: Requirements 1.4**
    - For any arbitrary modifications to form inputs, clicking Cancel restores original values and makes zero API calls

  - [ ]* 5.4 Write property test — Property 3: Email is always read-only in edit mode
    - **Property 3: Email is always read-only in edit mode**
    - **Validates: Requirements 1.5**
    - For any user, while in edit mode the email input is read-only/disabled and the note is visible

  - [ ]* 5.5 Write property test — Property 4: Blank full_name is rejected client-side
    - **Property 4: Blank full_name is rejected client-side**
    - **Validates: Requirements 2.1**
    - Use `fc.stringOf(fc.constantFrom(' ', '\t', '\n'))` — `validateForm()` returns false and `formErrors.full_name` is set; no API call is made

  - [ ]* 5.6 Write property test — Property 5: Invalid phone format is rejected client-side
    - **Property 5: Invalid phone format is rejected client-side**
    - **Validates: Requirements 2.2, 2.3**
    - For strings not matching `^\+?[0-9\s\-(). ]{7,20}$`, `validateForm()` returns false; for matching strings it returns true

  - [ ]* 5.7 Write property test — Property 6: full_name is trimmed before submission
    - **Property 6: full_name is trimmed before submission**
    - **Validates: Requirements 2.4**
    - For any `full_name` with leading/trailing whitespace, the PUT request body `full_name` equals `input.trim()`

  - [ ]* 5.8 Write property test — Property 7: Valid data triggers the correct API call
    - **Property 7: Valid data triggers the correct API call**
    - **Validates: Requirements 3.1**
    - For any valid `full_name` and `phone`, submitting results in exactly one PUT to `/api/auth/profile` with the correct trimmed body

  - [ ]* 5.9 Write property test — Property 13: Successful save updates context and exits edit mode
    - **Property 13: Successful save updates context and exits edit mode**
    - **Validates: Requirements 4.1, 4.2**
    - For any HTTP 200 response, `isEditing` becomes false and the read-only view shows the updated values

  - [ ]* 5.10 Write property test — Property 14: Errors preserve edit state and show toast
    - **Property 14: Errors preserve edit state and show toast**
    - **Validates: Requirements 5.1, 5.2, 5.3**
    - For any non-2xx status or network error, `isEditing` remains true and `formData` is unchanged

- [ ] 6. Final checkpoint — Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Property tests use `fast-check` with `@fast-check/jest`; each test must include a comment: `// Feature: profile-edit, Property N: <title>`
- The `email` field is never read from the PUT request body — it is silently ignored server-side and rendered read-only client-side
- No database migration is needed; `full_name`, `phone`, and `updated_at` columns already exist
