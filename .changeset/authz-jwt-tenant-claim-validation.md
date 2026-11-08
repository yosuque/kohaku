---
"@kohaku-ui/authz-hmac": patch
"@kohaku-ui/authz-jwt": patch
---

`@kohaku-ui/authz-jwt`: the default claim mapping now rejects a bearer JWT whose tenant claim is over 256 UTF-16 code units or contains a control character, with a new `JwtIdentityError` code `INVALID_TENANT` (a 401 in the sample hosts). Such a tenant used to pass identity resolution and then fail at capability issuance as a 500. `@kohaku-ui/authz-hmac` exports the `isValidTenantClaim` rule so both packages apply the identical check.
