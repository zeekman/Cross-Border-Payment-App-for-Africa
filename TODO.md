# ESLint + Prettier Implementation TODO

## Plan Steps (from approved plan):

### 1. Create Git Branch ✅ (done: feat/eslint-prettier)


- [x] Create `backend/.eslintrc.js` ✅
- [x] Create `backend/.prettierrc` ✅
- [x] Update `backend/package.json` scripts (lint, lint:fix, format, format:check) ✅
- [ ] Run `npm run lint:fix && npm run format` 
- [ ] Verify: `npm run lint && npm run format:check`

### 3. Frontend Setup
- [x] Install ESLint + Airbnb + React + Prettier deps (`cd frontend && npm i eslint-config-airbnb eslint-plugin-react eslint-plugin-react-hooks eslint-plugin-jsx-a11y eslint-plugin-import prettier eslint-config-prettier eslint-plugin-prettier --save-dev --legacy-peer-deps`) ✅ (installing)
- [x] Create `frontend/.eslintrc.js` ✅
- [x] Create `frontend/.prettierrc` ✅
- [x] Update `frontend/package.json` scripts ✅
- [ ] Run `npm run lint:fix && npm run format`
- [ ] Verify: `npm run lint && npm run format:check`

### 4. Finalize
- [ ] `git add . && git commit -m \"feat: add ESLint+Airbnb and Prettier, fix all issues\"`
- [ ] Check/add lint to CI workflows (if .github/workflows/ exist)
- [ ] Update this TODO with completions
- [ ] Open PR

Next: Wait for backend install complete, then create configs.

