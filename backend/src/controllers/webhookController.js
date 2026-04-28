const crypto = require('crypto');
const dns = require('dns').promises;
const db = require('../db');

const VALID_EVENTS = ['payment.sent', 'payment.received', 'payment.failed'];

// RFC 1918, loopback, link-local, and cloud metadata ranges
const BLOCKED_CIDRS = [
  [0x0a000000, 0xff000000],   // 10.0.0.0/8
  [0xac100000, 0xfff00000],   // 172.16.0.0/12
  [0xc0a80000, 0xffff0000],   // 192.168.0.0/16
  [0x7f000000, 0xff000000],   // 127.0.0.0/8  (loopback)
  [0xa9fe0000, 0xffff0000],   // 169.254.0.0/16 (link-local / metadata)
  [0x64400000, 0xffc00000],   // 100.64.0.0/10 (shared address space)
  [0x00000000, 0xff000000],   // 0.0.0.0/8
  [0xe0000000, 0xf0000000],   // 224.0.0.0/4  (multicast)
  [0xf0000000, 0xf0000000],   // 240.0.0.0/4  (reserved)
];

function ipToInt(ip) {
  return ip.split('.').reduce((acc, octet) => (acc << 8) + parseInt(octet, 10), 0) >>> 0;
}

function isPrivateIp(ip) {
  // IPv6 loopback / link-local
  if (ip === '::1' || ip.startsWith('fe80') || ip.startsWith('fc') || ip.startsWith('fd')) return true;
  // Only check IPv4
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) return false;
  const n = ipToInt(ip);
  return BLOCKED_CIDRS.some(([net, mask]) => (n & mask) === (net & mask));
}

async function validatePublicUrl(url) {
  let parsed;
  try { parsed = new URL(url); } catch { return false; }
  if (parsed.protocol !== 'https:') return false;

  // Reject if hostname is a bare IP
  const hostname = parsed.hostname;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname)) {
    if (isPrivateIp(hostname)) return false;
  }

  // Resolve hostname and check all returned IPs
  try {
    const { address } = await dns.lookup(hostname);
    if (isPrivateIp(address)) return false;
  } catch {
    return false; // unresolvable hostname
  }
  return true;
}

async function create(req, res, next) {
  try {
    const { url, events } = req.body;

    if (!await validatePublicUrl(url)) {
      return res.status(400).json({ error: 'Webhook URL must point to a public HTTPS endpoint' });
    }

    const invalidEvents = (events || []).filter((e) => !VALID_EVENTS.includes(e));
    if (invalidEvents.length) {
      return res.status(400).json({ error: `Invalid events: ${invalidEvents.join(', ')}` });
    }

    const secret = crypto.randomBytes(32).toString('hex');
    const { rows } = await db.query(
      `INSERT INTO webhooks (user_id, url, secret, events)
       VALUES ($1, $2, $3, $4)
       RETURNING id, url, events, active, created_at`,
      [req.user.userId, url, secret, events || []]
    );

    res.status(201).json({ ...rows[0], secret });
  } catch (err) {
    next(err);
  }
}

async function list(req, res, next) {
  try {
    const { rows } = await db.query(
      `SELECT id, url, events, active, created_at FROM webhooks WHERE user_id = $1 ORDER BY created_at DESC`,
      [req.user.userId]
    );
    res.json({ webhooks: rows });
  } catch (err) {
    next(err);
  }
}

module.exports = { create, list };
