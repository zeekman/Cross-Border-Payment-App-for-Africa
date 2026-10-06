import api from './client';

/**
 * Authenticate a user with email and password.
 *
 * @param {{ email: string, password: string }} credentials
 * @returns {Promise<object>} The login response (may indicate a 2FA challenge).
 */
export async function login({ email, password }) {
  const { data } = await api.post('/auth/login', { email, password });
  return data;
}

/**
 * Complete a 2FA challenge during login.
 *
 * The backend accepts either a TOTP code (`totp_code`) or a backup code
 * (`backup_code`) as an alternative. When a backup code is supplied the
 * backend marks it as used and returns the number of remaining codes.
 *
 * @param {{ challengeToken?: string, totpCode?: string, backupCode?: string }} params
 * @returns {Promise<object>} The verified login response.
 */
export async function verifyTwoFactor({ challengeToken, totpCode, backupCode } = {}) {
  const payload = {};

  if (challengeToken) {
    payload.challenge_token = challengeToken;
  }

  if (backupCode) {
    payload.backup_code = backupCode;
  } else if (totpCode) {
    payload.totp_code = totpCode;
  }

  const { data } = await api.post('/auth/2fa/verify', payload);
  return data;
}

export default {
  login,
  verifyTwoFactor,
};
