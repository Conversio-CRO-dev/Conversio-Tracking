#!/usr/bin/env node
// Client key management for the Conversio tag loader.
// Requires: wrangler installed and logged in (`npx wrangler login`).
//
// Usage:
//   node manage-keys.mjs issue --client "Acme Co" [--version 2.2] [--domains acme.com,www.acme.com]
//   node manage-keys.mjs revoke <key>
//   node manage-keys.mjs activate <key>
//   node manage-keys.mjs update <key> [--client ...] [--version ...] [--domains ...]
//   node manage-keys.mjs verify <key>
//   node manage-keys.mjs show <key>
//   node manage-keys.mjs list
//
// Optional env vars CF_API_TOKEN + CF_ZONE_ID (see README) enable an active
// cache purge after revoke/activate/update, so the change takes effect in
// seconds instead of waiting out the edge cache. Without them, everything
// still works, just with the slower default propagation.

import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const NAMESPACE_BINDING = 'CLIENT_KEYS';
const WRANGLER_CONFIG = new URL('../wrangler.toml', import.meta.url).pathname;
const LOADER_ORIGIN = 'https://tag.conversio.dev';

function wrangler(args) {
  return execFileSync('npx', ['wrangler', ...args, '--config', WRANGLER_CONFIG], {
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
    body: JSON.stringify({ files: [`${LOADER_ORIGIN}/t/${key}.js`] })
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
    console.error('Usage: issue --client "Acme Co" [--version 2.2] [--domains acme.com,www.acme.com]');
    process.exit(1);
  }

  const key = generateKey();
  const record = {
    status: 'active',
    client: flags.client,
    version: flags.version || '2.2'
  };
  if (flags.domains) {
    record.domains = flags.domains.split(',').map((d) => d.trim()).filter(Boolean);
  }

  kvPut(key, record);

  console.log('Key issued for', flags.client);
  console.log(key);
  if (!flags.domains) {
    console.log('(no --domains set - this key will work from any site if it leaks; add one later with `update` if that matters for this client)');
  }
  console.log('\nGTM Custom HTML tag content:\n');
  console.log(`<script src="${LOADER_ORIGIN}/t/${key}.js" async></script>`);
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
  if (!key) { console.error('Usage: update <key> [--client "Acme Co"] [--version 2.2] [--domains a.com,b.com]'); process.exit(1); }

  const record = kvGet(key);
  if (!record) { console.error('No record found for that key'); process.exit(1); }

  const flags = parseFlags(flagArgv);
  if (flags.client) record.client = flags.client;
  if (flags.version) record.version = flags.version;
  if (flags.domains) record.domains = flags.domains.split(',').map((d) => d.trim()).filter(Boolean);

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
    console.log(name, '->', record ? `${record.client} (${record.status})` : 'unreadable');
  }
}

async function cmdVerify(argv) {
  const key = argv[0];
  if (!key) { console.error('Usage: verify <key>'); process.exit(1); }

  const url = `${LOADER_ORIGIN}/t/${key}.js`;
  const res = await fetch(url);
  const body = await res.text();

  if (res.status === 200 && body.startsWith('// CONVERSIO TAG')) {
    const versionLine = body.split('\n')[0];
    console.log(`OK - serving the runtime bundle (${versionLine.replace('// ', '')})`);
    return;
  }

  if (res.status === 429) {
    console.log('RATE LIMITED - this key has exceeded its request cap, check for abuse or raise the limit in wrangler.toml');
    return;
  }

  console.log(`NOT SERVING - status ${res.status}, body: ${body.trim()}`);
  console.log('Check the key exists, is active, and (if domain-locked) that you are testing from an allowed origin.');
}

const [, , command, ...rest] = process.argv;

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
