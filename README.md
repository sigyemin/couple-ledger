# couple-ledger

두 사람이 함께 쓰는 공동 가계부 웹앱(PWA). 월별 카드·통장 내역 엑셀을 브라우저에서 읽어 분류하고, 공동지출을 5:5로 정산해 기록한다.

- 배포: GitHub Pages (정적 파일, 서버 코드 없음)
- DB·로그인: Supabase (PostgreSQL, 구글 로그인, RLS로 등록된 두 계정만 접근)
- 언어: 표준 HTML5·CSS3·JavaScript ES 모듈. 프레임워크·빌드 도구 없음 → 저장소 소스가 곧 배포물
- 외부 라이브러리: SheetJS 0.20.3, supabase-js v2 (버전 고정 파일을 `vendor/`에 포함, 해시 기록)

> 이 저장소는 **공개 저장소**다(GitHub Pages 무료 조건). 아래 "넣으면 안 되는 것"을 먼저 읽는다.

## 넣으면 안 되는 것 (예외 없음)

| 금지 | 이유·대신 할 것 |
|---|---|
| 실제 카드·통장 내역 파일(xls, xlsx, csv, html, pdf), 그 캡처 이미지 | 엑셀 원본은 브라우저 밖으로 나가지 않는다. 샘플은 저장소 폴더 밖에 둔다 |
| 카드번호·계좌번호·전화번호 | 카드는 끝 4자리만 DB에. 계좌번호는 어디에도 저장하지 않는다 |
| 사람 실명(이체 상대 등) | 코드·테스트·PR·문서에는 **가짜 이름만** 쓴다 |
| DB 덤프·백업 파일, 테스트 결과 내보내기 | 백업은 암호화해 저장소 밖에 보관 |
| Supabase service_role·secret 키, DB 비밀번호, 액세스 토큰 | 저장소에 둘 수 있는 키는 공개용 publishable(또는 legacy anon) 키 하나뿐이고 `app/config.js`에만 둔다 |

- 테스트 데이터는 스크립트로 만든 **합성 데이터**만 쓴다. 엑셀 파서 테스트도 실행 중에 합성 파일을 만들어 읽는다(파일로 커밋하지 않음).
- 한 번 공개된 값은 이미 복제됐다고 본다. 실수로 올렸다면 ① 키·토큰 교체 ② 이력 재작성 ③ GitHub에 캐시 삭제 요청 순서로 처리한다.

### 자동 검사 (두 겹)

| 층 | 언제 | 내용 |
|---|---|---|
| `.gitignore` | `git add` | 위 파일 종류를 기본으로 제외 (`git add -f`로 우회 가능) |
| 커밋 전 검사 | `git commit` | `.githooks/pre-commit` → `node scripts/scan.mjs --staged` |
| PR 검사 | PR 생성·갱신 | `.github/workflows/scan.yml` (같은 스크립트 + 단위 테스트). 커밋 전 검사를 건너뛰어도 여기서 다시 막는다. 검사기·허용 목록은 base 쪽 것을 쓴다 |

`scripts/scan.mjs`가 막는 것: 금지 파일 종류, Supabase secret 키, 개인 키 블록, 비밀번호가 든 DB 주소, anon이 아닌 JWT(anon JWT도 `app/config.js` 밖에서는 금지), 10자리 이상 숫자 덩어리(카드·계좌·전화번호 모양, DB의 `has_sensitive_number`와 같은 규칙. 구현은 `app/core/sensitive.js` 하나를 앱 입력 검증과 함께 쓴다). 결과에는 경로·줄 번호·규칙 이름만 나오고 찾은 값은 출력하지 않는다. 사람 이름은 자동으로 찾을 수 없으므로 리뷰에서 확인한다. UTF-16(BOM 있음) 텍스트는 풀어서 검사하고, 그 밖에 NUL 바이트가 든 파일은 `icons/*.png`·`vendor/` 밖에서 막는다.

검사의 한계 (리뷰에서 확인):
- 워크플로 파일(`.github/workflows/scan.yml`)은 PR 쪽 것이 실행된다. `scripts/`, `app/core/sensitive.js`, `vendor/`, `.scan-allow`, `.github/`, `.githooks/`, `.gitignore`를 바꾸는 PR은 검사에 경고가 뜨며, 리뷰에서 반드시 확인한다
- 한 줄씩 검사하므로 줄바꿈으로 나눈 숫자, 탭·쉼표로 구분한 숫자는 걸리지 않는다
- PR 검사는 마지막 커밋의 파일 내용만 본다. 중간 커밋, 커밋 메시지, PR 본문은 검사하지 않는다

## 처음 받았을 때

```sh
git clone https://github.com/sigyemin/couple-ledger.git
cd couple-ledger
git config core.hooksPath .githooks     # 커밋 전 검사 켜기 (PC마다 한 번)
node scripts/scan.mjs --all             # 전체 파일 검사 (Node 20 이상)
node --test $(find tests -name '*.test.mjs')
```

## 작업 규칙

- 모든 변경은 브랜치 → PR → 보안·코드 리뷰 후 병합. 예외: keepalive 워크플로의 날짜 표식 자동 커밋
- 운영 DB에서 테스트할 때는 테스트 결제수단(`is_test`)으로 구분하고 끝나면 일괄 삭제한다. 스키마 변경 전에는 반드시 백업한다
- 화면에 DB 값을 넣을 때는 `textContent`만 쓴다(`innerHTML` 금지). `eval`·`new Function` 금지

## 폴더

```
index.html            진입점 + CSP meta          (화면 단계에서 추가)
app/main.js           부팅: 인증 가드 → 라우터    (공통 컴포넌트 단계)
app/core/             공통 컴포넌트: auth-guard(인증 가드), db(DB 래퍼), errors(오류 처리·기록),
                      format(표시), validate(검증), sensitive(민감번호 규칙), confirm(확인 대화상자)
app/screens/          화면: 홈·내역·올리기·정산·더보기
app/workers/          엑셀 파싱 Web Worker
vendor/               supabase-js, SheetJS (버전 고정 + 해시 기록)
db/                   schema.sql, migrations/
docs/                 DB 설치 절차서 등 운영 문서
scripts/              저장소 도구 (scan.mjs: 유출 검사)
tests/                단위 테스트 (node --test), 합성 데이터만
.githooks/            커밋 전 검사
.github/workflows/    PR 검사, keepalive
```

## 라이선스

라이선스를 두지 않는다. 저작권은 저장소 소유자에게 있으며, 코드를 복제·수정·배포할 권리를 허락하지 않는다(All rights reserved). 공개는 GitHub Pages 배포를 위한 것이다.
