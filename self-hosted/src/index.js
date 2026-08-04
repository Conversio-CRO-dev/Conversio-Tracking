// Conversio tag loader/validator.
//
// Route shape:  GET /t/<clientKey>.js
//
// The key is first an access-control token looked up in KV, and that lookup
// decides whether the request gets a bundle at all. Clients on the same
// version are served the same bundle except for one substitution: the
// client's tracking ID is patched into it at serve time (see serveBundle), so
// per-client configuration can be set once when the key is issued without
// every client needing its own build.
//
// KV binding: CLIENT_KEYS, values shaped as:
//   {
//     "status": "active" | "revoked",
//     "client": "Acme Co",
//     "version": "2.2",              // which bundle in /public to serve
//     "domains": ["acme.com"],       // optional origin allow-list
//     "trackingId": "G-XXXXXXXXXX"   // optional, exposed to the tag as
//   }                                //   window.conversioSettings.trackingId
//
// RATE_LIMITER binding: caps requests per key (see wrangler.toml), so a
// leaked/scraped key can't be used to run up request costs or degrade
// service for every other client sharing this Worker.

var KEY_PATTERN = /^\/t\/([A-Za-z0-9_-]{16,64})\.js$/;
var DEFAULT_VERSION = '2.2';

// The slot in the bundle that the client's tracking ID is patched into. Must
// stay in step with TRACKING_ID_SLOT in the runtime tag.
var TRACKING_ID_SLOT = '@@CONVERSIO_TRACKING_ID@@';

// Deliberately a safe-charset check rather than a GA-specific one. Two
// different jobs: manage-keys.mjs checks the value looks like a real GA
// measurement ID (catching typos at the point someone types one in), while
// this checks it is safe to splice into a JS string literal that then runs on
// every page of the client's site. A record hand-edited in the Cloudflare
// dashboard never passed through the CLI, so this side cannot assume the
// value was ever validated. Anything failing it is dropped, not injected.
var TRACKING_ID_SAFE = /^[A-Za-z0-9_-]{1,64}$/;

function log(reason, fields) {
  var entry = Object.assign({ event: 'conversio_loader', reason: reason }, fields || {});
  console.log(JSON.stringify(entry));
}

function emptyScriptResponse() {
  return new Response('// conversio: inactive\n', {
    status: 200,
    headers: {
      'content-type': 'application/javascript; charset=utf-8',
      'cache-control': 'public, max-age=30'
    }
  });
}

function rateLimitedResponse() {
  return new Response('// conversio: rate limited\n', {
    status: 429,
    headers: {
      'content-type': 'application/javascript; charset=utf-8',
      'cache-control': 'no-store'
    }
  });
}

function hostnameFromRequest(request) {
  var origin = request.headers.get('Origin');
  var referer = request.headers.get('Referer');
  var raw = origin || referer;
  if (!raw) return null;
  try {
    return new URL(raw).hostname;
  } catch (e) {
    return null;
  }
}

function domainAllowed(hostname, domains) {
  if (!hostname) return false;
  var i;
  for (i = 0; i < domains.length; i++) {
    if (hostname === domains[i] || hostname.endsWith('.' + domains[i])) return true;
  }
  return false;
}

function safeTrackingId(raw, key) {
  if (!raw) return '';
  // Typed explicitly rather than left to RegExp coercion, so a hand-edited
  // record holding a number or an object can't stringify into something that
  // happens to pass the check below.
  if (typeof raw !== 'string' || !TRACKING_ID_SAFE.test(raw)) {
    log('tracking_id_rejected', { key: key });
    return '';
  }
  return raw;
}

async function serveBundle(request, env, record, key) {
  var version = record.version || DEFAULT_VERSION;
  var assetUrl = new URL('/runtime-tag.' + version + '.js', request.url);
  var asset = await env.ASSETS.fetch(new Request(assetUrl, request));

  if (!asset.ok) {
    log('asset_missing', { version: version });
    return emptyScriptResponse();
  }

  var body = await asset.text();

  // Always substituted, even when the client has no tracking ID, so nobody is
  // ever served the raw placeholder. An empty slot reads as "not configured"
  // in the tag. Bundles predating the slot simply contain nothing to replace.
  body = body.split(TRACKING_ID_SLOT).join(safeTrackingId(record.trackingId, key));

  return new Response(body, {
    status: 200,
    headers: {
      'content-type': 'application/javascript; charset=utf-8',
      'cache-control': 'public, max-age=300, stale-while-revalidate=600',
      'x-content-type-options': 'nosniff'
    }
  });
}

export default {
  async fetch(request, env) {
    var url = new URL(request.url);
    var match = url.pathname.match(KEY_PATTERN);

    if (!match) {
      return new Response('Not found', { status: 404 });
    }

    var key = match[1];

    if (env.RATE_LIMITER) {
      var rateLimit = await env.RATE_LIMITER.limit({ key: key });
      if (!rateLimit.success) {
        log('rate_limited', { key: key });
        return rateLimitedResponse();
      }
    }

    var record = await env.CLIENT_KEYS.get(key, { type: 'json' });

    if (!record) {
      log('unknown_key', { key: key });
      return emptyScriptResponse();
    }

    if (record.status !== 'active') {
      log('revoked_key', { key: key, client: record.client });
      return emptyScriptResponse();
    }

    if (record.domains && record.domains.length) {
      var hostname = hostnameFromRequest(request);
      if (!domainAllowed(hostname, record.domains)) {
        log('domain_mismatch', { key: key, client: record.client, hostname: hostname });
        return emptyScriptResponse();
      }
    }

    return serveBundle(request, env, record, key);
  }
};
