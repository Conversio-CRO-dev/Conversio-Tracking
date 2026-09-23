#!/usr/bin/env node
// Client key management for the Conversio tag loader.
// Requires: wrangler installed and logged in (`npx wrangler login`).
//
// Usage:
//   node manage-keys.mjs issue --client "Acme Co" [--version 2.2] [--domains acme.com,www.acme.com] [--tracking-id G-XXXXXXXXXX]
//   node manage-keys.mjs revoke <key>
//   node manage-keys.mjs activate <key>
//   node manage-keys.mjs update <key> [--client ...] [--version ...] [--domains ...] [--tracking-id ...] [--audiences true|false]
//   node manage-keys.mjs verify <key>
//   node manage-keys.mjs show <key>
//   node manage-keys.mjs list
//
// A --version is checked against the bundles in public/ before anything is
// written, for both issue and update. Pinning a key to a version nobody
// deployed is not a visible error: the Worker serves that client the inactive
// stub behind a clean 200 and their tracking simply stops.
//
// Any command takes an optional --env, targeting a wrangler environment:
//   node manage-keys.mjs list --env staging
// With no --env this is production, matching wrangler, where production is the
// top-level config rather than a named environment. The flag is stripped before
// dispatch so no command has to know about it, and the environment is printed
// by every mutating command: the whole hazard a staging flag introduces is
// doing the right thing to the wrong environment.
//
// A non-production environment needs CONVERSIO_LOADER_ORIGIN set to its
// hostname, which `issue` prints into the snippet and `verify` fetches. There is
// deliberately no default, since a wrong guess would have `verify` reporting
// confidently on a URL nobody is serving.
//
// Optional env vars CF_API_TOKEN + CF_ZONE_ID (see README) enable an active
// cache purge after revoke/activate/update, so the change takes effect in
// seconds instead of waiting out the edge cache. Without them, everything
// still works, just with the slower default propagation.

import { randomBytes } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const NAMESPACE_BINDING = 'CLIENT_KEYS';
const WRANGLER_CONFIG = new URL('../wrangler.toml', import.meta.url).pathname;
const PRODUCTION_ORIGIN = 'https://tag.conversio.dev';

// Pulled out of process.argv before dispatch, so each command's own flag
// parsing is untouched by it.
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

// Production is the top-level wrangler config and takes no --env, so an
// environment being set at all means this is not production.
function loaderOrigin() {
  if (!ENV) return PRODUCTION_ORIGIN;

  const origin = (process.env.CONVERSIO_LOADER_ORIGIN || '').replace(/\/+$/, '');
  if (!origin) {
    console.error(`--env ${ENV} needs CONVERSIO_LOADER_ORIGIN set to that environment's hostname, e.g.`);
    console.error('  CONVERSIO_LOADER_ORIGIN=https://conversio-tag-loader-staging.<subdomain>.workers.dev');
    console.error('No default on purpose: guessing it would have `verify` report on a URL nobody serves.');
    process.exit(1);
  }
  return origin;
}

// Printed by every command that writes, because the failure this flag creates
// is doing the right thing to the wrong environment.
function announceEnv() {
  console.log(ENV ? `(environment: ${ENV})` : '(environment: production)');
}

// A GA measurement ID. Checked here so a typo is caught while someone is still
// looking at the terminal, rather than shipping a dead property ID that nobody
// notices for weeks. The Worker applies its own, looser, safe-to-inject check
// on the way out (see src/index.js) since a record edited straight in the
// Cloudflare dashboard never comes through here.
const TRACKING_ID_PATTERN = /^G-[A-Z0-9]{4,20}$/;

// The bundles the Worker serves from, and the only versions a key can name.
const BUNDLE_DIR = new URL('../public/', import.meta.url);
const BUNDLE_NAME = /^runtime-tag\.([0-9]+(?:\.[0-9]+){1,3})\.js$/;

// Numeric per component, so 3.1 sorts above 2.6.3 rather than below it the way
// a string compare would have it.
function compareVersions(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

function availableVersions() {
  try {
    return readdirSync(BUNDLE_DIR)
      .map((name) => (name.match(BUNDLE_NAME) || [])[1])
      .filter(Boolean)
      .sort(compareVersions);
  } catch (e) {
    return [];
  }
}

// A version is spliced into an asset URL by the Worker and decides what every
// page of a client's site runs, so a typo in one is not a typo. The Worker finds
// no such asset, logs asset_missing, and serves the inactive stub: that client's
// tracking goes silent behind a clean 200, with nothing surfaced to them or to
// whoever ran this. Much cheaper to fail at the terminal while someone is still
// looking at it.
//
// What this checks is the working tree, which is where a deploy comes from, and
// deliberately not the deployment. The bundle is not fetchable at a bare path,
// the Worker answering anything but /t/<key>.js with a 404, so there is nothing
// to probe from out here. `verify` is what proves what a client is really being
// served, and it stays the step after any change to a version.
function checkVersion(raw) {
  const value = String(raw).trim();
  const versions = availableVersions();

  if (versions.indexOf(value) !== -1) return value;

  console.error(`No bundle for version "${value}" in self-hosted/public/.`);
  if (versions.length) {
    console.error(`Available: ${versions.join(', ')}`);
    console.error('Pinning a key to a version nobody deployed serves that client the inactive');
    console.error('stub, which looks to them exactly like working tracking that reports nothing.');
    console.error('If the version is real but new, pull first: this reads your working tree.');
  } else {
    console.error('No bundles found there at all. Run this from the self-hosted/ directory.');
  }
  process.exit(1);
}

// Matches the line the Worker substitutes, so `verify` can report what a
// client is actually being served rather than what KV claims.
const SERVED_TRACKING_ID = /TRACKING_ID_SLOT\s*=\s*'([^']*)'/;

// Whether this client has audiences, which gates the /a/ route on the Worker.
// Deliberately strict rather than truthy: the only useful default would be "on",
// and a typo read as consent to serve visitor-level data is the wrong way round
// to fail. Same argument the consent queue makes for stepping over an
// unrecognised command.
const AUDIENCES_ON = ['true', 'on', 'yes', '1'];
const AUDIENCES_OFF = ['false', 'off', 'no', '0', ''];

function normaliseAudiences(raw) {
  const value = String(raw === undefined ? '' : raw).trim().toLowerCase();
  if (AUDIENCES_ON.indexOf(value) !== -1) return true;
  if (AUDIENCES_OFF.indexOf(value) !== -1) return false;
  console.error(`Invalid --audiences "${raw}". Expected one of: ${AUDIENCES_ON.concat(AUDIENCES_OFF.filter(Boolean)).join(', ')}.`);
  process.exit(1);
}

function normaliseTrackingId(raw) {
  // Upper-cased before checking: GA issues these uppercase and there is no
  // valid lowercase variant to confuse it with, so a lowercased one is a
  // transcription artifact rather than a different ID.
  const value = (raw || '').trim().toUpperCase();
  if (!value) return null;
  if (!TRACKING_ID_PATTERN.test(value)) {
    console.error(`Invalid --tracking-id "${raw.trim()}". Expected a GA measurement ID, e.g. G-J4EDMZMNY9.`);
    process.exit(1);
  }
  return value;
}

function wrangler(args) {
  const envArgs = ENV ? ['--env', ENV] : [];
  return execFileSync('npx', ['wrangler', ...args, '--config', WRANGLER_CONFIG, ...envArgs], {
    encoding: 'utf8'
  });
}

function generateKey() {
  return 'cvo_' + randomBytes(18).toString('base64url');
}

function parseFlags(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i += 2) {
    const name = argv[i].replace(/^--/, '');
    flags[name] = argv[i + 1];
  }
  return flags;
}

function kvPut(key, record) {
  wrangler(['kv', 'key', 'put', '--binding', NAMESPACE_BINDING, '--remote', key, JSON.stringify(record)]);
}

function kvGet(key) {
  try {
    const raw = wrangler(['kv', 'key', 'get', '--binding', NAMESPACE_BINDING, '--remote', key]);
    return JSON.parse(raw);
  } catch (e) {
    return null;
  }
}

async function purgeUrl(key) {
  // The purge targets a zone on conversio.dev. A non-production environment is
  // on workers.dev, which is not that zone and has nothing cached in front of
  // it anyway, so purging would either fail or clear something else entirely.
  if (ENV) {
    console.log(`(environment ${ENV} is not behind the conversio.dev zone, skipping cache purge)`);
    return;
  }

  const token = process.env.CF_API_TOKEN;
  const zoneId = process.env.CF_ZONE_ID;
  if (!token || !zoneId) {
    console.log('(CF_API_TOKEN/CF_ZONE_ID not set, skipping cache purge - change will take effect within the edge cache TTL instead)');
    return;
  }

  const res = await fetch(`https://api.cloudflare.com/client/v4/zones/${zoneId}/purge_cache`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ files: [`${loaderOrigin()}/t/${key}.js`] })
  });

  const body = await res.json();
  if (!body.success) {
    console.error('Cache purge failed:', JSON.stringify(body.errors));
    return;
  }
  console.log('Cache purged, change is effective immediately.');
}

function cmdIssue(argv) {
  const flags = parseFlags(argv);
  if (!flags.client) {
    console.error('Usage: issue --client "Acme Co" [--version 2.2] [--domains acme.com,www.acme.com] [--tracking-id G-XXXXXXXXXX]');
    process.exit(1);
  }

  // Before the key is generated and before anything is written, so a bad
  // version costs nothing and leaves nothing behind. The default goes through
  // the same check, an unvalidated default being exactly as dangerous as an
  // unvalidated flag.
  const version = checkVersion(flags.version || '2.2');

  const key = generateKey();
  const record = {
    status: 'active',
    client: flags.client,
    version: version
  };
  if (flags.domains) {
    record.domains = flags.domains.split(',').map((d) => d.trim()).filter(Boolean);
  }
  const trackingId = normaliseTrackingId(flags['tracking-id']);
  if (trackingId) record.trackingId = trackingId;
  if ('audiences' in flags && normaliseAudiences(flags.audiences)) record.audiences = true;

  kvPut(key, record);

  console.log('Key issued for', flags.client);
  console.log(key);
  if (!flags.domains) {
    console.log('(no --domains set - this key will work from any site if it leaks; add one later with `update` if that matters for this client)');
  }
  if (trackingId) {
    console.log(`(tracking ID ${trackingId}, readable by the tag as window.conversioSettings.trackingId)`);
  } else {
    console.log('(no --tracking-id set - window.conversioSettings.trackingId will be null for this client; add one later with `update`)');
  }
  console.log('\nGTM Custom HTML tag content:\n');
  console.log(`<script src="${loaderOrigin()}/t/${key}.js" async></script>`);
}

async function cmdRevoke(argv) {
  const key = argv[0];
  if (!key) { console.error('Usage: revoke <key>'); process.exit(1); }

  const record = kvGet(key);
  if (!record) { console.error('No record found for that key'); process.exit(1); }

  record.status = 'revoked';
  kvPut(key, record);
  console.log('Revoked key for', record.client);
  await purgeUrl(key);
}

async function cmdActivate(argv) {
  const key = argv[0];
  if (!key) { console.error('Usage: activate <key>'); process.exit(1); }

  const record = kvGet(key);
  if (!record) { console.error('No record found for that key'); process.exit(1); }

  record.status = 'active';
  kvPut(key, record);
  console.log('Activated key for', record.client);
  await purgeUrl(key);
}

async function cmdUpdate(argv) {
  const [key, ...flagArgv] = argv;
  if (!key) { console.error('Usage: update <key> [--client "Acme Co"] [--version 2.2] [--domains a.com,b.com] [--tracking-id G-XXXXXXXXXX]'); process.exit(1); }

  // EVERY flag is validated before the lookup, so a typo fails at the terminal
  // without a network round trip and without a record sitting half-updated in
  // memory. Each of these exits the process on a bad value, so a validation that
  // ran after kvGet would already have cost a read and, worse, would abort
  // partway through applying the rest.
  const flags = parseFlags(flagArgv);
  const version = flags.version ? checkVersion(flags.version) : null;
  // Present-but-empty (--tracking-id "") clears it, so a wrong ID can be removed
  // and not just replaced. null therefore means two different things depending on
  // whether the flag was passed at all, which is why both are read here.
  const trackingId = 'tracking-id' in flags ? normaliseTrackingId(flags['tracking-id']) : null;
  const audiences = 'audiences' in flags ? normaliseAudiences(flags.audiences) : null;

  const record = kvGet(key);
  if (!record) { console.error('No record found for that key'); process.exit(1); }

  if (flags.client) record.client = flags.client;
  if (version) record.version = version;
  if (flags.domains) record.domains = flags.domains.split(',').map((d) => d.trim()).filter(Boolean);
  if ('tracking-id' in flags) {
    if (trackingId) record.trackingId = trackingId;
    else delete record.trackingId;
  }
  // Absent rather than false when off, so a record carries the flag only when it
  // means something. The Worker tests for === true, so both read the same.
  if (audiences !== null) {
    if (audiences) record.audiences = true;
    else delete record.audiences;
  }

  kvPut(key, record);
  console.log('Updated key for', record.client);
  console.log(JSON.stringify(record, null, 2));
  await purgeUrl(key);
}

function cmdShow(argv) {
  const key = argv[0];
  if (!key) { console.error('Usage: show <key>'); process.exit(1); }

  const record = kvGet(key);
  if (!record) { console.error('No record found for that key'); process.exit(1); }

  console.log(JSON.stringify(record, null, 2));
}

function cmdList() {
  const raw = wrangler(['kv', 'key', 'list', '--binding', NAMESPACE_BINDING, '--remote']);
  const keys = JSON.parse(raw);
  for (const { name } of keys) {
    const record = kvGet(name);
    if (!record) { console.log(name, '-> unreadable'); continue; }
    // Version and tracking ID inline: during a staged rollout the thing you
    // need to see at a glance is which clients have moved and which have not.
    const bits = [
      record.status,
      'v' + (record.version || 'default'),
      record.trackingId || 'no tracking id',
      record.audiences === true ? 'audiences' : 'no audiences'
    ];
    console.log(name, '->', `${record.client} (${bits.join(', ')})`);
  }
}

async function cmdVerify(argv) {
  const key = argv[0];
  if (!key) { console.error('Usage: verify <key>'); process.exit(1); }

  const url = `${loaderOrigin()}/t/${key}.js`;
  const res = await fetch(url);
  const body = await res.text();

  if (res.status === 200 && body.startsWith('// CONVERSIO TAG')) {
    const versionLine = body.split('\n')[0];
    console.log(`OK - serving the runtime bundle (${versionLine.replace('// ', '')})`);

    // Read back what was actually substituted into the served bytes, which is
    // the only way to confirm the tracking ID survived KV, the Worker's own
    // safety check, and the edge cache.
    const served = body.match(SERVED_TRACKING_ID);
    if (!served) {
      console.log('Tracking ID: not supported by this bundle version');
    } else if (!served[1]) {
      console.log('Tracking ID: none configured (window.conversioSettings.trackingId will be null)');
    } else {
      console.log(`Tracking ID: ${served[1]}`);
    }
    return;
  }

  if (res.status === 429) {
    console.log('RATE LIMITED - this key has exceeded its request cap, check for abuse or raise the limit in wrangler.toml');
    return;
  }

  console.log(`NOT SERVING - status ${res.status}, body: ${body.trim()}`);
  console.log('Check the key exists, is active, and (if domain-locked) that you are testing from an allowed origin.');
}

const [command, ...rest] = ARGV;

if (['issue', 'revoke', 'activate', 'update'].includes(command)) announceEnv();

switch (command) {
  case 'issue': cmdIssue(rest); break;
  case 'revoke': await cmdRevoke(rest); break;
  case 'activate': await cmdActivate(rest); break;
  case 'update': await cmdUpdate(rest); break;
  case 'verify': await cmdVerify(rest); break;
  case 'show': cmdShow(rest); break;
  case 'list': cmdList(); break;
  default:
    console.error('Unknown command. Use: issue | revoke | activate | update | verify | show | list');
    process.exit(1);
}
