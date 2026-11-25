const ANCHOR_DOMAINS = (process.env.REACT_APP_ANCHOR_DOMAINS || 'testanchor.stellar.org')
  .split(',')
  .map((d) => d.trim().toLowerCase())
  .filter(Boolean);

/** Returns the URL if it is HTTPS and on an allow-listed anchor domain, else null. */
export function safeAnchorUrl(raw) {
  try {
    const u = new URL(raw);
    const host = u.hostname.toLowerCase();
    if (u.protocol !== 'https:') return null;
    return ANCHOR_DOMAINS.some((d) => host === d || host.endsWith(`.${d}`)) ? u.href : null;
  } catch {
    return null;
  }
}
