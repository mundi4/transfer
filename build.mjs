#!/usr/bin/env node
// One-shot builder: packs fonts/ → tar.xz → base64 → chunked parts → inlines into index.html.
// Sans and Serif are kept as TWO separate archives per the handoff spec.

import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const FONTS_DIR = 'fonts';
const LINE_WIDTH = 64;
const LINES_PER_PART = 2000;

const GROUPS = [
  {
    label: 'Sans',
    kind: 'fonts-sans.zip',
    files: [
      'noto-sans-kr-v39-korean_latin-regular.woff2',
      'noto-sans-kr-v39-korean_latin-700.woff2',
    ],
  },
  {
    label: 'Serif',
    kind: 'fonts-serif.zip',
    files: [
      'noto-serif-kr-v31-korean_latin-regular.woff2',
      'noto-serif-kr-v31-korean_latin-700.woff2',
    ],
  },
];

function buildArchive(files) {
  const dir = mkdtempSync(join(tmpdir(), 'transfer-'));
  const out = join(dir, 'a.zip');
  const list = files.map(f => `'${f}'`).join(' ');
  // -0 store mode (woff2 is already brotli-compressed, deflate gains nothing).
  // -X strip extra fields, -D no dir entries → smaller, more reproducible.
  // Run from FONTS_DIR so paths inside the zip are just the basenames.
  execSync(
    `cd '${FONTS_DIR}' && zip -q -0 -X -D '${out}' ${list}`,
    { stdio: ['ignore', 'inherit', 'inherit'] },
  );
  const buf = readFileSync(out);
  rmSync(dir, { recursive: true, force: true });
  return buf;
}

function chunkParts(b64, kind) {
  const lines = [];
  for (let i = 0; i < b64.length; i += LINE_WIDTH) lines.push(b64.slice(i, i + LINE_WIDTH));
  const total = Math.ceil(lines.length / LINES_PER_PART);
  const parts = [];
  for (let p = 0; p < total; p++) {
    const n = p + 1;
    const slice = lines.slice(p * LINES_PER_PART, (p + 1) * LINES_PER_PART);
    parts.push(`----- ${n}/${total} BEGIN ${kind} -----\n${slice.join('\n')}\n----- ${n}/${total} END ${kind} -----`);
  }
  return parts;
}

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

const built = GROUPS.map(g => {
  const archive = buildArchive(g.files);
  const b64 = archive.toString('base64');
  const parts = chunkParts(b64, g.kind);
  const digest = sha256(archive);
  console.log(`[${g.label}] ${g.kind}: archive=${archive.length} B, b64=${b64.length}, parts=${parts.length}, sha256=${digest.slice(0, 12)}…`);
  return {
    label: g.label,
    kind: g.kind,
    archiveBytes: archive.length,
    b64Length: b64.length,
    sha256: digest,
    parts,
  };
});

const totalParts = built.reduce((s, g) => s + g.parts.length, 0);
console.log(`total: ${totalParts} parts`);

const dataJson = JSON.stringify(built)
  .replace(/</g, '\\u003c')
  .replace(/-->/g, '--\\u003e')
  .replace(/[\u2028\u2029]/g, c => '\\u' + c.charCodeAt(0).toString(16));

const html = `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1">
<title>폰트 운반</title>
<style>
*{box-sizing:border-box}
html,body{margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;-webkit-text-size-adjust:100%}
body{padding:16px;max-width:480px;margin:0 auto;background:#fafafa;color:#222}
h1{font-size:18px;margin:0 0 14px;display:flex;justify-content:space-between;align-items:baseline}
h1 small{font-size:12px;color:#888;font-weight:400}
.help{font-size:12px;color:#5a4a00;background:#fff8d6;border:1px solid #e8d97a;border-radius:8px;padding:10px 12px;margin-bottom:14px;line-height:1.55}
.group{background:#fff;border:1px solid #e2e2e2;border-radius:10px;padding:14px;margin-bottom:14px}
.group h2{margin:0 0 4px;font-size:16px}
.kind{color:#888;font-weight:400;font-size:12px;margin-left:4px}
.counter{font-variant-numeric:tabular-nums;font-size:14px;color:#444;margin-bottom:8px}
.progress{height:6px;background:#eee;border-radius:3px;overflow:hidden;margin-bottom:10px}
.progress>div{height:100%;background:#2a8;transition:width .12s linear;width:0%}
.chips{display:grid;grid-template-columns:repeat(6,1fr);gap:6px;margin-bottom:8px}
.chip{padding:14px 0;font-size:15px;font-weight:600;border:1px solid #ccc;border-radius:7px;background:#fff;color:#333;cursor:pointer;-webkit-tap-highlight-color:transparent;font-variant-numeric:tabular-nums;transition:background .12s,color .12s,border-color .12s}
.chip:active{transform:scale(.97)}
.chip.done{background:#e8f5ee;color:#2a8;border-color:#9bd3b3}
.chip.next{background:#2a8;color:#fff;border-color:#2a8;box-shadow:0 0 0 3px rgba(42,136,80,.22)}
.chip.copying{background:#ffd54a;color:#5a4500;border-color:#e8b800}
.secondary{display:block;width:100%;padding:10px;font-size:14px;border:1px solid #ccc;border-radius:8px;background:transparent;color:#555;cursor:pointer;-webkit-tap-highlight-color:transparent}
.meta{font-size:11px;color:#888;margin-top:8px;font-variant-numeric:tabular-nums;word-break:break-all}
#toast{position:fixed;bottom:20px;left:50%;transform:translateX(-50%);background:rgba(0,0,0,.85);color:#fff;padding:10px 16px;border-radius:6px;font-size:14px;opacity:0;transition:opacity .2s;pointer-events:none;max-width:90%;text-align:center;line-height:1.4;white-space:pre-line}
#toast.show{opacity:1}
</style>
</head>
<body>
<h1>폰트 운반 <small>clipboard handoff</small></h1>
<div class="help">
번호 칩 하나 누르면 그 파트가 클립보드에 복사됩니다. 메신저로 가서 paste → 돌아와 다음 번호 누르기 → 반복.<br>
다음에 보낼 번호는 <b>녹색</b>, 이미 보낸 번호는 <span style="color:#2a8">옅은 녹색 ✓</span>. 이미 보낸 칩 다시 눌러도 다시 복사됩니다 (재전송용).<br>
Sans / Serif 는 별개 묶음입니다. 둘 다 끝까지 보내세요 (순서 무관).
</div>
<div id="groups"></div>
<button class="secondary" id="reset">전체 리셋</button>
<div id="toast"></div>
<script>
const GROUPS = ${dataJson};
const done = GROUPS.map(()=>new Set());
const root = document.getElementById('groups');
const toastEl = document.getElementById('toast');
let busy = false;

function esc(s){return String(s).replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}

function buildDom(){
  root.innerHTML = '';
  GROUPS.forEach((g,i)=>{
    const div = document.createElement('div');
    div.className = 'group';
    div.dataset.i = i;
    let chips = '';
    for (let p = 0; p < g.parts.length; p++) {
      chips += '<button class="chip" data-i="' + i + '" data-p="' + p + '">' + (p+1) + '</button>';
    }
    div.innerHTML =
      '<h2>' + esc(g.label) + '<span class="kind">(' + esc(g.kind) + ')</span></h2>' +
      '<div class="counter"></div>' +
      '<div class="progress"><div></div></div>' +
      '<div class="chips">' + chips + '</div>' +
      '<div class="meta">archive ' + (g.archiveBytes/1024).toFixed(1) + ' KB · base64 ' + (g.b64Length/1024).toFixed(1) + ' KB · ' + g.parts.length + ' 파트<br>sha256 ' + g.sha256 + '</div>';
    root.appendChild(div);
  });
}

function nextIdx(gi){
  const total = GROUPS[gi].parts.length;
  for (let p = 0; p < total; p++) if (!done[gi].has(p)) return p;
  return -1;
}

function update(copying){
  GROUPS.forEach((g,gi)=>{
    const div = root.querySelector('.group[data-i="' + gi + '"]');
    if (!div) return;
    const total = g.parts.length;
    const doneCount = done[gi].size;
    div.querySelector('.counter').textContent = doneCount + ' / ' + total + ' 파트' + (doneCount >= total ? ' — 완료' : '');
    div.querySelector('.progress > div').style.width = total ? (doneCount/total*100).toFixed(2) + '%' : '0%';
    const next = nextIdx(gi);
    div.querySelectorAll('.chip').forEach((c, ci)=>{
      c.classList.toggle('done', done[gi].has(ci));
      c.classList.toggle('next', ci === next);
      c.classList.toggle('copying', !!(copying && copying.gi === gi && copying.pi === ci));
    });
  });
}

let toastTimer;
function toast(msg){
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(()=>toastEl.classList.remove('show'), 2500);
}

async function copyOne(gi, pi){
  if (busy) return;
  busy = true;
  update({gi, pi});
  try {
    await navigator.clipboard.writeText(GROUPS[gi].parts[pi]);
    done[gi].add(pi);
    toast(GROUPS[gi].label + ' ' + (pi+1) + '/' + GROUPS[gi].parts.length + ' 복사됨');
  } catch (err) {
    toast('실패: ' + (err && err.message ? err.message : err));
  } finally {
    busy = false;
    update();
  }
}

document.addEventListener('click', (e)=>{
  const t = e.target.closest('button');
  if (!t) return;
  if (t.id === 'reset') {
    if (busy) return;
    for (let i=0;i<done.length;i++) done[i].clear();
    update();
    toast('전체 리셋');
    return;
  }
  if (t.classList.contains('chip')) {
    copyOne(+t.dataset.i, +t.dataset.p);
  }
});

buildDom();
update();
</script>
</body>
</html>
`;

writeFileSync('index.html', html);
console.log(`wrote index.html (${(html.length/1024/1024).toFixed(2)} MB)`);
