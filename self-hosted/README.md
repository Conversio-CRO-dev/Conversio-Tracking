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

## One-time setup

1. Install wrangler and log in (from the `self-hosted/` directory):

   ```bash
   npx wrangler login
   ```

2. Create the KV namespace that stores client keys:

   ```bash
   npx wrangler kv namespace create CLIENT_KEYS
   ```

   Copy the `id` it prints into `wrangler.toml` under `[[kv_namespaces]]`.

3. Add `conversio.dev` as a site in the Cloudflare dashboard (Free plan) and
   switch its nameservers at the registrar to the two Cloudflare provides.
   Once the zone shows Active (Cloudflare emails you), uncomment the
   `[[routes]]` block in `wrangler.toml`, it's already set to
   `tag.conversio.dev/t/*`.

4. Deploy:

   ```bash
   npx wrangler deploy
   ```

## Issuing a key for a new client

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

The command prints the exact `<script>` tag to hand to the client.

## Revoking / restoring a client

```bash
node scripts/manage-keys.mjs revoke cvo_xxxxxxxxxxxxxxxxxxxxxxxx
node scripts/manage-keys.mjs activate cvo_xxxxxxxxxxxxxxxxxxxxxxxx
```

Takes effect within the KV propagation window (typically under a minute)
plus whatever's left of the 5 minute edge cache on that client's script
response.

## Listing all issued keys

```bash
node scripts/manage-keys.mjs list
```

## Shipping a new bundle version

Add `public/runtime-tag.<version>.js`, then either issue new keys pointing at
it or move an existing client over with:

```bash
node scripts/manage-keys.mjs update cvo_xxxxxxxxxxxxxxxxxxxxxxxx --version 2.3
```

Old keys keep serving whatever version they were issued with until you change
them, so a bad release never breaks every client at once.
