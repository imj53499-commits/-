# School YouTube

관리자가 승인한 사람만 들어와서 볼 수 있는 YouTube 뷰어입니다. Cloudflare Pages 무료 플랜에서 돌아갑니다.

- 홈: 들어가면 바로 인기/추천 영상 목록 (카테고리: 음악, 게임, 뉴스, 스포츠 …)
- Shorts: 세로로 한 개씩 넘겨 보기 (휴대폰은 위아래로 밀기, 컴퓨터는 휠이나 ↑↓ 키), 끝까지 가면 자동으로 더 불러옴
- 검색 + 자동완성
- 영상 재생 (YouTube 공식 임베드 플레이어), 설명, 관련 영상
- 채널 페이지
- 다크 모드, 모바일 화면 지원
- 브라우저 탭·방문 기록에는 항상 "새 탭" 이라는 제목과 회색 아이콘만 표시 (`public/app.js` 의 `PAGE_TITLE`)
- 로그인: 이름(실명)·아이디·비밀번호로 가입 (이메일 필요 없음). 가입하면 **관리자가 승인해야** 쓸 수 있음. 관리자 화면은 `/#/admin`
- 화면 가리기: 단축키(기본 `` ` ``, 오른쪽 위 ⚙에서 변경)를 한 번 누르면 빈 화면으로 가려지고 영상이 멈춤, 다시 누르면 원래 화면으로 돌아오고 영상도 이어서 재생
- 나가기 버튼(오른쪽 위): Google로 완전히 나가기 (주소는 `public/app.js` 의 `EXIT_URL`)

YouTube API 키는 필요 없습니다. 서버(Pages Functions)가 YouTube 내부 API에 익명으로 요청해서 영상 정보를 가져옵니다.

## Cloudflare Pages에 올리기

1. https://dash.cloudflare.com → **Workers & Pages** → **Create application** → **Pages** 탭 → **Import an existing Git repository**
2. 이 저장소와 브랜치 선택
3. 빌드 설정: Framework preset **None**, Build command **비워 두기**
   (출력 폴더 `public` 은 `wrangler.jsonc` 에 들어 있어서 자동으로 적용됩니다)
4. **Save and Deploy** → `https://<프로젝트이름>.pages.dev` 주소가 생깁니다
5. 내 도메인 연결: 프로젝트 → **Custom domains** → **Set up a custom domain** → 도메인 입력
   → 내도메인.한국 등에서 **별칭(CNAME)** 을 `<프로젝트이름>.pages.dev` 로 설정

`/api/*` 는 `functions/api/[[path]].js` (Pages Functions)가 처리합니다.

## 로그인 설정 (처음 한 번)

1. **KV 저장소 만들기**: Cloudflare → **Storage & databases** → **KV** → **Create** (이름 예: `schoolyoutube-db`)
   → 만들어진 KV 의 **ID** 를 `wrangler.jsonc` 의 `kv_namespaces` 에 넣기 (binding 이름은 `DB`)
2. **관리자 비밀번호 정하기**: Pages 프로젝트 → **Settings** → **Variables and Secrets** → **Add**
   → Type **Secret**, Name `ADMIN_PASSWORD`, Value 원하는 비밀번호 → 저장 후 다시 배포
3. `https://<내 주소>/#/admin` 에서 관리자 비밀번호로 들어가 가입 신청을 승인/거절

KV 를 연결하기 전에는 로그인 없이 누구나 볼 수 있고, 연결하는 순간부터 로그인이 필요해집니다. 계정은 KV 에 저장되고, 비밀번호는 PBKDF2 로 해시해서 저장합니다. 로그인 유지 기간은 30일(관리자는 12시간)입니다.

## 터미널로 올리기

```bash
npm install
npx wrangler login
npm run deploy        # wrangler pages deploy
```

## 내 컴퓨터에서 실행

```bash
npm install
npm run dev -- --kv DB --binding ADMIN_PASSWORD=test   # http://localhost:8788
npm test
```

## 구조

| 파일 | 역할 |
|------|------|
| `functions/api/[[path]].js` | Pages 진입점 (`/api/*`) |
| `src/server.js` | `/api/*` 입구: 로그인 확인 후 영상 API 로 전달 |
| `src/auth.js` | 가입, 로그인, 세션, 관리자 승인 (KV 저장) |
| `src/api.js` | API 라우트 (`/api/home`, `/api/shorts`, `/api/search`, `/api/suggest`, `/api/video`, `/api/channel`) + 5분 캐시 |
| `src/youtube.js` | YouTube 내부 API 호출과 응답에서 영상 정보 추출 |
| `public/` | 화면 (HTML/CSS/JS, 빌드 불필요) |
| `wrangler.jsonc` | Cloudflare Pages 설정 (출력 폴더 `public`) |

## 참고

- YouTube가 응답 형식을 바꾸면 일부 정보가 안 나올 수 있습니다. 그땐 `src/youtube.js` 의 추출 부분만 고치면 됩니다.
- YouTube가 Cloudflare 서버 IP를 가끔 막을 수 있습니다. 그럴 땐 화면에 "다시 시도" 안내가 나옵니다.
