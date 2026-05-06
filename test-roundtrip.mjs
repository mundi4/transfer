#!/usr/bin/env node
// Round-trip verification: parse index.html exactly the way the receiving
// decoder is expected to (BEGIN/END marker pattern), reconstruct each
// archive, decompress, untar, and compare sha256 against fonts/.

import { readFileSync, mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const sha = b => createHash('sha256').update(b).digest('hex');

// 1. Read originals.
const fontsDir = 'fonts';
const originals = {};
for (const f of readdirSync(fontsDir)) {
  originals[f] = sha(readFileSync(join(fontsDir, f)));
}
console.log('originals:');
for (const [f, h] of Object.entries(originals)) console.log(`  ${h}  ${f}`);

// 2. Pull the GROUPS data straight out of index.html.
//    Extract the JSON-ish literal between `const GROUPS = ` and `;\nconst state`.
const html = readFileSync('index.html', 'utf-8');
const m = html.match(/const GROUPS = (\[[\s\S]*?\]);\nconst done =/);
if (!m) { console.error('cannot locate GROUPS in index.html'); process.exit(1); }
// The data is JSON with < escaping for `<`. JSON.parse handles \u escapes.
const GROUPS = JSON.parse(m[1]);
console.log(`\nfound ${GROUPS.length} groups in index.html`);

// 3. For each group, simulate the destination decoder:
//    - Parse part strings, find BEGIN/END markers
//    - Concat base64 lines (in numeric order)
//    - base64-decode → write to .tar.xz → xz -d → tar xf → sha256 compare
const tmp = mkdtempSync(join(tmpdir(), 'roundtrip-'));
let allOk = true;

for (const g of GROUPS) {
  console.log(`\n[${g.label}] ${g.kind}, ${g.parts.length} parts, expected sha256=${g.sha256}`);
  // Pretend the parts arrive as a single concatenated text blob (worst-case).
  const blob = g.parts.join('\n\n');
  // Decoder pattern: -----BEGIN <kind> N/TOTAL----- ... -----END <kind> N/TOTAL-----
  const re = /----- (\d+)\/(\d+) BEGIN (\S+) -----\n([\s\S]*?)\n----- \1\/\2 END \3 -----/g;
  const collected = new Map();
  let totalExpected = null;
  let kindSeen = null;
  let match;
  while ((match = re.exec(blob)) !== null) {
    const [, nStr, tStr, kind, body] = match;
    if (kindSeen === null) kindSeen = kind;
    else if (kindSeen !== kind) { console.error(`  mixed kinds: ${kindSeen} vs ${kind}`); allOk = false; }
    const t = parseInt(tStr, 10);
    if (totalExpected === null) totalExpected = t;
    else if (totalExpected !== t) { console.error(`  inconsistent total: ${totalExpected} vs ${t}`); allOk = false; }
    collected.set(parseInt(nStr, 10), body);
  }
  if (collected.size !== g.parts.length) {
    console.error(`  parsed ${collected.size} parts, expected ${g.parts.length}`);
    allOk = false;
  }
  if (kindSeen !== g.kind) {
    console.error(`  kind mismatch: parsed=${kindSeen} expected=${g.kind}`);
    allOk = false;
  }
  // Reassemble in order, strip newlines from base64 body (decoder normally just concats lines).
  const ordered = [];
  for (let n = 1; n <= collected.size; n++) {
    const body = collected.get(n);
    if (body === undefined) { console.error(`  missing part ${n}`); allOk = false; continue; }
    ordered.push(body.replace(/\n/g, ''));
  }
  const b64 = ordered.join('');
  const archive = Buffer.from(b64, 'base64');
  const archiveSha = sha(archive);
  console.log(`  reconstructed archive: ${archive.length} B, sha256=${archiveSha}`);
  if (archiveSha !== g.sha256) {
    console.error(`  archive sha256 mismatch!`);
    allOk = false;
  }
  // Write out, unzip.
  const groupDir = join(tmp, g.kind);
  execSync(`mkdir -p '${groupDir}'`);
  const arcPath = join(groupDir, g.kind);
  execSync(`cat > '${arcPath}'`, { input: archive });
  execSync(`unzip -q -o '${arcPath}' -d '${groupDir}'`);
  // sha256 every extracted woff2 against originals.
  for (const f of readdirSync(groupDir)) {
    if (!f.endsWith('.woff2')) continue;
    const got = sha(readFileSync(join(groupDir, f)));
    const want = originals[f];
    const ok = got === want;
    console.log(`  ${ok ? 'OK ' : 'BAD'} ${f}  ${got}`);
    if (!ok) allOk = false;
  }
}

rmSync(tmp, { recursive: true, force: true });

if (!allOk) { console.error('\nFAIL'); process.exit(1); }
console.log('\nALL OK — round-trip verified');
