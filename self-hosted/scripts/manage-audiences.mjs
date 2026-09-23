#!/usr/bin/env node
// Audience data management for the Conversio tag loader.
// Requires: wrangler installed and logged in (`npx wrangler login`).
//
// Loads rows derived in BigQuery into the AUDIENCES KV namespace, where the
// Worker's /a/<clientKey>/<conversio_id> route serves them. See
// docs/v3-architecture.md and bigquery/audience_membership.sql.
//
// Usage:
//   node manage-audiences.mjs load <clientKey> --file rows.json [--dry-run] [--skip-invalid] [--force]
//   node manage-audiences.mjs show <clientKey> <conversioId>
//   node manage-audiences.mjs list <clientKey> [--limit 20]
//   node manage-audiences.mjs delete <clientKey> <conversioId>
//
// Every command takes --env, as manage-keys.mjs does.
//
// The expected export, which produces exactly the fields this wants:
//
//   bq query --nouse_legacy_sql --format=json \
//     'SELECT conversio_id, audiences, UNIX_SECONDS(computed_at) AS ts
//        FROM `PROJECT.conversio_v3.audience_membership`' > rows.json
//
// --dry-run validates the file and reports, touching no network at all, which
// is how to check an export before it goes anywhere near a live namespace.

import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const AUDIENCES_BINDING = 'AUDIENCES';
const CLIENT_KEYS_BINDING = 'CLIENT_KEYS';
const WRANGLER_CONFIG = new URL('../wrangler.toml', import.meta.url).pathname;

// Mirrors of what the Worker enforces, and deliberately duplicated rather than
// imported: this catches a bad export while someone is looking at the terminal,
// the Worker catches a record hand-edited through the Cloudflare dashboard that
// never passed through here. Same two-sided arrangement as the tracking ID.
const CLIENT_KEY_SAFE = /^[A-Za-z0-9_-]{16,64}$/;
const CONVERSIO_ID_SAFE = /^con_[a-z2-7]{16}\.[0-9]{1,20}$/;
const AUDIENCE_CODE_SAFE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const MAX_CODES = 24;

// wrangler's bulk endpoint takes 10,000 pairs; 5,000 leaves room for long keys
// without anyone having to think about the payload ceiling.
const CHUNK = 5000;

function extractEnv(argv) {
  const i = argv.indexOf('--env');
  if (i === -1) return { env: null, argv };
  const value = argv[i + 1];
  if (!value || value.startsWith('--')) {
    console.error('--env needs a value, e.g. --env staging');
    process.exit(1);
  }
  return { env: value, argv: argv.slice(0, i).concat(argv.slice(i + 2)) };
}

const { env: ENV, argv: ARGV } = extractEnv(process.argv.slice(2));

function announceEnv() {
  console.log(`(environment: ${ENV || 'production'})`);
}

function wrangler(args) {
  const envArgs = ENV ? ['--env', ENV] : [];
  return execFileSync('npx', ['wrangler', ...args, '--config', WRANGLER_CONFIG, ...envArgs], {
    encoding: 'utf8'
  });
}

function parseFlags(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) { positional.push(argv[i]); continue; }
    const name = argv[i].replace(/^--/, '');
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) { flags[name] = true; continue; }
    flags[name] = next;
    i++;
  }
  return { flags, positional };
}

function requireClientKey(key) {
  if (!key || !CLIENT_KEY_SAFE.test(key)) {
    console.error(`Not a client key: "${key || ''}". Expected cvo_... as issued by manage-keys.mjs.`);
    process.exit(1);
  }
  return key;
}

function audienceKey(clientKey, conversioId) {
  return `aud:${clientKey}:${conversioId}`;
}

// ---------------------------------------------------------------------------
// Reading an export
// ---------------------------------------------------------------------------

// bq writes a JSON array with --format=json and newline-delimited JSON from
// `bq extract`, and both are things someone will reasonably hand this. Accepting
// either costs four lines and saves a confusing failure on a file that is
// perfectly valid, just not the shape that was assumed.
function parseRows(text) {
  const trimmed = text.trim();
  if (!trimmed) return [];

  if (trimmed.startsWith('[')) {
    const parsed = JSON.parse(trimmed);
    if (!Array.isArray(parsed)) throw new Error('expected an array of rows');
    return parsed;
  }

  return trimmed.split('\n').filter((l) => l.trim()).map((l, i) => {
    try { return JSON.parse(l); }
    catch (e) { throw new Error(`line ${i + 1} is not JSON: ${l.slice(0, 60)}`); }
  });
}

// A REPEATED field comes back as a plain array from modern bq and as
// [{"v": "..."}] from some older paths and from the legacy API. Both mean the
// same thing, so both are read.
function readCodes(raw) {
  if (!Array.isArray(raw)) return null;
  return raw.map((entry) => {
    if (typeof entry === 'string') return entry;
    if (entry && typeof entry === 'object' && typeof entry.v === 'string') return entry.v;
    return entry;
  });
}

// BigQuery renders INT64 as a JSON string, so a ts that looks like a number in
// the console arrives here quoted. computed_at is accepted as a fallback for an
// export that forgot to convert it.
function readTimestamp(row) {
  if (row.ts !== undefined && row.ts !== null) {
    const n = Number(row.ts);
    return Number.isFinite(n) ? Math.floor(n) : NaN;
  }
  if (row.computed_at) {
    const ms = Date.parse(String(row.computed_at).replace(' UTC', 'Z').replace(' ', 'T'));
    return Number.isFinite(ms) ? Math.floor(ms / 1000) : NaN;
  }
  return NaN;
}

// Every row is checked before any of them is written. A half-loaded dataset from
// a bad export is worse than a refused one: the rows that landed are
// indistinguishable from correct ones afterwards.
function validate(rows) {
  const ok = [];
  const problems = [];

  rows.forEach((row, i) => {
    const where = `row ${i + 1}`;

    if (!row || typeof row !== 'object') {
      problems.push(`${where}: not an object`);
      return;
    }

    const id = row.conversio_id;
    if (typeof id !== 'string' || !CONVERSIO_ID_SAFE.test(id)) {
      problems.push(`${where}: conversio_id is not a valid id (${JSON.stringify(id)})`);
      return;
    }

    const codes = readCodes(row.audiences);
    if (codes === null) {
      problems.push(`${where}: audiences is not an array (${JSON.stringify(row.audiences)})`);
      return;
    }

    const bad = codes.filter((c) => typeof c !== 'string' || !AUDIENCE_CODE_SAFE.test(c));
    if (bad.length) {
      // Named rather than counted, because the usual cause is one code with a
      // capital letter or a space in it, and seeing which is the whole fix.
      problems.push(`${where}: unusable audience code(s) ${JSON.stringify(bad)} - must match ${AUDIENCE_CODE_SAFE}`);
      return;
    }

    if (codes.length > MAX_CODES) {
      problems.push(`${where}: ${codes.length} codes, the cookie budget allows ${MAX_CODES}`);
      return;
    }

    const ts = readTimestamp(row);
    if (!Number.isFinite(ts) || ts <= 0) {
      problems.push(`${where}: no usable timestamp (ts or computed_at)`);
      return;
    }

    ok.push({ conversio_id: id, value: { ts, a: codes } });
  });

  return { ok, problems };
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function cmdLoad(argv) {
  const { flags, positional } = parseFlags(argv);
  const clientKey = requireClientKey(positional[0]);

  if (!flags.file || flags.file === true) {
    console.error('Usage: load <clientKey> --file rows.json [--dry-run] [--skip-invalid] [--force]');
    process.exit(1);
  }

  let rows;
  try {
    rows = parseRows(readFileSync(flags.file, 'utf8'));
  } catch (e) {
    console.error(`Could not read ${flags.file}: ${e.message}`);
    process.exit(1);
  }

  const { ok, problems } = validate(rows);

  console.log(`${rows.length} row(s) read, ${ok.length} valid, ${problems.length} rejected.`);
  if (problems.length) {
    problems.slice(0, 20).forEach((p) => console.log('  ' + p));
    if (problems.length > 20) console.log(`  ... and ${problems.length - 20} more`);
  }

  if (problems.length && !flags['skip-invalid']) {
    console.error('\nNothing written. Fix the export, or pass --skip-invalid to load the valid rows only.');
    process.exit(1);
  }

  if (!ok.length) {
    console.error('No valid rows to write.');
    process.exit(1);
  }

  // Deliberately before anything that touches the network, so this is a real
  // offline check of an export rather than a check that happens to skip the
  // last step.
  if (flags['dry-run']) {
    console.log('\n--dry-run: nothing written, no network touched. Would write:');
    ok.slice(0, 5).forEach((r) => {
      console.log(`  ${audienceKey(clientKey, r.conversio_id)} = ${JSON.stringify(r.value)}`);
    });
    if (ok.length > 5) console.log(`  ... and ${ok.length - 5} more`);
    return;
  }

  announceEnv();

  // Catches the mistake this command is most likely to make: a mistyped client
  // key, which would otherwise write a dataset under a key nothing ever reads
  // and leave it there, orphaned and invisible.
  const record = clientRecord(clientKey);
  if (!record) {
    console.error(`\nNo client key record for ${clientKey}. Check the key with manage-keys.mjs list.`);
    process.exit(1);
  }
  if (record.audiences !== true && !flags.force) {
    console.error(`\n${record.client} does not have audiences enabled, so the route will not serve these.`);
    console.error(`Enable it first:\n  node scripts/manage-keys.mjs update ${clientKey} --audiences true`);
    console.error('Or pass --force to load the data anyway and enable it later.');
    process.exit(1);
  }

  let written = 0;
  for (let i = 0; i < ok.length; i += CHUNK) {
    const chunk = ok.slice(i, i + CHUNK).map((r) => ({
      key: audienceKey(clientKey, r.conversio_id),
      value: JSON.stringify(r.value)
    }));
    bulkPut(chunk);
    written += chunk.length;
    if (ok.length > CHUNK) console.log(`  ${written}/${ok.length}`);
  }

  console.log(`\nWrote ${written} audience record(s) for ${record.client}.`);
  console.log(`Check one with:\n  node scripts/manage-audiences.mjs show ${clientKey} ${ok[0].conversio_id}`);
}

function bulkPut(pairs) {
  const file = join(tmpdir(), `conversio-audiences-${process.pid}-${Date.now()}.json`);
  writeFileSync(file, JSON.stringify(pairs));
  try {
    wrangler(['kv', 'bulk', 'put', file, '--binding', AUDIENCES_BINDING, '--remote']);
  } finally {
    try { unlinkSync(file); } catch (e) { /* best effort */ }
  }
}

function clientRecord(clientKey) {
  try {
    return JSON.parse(wrangler(['kv', 'key', 'get', '--binding', CLIENT_KEYS_BINDING, '--remote', clientKey]));
  } catch (e) {
    return null;
  }
}

function cmdShow(argv) {
  const { positional } = parseFlags(argv);
  const clientKey = requireClientKey(positional[0]);
  const id = positional[1];

  if (!id || !CONVERSIO_ID_SAFE.test(id)) {
    console.error(`Not a conversio_id: "${id || ''}". Expected con_<16 chars>.<digits>.`);
    process.exit(1);
  }

  try {
    const raw = wrangler(['kv', 'key', 'get', '--binding', AUDIENCES_BINDING, '--remote',
      audienceKey(clientKey, id)]);
    const value = JSON.parse(raw);
    console.log(JSON.stringify(value, null, 2));
    const age = Math.floor(Date.now() / 1000) - (value.ts || 0);
    console.log(`\ncomputed ${Math.floor(age / 3600)}h ago`);
  } catch (e) {
    console.log('No audience record for that visitor.');
    console.log('That is a normal state: most visitors are in no audience, and the route answers');
    console.log('them with an empty list rather than an error.');
  }
}

function cmdList(argv) {
  const { flags, positional } = parseFlags(argv);
  const clientKey = requireClientKey(positional[0]);
  const limit = Number(flags.limit || 20);

  const raw = wrangler(['kv', 'key', 'list', '--binding', AUDIENCES_BINDING, '--remote',
    '--prefix', `aud:${clientKey}:`]);
  const keys = JSON.parse(raw);

  console.log(`${keys.length} audience record(s) for ${clientKey}.`);
  keys.slice(0, limit).forEach((k) => console.log('  ' + k.name.split(':').slice(2).join(':')));
  if (keys.length > limit) console.log(`  ... and ${keys.length - limit} more (--limit to see more)`);
}

// One visitor at a time, which is what an erasure request needs. There is no
// bulk delete here on purpose: emptying a client's audiences is a thing to do
// deliberately and rarely, and a reload overwrites anyway.
function cmdDelete(argv) {
  const { positional } = parseFlags(argv);
  const clientKey = requireClientKey(positional[0]);
  const id = positional[1];

  if (!id || !CONVERSIO_ID_SAFE.test(id)) {
    console.error(`Not a conversio_id: "${id || ''}".`);
    process.exit(1);
  }

  announceEnv();
  wrangler(['kv', 'key', 'delete', '--binding', AUDIENCES_BINDING, '--remote',
    audienceKey(clientKey, id)]);
  console.log(`Deleted the audience record for ${id}.`);
  console.log('Note this is one of three stores: the BigQuery row and any cookie already on');
  console.log('that visitor\'s browser are unaffected. See docs/v3-architecture.md §9.5.');
}

const [command, ...rest] = ARGV;

switch (command) {
  case 'load': cmdLoad(rest); break;
  case 'show': cmdShow(rest); break;
  case 'list': cmdList(rest); break;
  case 'delete': cmdDelete(rest); break;
  default:
    console.error('Unknown command. Use: load | show | list | delete');
    process.exit(1);
}
