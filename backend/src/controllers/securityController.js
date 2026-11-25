const db = require('../db');
const audit = require('../services/audit');
const webauthn = require('../services/webauthn');
const { saveAvatar, deleteAvatar } = require('../services/avatarStorage');
const { PIN_POLICY } = require('../services/pin');
const { issueStepUpToken } = require('../utils/stepUp');

function getPinPolicy(req, res) {
  res.json(PIN_POLICY);
}

async function webauthnRegisterOptions(req, res, next) {
  try {
    const { rows } = await db.query('SELECT id, email FROM users WHERE id = $1', [req.user.userId]);
    if (!rows[0]) return res.status(404).json({ error: 'User not found' });
    res.json(await webauthn.registrationOptions(rows[0]));
  } catch (err) {
    next(err);
  }
}

async function webauthnRegister(req, res, next) {
  try {
    const result = await webauthn.verifyRegistration(req.user.userId, req.body);
    if (!result.ok) return res.status(400).json({ error: result.error });
    audit.log(req.user.userId, 'webauthn_registered', req.ip, req.headers['user-agent']);
    res.status(201).json({ message: 'Biometric credential registered' });
  } catch (err) {
    next(err);
  }
}

async function webauthnStepUpOptions(req, res, next) {
  try {
    const options = await webauthn.stepUpOptions(req.user.userId, req.body?.transaction);
    if (!options) return res.status(404).json({ error: 'No biometric credential registered' });
    res.json(options);
  } catch (err) {
    next(err);
  }
}

async function webauthnStepUpVerify(req, res, next) {
  try {
    const { assertion, transaction } = req.body || {};
    const result = await webauthn.verifyStepUp(req.user.userId, assertion, transaction);
    if (!result.ok) {
      audit.log(req.user.userId, 'step_up_webauthn_failed', req.ip, req.headers['user-agent']);
      return res.status(401).json({ error: result.error });
    }
    audit.log(req.user.userId, 'step_up_webauthn', req.ip, req.headers['user-agent']);
    res.json({ step_up_token: issueStepUpToken(req.user.userId, 'webauthn') });
  } catch (err) {
    next(err);
  }
}

async function uploadAvatar(req, res, next) {
  try {
    if (!req.file) return res.status(400).json({ error: 'No image uploaded' });
    let avatarUrl;
    try {
      avatarUrl = await saveAvatar(req.file.buffer);
    } catch {
      return res.status(400).json({ error: 'Invalid image file' });
    }
    const { rows } = await db.query('SELECT avatar_url FROM users WHERE id = $1', [req.user.userId]);
    await db.query('UPDATE users SET avatar_url = $1 WHERE id = $2', [avatarUrl, req.user.userId]);
    await deleteAvatar(rows[0]?.avatar_url);
    res.json({ avatar_url: avatarUrl });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  getPinPolicy,
  webauthnRegisterOptions,
  webauthnRegister,
  webauthnStepUpOptions,
  webauthnStepUpVerify,
  uploadAvatar,
};
