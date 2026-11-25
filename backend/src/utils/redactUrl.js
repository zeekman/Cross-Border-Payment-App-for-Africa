const SENSITIVE_PARAMS = /([?&](?:token|reset_token|verification_token|code)=)[^&#]*/gi;

/** Redact sensitive query-string values (e.g. ?token=...) before logging a URL. */
function redactUrl(url) {
  return typeof url === 'string' ? url.replace(SENSITIVE_PARAMS, '$1[REDACTED]') : url;
}

module.exports = { redactUrl };
