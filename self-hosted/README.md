# Conversio tag loader

Self-hosts the Conversio runtime tag on a Cloudflare Worker, gated by a
per-client key instead of pasting the full script into each client's GTM
container.

## How it works

- The runtime bundle in `public/` is identical for every client. It is not
  client-specific config, it's the same JS everyone gets.
- What's client-specific is a random key, looked up in a Cloudflare KV store
  on every request. If the key is active, the Worker serves the bundle. If
  it's missing, revoked, or (optionally) requested from a domain not on that
  key's allow-list, it serves a harmless empty response instead.
- Revoking a client is one command, no redeploy, and no change needed on the
  client's side, their tag just goes silent.

The client's GTM Custom HTML tag shrinks to one line:

```html
<script src="https://tag.conversio.dev/t/cvo_xxxxxxxxxxxxxxxxxxxxxxxx.js" async></script>
```

---

## One-time Cloudflare setup

Everything in this section only needs doing once, to stand the loader up
(it's already been done for `tag.conversio.dev`, this is here for
reference or if you ever need to rebuild it from scratch, e.g. a new
environment).

1. **Create a Cloudflare account** at [dash.cloudflare.com/sign-up](https://dash.cloudflare.com/sign-up).
   The free plan is enough (100,000 Worker requests/day, KV, static assets).

2. **Add your domain as a Cloudflare zone.** Dashboard → Add a Site → your
   domain → Free plan. Cloudflare scans and imports any existing DNS
   records automatically, review that list (especially MX/email records)
   before continuing. Then switch the domain's nameservers at your
   registrar to the two Cloudflare gives you, and wait for Cloudflare to
   email you that the zone is Active (usually within a couple of hours).

3. **Install wrangler and log in** (from this `self-hosted/` directory):

   ```bash
   npx wrangler login
   ```

   This opens a browser tab to authorize the Cloudflare account from
   step 1.

4. **Create the KV namespace that stores client keys:**

   ```bash
   npx wrangler kv namespace create CLIENT_KEYS
   ```

   Copy the `id` it prints into `wrangler.toml` under `[[kv_namespaces]]`.

5. **Deploy:**

   ```bash
   npx wrangler deploy
   ```

   `wrangler.toml` already points `[[routes]]` at `tag.conversio.dev`
   (a Custom Domain, whole-hostname mapping, no path wildcard, the Worker
   does its own `/t/<key>.js` routing internally) and provisions the DNS
   record for it automatically. If you're standing this up on a different
   domain, update that `pattern` first.

   This also turns on the rate limiter (`[[ratelimits]]`, capped per client
   key, tune `limit`/`period` in `wrangler.toml` to sit comfortably above
   your busiest client's real traffic) and Workers Logs (`[observability]`,
   viewable in the dashboard or via `npx wrangler tail`).

6. **(Optional) Enable instant cache purge on revoke/activate/update.**
   Without this, a revoke still works, it just takes up to a few minutes to
   propagate (KV replication plus the edge cache TTL). To make it near
   instant:

   - In the Cloudflare dashboard: **My Profile → API Tokens → Create Token**,
     use the "Purge Cache" template, and scope it to the `conversio.dev`
     zone only.
   - Find the **Zone ID** on that zone's Overview page (right-hand sidebar).
   - Create `self-hosted/.env` (already gitignored, never commit it):

     ```
     CF_API_TOKEN=your-token-here
     CF_ZONE_ID=your-zone-id-here
     ```

   - Run the CLI with `node --env-file=.env scripts/manage-keys.mjs ...`
     instead of plain `node scripts/manage-keys.mjs ...`. Without the
     `--env-file` flag (or the env vars set another way), the commands
     below still work, they just print a note that they skipped the purge.

---

## Managing clients

All of these use the CLI in `scripts/manage-keys.mjs`, run from this
`self-hosted/` directory. It shells out to `wrangler`, so step 3 above
must already be done (logged in) on whatever machine you run it from.

### Create a new client

```bash
node scripts/manage-keys.mjs issue --client "Acme Co"
```

Optional flags:

- `--version 2.2` pins that client to a specific bundle in `public/`
  (defaults to the current latest). Useful if a client needs to stay on an
  older version while others move forward.
- `--domains acme.com,www.acme.com` locks the key to those origins, checked
  against the `Referer` header (script tags don't send `Origin`). Only set
  this if you're confident the client site doesn't run a `no-referrer`
  policy, that would cause the check to fail closed. Leave it off if unsure,
  a stolen key is a much smaller risk than a broken tag.

This prints the exact `<script>` tag to hand to the client for their GTM
Custom HTML tag.

### Revoke a client

```bash
node scripts/manage-keys.mjs revoke cvo_xxxxxxxxxxxxxxxxxxxxxxxx
```

Their existing `<script>` tag is left in place on their site, it just stops
being served, the client sees no error, tracking simply stops. Takes effect
within the KV propagation window (typically under a minute) plus whatever's
left of the 5 minute edge cache on that client's script response, or near
instantly if you've set up cache purge (see step 6 above).

### Restore a revoked client

```bash
node scripts/manage-keys.mjs activate cvo_xxxxxxxxxxxxxxxxxxxxxxxx
```

Same key, same `<script>` tag, no changes needed on their end.

### List all issued keys

```bash
node scripts/manage-keys.mjs list
```

### Check a single client's record

```bash
node scripts/manage-keys.mjs show cvo_xxxxxxxxxxxxxxxxxxxxxxxx
```

### Verify a client is actually serving

```bash
node scripts/manage-keys.mjs verify cvo_xxxxxxxxxxxxxxxxxxxxxxxx
```

Makes a real request to the live URL and reports whether it's serving the
bundle, the harmless inactive response, or rate limited. Useful before
handing a new `<script>` tag to a client, or right after a revoke/activate,
to confirm the change actually took effect rather than trusting the cache
timing.

---

## Shipping a new bundle version

Add `public/runtime-tag.<version>.js`, then either issue new keys pointing at
it or move an existing client over with:

```bash
node scripts/manage-keys.mjs update cvo_xxxxxxxxxxxxxxxxxxxxxxxx --version 2.3
```

Old keys keep serving whatever version they were issued with until you change
them, so a bad release never breaks every client at once.

---

## Known risks and trade-offs

Rolling this out to clients centralizes something that used to be fully
decentralized (each client's Custom HTML tag was self-contained). That trade
buys easy revocation and one place to fix bugs, at the cost of these:

- **Single dependency for everyone.** Every client's tracking now depends on
  one Worker, one KV namespace, one Cloudflare account. An outage or a bad
  deploy affects all clients at once, not just one. Rate limiting and
  structured logging (above) reduce the chance of a *self-inflicted* outage,
  they don't remove the shared-dependency trade-off itself.

- **Ad blockers and privacy tools may target the subdomain.** A dedicated
  hostname with "tag" in the name is a more obvious blocklist target than
  code pasted inline into a client's own GTM container.

  Checked as of 2026-07-24: `tag.conversio.dev` does not appear in any of
  uBlock Origin's default lists (EasyList, EasyPrivacy, Peter Lowe's list,
  or uBlock's own filters/privacy/badware/resource-abuse lists). These
  lists block by exact domain, not by a generic `tag.*` pattern, there are
  roughly 30 individually-listed `tag.<company>.<tld>` domains in
  EasyPrivacy today (e.g. `tag.brandcdn.com`, `tag.flagship.io`), almost
  certainly other companies running the same shared third-party
  tag-loader architecture as this one, each added only after maintainers
  noticed and flagged it. So this is a "clean today" result, not a
  permanent guarantee, worth rechecking every few months or if client-side
  tracking volume unexpectedly drops, rather than assuming it stays clean
  indefinitely. Also worth testing against Brave's built-in blocking and
  common corporate proxies, which weren't covered by this check.

- **Single point of operational control.** Right now, only whoever has
  `wrangler login` access on their machine can issue or revoke keys, there's
  no team access model. If more than one person needs to manage clients,
  add them as members on the Cloudflare account (dashboard → Manage Account
  → Members) rather than sharing login credentials.

- **Migrating a client is a live-traffic change.** Swapping their existing
  Custom HTML tag for the one-line loader touches tracking that's currently
  working. Roll out to one lower-stakes client first, verify with the
  `verify` command and a check of real dataLayer events, then broaden,
  rather than switching everyone at once.
