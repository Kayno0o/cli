# @kaynooo/cli-probe

`probe` reports what a site answers in one call: the negotiated HTTP version, the redirect chain, timings, addresses, TLS and certificate, the headers worth knowing, and a warning mark for what needs attention.

```sh
bun add -g @kaynooo/cli-probe
```

| Command | What it does |
| --- | --- |
| `probe example.com` | a bare domain tries https first, then http; prints the HTTP version, status chain, timings (dns, connect, tls, first byte, total), A and AAAA addresses, TLS version and cipher, certificate issuer, expiry and names, server, content type and encoding, cache control, hsts, a CDN hint, and whether h2 and h3 are offered |
| `probe https://example.com/path --json` | the same as one JSON object |
| `probe -k https://localhost:8443` | go on with a certificate curl does not trust (it is reported as a warning) |

Redirects are followed hop by hop, at most 10. The HTTP version and timings come from `curl --write-out '%{json}'`, the certificate from `node:tls`, which Bun's fetch exposes neither of. HTTP/3 is spoken only when `curl --version` lists it, otherwise h3 is reported from `alt-svc` alone.

Warnings: a certificate with fewer than 14 days left, expired or not trusted, an `http://` twin that does not redirect to https (checked for a bare domain or an https URL on the default port), more than 10 redirects, a site not served over https.

Exits 0 when the site answered, 1 when it could not be reached, 2 on a usage error.
