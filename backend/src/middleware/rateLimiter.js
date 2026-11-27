const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const { MemoryStore } = require('express-rate-limit');
const Redis = require('ioredis');
const logger = require('../utils/logger');
const audit = require('../services/audit');
const metrics = require('../utils/metrics');

// Redis client for rate limiting (shared instance)
let redisClient = null;

function getRedis() {
  if (redisClient) return redisClient;
  if (!process.env.REDIS_URL) return null;
  redisClient = new Redis(process.env.REDIS_URL, {
    lazyConnect: true,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
  });
  redisClient.on('error', () => {});
  return redisClient;
}

// Tracks, per limiter prefix, whether the store is currently degraded to the
// express-rate-limit in-memory fallback — and when it started / was last
// logged, so we warn once on the transition and periodically thereafter
// instead of on every request.
const DEGRADED_LOG_INTERVAL_MS = 5 * 60 * 1000;
const degradedState = new Map(); // prefix -> { since, lastLoggedAt, reason }

function markDegraded(prefix, reason) {
  const now = Date.now();
  const state = degradedState.get(prefix);
  metrics.rateLimiterRedisFailuresTotal.inc({ prefix, reason });

  if (!state) {
    degradedState.set(prefix, { since: now, lastLoggedAt: now, reason });
    metrics.rateLimiterDegraded.set({ prefix }, 1);
    logger.warn('Rate limiter degraded: falling back to per-process in-memory limiting', {
      prefix,
      reason,
    });
    return;
  }

  if (now - state.lastLoggedAt >= DEGRADED_LOG_INTERVAL_MS) {
    state.lastLoggedAt = now;
    logger.warn('Rate limiter still degraded: per-process in-memory limiting remains active', {
      prefix,
      reason,
      degradedForMs: now - state.since,
    });
  }
}

function markHealthy(prefix) {
  metrics.rateLimiterDegraded.set({ prefix }, 0);
  if (degradedState.has(prefix)) {
    const state = degradedState.get(prefix);
    degradedState.delete(prefix);
    logger.warn('Rate limiter recovered: shared Redis store is available again', {
      prefix,
      degradedForMs: Date.now() - state.since,
    });
  }
}

// Reports 'redis' or 'memory-fallback' per limiter prefix, for the health-check surface.
function getRateLimiterStatus() {
  return {
    auth: degradedState.has('auth') ? 'memory-fallback' : 'redis',
    payment: degradedState.has('payment') ? 'memory-fallback' : 'redis',
    read: degradedState.has('read') ? 'memory-fallback' : 'redis',
    admin: degradedState.has('admin') ? 'memory-fallback' : 'redis',
    'email-send-ip': degradedState.has('email-send-ip') ? 'memory-fallback' : 'redis',
    'email-send-addr': degradedState.has('email-send-addr') ? 'memory-fallback' : 'redis',
    'token-verify': degradedState.has('token-verify') ? 'memory-fallback' : 'redis',
    'second-factor': degradedState.has('second-factor') ? 'memory-fallback' : 'redis',
    'phone-otp-verify': degradedState.has('phone-otp-verify') ? 'memory-fallback' : 'redis',
    'sms-send': degradedState.has('sms-send') ? 'memory-fallback' : 'redis',
    'auth-action': degradedState.has('auth-action') ? 'memory-fallback' : 'redis',
  };
}

// express-rate-limit v7 custom store backed by ioredis
class RedisStore {
  constructor(windowMs, prefix) {
    this.windowSec = Math.ceil(windowMs / 1000);
    this.prefix = prefix;
    // Per-process fallback used while Redis is unconfigured or erroring.
    // express-rate-limit has no implicit fallback: a store that returns null
    // makes every request fail with a 500.
    this.memory = new MemoryStore();
  }

  init(options) {
    this.memory.init(options);
  }

  async increment(key) {
    const redis = getRedis();
    const storeKey = `rl:${this.prefix}:${key}`;
    if (!redis) {
      // No Redis configured — fall back to in-memory (handled by express-rate-limit default)
      markDegraded(this.prefix, 'no_redis_configured');
      return this.memory.increment(key);
    }
    try {
      const multi = redis.multi();
      multi.incr(storeKey);
      multi.ttl(storeKey);
      const [[, totalHits], [, ttl]] = await multi.exec();
      if (ttl === -1) {
        await redis.expire(storeKey, this.windowSec);
      }
      const resetTime = new Date(Date.now() + (ttl > 0 ? ttl : this.windowSec) * 1000);
      markHealthy(this.prefix);
      return { totalHits, resetTime };
    } catch (err) {
      markDegraded(this.prefix, 'redis_error');
      return this.memory.increment(key); // Redis error — degrade to per-process limiting
    }
  }

  async decrement(key) {
    const redis = getRedis();
    if (!redis) return this.memory.decrement(key);
    try {
      await redis.decr(`rl:${this.prefix}:${key}`);
    } catch {}
  }

  async resetKey(key) {
    const redis = getRedis();
    if (!redis) return this.memory.resetKey(key);
    try {
      await redis.del(`rl:${this.prefix}:${key}`);
    } catch {}
  }
}

function getTrustedIp(req) {
  // Express computes req.ip using the configured trust-proxy chain. Never
  // trust a client-supplied left-most X-Forwarded-For value here.
  return req.ip || req.socket?.remoteAddress || 'unknown';
}

function makeKeyByIp(req) {
  return getTrustedIp(req);
}

function makeKeyByUser(req) {
  return req.user?.userId || getTrustedIp(req);
}

// Keys by the target email address (hashed so raw addresses never land in
// Redis keys). Falls back to the IP when the body carries no email.
function makeKeyByEmail(req) {
  const raw = req.body?.email || req.body?.new_email;
  if (typeof raw !== 'string' || !raw.trim()) return `ip:${getTrustedIp(req)}`;
  const normalized = raw.trim().toLowerCase();
  return crypto.createHash('sha256').update(normalized).digest('hex');
}

function makeKeyByAdmin(req) {
  return req.user?.userId || getTrustedIp(req);
}

function onLimitReached(req, res, options) {
  const userId = req.user?.userId || null;
  const ip = getTrustedIp(req);
  logger.warn('Rate limit exceeded', { path: req.path, ip, userId });
  audit.log(userId, 'rate_limit_exceeded', ip, req.headers['user-agent'], {
    endpoint: req.path,
    method: req.method,
  });
}

function makeHeaders(req, res, rateLimitInfo) {
  const { limit, remaining, resetTime } = rateLimitInfo;
  res.setHeader('X-RateLimit-Limit', limit);
  res.setHeader('X-RateLimit-Remaining', Math.max(0, remaining));
  if (resetTime) {
    const retryAfter = Math.ceil((resetTime.getTime() - Date.now()) / 1000);
    res.setHeader('X-RateLimit-Reset', Math.ceil(resetTime.getTime() / 1000));
    res.setHeader('Retry-After', retryAfter);
  }
}

const WINDOW_1MIN = 60 * 1000;
const WINDOW_1MIN_SEC = 60;

// Marks a middleware as a rate limiter so route-coverage tests can assert
// every auth route mounts one (BE-194).
function tagLimiter(fn) {
  fn.isRateLimiter = true;
  return fn;
}

// Auth endpoints: 5 req/min per IP
const authLimiter = tagLimiter(rateLimit({
  windowMs: WINDOW_1MIN,
  max: 5,
  keyGenerator: makeKeyByIp,
  store: new RedisStore(WINDOW_1MIN, 'auth'),
  standardHeaders: false,
  legacyHeaders: false,
  handler(req, res, next, options) {
    onLimitReached(req, res, options);
    makeHeaders(req, res, { limit: options.max, remaining: 0, resetTime: new Date(Date.now() + options.windowMs) });
    res.status(429).json({ error: 'Too many auth attempts. Please try again later.' });
  },
  message: { error: 'Too many auth attempts. Please try again later.' },
}));

// Payment submission: 10 req/min per authenticated user
const paymentLimiter = rateLimit({
  windowMs: WINDOW_1MIN,
  max: 10,
  keyGenerator: makeKeyByUser,
  store: new RedisStore(WINDOW_1MIN, 'payment'),
  standardHeaders: false,
  legacyHeaders: false,
  handler(req, res, next, options) {
    onLimitReached(req, res, options);
    makeHeaders(req, res, { limit: options.max, remaining: 0, resetTime: new Date(Date.now() + options.windowMs) });
    res.status(429).json({ error: 'Payment rate limit exceeded. Please slow down.' });
  },
});

// Balance/read endpoints: 60 req/min per authenticated user
const readLimiter = rateLimit({
  windowMs: WINDOW_1MIN,
  max: 60,
  keyGenerator: makeKeyByUser,
  store: new RedisStore(WINDOW_1MIN, 'read'),
  standardHeaders: false,
  legacyHeaders: false,
  handler(req, res, next, options) {
    onLimitReached(req, res, options);
    makeHeaders(req, res, { limit: options.max, remaining: 0, resetTime: new Date(Date.now() + options.windowMs) });
    res.status(429).json({ error: 'Too many requests. Please try again later.' });
  },
});

// Wallet secret-key export: 3 req/15min per authenticated user — separate from the
// general read limiter because exporting a decrypted Stellar secret key is one of
// the highest-impact actions an account can take (#959).
const WINDOW_15MIN = 15 * 60 * 1000;
const exportKeyLimiter = rateLimit({
  windowMs: WINDOW_15MIN,
  max: 3,
  keyGenerator: makeKeyByUser,
  store: new RedisStore(WINDOW_15MIN, 'export-key'),
  standardHeaders: false,
  legacyHeaders: false,
  handler(req, res, next, options) {
    onLimitReached(req, res, options);
    makeHeaders(req, res, { limit: options.max, remaining: 0, resetTime: new Date(Date.now() + options.windowMs) });
    res.status(429).json({ error: 'Too many export attempts. Please try again later.' });
  },
});

// Phone OTP verification: 5 attempts/15min per user. A 6-digit OTP is live for
// 10 minutes, so without this it could be brute-forced (BE-197).
const phoneOtpLimiter = rateLimit({
  windowMs: WINDOW_15MIN,
  max: 5,
  keyGenerator: makeKeyByUser,
  store: new RedisStore(WINDOW_15MIN, 'phone-otp'),
  standardHeaders: false,
  legacyHeaders: false,
  handler(req, res, next, options) {
    onLimitReached(req, res, options);
    makeHeaders(req, res, { limit: options.max, remaining: 0, resetTime: new Date(Date.now() + options.windowMs) });
    res.status(429).json({ error: 'Too many verification attempts. Please try again later.' });
  },
});

// Data-subject requests (export / account deletion): 3 req/hour per user
// (BE-232). Each export builds a full archive of the user's data.
const WINDOW_1HOUR = 60 * 60 * 1000;
const dsarLimiter = rateLimit({
  windowMs: WINDOW_1HOUR,
  max: 3,
  keyGenerator: makeKeyByUser,
  store: new RedisStore(WINDOW_1HOUR, 'dsar'),
  standardHeaders: false,
  legacyHeaders: false,
  handler(req, res, next, options) {
    onLimitReached(req, res, options);
    makeHeaders(req, res, { limit: options.max, remaining: 0, resetTime: new Date(Date.now() + options.windowMs) });
    res.status(429).json({ error: 'Too many data requests. Please try again later.' });
  },
// ── Named per-route auth limiters (BE-194) ─────────────────────────────────
// Mounted next to each route in routes/auth.js so a new auth route can't be
// added without an explicit limiter. Per-user limiters must be mounted after
// authMiddleware so req.user is populated; unauthenticated callers fall back
// to the trusted IP.
const WINDOW_5MIN = 5 * 60 * 1000;
const WINDOW_1HOUR = 60 * 60 * 1000;

function buildLimiter({ windowMs, max, prefix, keyGenerator, error, limitedResponse }) {
  return tagLimiter(rateLimit({
    windowMs,
    max,
    keyGenerator,
    store: new RedisStore(windowMs, prefix),
    standardHeaders: false,
    legacyHeaders: false,
    handler(req, res, next, options) {
      onLimitReached(req, res, options);
      if (limitedResponse) {
        // Endpoints that must not reveal account existence (forgot-password)
        // answer with the same generic 200 they always return, but do no work.
        return res.status(200).json(limitedResponse);
      }
      makeHeaders(req, res, { limit: options.max, remaining: 0, resetTime: new Date(Date.now() + options.windowMs) });
      res.status(429).json({ error });
    },
  }));
}

// Email-sending endpoints: 3/hour per target address AND 20/hour per IP.
// Pass `limitedResponse` to return a generic 200 instead of a 429.
function createEmailSendLimiter({ limitedResponse } = {}) {
  const error = 'Too many email requests. Please try again later.';
  return [
    buildLimiter({ windowMs: WINDOW_1HOUR, max: 20, prefix: 'email-send-ip', keyGenerator: makeKeyByIp, error, limitedResponse }),
    buildLimiter({ windowMs: WINDOW_1HOUR, max: 3, prefix: 'email-send-addr', keyGenerator: makeKeyByEmail, error, limitedResponse }),
  ];
}
const emailSendLimiter = createEmailSendLimiter();

// Token-guessing surfaces (reset-password, verify-email): 10/min per IP.
const tokenVerifyLimiter = buildLimiter({
  windowMs: WINDOW_1MIN,
  max: 10,
  prefix: 'token-verify',
  keyGenerator: makeKeyByIp,
  error: 'Too many verification attempts. Please try again later.',
});

// Second-factor checks (PIN, TOTP, phone OTP, WebAuthn): 10/5min per user.
const secondFactorLimiter = buildLimiter({
  windowMs: WINDOW_5MIN,
  max: 10,
  prefix: 'second-factor',
  keyGenerator: makeKeyByUser,
  error: 'Too many verification attempts. Please try again later.',
});

// Phone OTP verification: additionally 10/hour per user (BE-193).
const phoneOtpVerifyLimiter = buildLimiter({
  windowMs: WINDOW_1HOUR,
  max: 10,
  prefix: 'phone-otp-verify',
  keyGenerator: makeKeyByUser,
  error: 'Too many OTP attempts. Please try again later.',
});

// SMS-sending endpoints: 5/hour per user (the controller also enforces the
// per-send cooldown and daily caps — BE-195).
const smsSendLimiter = buildLimiter({
  windowMs: WINDOW_1HOUR,
  max: 5,
  prefix: 'sms-send',
  keyGenerator: makeKeyByUser,
  error: 'Too many SMS requests. Please try again later.',
});

// Remaining account actions (refresh, logout, profile/2FA setup, etc.):
// 30/min per user, falling back to IP.
const authActionLimiter = buildLimiter({
  windowMs: WINDOW_1MIN,
  max: 30,
  prefix: 'auth-action',
  keyGenerator: makeKeyByUser,
  error: 'Too many requests. Please try again later.',
});

// Per-user PIN/TOTP failure tracking for secret-key export (#1177).
// The IP-keyed exportKeyLimiter above can be bypassed with forged
// X-Forwarded-For when TRUSTED_PROXIES is set, so a 4–6 digit PIN could be
// brute-forced at offline speed across rotating IPs. We therefore count
// verification failures per user and lock export (and other PIN-protected
// actions) after EXPORT_MAX_FAILURES failures for EXPORT_LOCKOUT_MS.
const EXPORT_MAX_FAILURES = Number(process.env.EXPORT_MAX_FAILURES || 5);
const EXPORT_LOCKOUT_MS = Number(process.env.EXPORT_LOCKOUT_MS || 15 * 60 * 1000);
const EXPORT_FAILURE_PREFIX = 'export-key-fail';

// In-process fallback used when Redis is unavailable, so lockout still works
// (per-process) rather than silently disabling the protection.
const exportFailureMemory = new Map(); // userId -> { count, lockedUntil }

function getExportFailureMemory(userId) {
  const entry = exportFailureMemory.get(userId);
  if (!entry) return { count: 0, lockedUntil: 0 };
  if (entry.lockedUntil && entry.lockedUntil <= Date.now()) {
    exportFailureMemory.delete(userId);
    return { count: 0, lockedUntil: 0 };
  }
  return entry;
}

// Returns { locked, lockedUntil, failures } for the given user.
async function getExportLockStatus(userId) {
  if (!userId) return { locked: false, lockedUntil: 0, failures: 0 };
  const redis = getRedis();
  if (!redis) {
    const entry = getExportFailureMemory(userId);
    return {
      locked: entry.lockedUntil > Date.now(),
      lockedUntil: entry.lockedUntil || 0,
      failures: entry.count || 0,
    };
  }
  try {
    const key = `rl:${EXPORT_FAILURE_PREFIX}:${userId}`;
    const [countRaw, ttl] = await Promise.all([redis.get(key), redis.pttl(key)]);
    const count = Number(countRaw || 0);
    const locked = count >= EXPORT_MAX_FAILURES && ttl > 0;
    return {
      locked,
      lockedUntil: locked ? Date.now() + ttl : 0,
      failures: count,
    };
  } catch {
    const entry = getExportFailureMemory(userId);
    return {
      locked: entry.lockedUntil > Date.now(),
      lockedUntil: entry.lockedUntil || 0,
      failures: entry.count || 0,
    };
  }
}

// Records a failed PIN/TOTP verification for the user. Returns the updated
// status so callers can decide whether to lock and notify.
async function recordExportFailure(userId) {
  if (!userId) return { locked: false, lockedUntil: 0, failures: 0 };
  const redis = getRedis();
  if (!redis) {
    const entry = getExportFailureMemory(userId);
    entry.count = (entry.count || 0) + 1;
    if (entry.count >= EXPORT_MAX_FAILURES) {
      entry.lockedUntil = Date.now() + EXPORT_LOCKOUT_MS;
    }
    exportFailureMemory.set(userId, entry);
    return {
      locked: entry.lockedUntil > Date.now(),
      lockedUntil: entry.lockedUntil || 0,
      failures: entry.count,
    };
  }
  try {
    const key = `rl:${EXPORT_FAILURE_PREFIX}:${userId}`;
    const count = await redis.incr(key);
    if (count === 1) {
      await redis.pexpire(key, EXPORT_LOCKOUT_MS);
    }
    const ttl = await redis.pttl(key);
    const locked = count >= EXPORT_MAX_FAILURES;
    return {
      locked,
      lockedUntil: locked ? Date.now() + (ttl > 0 ? ttl : EXPORT_LOCKOUT_MS) : 0,
      failures: count,
    };
  } catch {
    const entry = getExportFailureMemory(userId);
    entry.count = (entry.count || 0) + 1;
    if (entry.count >= EXPORT_MAX_FAILURES) {
      entry.lockedUntil = Date.now() + EXPORT_LOCKOUT_MS;
    }
    exportFailureMemory.set(userId, entry);
    return {
      locked: entry.lockedUntil > Date.now(),
      lockedUntil: entry.lockedUntil || 0,
      failures: entry.count,
    };
  }
}

// Clears the failure counter after a successful export.
async function resetExportFailures(userId) {
  if (!userId) return;
  exportFailureMemory.delete(userId);
  const redis = getRedis();
  if (!redis) return;
  try {
    await redis.del(`rl:${EXPORT_FAILURE_PREFIX}:${userId}`);
  } catch {}
}

module.exports = {
  authLimiter,
  paymentLimiter,
  readLimiter,
  exportKeyLimiter,
  phoneOtpLimiter,
  dsarLimiter,
  emailSendLimiter,
  createEmailSendLimiter,
  tokenVerifyLimiter,
  secondFactorLimiter,
  phoneOtpVerifyLimiter,
  smsSendLimiter,
  authActionLimiter,
  RedisStore,
  getRateLimiterStatus,
  getTrustedIp,
  getExportLockStatus,
  recordExportFailure,
  resetExportFailures,
  EXPORT_MAX_FAILURES,
  EXPORT_LOCKOUT_MS,
};
