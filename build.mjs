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
    kind: 'fonts-sans.tar.xz',
    files: [
      'noto-sans-kr-v39-korean_latin-regular.woff2',
      'noto-sans-kr-v39-korean_latin-700.woff2',
    ],
  },
  {
    label: 'Serif',
    kind: 'fonts-serif.tar.xz',
    files: [
      'noto-serif-kr-v31-korean_latin-regular.woff2',
      'noto-serif-kr-v31-korean_latin-700.woff2',
    ],
  },
];

function buildArchive(files) {
  const dir = mkdtempSync(join(tmpdir(), 'transfer-'));
  const out = join(dir, 'a.tar.xz');
  const list = files.map(f => `'${f}'`).join(' ');
  // Deterministic tar (fixed mtime/owner) → reproducible archive across rebuilds.
  execSync(
    `tar -C '${FONTS_DIR}' --owner=0 --group=0 --numeric-owner --sort=name --mtime='1970-01-01 00:00:00 UTC' -cf - ${list} | xz -9e -c > '${out}'`,
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
.progress{height:6px;background:#eee;border-radius:3px;overflow:hidden;margin-bottom:12px}
.progress>div{height:100%;background:#2a8;transition:width .12s linear;width:0%}
button{display:block;width:100%;padding:14px;font-size:16px;border:0;border-radius:8px;background:#2a8;color:#fff;font-weight:600;cursor:pointer;-webkit-tap-highlight-color:transparent}
button:active:not(:disabled){background:#1f7060}
button:disabled{background:#bbb;cursor:not-allowed}
.secondary{background:transparent!important;color:#555!important;border:1px solid #ccc!important;font-weight:400!important;padding:10px!important;font-size:14px!important}
.meta{font-size:11px;color:#888;margin-top:8px;font-variant-numeric:tabular-nums;word-break:break-all}
#toast{position:fixed;bottom:20px;left:50%;transform:translateX(-50%);background:rgba(0,0,0,.85);color:#fff;padding:10px 16px;border-radius:6px;font-size:14px;opacity:0;transition:opacity .2s;pointer-events:none;max-width:90%;text-align:center;line-height:1.4;white-space:pre-line}
#toast.show{opacity:1}
</style>
</head>
<body>
<h1>폰트 운반 <small>clipboard handoff</small></h1>
<div class="help">
"다음 N개 복사" 누르면 200 ms 간격으로 클립보드에 1개씩 덮어쓰기 합니다. 폰 키보드 클립보드 히스토리에 N개 엔트리로 쌓이니, 메신저로 가서 1개씩 paste 후 다시 돌아와 다음 배치를 누르세요.<br>
Sans / Serif 는 별개 묶음입니다. 각각 끝까지 보내면 됩니다 (순서 무관).
</div>
<div id="groups"></div>
<button class="secondary" id="reset">전체 리셋</button>
<div id="toast"></div>
<script>
const GROUPS = ${dataJson};
const state = GROUPS.map(()=>0);
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
    div.innerHTML =
      '<h2>' + esc(g.label) + '<span class="kind">(' + esc(g.kind) + ')</span></h2>' +
      '<div class="counter"></div>' +
      '<div class="progress"><div></div></div>' +
      '<button data-action="next" data-i="' + i + '"></button>' +
      '<div class="meta">archive ' + (g.archiveBytes/1024).toFixed(1) + ' KB · base64 ' + (g.b64Length/1024).toFixed(1) + ' KB · ' + g.parts.length + ' 파트<br>sha256 ' + g.sha256 + '</div>';
    root.appendChild(div);
  });
}

function update(){
  GROUPS.forEach((g,i)=>{
    const cur = state[i];
    const total = g.parts.length;
    const done = cur >= total;
    const remaining = total - cur;
    const batch = Math.min(10, remaining);
    const div = root.querySelector('.group[data-i="' + i + '"]');
    if (!div) return;
    div.querySelector('.counter').textContent = cur + ' / ' + total + ' 파트' + (done ? ' — 완료' : '');
    div.querySelector('.progress > div').style.width = total ? (cur/total*100).toFixed(2) + '%' : '0%';
    const btn = div.querySelector('button[data-action="next"]');
    btn.textContent = done ? '완료' : (busy ? '복사중…' : '다음 ' + batch + '개 복사');
    btn.disabled = done || busy;
  });
}

let toastTimer;
function toast(msg){
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(()=>toastEl.classList.remove('show'), 3500);
}

async function copyNext(i, n){
  if (busy) return;
  busy = true; update();
  const g = GROUPS[i];
  const start = state[i];
  const end = Math.min(start + n, g.parts.length);
  if (start >= end) { busy = false; update(); return; }
  try {
    for (let j = start; j < end; j++) {
      await navigator.clipboard.writeText(g.parts[j]);
      state[i] = j + 1;
      const div = root.querySelector('.group[data-i="' + i + '"]');
      if (div) {
        div.querySelector('.counter').textContent = state[i] + ' / ' + g.parts.length + ' 파트';
        div.querySelector('.progress > div').style.width = (state[i]/g.parts.length*100).toFixed(2) + '%';
      }
      if (j < end - 1) await new Promise(r=>setTimeout(r, 200));
    }
    toast(g.label + ' ' + (end - start) + '개 복사 완료.\\n메신저로 가서 paste 후 돌아오세요.');
  } catch (err) {
    toast('실패 (인덱스 ' + state[i] + '): ' + (err && err.message ? err.message : err));
  } finally {
    busy = false; update();
  }
}

document.addEventListener('click', (e)=>{
  const t = e.target.closest('button');
  if (!t) return;
  if (t.id === 'reset') {
    if (busy) return;
    for (let i=0;i<state.length;i++) state[i] = 0;
    update();
    toast('전체 리셋');
    return;
  }
  if (t.dataset.action === 'next') {
    copyNext(+t.dataset.i, 10);
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
