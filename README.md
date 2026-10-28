# School YouTube

로그인 없이 접속하자마자 바로 영상을 볼 수 있는 YouTube 뷰어입니다. Cloudflare Pages 무료 플랜에서 돌아갑니다.

- 홈: 들어가면 바로 인기/추천 영상 목록 (카테고리: 음악, 게임, 뉴스, 스포츠 …)
- 검색 + 자동완성
- 영상 재생 (YouTube 공식 임베드 플레이어), 설명, 관련 영상
- 채널 페이지
- 다크 모드, 모바일 화면 지원
- 빠른 나가기: `` ` `` 키(숫자 1 왼쪽) 또는 오른쪽 위 나가기 버튼 → 화면을 바로 지우고 Google로 이동 (주소는 `public/app.js` 의 `EXIT_URL`)

API 키도 로그인도 필요 없습니다. 서버(Pages Functions)가 YouTube 내부 API에 익명으로 요청해서 영상 정보를 가져옵니다.

## Cloudflare Pages에 올리기

1. https://dash.cloudflare.com → **Workers & Pages** → **Create application** → **Pages** 탭 → **Import an existing Git repository**
2. 이 저장소와 브랜치 선택
3. 빌드 설정: Framework preset **None**, Build command **비워 두기**
   (출력 폴더 `public` 은 `wrangler.jsonc` 에 들어 있어서 자동으로 적용됩니다)
4. **Save and Deploy** → `https://<프로젝트이름>.pages.dev` 주소가 생깁니다
5. 내 도메인 연결: 프로젝트 → **Custom domains** → **Set up a custom domain** → 도메인 입력
   → 내도메인.한국 등에서 **별칭(CNAME)** 을 `<프로젝트이름>.pages.dev` 로 설정

`/api/*` 는 `functions/api/[[path]].js` (Pages Functions)가 처리합니다.

## 터미널로 올리기

```bash
npm install
npx wrangler login
npm run deploy        # wrangler pages deploy
```

## 내 컴퓨터에서 실행

```bash
npm install
npm run dev        # http://localhost:8788
npm test
```

## 구조

| 파일 | 역할 |
|------|------|
| `functions/api/[[path]].js` | Pages 진입점 (`/api/*`) |
| `src/api.js` | API 라우트 (`/api/home`, `/api/search`, `/api/suggest`, `/api/video`, `/api/channel`) + 5분 캐시 |
| `src/youtube.js` | YouTube 내부 API 호출과 응답에서 영상 정보 추출 |
| `public/` | 화면 (HTML/CSS/JS, 빌드 불필요) |
| `wrangler.jsonc` | Cloudflare Pages 설정 (출력 폴더 `public`) |

## 참고

- YouTube가 응답 형식을 바꾸면 일부 정보가 안 나올 수 있습니다. 그땐 `src/youtube.js` 의 추출 부분만 고치면 됩니다.
- YouTube가 Cloudflare 서버 IP를 가끔 막을 수 있습니다. 그럴 땐 화면에 "다시 시도" 안내가 나옵니다.
