# SSRF (Server-Side Request Forgery) Protection

## Overview

This document describes the SSRF protection mechanisms implemented for webhook URL validation in the Cross-Border Payment App.

## Threat Model

SSRF attacks allow attackers to make the server perform HTTP requests to unintended targets, including:
- Private internal networks (RFC-1918 ranges)
- Cloud metadata endpoints (AWS, GCP, Azure)
- Loopback addresses (localhost)
- Link-local addresses (169.254.x.x)
- Reserved/multicast ranges

## Protected Ranges

The `ssrfValidator.js` utility blocks the following IP ranges:

### IPv4 Ranges
| Range | CIDR | Purpose | Blocked |
|-------|------|---------|---------|
| 10.0.0.0 - 10.255.255.255 | 10.0.0.0/8 | RFC-1918 Private | ✓ |
| 172.16.0.0 - 172.31.255.255 | 172.16.0.0/12 | RFC-1918 Private | ✓ |
| 192.168.0.0 - 192.168.255.255 | 192.168.0.0/16 | RFC-1918 Private | ✓ |
| 127.0.0.0 - 127.255.255.255 | 127.0.0.0/8 | Loopback | ✓ |
| 169.254.0.0 - 169.254.255.255 | 169.254.0.0/16 | Link-local/Metadata | ✓ |
| 100.64.0.0 - 100.127.255.255 | 100.64.0.0/10 | Shared Address Space | ✓ |
| 0.0.0.0 - 0.255.255.255 | 0.0.0.0/8 | This Network | ✓ |
| 224.0.0.0 - 239.255.255.255 | 224.0.0.0/4 | Multicast | ✓ |
| 240.0.0.0 - 255.255.255.255 | 240.0.0.0/4 | Reserved | ✓ |

### IPv6 Ranges
| Range | Purpose | Blocked |
|-------|---------|---------|
| ::1 | Loopback | ✓ |
| fe80::/10 | Link-local | ✓ |
| fc00::/7 | Unique Local | ✓ |
| fd00::/8 | Unique Local | ✓ |

## Implementation

### Shared Utility: `ssrfValidator.js`

Located at: `src/utils/ssrfValidator.js`

**Exported Functions:**

#### `isPrivateIp(ip: string): boolean`
Checks if an IP address is private/reserved.

```javascript
const { isPrivateIp } = require('../utils/ssrfValidator');

isPrivateIp('192.168.1.1');  // true
isPrivateIp('8.8.8.8');      // false
isPrivateIp('::1');          // true
```

#### `validatePublicUrl(url: string): Promise<boolean>`
Validates that a URL points to a public HTTPS endpoint.

```javascript
const { validatePublicUrl } = require('../utils/ssrfValidator');

await validatePublicUrl('https://example.com/hook');      // true
await validatePublicUrl('https://192.168.1.1/hook');      // false
await validatePublicUrl('http://example.com/hook');       // false (not HTTPS)
await validatePublicUrl('https://internal.corp/hook');    // false (resolves to private IP)
```

### Webhook Controller: `webhookController.js`

**Validation on Webhook Creation:**

```javascript
async function create(req, res, next) {
  const { url, events } = req.body;

  // Validates HTTPS protocol, bare private IPs, and DNS resolution
  if (!await validatePublicUrl(url)) {
    return res.status(400).json({ 
      error: 'Webhook URL must point to a public HTTPS endpoint' 
    });
  }
  // ... rest of creation logic
}
```

### Webhook Service: `webhook.js`

**Re-validation on Delivery:**

```javascript
async function deliverWithRetry(url, secret, payload, attempt = 0) {
  // Re-validate URL before each delivery to catch DNS rebinding attacks
  if (!await isPublicHttpsUrl(url)) {
    logger.error('Webhook delivery blocked: URL failed SSRF validation', { url });
    return;
  }
  // ... rest of delivery logic
}
```

## Protection Layers

### Layer 1: Protocol Validation
- Only HTTPS is allowed
- HTTP URLs are rejected

### Layer 2: Bare IP Validation
- If hostname is a bare IPv4 address, check if it's private
- Rejects private IPs immediately without DNS lookup

### Layer 3: DNS Resolution
- Resolves hostname to IP address
- Checks resolved IP against blocked ranges
- Rejects unresolvable hostnames

### Layer 4: DNS Rebinding Protection
- Re-validates URL before each webhook delivery
- Catches cases where DNS record changed between registration and delivery
- Prevents time-of-check-time-of-use (TOCTOU) attacks

## Test Coverage

Comprehensive test suite in `src/__tests__/webhookSsrf.test.js`:

- ✓ HTTP protocol rejection
- ✓ Localhost blocking (127.0.0.1)
- ✓ AWS metadata endpoint blocking (169.254.169.254)
- ✓ RFC-1918 Class A (10.x.x.x)
- ✓ RFC-1918 Class B (172.16.x.x - 172.31.x.x)
- ✓ RFC-1918 Class C (192.168.x.x)
- ✓ Shared address space (100.64.x.x)
- ✓ Bare private IPs in URLs
- ✓ Multicast addresses (224.x.x.x)
- ✓ Reserved addresses (240.x.x.x)
- ✓ IPv6 loopback (::1)
- ✓ IPv6 link-local (fe80::)
- ✓ IPv6 private (fc00::, fd00::)
- ✓ Valid public IPv4 addresses
- ✓ Valid public IPv6 addresses
- ✓ Unresolvable hostnames

## Security Considerations

### What This Protects Against
- Accessing internal services (databases, caches, admin panels)
- Accessing cloud metadata endpoints (AWS IMDSv1/v2, GCP, Azure)
- Accessing localhost services
- DNS rebinding attacks

### What This Does NOT Protect Against
- Attacks on legitimate public services (if attacker controls the domain)
- Time-of-check-time-of-use attacks on the webhook creation endpoint (mitigated by re-validation on delivery)
- Attacks via IPv6 addresses not in the blocked list (IPv6 support is basic)

### Recommendations
1. Monitor webhook delivery failures for suspicious patterns
2. Implement rate limiting on webhook creation
3. Consider IP reputation/blocklist services for additional protection
4. Regularly audit webhook URLs in the database
5. Log all SSRF validation failures for security monitoring

## Maintenance

When updating SSRF protection:
1. Update `BLOCKED_CIDRS` in `ssrfValidator.js`
2. Add corresponding test cases in `webhookSsrf.test.js`
3. Update this documentation
4. Run full test suite: `npm test -- webhookSsrf.test.js`

## References

- RFC 1918: Address Allocation for Private Internets
- RFC 3927: Dynamic Configuration of IPv4 Link-Local Addresses
- RFC 4193: Unique Local IPv6 Unicast Addresses
- OWASP: Server-Side Request Forgery (SSRF)
