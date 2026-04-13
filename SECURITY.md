# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 1.x.x  | :white_check_mark: |
| < 1.0   | :x:                |

## Reporting a Vulnerability

We take security seriously at IKONBAI™, Inc.

If you discover a security vulnerability in KIOKU™, please report it responsibly:

**Email:** security@ikonbai.com

Please include:
- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (if any)

### What to expect
- Acknowledgment within 48 hours
- Status update within 7 business days
- Credit in our security advisories (if desired)

### Out of scope
- Denial of service attacks
- Social engineering
- Vulnerabilities in third-party services

## Security Measures

KIOKU™ implements:
- SHA-256 hashed API keys
- JWT authentication with required secret
- Rate limiting with fail-closed design
- Input validation via Zod schemas
- IDOR ownership checks on all endpoints
- WebSocket authentication
- GDPR data export and purge endpoints
- Stripe webhook signature verification

## Bug Bounty

We do not currently offer a bug bounty program, but we deeply appreciate responsible disclosure and will credit researchers who report valid vulnerabilities.

---

© 2026 IKONBAI™, Inc. All rights reserved.
