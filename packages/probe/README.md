# @kaynooo/cli-probe

`probe` reports what a site answers in one call: the negotiated HTTP version, the redirect chain, timings, addresses, TLS and certificate, the headers worth knowing, and a warning mark for what needs attention.

```sh
bun add -g @kaynooo/cli-probe
```

| Command | What it does |
| --- | --- |
| `probe example.com` | a bare domain tries https first, then http; one line: HTTP version, status, final URL, total time, redirects, certificate expiry, first address and the warnings |
| `probe example.com --verbose` | the whole table: the status chain, timings (dns, connect, tls, first byte, total), A and AAAA addresses, TLS version and cipher, certificate issuer, expiry and names, server, content type and encoding, cache control, hsts, a CDN hint, and whether h2 and h3 are offered |
| `probe a.test b.test` | several targets, probed together, one line (or table) each in the order given |
| `probe https://example.com/path --json` | the same as one JSON object |
| `probe -k https://localhost:8443` | go on with a certificate curl does not trust (it is reported as a warning) |
| `probe -H "X-Debug: 1" https://example.com` | a header sent with every request, repeatable |
| `probe --resolve example.com:203.0.113.7 https://example.com` | reaches the host at that address instead of the DNS answer (an IPv4 or IPv6 literal), repeatable; the certificate is read from that address, the Host header and the SNI stay the host's, and the addresses reported are that one |
| `probe -t 5s example.com` | longest one request may take (20s by default, 3s for a DNS query), a bare number counting seconds |
| `probe --dns example.com` | no HTTP request: the A, AAAA and CNAME records with their TTL as the system resolver, Cloudflare (1.1.1.1), Google (8.8.8.8), Quad9 (9.9.9.9) and each nameserver of the host's zone answer them, and a warning for each resolver answering otherwise than the zone's nameservers |
| `probe --cors https://app.example.com https://api.example.com/items` | sends the preflight a browser on that origin sends before a JSON POST, and says whether it would go on: allowed or refused, each reason, the `access-control-*` and `vary` headers |
| `probe --cors https://app.example.com --method PUT --cors-headers content-type,authorization <url>` | the preflight of another request: its method (POST by default) and the headers it carries (`content-type` by default, empty for none) |

## JSON output

One target prints one object, `{target, url, version, status, chain, timings, addresses, tls, certificate, headers, cdn, offers, httpRedirect, failedHop, warnings}`, unchanged by the other options (`--json` is always the full report). Several targets print an array of those in the order given, an unreachable one being `{target, error}`.

Redirects are followed hop by hop, at most 10; a redirect to a target that does not answer is kept as `failedHop`, `{url, error}`, with a warning. The HTTP version and timings come from `curl --write-out '%{json}'`, the certificate from `node:tls`, which Bun's fetch exposes neither of. HTTP/3 is spoken only when `curl --version` lists it, otherwise h3 is reported from `alt-svc` alone.

Warnings: a certificate with fewer than 14 days left, expired or not trusted, an `http://` twin that does not redirect to https (checked for a bare domain or an https URL on the default port), more than 10 redirects, a site not served over https.

## DNS comparison

`--dns` takes names or URLs, an IP address being refused. The zone is the nearest name up from the host that has NS records, a top-level domain or an alias never counting as one, and a lookup that fails stops the climb rather than take a parent's nameservers; the zone's nameservers are the reference, reached at the address Cloudflare gives for them. Two answers agree when their A records share an address and their AAAA records do too, so a round robin rotating its records is no disagreement while a family one side lacks is one; an alias compares by its target alone, since a zone's nameservers do not follow it out of the zone. A CDN answering by where the question comes from can still show as a disagreement.

The system resolver is the one `/etc/resolv.conf` names, asked directly: `/etc/hosts` is not read. The flush advice holds when that is systemd-resolved's stub, `127.0.0.53`. Under Bun a DNS query's `-t` is rounded up to whole seconds, one at least.

Warnings: the system resolver behind the zone (`sudo resolvectl flush-caches` drops its copy, the TTL saying how long it may keep it otherwise, left out for an alias whose own TTL is not known), a public resolver giving what none of the zone's nameservers gives, the nameservers disagreeing among themselves, resolvers disagreeing with no nameserver to tell which is right, a resolver not answering, no zone found or the zone lookup failing. `--json` is `{target, zone, answers, agree, warnings}`, each answer `{resolver, server, authoritative, a, aaaa, cname, ttl, error?}`.

## CORS preflight

`--cors <origin>` sends `OPTIONS` with `Origin`, `Access-Control-Request-Method` and `Access-Control-Request-Headers`, the way a browser does, then applies the Fetch standard's checks: a 2xx status, `access-control-allow-origin` being `*` or the origin, `access-control-allow-methods` listing a method other than GET, HEAD or POST (or `*`), `access-control-allow-headers` covering every header (`*` covers all but `authorization`). The method is uppercased when it is one of the six fetch normalizes (DELETE, GET, HEAD, OPTIONS, POST, PUT) and otherwise sent and matched as typed, `patch` needing `patch` listed. `accept`, `accept-language` and `content-language` are left out of the preflight, a browser letting them through unlisted. Warnings: credentials allowed alongside a `*`, which a credentialed request does not get, and the request's origin allowed without `vary: origin`. `--json` is `{target, url, status, request, allowed, reasons, warnings, headers}`. `-H`, `--resolve`, `-k` and `-t` apply to the preflight too.

Exits 0 when every site answered, 1 when one could not be reached or one of its redirects led nowhere, a CORS preflight was refused or no resolver knows a name, 2 on a usage error (a bad URL, header, origin or `--resolve` is refused before any request is made).
