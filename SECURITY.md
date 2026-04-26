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
- WorldCat Classify (classify.oclc.org) — keyless ISBN classification (HTTP only)

bibcheck performs HEAD requests against URLs in your bibliography for canonical-edition verification, validating each redirect hop against a trusted-host whitelist and rejecting redirects to private IP ranges (SSRF mitigation).

User-supplied phrase-denylist regex patterns are compiled with [re2js](https://www.npmjs.com/package/re2js) for linear-time guarantees (ReDoS mitigation).
