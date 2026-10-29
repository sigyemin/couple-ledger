# 외부 라이브러리 (버전 고정)

npm으로 설치하지 않는다. 공식 배포처에서 받은 파일을 **고치지 않고** 그대로 둔다. 해시는 `vendor/integrity.json`에 있고, 단위 테스트(`tests/vendor.test.mjs` → `scripts/vendor-check.mjs`)가 매번 다시 계산해 대조한다. `vendor/` 아래에 목록에 없는 파일이 생겨도 실패한다.

| 라이브러리 | 버전 | 파일 | 라이선스 | 받은 날 |
|---|---|---|---|---|
| supabase-js | 2.118.0 (npm 공개 2026-10-15) | `supabase-js-2.118.0/supabase.js` (패키지의 `dist/umd/supabase.js`, 의존 패키지까지 묶인 단일 파일) | MIT (`LICENSE`) | 2026-10-29 |
| SheetJS (xlsx) | 0.20.3 | `xlsx-0.20.3/xlsx.mjs` (ES 모듈 단일 파일) | Apache-2.0 (`LICENSE`) | 2026-10-29 |

## 받은 곳과 대조 근거

### supabase-js 2.118.0
- 원본: `https://registry.npmjs.org/@supabase/supabase-js/-/supabase-js-2.118.0.tgz`
- 레지스트리가 공개한 `dist.integrity`: `sha512-FxI8UXMVC2UG7IkeiI8fuQZqq2oI3JeSuN8MPIC2RLVaoEAxKS0nqE6kii9Ewpq8f9gNPM6git1Y8f0vN/QLFw==`
- 받은 tarball의 sha512(base64)를 계산해 위 값과 **일치** 확인. `supabase.js`와 `LICENSE`는 그 tarball에서 꺼낸 파일 그대로
- ES 모듈 단일 파일은 패키지에 없다(`dist/index.mjs`는 `@supabase/*` 패키지를 이름으로 import). CDN이 만든 ESM 묶음(+esm)은 Supabase가 만든 파일이 아니라서 쓰지 않는다(보안 리뷰 v0.1 9장). 그래서 공식 UMD 묶음을 일반 `<script>`로 읽고(전역 `supabase`), 앱은 `app/core/supabase-client.js`로만 쓴다
- 파일 안에 `eval`·`new Function`·`innerHTML`·`document.write` 없음(문자열 검색)
- 이 버전을 고른 이유: 받은 날 기준 최신(2.118.0)이 공개 14일째

### SheetJS 0.20.3
- 원본: `https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz` (공식 배포처. npm 레지스트리의 `xlsx`는 0.18.5에 멈춰 있고 취약점이 있어 쓰지 않는다)
- 배포처는 체크섬·서명을 공개하지 않는다(보안 리뷰 v0.1 9장) → **배포처 값과의 대조는 [모름]**
- 대신 한 일: tarball을 두 번 받아 sha256 일치, tarball 안의 `xlsx.mjs`와 `https://cdn.sheetjs.com/xlsx-0.20.3/package/xlsx.mjs`를 따로 받은 파일이 sha256 일치. 두 번 모두 같은 네트워크(같은 프록시)라 "서로 다른 네트워크" 비교는 하지 못함
- 파일 안 `innerHTML`은 1곳으로, HTML 표를 읽을 때 값을 **읽는** 데만 쓴다(쓰기 아님). 앱은 엑셀을 Web Worker에서 읽으므로 DOM이 없다. `eval`·`new Function` 없음
- 0.20.3은 CVE-2023-30533(0.19.3에서 수정)·CVE-2024-22363(0.20.2 미만)에 해당하지 않는다(보안 리뷰 v0.1 9장)

## 쓰는 법
- supabase-js: `index.html`에서 앱 모듈보다 먼저 `<script src="vendor/supabase-js-2.118.0/supabase.js" integrity="(integrity.json의 sri)">`. 그다음 `app/core/supabase-client.js`의 `createSupabaseClient()`
- SheetJS: 엑셀 파싱 Worker에서 `import * as XLSX from '../../vendor/xlsx-0.20.3/xlsx.mjs'`. 옵션 `cellFormula:false, cellHTML:false, cellStyles:false`(보안 리뷰 9장)
- 모듈 `import`에는 SRI가 적용되지 않는다. 해시 대조는 테스트가 한다

## 업데이트
월 1회 GitHub Advisory·OSV에서 `@supabase/supabase-js`, `xlsx`를 확인한다. 높음 이상은 바로, 그 밖은 분기 1회 PR로. 바꿀 때는 이 문서와 `integrity.json`을 같은 PR에서 고친다.
