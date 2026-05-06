# 핸드오프 — 폰 클립보드 운반 페이지

## 목적

사내 폐쇄망 운영 PC 로 Noto Sans/Serif KR woff2 4개 1회 운반. 직접 망연결
불가 → 사내 메신저 paste 가 유일 채널 → 메시지당 글자 수 제한 때문에 큰
base64 를 잘게 자른 "파트" 로 나눠 paste.

기존 운반은 PC 에서 파트 파일을 하나씩 메신저에 paste 했음. 이 페이지는 _폰_
으로 운반:

- 폰 키보드 (Gboard / Samsung Keyboard) 의 _클립보드 히스토리_ 가 활성화돼
  있어 `navigator.clipboard.writeText` 를 순차 호출하면 호출마다 별도 히스토리
  엔트리로 capture 됨
- 사용자가 사내 메신저 앱에서 키보드 클립보드 패널 열어 1개씩 paste

## 입력

레포 안 (사용자가 업로드 완료):

- `fonts/noto-sans-kr-v39-korean_latin-regular.woff2`
- `fonts/noto-sans-kr-v39-korean_latin-700.woff2`
- `fonts/noto-serif-kr-v31-korean_latin-regular.woff2`
- `fonts/noto-serif-kr-v31-korean_latin-700.woff2`

woff2 는 brotli 로 이미 압축됨 → 추가 압축 효과 없음 → 컨테이너는 단순 묶음용
(zip `-0` store 모드).

## 파이프라인

Sans / Serif 는 **각각 별도 묶음**. 한 묶음으로 합치지 말 것.

```
sans woff2 × 2  →  zip -0 (store)  →  base64  →  2000-line/64-char chunks  →  fonts-sans.zip parts
serif woff2 × 2 →  zip -0 (store)  →  base64  →  2000-line/64-char chunks  →  fonts-serif.zip parts
```

빌드 스크립트 `build.mjs` 가:

1. 각 그룹별 `zip -0 -X -D` (압축 없음 + extra field 제거 + dir 엔트리 없음)
2. base64 인코딩
3. 줄당 64자 줄바꿈, 2000줄(=128,000자) 씩 1 파트
4. 각 파트에 BEGIN/END 마커 부착
5. 양쪽 그룹의 파트 배열을 `index.html` 에 인라인 JS const 로 emit

zip 선택 이유: Windows 기본 더블클릭 풀림. 운영 PC 에서 추가 도구 불필요.

현재 빌드 결과:

- `fonts-sans.zip`: 1.05 MB → 12 파트
- `fonts-serif.zip`: 1.91 MB → 21 파트
- 합계 33 파트

## 마커 포맷

각 파트 첫 줄에 `N/TOTAL` 이 먼저 오도록 라벨링 (메신저 클립보드 히스토리에서
어느 파트인지 한눈에 식별):

```
----- N/TOTAL BEGIN <kind> -----
<64-char base64 line × ≤2000>
----- N/TOTAL END <kind> -----
```

`<kind>` ∈ { `fonts-sans.zip`, `fonts-serif.zip` }.
같은 kind 끼리만 모아 BEGIN/END 사이 base64 라인을 concat → decode → .zip.

각 클립보드 엔트리 = 1 파트 = BEGIN 라인 + ≤2000줄 base64 + END 라인 (≈ 128 KB
텍스트, 마지막 파트는 더 작을 수 있음).

운영 PC 측 디코더 정규식 예:

```
^----- (\d+)/(\d+) BEGIN (\S+) -----$
^----- \1/\2 END \3 -----$
```

## 페이지 UX

`index.html` 1파일, 외부 의존 0 (인라인 vanilla JS/CSS).

- Sans / Serif 두 그룹이 각각 자체 카운터·진행률·"다음 N개 복사" 버튼
- 버튼 누르면 현재 인덱스부터 10개를 200ms 간격으로 순차
  `clipboard.writeText` 호출. 매 호출마다 폰 클립보드 히스토리에 새 엔트리로
  쌓임
- 마지막 배치는 남은 개수만큼 (예: 12파트 → 10 + 2)
- "전체 리셋" 버튼: 양쪽 인덱스 0
- 각 그룹 모든 파트 소진 시 버튼 disabled + "완료"

JS 골격:

```js
const GROUPS = [{ kind: 'fonts-sans.tar.xz', parts: [...] }, ...];
const state = GROUPS.map(() => 0);

async function copyNext(i, n = 10) {
  const g = GROUPS[i];
  const start = state[i];
  const end = Math.min(start + n, g.parts.length);
  for (let j = start; j < end; j++) {
    await navigator.clipboard.writeText(g.parts[j]);
    state[i] = j + 1;
    if (j < end - 1) await new Promise(r => setTimeout(r, 200));
  }
}
```

## 기술 제약

- **HTTPS 필수** — Clipboard API 는 secure context 강제. GitHub Pages 자동
  HTTPS 제공.
- **사용자 제스처 윈도우** — Chrome 은 click 후 ~5초 내 `writeText` 허용.
  10 × 200ms = 2초 → 윈도우 안에 들어옴.
- **빌드 무관 정적 페이지** — `index.html` + `build.mjs`. GH Pages Source =
  branch root.

## 산출물 / 레포 구조

```
.
├── HANDOFF.md          ← 이 문서
├── README.md
├── fonts/              ← 입력 woff2 4개
├── build.mjs           ← 빌드 스크립트
├── test-roundtrip.mjs  ← 로컬 검증 (decode + unpack + sha256 비교)
└── index.html          ← 빌드 산출물 (33 파트 인라인, ~4 MB)
```

`index.html` 은 빌드 산출물이지만 GH Pages 가 서빙해야 하므로 _커밋 포함_.

## 호스팅

GitHub Pages 로:

1. repo Settings → Pages
2. Source = `Deploy from a branch`
3. Branch = 현재 브랜치(`claude/font-handoff-page-teE6m`) 또는 main 머지 후 main
4. Folder = `/ (root)`
5. URL = `https://<user>.github.io/<repo>/`

폰 Chrome 으로 그 URL 접속해서 사용.

## 검증

빌드 후 `node test-roundtrip.mjs` 가 다음을 확인함:

- 양 그룹의 BEGIN/END 마커가 올바른 형식으로 들어 있음
- 모든 파트 번호 1..N 이 빠짐없이 존재
- base64 concat → decode → 빌드시 archive sha256 와 일치
- unzip → 추출된 woff2 4개 sha256 = `fonts/` 원본과 일치

이번 빌드 결과: **PASS**.

폰 실사용 검증:

- [ ] 폰에서 "Sans 다음 N개 복사" → 메신저 클립보드 패널에 N개 엔트리 보이는지
- [ ] 카운터가 마지막 배치 후 `12/12` (sans) / `21/21` (serif) 로 끝
- [ ] 운영 PC 측 디코더가 두 kind 를 각각 별개 파일로 처리하는지

## 비고

- 1회성 운반 도구. 운반 끝나면 repo 자체는 archive 해도 무관.
- 운영 PC 측 디코드 / 폰트 설치는 이 레포 책임 아님.
- woff2 가 안 바뀌면 재빌드 0 (`build.mjs` 는 결정론적).
