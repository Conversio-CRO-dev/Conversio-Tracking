# Conversio tag loader

Self-hosts the Conversio runtime tag on a Cloudflare Worker, gated by a
per-client key instead of pasting the full script into each client's GTM
container.

## How it works

- The runtime bundle in `public/` is the same JS for every client on a given
  version, with one exception: the client's tracking ID is patched into it at
  serve time (see [Client-level settings](#client-level-settings) below).
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

- `--version 2.4` pins that client to a specific bundle in `public/`. Useful
  if a client needs to stay on an older version while others move forward.
  Note this defaults to `2.2`, not to the newest bundle present, so pass it
  explicitly when issuing a key for a current-version client. Same for
  `DEFAULT_VERSION` in `src/index.js`, which covers a record with no version
  at all.
- `--domains acme.com,www.acme.com` locks the key to those origins, checked
  against the `Referer` header (script tags don't send `Origin`). Only set
  this if you're confident the client site doesn't run a `no-referrer`
  policy, that would cause the check to fail closed. Leave it off if unsure,
  a stolen key is a much smaller risk than a broken tag.
- `--tracking-id G-J4EDMZMNY9` sets the client's GA property ID, readable by
  the tag as `window.conversioSettings.trackingId`. See
  [Client-level settings](#client-level-settings).

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
bundle, the harmless inactive response, or rate limited, and which tracking
ID (if any) is in the bytes actually being served. Useful before handing a new
`<script>` tag to a client, or right after a revoke/activate/update, to
confirm the change actually took effect rather than trusting the cache timing.

---

## Client-level settings

Some values belong to the client rather than the visitor. Today that's the
tracking ID (a GA property ID); the mechanism generalises to anything else
that needs setting once per client.

It lives in the client's KV record and is patched into the bundle at serve
time, so the tag can read it without a second network request:

```bash
node scripts/manage-keys.mjs issue --client "Acme Co" --tracking-id G-J4EDMZMNY9
```

Set it on an existing client, or correct one, with `update`:

```bash
node scripts/manage-keys.mjs update cvo_xxxxxxxxxxxxxxxxxxxxxxxx --tracking-id G-J4EDMZMNY9
```

Clear it with an empty value (`--tracking-id ""`), which puts the client back
to having none.

Inside the tag and for any tag that runs after it, the value is on a global:

```js
window.conversioSettings.trackingId  // 'G-J4EDMZMNY9', or null if not set
```

### What the tag does with it

From 2.4 on, the tag sends a GA4 event to that property alongside every
`conversio_experience_session` and `conversio_event_instance` it emits to the
dataLayer. Both go out under one event name, `conversio_cro`, told apart by
their category/action/label:

| Parameter | From an experience emit | From an event emit |
| --- | --- | --- |
| `conversio_category` | `experience_category` | `event_category` |
| `conversio_action` | `experience_action` | `event_action` |
| `conversio_label` | `experience_label` | `event_label` |
| `conversio_segment` | `experience_segment` | `event_segment` |
| `conversio_experiences` | `sessionStorage.conversioExperienceList` | same |
| `conversio_events` | `sessionStorage.conversioEventList` | same |
| `conversio_id` | the visitor's `conversio_id` | same |
| `conversio_vitals` | Core Web Vitals as a JSON string, when collected | same |

**Routing is the part that needed care.** A bare `gtag('event', ...)` goes to
every measurement ID configured in that gtag instance, so on a site running
more than one GA4 property the event lands in all of them. Each send is pinned
with `send_to` to the single property in that client's key record, so it can't
leak into whichever property the site happened to configure last.

**The tag never calls `gtag('config', ...)`.** That property belongs to the
client and their own tagging already configures it; configuring it again from
here risks resetting their settings or emitting a duplicate `page_view`. The
trade-off is the one failure mode to know about: **if the property isn't
actually configured on the page, gtag silently drops the send.** That's the
first thing to check if events don't show up in GA4 realtime.

It uses `window.gtag` when present, which matters for a site that loaded
gtag.js under a custom dataLayer name, and otherwise queues the command on
`dataLayer` where gtag.js picks it up when it initialises. So a send firing
before GA has loaded still arrives rather than being lost.

Two limits worth designing around:

- **`conversio_vitals` is only present when the emit happens after Core Web
  Vitals collection has finished.** Experiences and events that fire early in
  the page have no vitals to carry, and simply omit the parameter. Both cases
  are normal, so don't treat absence as an error.
- **GA4 truncates event parameter values at 100 characters.** The two segment
  lists are JSON arrays that will pass that on a busy session and be cut
  silently. If you need the full lists, the alternative is sending a count plus
  the most recent few rather than the whole array.

Things worth knowing:

- **It's set before any dataLayer processing**, so a tag firing off a Conversio
  event can already read it. It is deliberately *not* on the `conversio_data`
  payload: that event fires late (after Core Web Vitals collection) and only
  once emission consent arrives, so anything needing the ID at page load could
  not rely on finding it there.
- **It isn't gated behind emission consent**, because it's client
  configuration, not visitor data. A GA property ID is public anyway, it
  appears in the page source of every GA-tagged site.
- **`null` is a normal state, not an error.** Clients with no tracking ID set,
  clients pinned to a pre-2.4 bundle, and the pasted-inline GTM copy of the tag
  all read as `null`. Those clients send nothing to GA4 and are otherwise
  completely unaffected, so leaving it unset is how you turn the GA4 delivery
  off for a client.
- **Changing it propagates like a version change**, i.e. the KV window plus
  what's left of the 5 minute edge cache, or near instantly with cache purge
  configured (step 6 above). `update` purges automatically.
- **The value is validated twice, for two different reasons.** The CLI checks
  it looks like a real GA measurement ID, to catch a typo while you're still
  looking at the terminal rather than shipping a dead property ID nobody
  notices for weeks. The Worker separately checks it's safe to splice into a
  JS string literal, because a record edited straight into KV via the
  Cloudflare dashboard never passed through the CLI. A value failing the
  Worker's check is dropped (the client reads `null`) and logged as
  `tracking_id_rejected`, rather than being served.

---

## Shipping a new bundle version

Add `public/runtime-tag.<version>.js` and `npx wrangler deploy`. That makes the
bundle *available* without moving anybody: every key keeps serving whatever
version its record pins, and `DEFAULT_VERSION` in `src/index.js` covers only
records with no version at all. So a bad release never breaks every client at
once, and the deploy itself is not the risky step.

Moving one client over is the risky step, and it's one command:

```bash
node scripts/manage-keys.mjs update cvo_xxxxxxxxxxxxxxxxxxxxxxxx --version 2.4
```

Rolling that client back is the same command with the old version, taking
effect as soon as the cache purge lands.

Two things to check when moving a client to 2.4 or later:

- **Set their `--tracking-id` in the same breath**, or in a separate `update`.
  Without one they get the tag but no GA4 delivery, which looks like a broken
  release rather than an unconfigured client.
- **Confirm nobody else moved** with `list`, which prints each client's version
  and tracking ID alongside their status.

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
