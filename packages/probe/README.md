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
| `probe -t 5s example.com` | longest one request may take (20s by default), a bare number counting seconds |

## JSON output

One target prints one object, `{target, url, version, status, chain, timings, addresses, tls, certificate, headers, cdn, offers, httpRedirect, warnings}`, unchanged by the other options (`--json` is always the full report). Several targets print an array of those in the order given, an unreachable one being `{target, error}`.

Redirects are followed hop by hop, at most 10. The HTTP version and timings come from `curl --write-out '%{json}'`, the certificate from `node:tls`, which Bun's fetch exposes neither of. HTTP/3 is spoken only when `curl --version` lists it, otherwise h3 is reported from `alt-svc` alone.

Warnings: a certificate with fewer than 14 days left, expired or not trusted, an `http://` twin that does not redirect to https (checked for a bare domain or an https URL on the default port), more than 10 redirects, a site not served over https.

Exits 0 when every site answered, 1 when one could not be reached, 2 on a usage error (a bad URL, header or `--resolve` is refused before any request is made).
