#!/usr/bin/env node
// Client key management for the Conversio tag loader.
// Requires: wrangler installed and logged in (`npx wrangler login`).
//
// Usage:
//   node manage-keys.mjs issue --client "Acme Co" [--version 2.2] [--domains acme.com,www.acme.com]
//   node manage-keys.mjs revoke <key>
//   node manage-keys.mjs activate <key>
//   node manage-keys.mjs show <key>
//   node manage-keys.mjs list

import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const NAMESPACE_BINDING = 'CLIENT_KEYS';
const WRANGLER_CONFIG = new URL('../wrangler.toml', import.meta.url).pathname;

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
  console.log('\nGTM Custom HTML tag content:\n');
  console.log(`<script src="https://tag.conversio.dev/t/${key}.js" async></script>`);
}

function cmdRevoke(argv) {
  const key = argv[0];
  if (!key) { console.error('Usage: revoke <key>'); process.exit(1); }

  const record = kvGet(key);
  if (!record) { console.error('No record found for that key'); process.exit(1); }

  record.status = 'revoked';
  kvPut(key, record);
  console.log('Revoked key for', record.client);
}

function cmdActivate(argv) {
  const key = argv[0];
  if (!key) { console.error('Usage: activate <key>'); process.exit(1); }

  const record = kvGet(key);
  if (!record) { console.error('No record found for that key'); process.exit(1); }

  record.status = 'active';
  kvPut(key, record);
  console.log('Activated key for', record.client);
}

function cmdUpdate(argv) {
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

const [, , command, ...rest] = process.argv;

switch (command) {
  case 'issue': cmdIssue(rest); break;
  case 'revoke': cmdRevoke(rest); break;
  case 'activate': cmdActivate(rest); break;
  case 'update': cmdUpdate(rest); break;
  case 'show': cmdShow(rest); break;
  case 'list': cmdList(); break;
  default:
    console.error('Unknown command. Use: issue | revoke | activate | update | show | list');
    process.exit(1);
}
