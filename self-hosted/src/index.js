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

// No DEFAULT_VERSION. It was '2.2', a bundle predating the tracking-ID slot, so
// a record that simply forgot its version was served a tag with no GA4
// delivery, no client stream, no vitals and no queues: a working tag that
// reports nothing, which reads as a broken release rather than as an
// unconfigured client. A version is also spliced into a URL in serveBundle, so
// it is checked rather than trusted, a record hand-edited in the Cloudflare
// dashboard never having passed through the CLI.
var VERSION_SAFE = /^[0-9]+(?:\.[0-9]+){1,3}$/;

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

// A client key is the bearer credential that gates the bundle, so the whole of
// it does not belong in a log store with its own access model and its own
// retention. Truncation rather than a hash, because a hash would have to be
// async here (crypto.subtle) and make every caller of log() async with it, for
// no gain: the tail this drops is 96 bits of CSPRNG output, so the prefix
// cannot be walked back to the key, while 48 bits is still uniquely one client
// across any number of clients this will ever have. Correlating a spike to a
// client, which is the only thing these logs are read for, works unchanged.
function fingerprint(key) {
  if (typeof key !== 'string') return null;
  return key.slice(0, 12);
}

function log(reason, fields) {
  var entry = Object.assign({ event: 'conversio_loader', reason: reason }, fields || {});
  console.log(JSON.stringify(entry));
}

function scriptHeaders(cacheControl) {
  return {
    'content-type': 'application/javascript; charset=utf-8',
    'cache-control': cacheControl,
    'x-content-type-options': 'nosniff'
  };
}

function emptyScriptResponse() {
  return new Response('// conversio: inactive\n', {
    status: 200,
    headers: scriptHeaders('public, max-age=30')
  });
}

// Distinct from emptyScriptResponse on purpose, and the difference is the
// cache header rather than the text. "Inactive" is a decision about this key
// and is allowed to sit in a browser cache for its 30 seconds. This is a
// transient failure of something this Worker depends on, so the next page load
// should get to re-decide rather than inheriting the outage for the rest of the
// max-age.
function unavailableResponse() {
  return new Response('// conversio: unavailable\n', {
    status: 200,
    headers: scriptHeaders('no-store')
  });
}

// 405 rather than the inactive stub, so a non-GET is answered as the wrong
// method instead of looking like a revoked client, and so it costs neither a
// rate-limit slot nor a KV read.
function methodNotAllowedResponse() {
  var headers = scriptHeaders('no-store');
  headers.allow = 'GET, HEAD';
  return new Response('// conversio: method not allowed\n', { status: 405, headers: headers });
}

function rateLimitedResponse() {
  return new Response('// conversio: rate limited\n', {
    status: 429,
    headers: scriptHeaders('no-store')
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
    log('tracking_id_rejected', { key: fingerprint(key) });
    return '';
  }
  return raw;
}

async function serveBundle(request, env, record, key) {
  var version = record.version;
  var assetUrl;
  var asset;
  var body;

  // A persistent configuration error rather than a transient outage, so it gets
  // emptyScriptResponse's max-age=30 rather than no-store: no-store here would
  // mean a Worker invocation and a KV read on every page view forever, with
  // nothing damping it, for exactly the records this branch exists to surface.
  if (typeof version !== 'string' || !VERSION_SAFE.test(version)) {
    log('version_invalid', { key: fingerprint(key), client: record.client, version: String(version) });
    return emptyScriptResponse();
  }

  assetUrl = new URL('/runtime-tag.' + version + '.js', request.url);

  // A bare GET, not `new Request(assetUrl, request)`. That form copies the
  // incoming method and headers onto the subrequest, and it was serving the
  // inactive stub for anything that was not a GET: verified against production,
  // a POST to /t/<a real key>.js came back 200 with '// conversio: inactive',
  // because the assets binding refused the POST, asset.ok was false, and this
  // returned the stub. Browsers GET a script tag so no client saw it, but it
  // also logged asset_missing, which is the alert that is supposed to mean a
  // key is pinned to a version nobody deployed. Only the pathname is used to
  // match an asset, so the copied headers bought nothing to begin with.
  try {
    asset = await env.ASSETS.fetch(new Request(assetUrl.toString(), { method: 'GET' }));
  } catch (e) {
    log('asset_error', { key: fingerprint(key), version: version });
    return unavailableResponse();
  }

  if (!asset.ok) {
    log('asset_missing', { key: fingerprint(key), version: version });
    return emptyScriptResponse();
  }

  try {
    body = await asset.text();
  } catch (e) {
    log('asset_unreadable', { key: fingerprint(key), version: version });
    return unavailableResponse();
  }

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
    var url;
    var match;
    var key;
    var rateLimit;
    var record;
    var hostname;

    // Every binding this handler touches is guarded individually, and the
    // reason is the failure mode rather than tidiness. An uncaught throw out of
    // fetch() is Cloudflare error 1101: a 500 carrying an HTML body, delivered
    // into a <script> tag on every page of every client on this Worker, for as
    // long as the incident lasts. Everything else here fails to a harmless
    // empty script, so this was the one path that did not. Guarding per binding
    // rather than wrapping the lot means the log says which dependency broke,
    // which is the whole value of the log during an outage.
    try {
      url = new URL(request.url);
    } catch (e) {
      return new Response('Not found', { status: 404 });
    }

    match = url.pathname.match(KEY_PATTERN);

    if (!match) {
      return new Response('Not found', { status: 404 });
    }

    // After the path match, so an unknown path is still a 404 whatever the
    // method, and before the rate limiter and KV, so a flood of non-GETs on a
    // real key costs neither.
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      log('method_not_allowed', { method: request.method });
      return methodNotAllowedResponse();
    }

    key = match[1];

    // A limiter that is down must not take the tag down with it. Failing open
    // is the deliberate choice: this caps a scraped key's cost, and an hour of
    // uncapped requests is a smaller problem than an hour of every client's
    // tracking being off.
    if (env.RATE_LIMITER) {
      try {
        rateLimit = await env.RATE_LIMITER.limit({ key: key });
      } catch (e) {
        log('rate_limiter_error', { key: fingerprint(key) });
        rateLimit = null;
      }

      if (rateLimit && !rateLimit.success) {
        log('rate_limited', { key: fingerprint(key) });
        return rateLimitedResponse();
      }
    }

    // Covers KV being unavailable and a record holding malformed JSON, which
    // arrive the same way: get(..., { type: 'json' }) throws on both. Neither
    // is a decision about this key, so neither gets the inactive stub's cache.
    try {
      record = await env.CLIENT_KEYS.get(key, { type: 'json' });
    } catch (e) {
      log('key_lookup_error', { key: fingerprint(key) });
      return unavailableResponse();
    }

    if (!record) {
      log('unknown_key', { key: fingerprint(key) });
      return emptyScriptResponse();
    }

    // A record that parsed but is not an object at all, which a hand-edited
    // value can be: a bare string or number would otherwise reach the property
    // reads below and be treated as a revoked client, logging a client name of
    // undefined and hiding the real problem.
    if (typeof record !== 'object') {
      log('record_malformed', { key: fingerprint(key) });
      return emptyScriptResponse();
    }

    if (record.status !== 'active') {
      log('revoked_key', { key: fingerprint(key), client: record.client });
      return emptyScriptResponse();
    }

    if (record.domains && record.domains.length) {
      hostname = hostnameFromRequest(request);
      if (!domainAllowed(hostname, record.domains)) {
        log('domain_mismatch', { key: fingerprint(key), client: record.client, hostname: hostname });
        return emptyScriptResponse();
      }
    }

    try {
      return await serveBundle(request, env, record, key);
    } catch (e) {
      log('serve_error', { key: fingerprint(key) });
      return unavailableResponse();
    }
  }
};
