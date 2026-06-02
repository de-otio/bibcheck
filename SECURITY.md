# Security policy

## Reporting

If you discover a security issue with bibcheck, please report it via:

- A private GitHub Security Advisory at https://github.com/de-otio/bibcheck/security/advisories
- Or email: richard.myers@de-otio.org

We aim to acknowledge reports within 7 days.

## Data and privacy

bibcheck collects no telemetry. The only outbound personal data is the
polite-pool email address (when configured via `[apis] crossref_mailto` /
`openalex_mailto`), which is sent to api.crossref.org and api.openalex.org
as a User-Agent string and `?mailto=` query parameter. Setting these
fields is optional.

bibcheck queries the following public APIs as part of its operation:
- CrossRef (api.crossref.org) — DOI metadata
- OpenAlex (api.openalex.org) — bibliographic metadata
- OpenLibrary (openlibrary.org) — ISBN metadata

bibcheck performs HEAD requests against URLs in your bibliography for
canonical-edition verification. The implemented SSRF mitigation covers
**cross-host redirect hops**: when a redirect moves to a different hostname,
bibcheck resolves that hostname's IP addresses and rejects the redirect if any
address is in a private range (loopback, RFC 1918, link-local). The initial
URL and same-host redirects are not IP-checked. The final destination is
validated against the trusted-host whitelist configured in `[trusted_hosts]`.

Note: per-hop private-IP rejection for all hops (including the initial URL and
same-host redirects) is not yet implemented. The current control is best-effort
for the cross-host redirect case. Only http/https scheme URLs are accepted at
any hop.

User-supplied phrase-denylist regex patterns are compiled with
[re2js](https://www.npmjs.com/package/re2js) for linear-time guarantees
(ReDoS mitigation).
