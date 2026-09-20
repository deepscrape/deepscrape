# Security.txt Configuration Guide

## Overview

This project implements RFC 9116 [security.txt](https://en.wikipedia.org/wiki/Security.txt) to provide security researchers with a standardized way to report vulnerabilities to Deepscrape.

## Current Configuration

The security.txt file is automatically served at:
- **Production**: `https://deepscrape.dev/.well-known/security.txt`
- **Development**: `http://localhost:4200/.well-known/security.txt` (via proxy)

### Current Fields

| Field | Value | Required | Notes |
|-------|-------|----------|-------|
| **Contact** | `mailto:security@deepscrape.dev` | ✅ | Primary security contact email |
| **Contact** | `https://deepscrape.dev/security` | ✅ | Backup contact URL |
| **Expires** | `2027-05-28T00:00:00Z` | ✅ | File expiration (1 year recommended) |
| **Preferred-Languages** | `en` | ❌ | Security team languages |
| **Policy** | `https://deepscrape.dev/security-policy` | ❌ | Link to security policy |
| **Acknowledgments** | `https://deepscrape.dev/security-acknowledgments` | ❌ | Hall of fame / acknowledgments page |
| **Canonical** | `https://deepscrape.dev/.well-known/security.txt` | ❌ | Canonical location |

## Implementation

### Express Server (`server.ts`)

The security.txt is served via a dedicated handler in the Express server:

```typescript
server.get('/.well-known/security.txt', serveSecurity)
```

**Handler**: `/api/handlers/security_handler.ts`

- Sets correct `Content-Type: text/plain; charset=utf-8`
- Implements 7-day cache (allows updates while reducing requests)
- No authentication required (public endpoint)

### Elysia BFF (`bff/server.ts`)

The Bun + Elysia service imports the same handler. Do not inline a second copy of the
body in the server file — that is exactly how the removed `server-elysia.ts` copy
drifted out of sync with `security_handler.ts`.

## Customization

### Change the Contact Email

Edit `/api/handlers/security_handler.ts`:

```typescript
Contact: mailto:your-security-email@deepscrape.dev
```

### Update Expiration Date

RFC 9116 recommends setting expiration to 1 year in the future. Update both:

1. **Express handler** (`security_handler.ts`):
   ```typescript
   Expires: 2028-05-28T00:00:00Z
   ```

2. There is no second copy to update. The BFF imports `security_handler.ts`, so
   editing that handler is the only change required.

### Add GPG Public Key (Encryption)

To allow encrypted vulnerability reports, host your public key and add:

```
Encryption: https://deepscrape.dev/.well-known/security.gpg
```

### Add Additional Contacts

For multiple contact methods:

```
Contact: mailto:security@deepscrape.dev
Contact: https://deepscrape.dev/security
Contact: tel:+1-555-0123
```

## Related Pages to Create

For full RFC 9116 compliance, create these pages:

### `/security` Page
- Landing page for security reporting
- Links to this security.txt file
- Bug bounty information (if applicable)

### `/security-policy`
- Vulnerability disclosure policy
- Reporting timeline expectations
- What qualifies as a security issue
- Non-disclosure agreement (NDA) terms if any

### `/security-acknowledgments`
- Hall of fame for security researchers
- Past vulnerability disclosures (coordinated)
- Thank you messages

### `/.well-known/security.gpg` (Optional)
- GPG public key for encrypted communications
- Key ID and fingerprint

## Best Practices

1. **Update Expires Regularly**: Update the expiration date before it expires (recommended 1 year)
2. **Monitor this Endpoint**: Set up monitoring to ensure security.txt is always accessible
3. **Respond Quickly**: Security researchers expect timely acknowledgment (within 48 hours)
4. **Keep Email Valid**: Ensure the security contact email is monitored
5. **Test Accessibility**: Regularly verify the file is accessible at `/.well-known/security.txt`

## Testing

### Local Testing

```bash
# Development server
curl http://localhost:4200/.well-known/security.txt

# Should return plaintext security.txt content
```

### Production Verification

```bash
curl https://deepscrape.dev/.well-known/security.txt
```

### Validate Syntax

Use [securitytxt.org](https://securitytxt.org) validator or:

```bash
# Download and validate
curl https://deepscrape.dev/.well-known/security.txt | \
  curl -X POST -d @- https://securitytxt.org/api/v1/scan
```

## RFC 9116 Compliance Checklist

- [x] Served at `/.well-known/security.txt`
- [x] `Content-Type: text/plain; charset=utf-8`
- [x] Plain text format (no JSON/XML)
- [x] One field per line
- [x] Field and value separated by colon and space
- [x] Comments supported with `#` prefix
- [x] Dates in RFC 3339 format
- [x] Contact field with `mailto:` prefix for email
- [x] Expires field present
- [x] Cache-Control headers set

## References

- [RFC 9116 - security.txt](https://www.rfc-editor.org/rfc/rfc9116.html)
- [securitytxt.org](https://securitytxt.org)
- [Cloudflare security.txt guide](https://developers.cloudflare.com/security-center/infrastructure/security-file/)
- [OWASP - Security.txt](https://owasp.org/www-community/Security.txt)
