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
canonical-edition verification. The SSRF mitigation has several layers:

- **Input-host allowlisting before any request.** The hostname of each
  bibliography URL is checked against the trusted-host whitelist configured in
  `[trusted_hosts]` *before* any network request is dispatched. A URL whose host
  is not allowlisted (for example a cloud metadata endpoint such as
  `169.254.169.254`) is reported as `wrong-host` and is never fetched.
- **Per-hop private-IP rejection.** Every hop — the initial URL *and* every
  redirect target, regardless of whether the redirect stays on the same host —
  is validated. Literal-IP hosts are classified directly; DNS names are resolved
  and every returned address is checked. A hop is rejected if it targets a
  private or non-routable address: IPv4 loopback (`127.0.0.0/8`), RFC 1918
  (`10/8`, `172.16/12`, `192.168/16`), link-local (`169.254.0.0/16`), the
  "this host" range (`0.0.0.0/8`), CGNAT shared space (`100.64.0.0/10`), IPv6
  loopback (`::1`), ULA (`fc00::/7`), IPv6 link-local (`fe80::/10`), and
  IPv4-mapped IPv6 forms (e.g. `::ffff:127.0.0.1`). Non-dotted IPv4 literals in
  decimal, octal, or hex form (e.g. `http://2130706433/`, `http://0x7f000001/`)
  are normalized and classified too.
- **Scheme restriction.** Only `http`/`https` URLs are accepted at any hop;
  `file:`, `data:`, `ftp:`, and other schemes are rejected.
- **Final-destination allowlisting.** After redirects are followed, the final
  destination host is re-checked against the trusted-host whitelist.

Limitation: the private-IP check resolves DNS and validates the returned
addresses, but the subsequent connection performs its own resolution, so a
DNS-rebinding attacker who flips a record between the two lookups is not fully
mitigated (TOCTOU). Closing this window requires pinning the validated IP into
the connection (a custom dispatcher) and is not yet implemented.

User-supplied phrase-denylist regex patterns are compiled with
[re2js](https://www.npmjs.com/package/re2js) for linear-time guarantees
(ReDoS mitigation).
