// Checks for the v3 audience route on the loader Worker
// (self-hosted/src/index.js): GET /a/<clientKey>/<conversio_id>.
//
// The Worker is exercised directly with stubbed Cloudflare bindings, as
// loader.test.js does. Two properties are held throughout and most of this file
// exists for them.
//
// Nothing this route depends on can answer with HTML. That is the loader's own
// rule and it matters here for a second reason: this response is parsed rather
// than executed, so an HTML error page becomes a JSON parse failure inside a
// client's page instead of a readable status.
//
// And nothing a hand-edited record contains can reach the cookie unchecked. A
// code ends up inside a comma-delimited cookie value, so one containing a comma
// would split into two and forge a membership the visitor does not have. A
// record edited straight into KV through the Cloudflare dashboard never passed
// through any CLI, so this side assumes nothing about it.
//
// Usage: node test/audiences.test.js
'use strict';

var ORIGIN = 'https://tag.conversio.dev';
var KEY = 'cvo_0123456789abcdefghij';
var OTHER_KEY = 'cvo_abcdefghijklmnopqrst';
var ID = 'con_abcdefghijklmnop.1700000000000000';
var SITE = 'https://acme.com';

var pass = 0;
var fail = 0;

function check(name, cond, detail) {
  if (cond) { pass++; }
  else {
    fail++;
    console.log('  FAIL  ' + name + (detail ? '  -> ' + detail : ''));
  }
}

function activeRecord(extra) {
  return Object.assign({ status: 'active', client: 'Acme Co', version: '2.6.3' }, extra || {});
}

function audienceRecord(extra) {
  return activeRecord(Object.assign({ audiences: true }, extra || {}));
}

// opts.audiences is the stubbed AUDIENCES namespace contents, keyed exactly as
// the Worker asks for them, so a namespacing mistake shows up as a miss rather
// than passing quietly.
function makeEnv(record, opts) {
  opts = opts || {};
  var asked = [];

  return {
    _asked: asked,
    CLIENT_KEYS: {
      get: function () {
        if (opts.kvThrows) return Promise.reject(new Error('KV internal error'));
        return Promise.resolve(record);
      }
    },
    AUDIENCES: opts.audiencesUnbound ? null : {
      get: function (k) {
        asked.push(k);
        if (opts.audiencesThrow) return Promise.reject(new Error('KV internal error'));
        return Promise.resolve(
          Object.prototype.hasOwnProperty.call(opts.audiences || {}, k) ? opts.audiences[k] : null
        );
      }
    },
    ASSETS: { fetch: function () { return Promise.resolve(new Response('', { status: 404 })); } },
    RATE_LIMITER: null,
    AUDIENCE_LIMITER: opts.limiterThrows
      ? { limit: function () { return Promise.reject(new Error('limiter down')); } }
      : opts.rateLimited
        ? { limit: function () { return Promise.resolve({ success: false }); } }
        : null
  };
}

function get(loader, record, opts) {
  opts = opts || {};
  var headers = {};
  if (opts.origin) headers.Origin = opts.origin;
  var path = opts.path || ('/a/' + (opts.key || KEY) + '/' + (opts.id || ID));
  var env = makeEnv(record, opts);
  return loader
    .fetch(new Request(ORIGIN + path, { headers: headers, method: opts.method || 'GET' }), env)
    .then(function (res) { return { res: res, env: env }; });
}

async function body(res) {
  var text = await res.text();
  try { return JSON.parse(text); } catch (e) { return { __unparseable: text }; }
}

async function main() {
  var loader = (await import('../self-hosted/src/index.js')).default;
  var stored = {};
  stored['aud:' + KEY + ':' + ID] = { ts: 1758585600, a: ['lapsed', 'outerwear'] };

  // 1. the happy path
  var r = await get(loader, audienceRecord(), { audiences: stored, origin: SITE });
  var b = await body(r.res);
  check('serves 200 for an enabled client', r.res.status === 200, 'status ' + r.res.status);
  check('answers as JSON', (r.res.headers.get('content-type') || '').indexOf('application/json') === 0,
    r.res.headers.get('content-type'));
  check('carries the audience codes', JSON.stringify(b.a) === '["lapsed","outerwear"]', JSON.stringify(b));
  check('carries the computed_at it was stored with', b.ts === 1758585600, JSON.stringify(b));
  check('carries a schema version', b.v === 1, JSON.stringify(b));
  check('is namespaced by client key', r.env._asked[0] === 'aud:' + KEY + ':' + ID, r.env._asked[0]);
  check('is cached privately and never shared',
    (r.res.headers.get('cache-control') || '').indexOf('private') === 0, r.res.headers.get('cache-control'));
  check('varies on Origin', (r.res.headers.get('vary') || '').indexOf('Origin') !== -1);
  check('nosniff is set', r.res.headers.get('x-content-type-options') === 'nosniff');

  // 2. a miss is an answer, not a failure. Most visitors are in no audience and
  //    most first-time visitors never can be, so this is the common path.
  r = await get(loader, audienceRecord(), { audiences: {}, origin: SITE });
  b = await body(r.res);
  check('an unknown visitor gets 200, not 404', r.res.status === 200, 'status ' + r.res.status);
  check('with an empty list', JSON.stringify(b.a) === '[]', JSON.stringify(b));
  check('and a timestamp, so the tag does not re-ask every page view',
    typeof b.ts === 'number' && b.ts > 1700000000, JSON.stringify(b));

  // 3. another client's key cannot read these audiences, both keys being live
  r = await get(loader, audienceRecord(), { audiences: stored, key: OTHER_KEY, origin: SITE });
  b = await body(r.res);
  check('a different client key reads none of them', JSON.stringify(b.a) === '[]', JSON.stringify(b));
  check('and asked a namespaced key of its own',
    r.env._asked[0] === 'aud:' + OTHER_KEY + ':' + ID, r.env._asked[0]);

  // 4. opt-in per client
  r = await get(loader, activeRecord(), { audiences: stored, origin: SITE });
  b = await body(r.res);
  check('a client without audiences enabled gets 404', r.res.status === 404, 'status ' + r.res.status);
  check('and is told why', b.error === 'not_enabled', JSON.stringify(b));
  check('and no audience lookup happened', r.env._asked.length === 0);
  check('a record with audiences set to a truthy non-true is not enabled',
    (await get(loader, activeRecord({ audiences: 'yes' }), { audiences: stored })).res.status === 404);

  // 5. the access-control decisions, inherited from the bundle route
  r = await get(loader, audienceRecord({ status: 'revoked' }), { audiences: stored });
  check('a revoked client gets 404', r.res.status === 404, 'status ' + r.res.status);
  check('and no audience lookup happened', r.env._asked.length === 0);

  r = await get(loader, null, { audiences: stored });
  check('an unknown key gets 404', r.res.status === 404, 'status ' + r.res.status);

  r = await get(loader, 'not-an-object', { audiences: stored });
  check('a record that is not an object gets 404', r.res.status === 404, 'status ' + r.res.status);

  // 6. the id is checked before anything is looked up
  var badIds = ['notanid', 'con_short.1', 'con_ABCDEFGHIJKLMNOP.1700000000000000',
                'con_abcdefghijklmnop.notanumber', '..', 'con_abcdefghijklmnop.1700000000000000x'];
  for (var i = 0; i < badIds.length; i++) {
    r = await get(loader, audienceRecord(), { audiences: stored, id: badIds[i] });
    check('a malformed id is refused: ' + badIds[i],
      r.res.status === 400 || r.res.status === 404, 'status ' + r.res.status);
    check('and costs no audience lookup: ' + badIds[i], r.env._asked.length === 0);
  }

  // 7. transient failures, each distinct from a decision about this client
  r = await get(loader, audienceRecord(), { audiencesUnbound: true });
  check('an unbound AUDIENCES namespace is 503, not a wrong answer', r.res.status === 503,
    'status ' + r.res.status);
  check('and is not cached', r.res.headers.get('cache-control') === 'no-store');

  r = await get(loader, audienceRecord(), { audiencesThrow: true });
  check('an AUDIENCES outage is 503', r.res.status === 503, 'status ' + r.res.status);

  r = await get(loader, audienceRecord(), { kvThrows: true });
  check('a CLIENT_KEYS outage is 503', r.res.status === 503, 'status ' + r.res.status);

  r = await get(loader, audienceRecord(), { rateLimited: true, audiences: stored });
  check('a rate-limited key gets 429', r.res.status === 429, 'status ' + r.res.status);
  check('and costs no audience lookup', r.env._asked.length === 0);

  r = await get(loader, audienceRecord(), { limiterThrows: true, audiences: stored, origin: SITE });
  check('a limiter that is down fails open rather than closed', r.res.status === 200,
    'status ' + r.res.status);

  // 8. CORS. A fetch sends Origin where a script tag does not, so the allow-list
  //    is enforceable here in a way it never was for the bundle.
  r = await get(loader, audienceRecord({ domains: ['acme.com'] }), { audiences: stored, origin: SITE });
  check('an allowed origin is echoed back',
    r.res.headers.get('access-control-allow-origin') === SITE,
    r.res.headers.get('access-control-allow-origin'));

  r = await get(loader, audienceRecord({ domains: ['acme.com'] }), { audiences: stored, origin: 'https://sub.acme.com' });
  check('a subdomain of an allowed domain is echoed back',
    r.res.headers.get('access-control-allow-origin') === 'https://sub.acme.com');

  r = await get(loader, audienceRecord({ domains: ['acme.com'] }), { audiences: stored, origin: 'https://evil.example' });
  check('a disallowed origin is refused outright', r.res.status === 404, 'status ' + r.res.status);

  r = await get(loader, audienceRecord(), { audiences: stored, origin: 'https://anything.example' });
  check('with no allow-list configured, any origin is echoed',
    r.res.headers.get('access-control-allow-origin') === 'https://anything.example');

  r = await get(loader, audienceRecord(), { audiences: stored });
  check('a request with no Origin still answers', r.res.status === 200);
  check('and carries no allow-origin header', !r.res.headers.get('access-control-allow-origin'));

  // 9. a hand-edited record cannot reach the cookie. The comma is the one that
  //    matters: a code containing one splits into two inside the cookie value.
  var hostile = {};
  hostile['aud:' + KEY + ':' + ID] = {
    ts: 1758585600,
    a: ['good', 'has,comma', 'has;semi', 'has space', 'UPPER', '', 'has"quote',
        '-leading-dash', 'also_good', 'x'.repeat(40), null, 42, {}, 'fine-2']
  };
  r = await get(loader, audienceRecord(), { audiences: hostile, origin: SITE });
  b = await body(r.res);
  check('a code containing a comma is dropped', b.a.indexOf('has,comma') === -1, JSON.stringify(b.a));
  check('a code containing a semicolon is dropped', b.a.indexOf('has;semi') === -1, JSON.stringify(b.a));
  check('a code containing a space is dropped', b.a.indexOf('has space') === -1, JSON.stringify(b.a));
  check('a code containing a quote is dropped', b.a.indexOf('has"quote') === -1, JSON.stringify(b.a));
  check('an upper-case code is dropped', b.a.indexOf('UPPER') === -1, JSON.stringify(b.a));
  check('an over-long code is dropped', b.a.join(',').indexOf('xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx') === -1);
  check('a non-string entry is dropped', b.a.indexOf(42) === -1 && b.a.indexOf(null) === -1);
  check('the good codes survive', JSON.stringify(b.a) === '["good","also_good","fine-2"]', JSON.stringify(b.a));

  var tooMany = {};
  tooMany['aud:' + KEY + ':' + ID] = { ts: 1758585600, a: [] };
  for (i = 0; i < 100; i++) tooMany['aud:' + KEY + ':' + ID].a.push('code-' + i);
  r = await get(loader, audienceRecord(), { audiences: tooMany, origin: SITE });
  b = await body(r.res);
  check('the code list is capped so the cookie cannot blow its budget',
    b.a.length === 24, 'got ' + b.a.length);

  var shapes = [
    ['a bare string record', 'nonsense'],
    ['a record whose a is not an array', { ts: 1, a: 'lapsed' }],
    ['a record with no a at all', { ts: 1758585600 }],
    ['a record that is a number', 42]
  ];
  for (i = 0; i < shapes.length; i++) {
    var s = {};
    s['aud:' + KEY + ':' + ID] = shapes[i][1];
    r = await get(loader, audienceRecord(), { audiences: s, origin: SITE });
    b = await body(r.res);
    check(shapes[i][0] + ' answers with an empty list rather than throwing',
      r.res.status === 200 && JSON.stringify(b.a) === '[]', r.res.status + ' ' + JSON.stringify(b));
  }

  var badTs = {};
  badTs['aud:' + KEY + ':' + ID] = { ts: 'yesterday', a: ['good'] };
  r = await get(loader, audienceRecord(), { audiences: badTs, origin: SITE });
  b = await body(r.res);
  check('a non-numeric timestamp falls back to now rather than being passed on',
    typeof b.ts === 'number' && b.ts > 1700000000, JSON.stringify(b));

  // 10. methods and paths
  r = await get(loader, audienceRecord(), { audiences: stored, method: 'POST' });
  b = await body(r.res);
  check('a POST is 405', r.res.status === 405, 'status ' + r.res.status);
  check('and answers as JSON, not the script stub',
    (r.res.headers.get('content-type') || '').indexOf('application/json') === 0 &&
    b.error === 'method_not_allowed', r.res.headers.get('content-type'));
  check('and costs no lookup of any kind', r.env._asked.length === 0);

  var paths = ['/a/' + KEY, '/a//' + ID, '/a/' + KEY + '/', '/a/short/' + ID,
               '/a/' + KEY + '/../../secrets', '/audiences/' + KEY + '/' + ID];
  for (i = 0; i < paths.length; i++) {
    r = await get(loader, audienceRecord(), { audiences: stored, path: paths[i] });
    check('an unmatched path is refused: ' + paths[i],
      r.res.status === 404 || r.res.status === 400, paths[i] + ' -> ' + r.res.status);
  }

  // 11. the property that covers every branch above at once
  var everyCase = [
    ['happy', audienceRecord(), { audiences: stored }],
    ['miss', audienceRecord(), { audiences: {} }],
    ['not enabled', activeRecord(), {}],
    ['revoked', audienceRecord({ status: 'revoked' }), {}],
    ['unknown key', null, {}],
    ['bad id', audienceRecord(), { id: 'nope' }],
    ['unbound', audienceRecord(), { audiencesUnbound: true }],
    ['audiences throw', audienceRecord(), { audiencesThrow: true }],
    ['keys throw', audienceRecord(), { kvThrows: true }],
    ['rate limited', audienceRecord(), { rateLimited: true }],
    ['method', audienceRecord(), { method: 'PUT' }]
  ];
  for (i = 0; i < everyCase.length; i++) {
    r = await get(loader, everyCase[i][1], everyCase[i][2]);
    var ct = r.res.headers.get('content-type') || '';
    var text = await r.res.clone().text();
    check('never HTML: ' + everyCase[i][0],
      ct.indexOf('application/json') === 0 && text.indexOf('<') !== 0, ct + ' ' + text.slice(0, 40));
    check('always parseable JSON: ' + everyCase[i][0],
      (function () { try { JSON.parse(text); return true; } catch (e) { return false; } })(), text.slice(0, 40));
  }

  console.log('\nself-hosted/src/index.js (audiences): ' + pass + ' passed, ' + fail + ' failed\n');
  process.exit(fail ? 1 : 0);
}

main();
