// Conversio tag loader/validator.
//
// Route shape:  GET /t/<clientKey>.js
//
// Every client is served the exact same runtime bundle (see self-hosted/public) -
// the key is not a config value, it is purely an access-control token looked
// up in KV. That lookup decides whether the request gets the bundle at all.
//
// KV binding: CLIENT_KEYS, values shaped as:
//   {
//     "status": "active" | "revoked",
//     "client": "Acme Co",
//     "version": "2.2",              // which bundle in /public to serve
//     "domains": ["acme.com"]        // optional origin allow-list
//   }
//
// RATE_LIMITER binding: caps requests per key (see wrangler.toml), so a
// leaked/scraped key can't be used to run up request costs or degrade
// service for every other client sharing this Worker.

var KEY_PATTERN = /^\/t\/([A-Za-z0-9_-]{16,64})\.js$/;
var DEFAULT_VERSION = '2.2';

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

async function serveBundle(request, env, version) {
  var assetUrl = new URL('/runtime-tag.' + version + '.js', request.url);
  var asset = await env.ASSETS.fetch(new Request(assetUrl, request));

  if (!asset.ok) {
    log('asset_missing', { version: version });
    return emptyScriptResponse();
  }

  var body = await asset.text();
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

    return serveBundle(request, env, record.version || DEFAULT_VERSION);
  }
};
