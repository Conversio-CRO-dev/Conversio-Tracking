#!/usr/bin/env node
// Builds a self-hosted runtime bundle from the GTM copy of the same version.
//
// Usage:
//   node scripts/build-bundle.mjs 2.4.1           # write public/runtime-tag.2.4.1.js
//   node scripts/build-bundle.mjs 2.4.1 --check   # exit 1 if the committed bundle is stale
//
// The GTM file in the repo root is the source of truth and keeps every comment:
// it is what gets read, reviewed and pasted into a client's container. The
// bundle served to visitors is the same code with the comments taken out, which
// is most of what a minifier would buy (comments compress worse than code, so
// they dominate the transfer) without mangling names or reflowing statements.
// The served file is therefore still readable in devtools when something needs
// debugging on a client's site: same identifiers, one statement per line, same
// indentation. Line numbers do shift, since the comment lines are gone.
//
// The licence and copyright header is kept; everything else goes.
//
// Three things stop this from being the usual regex-based comment stripper that
// eventually eats something it shouldn't:
//
//   1. Comments are found by walking the source one character at a time while
//      tracking whether we are inside a string or a regex literal, so a '//'
//      inside a string and the '/' opening a regex can't be mistaken for one.
//   2. The result is compiled (never run) before being written, so a build that
//      would serve a SyntaxError to every page of a client's site fails here.
//   3. test/runtime-tag-<version>.test.js runs the full suite against the file
//      this writes, not against the source it came from, so the served bytes
//      are behaviourally verified rather than assumed.
//
// Dependency-free by design, like the rest of this repo: Node only.

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Script } from 'node:vm';

const ROOT = new URL('../../', import.meta.url);

// The GTM copy wraps itself in comment-marked script tags, for pasting into a
// GTM Custom HTML tag. The bundle is loaded as a real script and has no use for
// them.
const SCRIPT_OPEN = '//<script>';
const SCRIPT_CLOSE = '//</script>';

// The one edit to the header line: the bundle is shared by every client on this
// version, so it carries no client slot.
const HEADER_FROM = 'Client: XXXXXX';
const HEADER_TO = 'Runtime bundle';

// Kept in step with the runtime tag and the loader. Only used as an invariant
// here: however the comments come out, the loader must still find exactly what
// it substitutes.
const TRACKING_ID_SLOT = '@@CONVERSIO_TRACKING_ID@@';

function fail(message) {
  console.error('build-bundle: ' + message);
  process.exit(1);
}

function occurrences(text, needle) {
  return text.split(needle).length - 1;
}

// Characters that can only be followed by an operand, so a '/' after one opens a
// regex literal rather than dividing. Anything else (an identifier, a digit, a
// closing bracket) means the '/' is division.
const OPERAND_EXPECTED = '=(,:[!&|?{};+-*%<>~^';

// The same, for keywords: `return /re/.test(x)` is a regex, and the character
// before the '/' is an ordinary letter, so the tail of the output has to be
// checked too.
const KEYWORD_BEFORE_REGEX = /(?:^|[^\w$])(return|typeof|instanceof|in|new|delete|void|case|do|else|throw|yield)\s*$/;

// Removes comments while leaving everything else, including line breaks, byte
// for byte. Newlines inside a block comment are emitted rather than swallowed,
// which keeps the output the same number of lines as the input: dropEmptiedLines
// below pairs the two up by index to work out which lines held only a comment,
// and that comparison is only sound while they still align.
function stripComments(source) {
  let out = '';
  let i = 0;
  // The last non-whitespace character emitted, which is what decides the
  // regex-or-division question above.
  let prev = '';

  const opensRegex = () => {
    if (prev === '') return true;
    if (OPERAND_EXPECTED.indexOf(prev) !== -1) return true;
    return KEYWORD_BEFORE_REGEX.test(out);
  };

  while (i < source.length) {
    const c = source[i];
    const next = source[i + 1];

    // Line comment: drop it, and drop the whitespace it was trailing so a
    // commented line doesn't leave trailing spaces behind.
    if (c === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') i++;
      out = out.replace(/[ \t]+$/, '');
      continue;
    }

    // Block comment: drop it but keep its line breaks. A comment sitting
    // between two spaces (`catch (e) { /* ignore */ }`) would otherwise leave a
    // double space, so one side of it is dropped.
    if (c === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2);
      const stop = end === -1 ? source.length : end + 2;
      const skipped = source.slice(i, stop);
      i = stop;
      out += '\n'.repeat(occurrences(skipped, '\n'));
      if (/[ \t]$/.test(out) && /^[ \t\r\n]/.test(source.slice(i))) {
        out = out.replace(/[ \t]+$/, '');
      }
      continue;
    }

    // A string or template literal, copied out whole: whatever it contains is
    // data, not code, and must not be inspected for comment markers.
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < source.length) {
        if (source[j] === '\\') { j += 2; continue; }
        if (source[j] === c) { j++; break; }
        j++;
      }
      out += source.slice(i, j);
      prev = c;
      i = j;
      continue;
    }

    // A regex literal, likewise. A '/' inside a character class does not end it.
    if (c === '/' && opensRegex()) {
      let j = i + 1;
      let inClass = false;
      while (j < source.length) {
        const ch = source[j];
        if (ch === '\\') { j += 2; continue; }
        if (ch === '\n') break;
        if (ch === '[') inClass = true;
        else if (ch === ']') inClass = false;
        else if (ch === '/' && !inClass) { j++; break; }
        j++;
      }
      while (j < source.length && /[a-z]/i.test(source[j])) j++;
      out += source.slice(i, j);
      prev = source[j - 1];
      i = j;
      continue;
    }

    out += c;
    if (!/\s/.test(c)) prev = c;
    i++;
  }

  return out;
}

// Drops the lines that held nothing but a comment, keeps the blank lines the
// author put there, and collapses the runs of blank lines that comment removal
// leaves behind. The result reads like the source with the prose deleted, which
// is the point: it is still line-per-statement and still indented.
function dropEmptiedLines(stripped, original) {
  const strippedLines = stripped.split('\n');
  const originalLines = original.split('\n');

  if (strippedLines.length !== originalLines.length) {
    fail('line count changed during comment removal, refusing to write');
  }

  const kept = strippedLines.filter((line, index) => (
    line.trim() !== '' || originalLines[index].trim() === ''
  ));

  const out = [];
  for (const line of kept) {
    const blank = line.trim() === '';
    if (blank && (out.length === 0 || out[out.length - 1].trim() === '')) continue;
    out.push(line);
  }
  while (out.length && out[out.length - 1].trim() === '') out.pop();

  return out.join('\n');
}

function build(version) {
  const sourceUrl = new URL(`conversio_runtime_tag_v${version}.js`, ROOT);
  let source;

  try {
    source = readFileSync(sourceUrl, 'utf8');
  } catch (e) {
    fail(`cannot read ${fileURLToPath(sourceUrl)}`);
  }

  const lines = source.split('\n');
  const closeIndex = lines.lastIndexOf(SCRIPT_CLOSE);

  if (lines[0] !== SCRIPT_OPEN) fail(`expected ${SCRIPT_OPEN} on line 1 of the GTM file`);
  if (closeIndex === -1) fail(`expected ${SCRIPT_CLOSE} at the end of the GTM file`);
  if (lines[1].indexOf(HEADER_FROM) === -1) fail(`line 2 does not look like the tag header: ${lines[1]}`);
  if (lines[1].indexOf(`version ${version}`) === -1) fail(`header does not say version ${version}: ${lines[1]}`);
  if (lines[2].indexOf('Copyright') === -1) fail(`line 3 is not the copyright notice: ${lines[2]}`);

  // Lines 2 and 3 of the GTM file: the version header, with the client slot
  // relabelled, and the copyright notice. The only comments the bundle keeps.
  const header = [lines[1].replace(HEADER_FROM, HEADER_TO), lines[2]];
  const body = lines.slice(3, closeIndex).join('\n');
  const output = header.join('\n') + '\n' + dropEmptiedLines(stripComments(body), body) + '\n';

  if (occurrences(output, TRACKING_ID_SLOT) !== occurrences(source, TRACKING_ID_SLOT)) {
    fail('the tracking ID slot did not survive comment removal intact');
  }

  // Compiled, not run: a bundle that cannot parse would take out tracking on
  // every page of every client on this version, so it must never be written.
  try {
    new Script(output, { filename: `runtime-tag.${version}.js` });
  } catch (e) {
    fail(`the built bundle does not parse: ${e.message}`);
  }

  return output;
}

const [, , version, flag] = process.argv;

if (!version) {
  console.error('Usage: node scripts/build-bundle.mjs <version> [--check]');
  process.exit(1);
}

const bundleUrl = new URL(`../public/runtime-tag.${version}.js`, import.meta.url);
const built = build(version);

if (flag === '--check') {
  let current;
  try {
    current = readFileSync(bundleUrl, 'utf8');
  } catch (e) {
    fail(`no bundle at ${fileURLToPath(bundleUrl)} yet, run without --check to write it`);
  }
  if (current !== built) {
    fail(`public/runtime-tag.${version}.js is out of date, rebuild it from conversio_runtime_tag_v${version}.js`);
  }
  console.log(`runtime-tag.${version}.js is up to date with the GTM file`);
} else {
  const before = (() => {
    try { return readFileSync(bundleUrl, 'utf8').length; } catch (e) { return null; }
  })();
  writeFileSync(bundleUrl, built);
  const saved = before === null ? '' : `, was ${before} bytes`;
  console.log(`wrote public/runtime-tag.${version}.js (${built.length} bytes${saved})`);
}
