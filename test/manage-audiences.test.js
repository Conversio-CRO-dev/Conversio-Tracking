// Checks for self-hosted/scripts/manage-audiences.mjs, the CLI that loads
// BigQuery-derived audiences into Cloudflare KV.
//
// Driven through --dry-run, which validates an export and reports without
// touching the network at all. That is deliberate on both sides: it makes the
// flag a real offline check of a file before it goes near a live namespace, and
// it makes the CLI testable here without a Cloudflare account.
//
// What is under test is the reading and the refusing, which is where the value
// is. A bad export that loads silently is the failure worth preventing: the
// rows that landed are indistinguishable from correct ones afterwards, and the
// codes come from a BigQuery job nobody watches.
//
// Usage: node test/manage-audiences.test.js
'use strict';

var fs = require('fs');
var os = require('os');
var path = require('path');
var execFileSync = require('child_process').execFileSync;

var CLI = path.join(__dirname, '..', 'self-hosted', 'scripts', 'manage-audiences.mjs');
var KEY = 'cvo_0123456789abcdefghij';
var ID = 'con_wu6iuxsffhwxljci.1789464054974051';
var ID2 = 'con_abcdefghijklmnop.1700000000000000';
var DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'conversio-aud-test-'));

var pass = 0;
var fail = 0;

function check(name, cond, detail) {
  if (cond) { pass++; }
  else {
    fail++;
    console.log('  FAIL  ' + name + (detail ? '  -> ' + detail : ''));
  }
}

// Runs the CLI and returns { status, out }, never throwing: a non-zero exit is
// the expected outcome of about half of these.
function run(args) {
  var file = path.join(DIR, 'rows-' + Math.random().toString(36).slice(2) + '.json');
  var body = args.body;
  fs.writeFileSync(file, typeof body === 'string' ? body : JSON.stringify(body));

  var argv = ['load', args.key || KEY, '--file', file, '--dry-run'].concat(args.extra || []);
  try {
    return { status: 0, out: execFileSync('node', [CLI].concat(argv), { encoding: 'utf8', stdio: 'pipe' }) };
  } catch (e) {
    return { status: e.status, out: (e.stdout || '') + (e.stderr || '') };
  }
}

var row = function (extra) {
  return Object.assign({ conversio_id: ID, audiences: ['lapsed_90d'], ts: '1789464054' }, extra || {});
};

// 1. the shapes bq actually produces
var r = run({ body: [row({ audiences: ['lapsed_90d', 'high_aov', 'browsed_outerwear'] })] });
check('reads a bq --format=json array', r.status === 0 && r.out.indexOf('1 valid') !== -1, r.out);
check('writes the key the Worker reads',
  r.out.indexOf('aud:' + KEY + ':' + ID) !== -1, r.out);
check('writes the value shape the Worker expects',
  r.out.indexOf('{"ts":1789464054,"a":["lapsed_90d","high_aov","browsed_outerwear"]}') !== -1, r.out);
check('touches no network on a dry run', r.out.indexOf('no network touched') !== -1);

r = run({ body: JSON.stringify(row()) + '\n' + JSON.stringify(row({ conversio_id: ID2 })) });
check('reads newline-delimited JSON', r.status === 0 && r.out.indexOf('2 valid') !== -1, r.out);

// A REPEATED field comes back as [{"v":"..."}] from some bq paths.
r = run({ body: [row({ audiences: [{ v: 'lapsed_90d' }, { v: 'high_aov' }] })] });
check('reads the legacy repeated-field shape',
  r.status === 0 && r.out.indexOf('"a":["lapsed_90d","high_aov"]') !== -1, r.out);

// BigQuery renders INT64 as a JSON string, so an unquoted ts must work too.
r = run({ body: [row({ ts: 1789464054 })] });
check('accepts a numeric ts as well as a quoted one',
  r.status === 0 && r.out.indexOf('"ts":1789464054') !== -1, r.out);

r = run({ body: [row({ ts: null, computed_at: '2026-09-23 10:00:00 UTC' })] });
check('falls back to computed_at when ts is absent',
  r.status === 0 && r.out.indexOf('"ts":1790157600') !== -1, r.out);

// 2. what must be refused, and the refusal must take the whole file with it
var rejects = [
  ['an audience code with a capital letter', row({ audiences: ['Lapsed_90d'] })],
  ['an audience code with a space', row({ audiences: ['lapsed 90d'] })],
  ['an audience code with a comma', row({ audiences: ['has,comma'] })],
  ['an audience code with a semicolon', row({ audiences: ['has;semi'] })],
  ['an audience code starting with a dash', row({ audiences: ['-leading'] })],
  ['an over-long audience code', row({ audiences: ['x'.repeat(33)] })],
  ['a conversio_id of the wrong shape', row({ conversio_id: 'not-an-id' })],
  ['an uppercase conversio_id', row({ conversio_id: ID.toUpperCase() })],
  ['audiences that is not an array', row({ audiences: 'lapsed_90d' })],
  ['a missing timestamp', row({ ts: null })],
  ['a non-numeric timestamp', row({ ts: 'yesterday' })],
  ['a negative timestamp', row({ ts: '-1' })],
  ['a row that is not an object', 'not-an-object']
];

rejects.forEach(function (pair) {
  var res = run({ body: [pair[1]] });
  check('refuses ' + pair[0], res.status !== 0, res.out);
  check('and writes nothing at all for ' + pair[0],
    res.out.indexOf('Nothing written') !== -1 || res.out.indexOf('No valid rows') !== -1, res.out);
});

// The comma is the one that matters, so the message has to name the code rather
// than counting them: the usual cause is one bad code among many.
r = run({ body: [row({ audiences: ['good', 'has,comma'] })] });
check('names the offending code rather than just counting',
  r.out.indexOf('has,comma') !== -1, r.out);

r = run({ body: [row({ audiences: (function () {
  var a = []; for (var i = 0; i < 30; i++) a.push('code_' + i); return a;
})() })] });
check('refuses more codes than the cookie budget allows',
  r.status !== 0 && r.out.indexOf('30 codes') !== -1, r.out);

// 3. one bad row stops the whole load, unless told otherwise
var mixed = [row(), row({ conversio_id: 'bad' }), row({ conversio_id: ID2 })];
r = run({ body: mixed });
check('one bad row refuses the whole file', r.status !== 0, r.out);
check('and says how to proceed anyway', r.out.indexOf('--skip-invalid') !== -1, r.out);

r = run({ body: mixed, extra: ['--skip-invalid'] });
check('--skip-invalid loads the good rows', r.status === 0, r.out);
check('and still reports what it dropped', r.out.indexOf('1 rejected') !== -1, r.out);

// 4. the mistake most likely to be made: a mistyped client key, which would
//    otherwise write a dataset under a key nothing ever reads.
r = run({ body: [row()], key: 'cvo_short' });
check('refuses a client key of the wrong shape', r.status !== 0, r.out);
check('before reading the file at all', r.out.indexOf('Not a client key') !== -1, r.out);

// 5. files that are not what they claim
r = run({ body: 'not json at all' });
check('refuses a file that is not JSON', r.status !== 0, r.out);
r = run({ body: '{"conversio_id":"' + ID + '"' });
check('refuses truncated JSON', r.status !== 0, r.out);
r = run({ body: [] });
check('refuses an empty export rather than reporting success', r.status !== 0, r.out);

fs.rmSync(DIR, { recursive: true, force: true });

console.log('\nself-hosted/scripts/manage-audiences.mjs: ' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
