# Swagger API Documentation TODO

## Plan Steps:
1. [x] Update backend/package.json: Add swagger-jsdoc and swagger-ui-express dependencies
2. [x] Update backend/src/app.js: Configure and mount Swagger UI at /api/docs
3. [ ] Add @swagger JSDoc comments to backend/src/routes/admin.js
4. [ ] Add @swagger JSDoc comments to backend/src/routes/analytics.js
5. [ ] Add @swagger JSDoc comments to backend/src/routes/anchor.js
6. [ ] Add @swagger JSDoc comments to backend/src/routes/auth.js
7. [ ] Add @swagger JSDoc comments to backend/src/routes/dev.js
8. [ ] Add @swagger JSDoc comments to backend/src/routes/kyc.js
9. [ ] Add @swagger JSDoc comments to backend/src/routes/notifications.js
10. [ ] Add @swagger JSDoc comments to backend/src/routes/paymentRequests.js
11. [ ] Add @swagger JSDoc comments to backend/src/routes/payments.js
12. [ ] Add @swagger JSDoc comments to backend/src/routes/scheduledPayments.js
13. [ ] Add @swagger JSDoc comments to backend/src/routes/sep10.js
14. [ ] Add @swagger JSDoc comments to backend/src/routes/sep31.js
15. [ ] Add @swagger JSDoc comments to backend/src/routes/stellarToml.js
16. [ ] Add @swagger JSDoc comments to backend/src/routes/wallet.js
17. [ ] Add @swagger JSDoc comments to backend/src/routes/webhooks.js
18. [ ] Update README.md: Add link to /api/docs
19. [ ] cd backend && npm install
20. [ ] Test: npm run dev && visit http://localhost:5000/api/docs
21. [ ] Run lint/tests: cd backend && npm run lint && npm test

Current progress: Starting step 1.


---

## Deprecation Removal TODO

### GET /api/wallet/transactions (issue #270)

- **Status**: Deprecated as of 2025-04-27
- **Replacement**: `GET /api/payments/history`
- **Sunset date**: 2026-01-01
- **Deprecation headers set**: `Deprecation: true`, `Link: </api/payments/history>; rel="successor-version"`, `Sunset`
- **Swagger**: marked `deprecated: true` in `backend/src/routes/wallet.js`
- [ ] **Remove** `GET /api/wallet/transactions` route from `backend/src/routes/wallet.js`
- [ ] **Remove** `getWalletTransactions` from `backend/src/controllers/walletController.js`
- [ ] **Remove** `getWalletTransactions` export from `walletController.js`
- [ ] Verify no frontend code references `/wallet/transactions`
- [ ] Update this TODO entry to mark removal complete
