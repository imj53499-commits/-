# MinTube

로그인 없이 접속하자마자 바로 영상을 볼 수 있는 YouTube 뷰어입니다. Cloudflare Workers 무료 플랜에서 돌아갑니다.

- 홈: 들어가면 바로 인기/추천 영상 목록 (카테고리: 음악, 게임, 뉴스, 스포츠 …)
- 검색 + 자동완성
- 영상 재생 (YouTube 공식 임베드 플레이어), 설명, 관련 영상
- 채널 페이지
- 다크 모드, 모바일 화면 지원

API 키도 로그인도 필요 없습니다. Worker가 YouTube 내부 API에 익명으로 요청해서 영상 정보를 가져옵니다.

## Cloudflare에 올리기 (터미널 없이)

1. https://dash.cloudflare.com 에 가입/로그인
2. 왼쪽 메뉴 **Compute (Workers)** → **Workers & Pages** → **Create application**
3. **Import a repository** 선택 → GitHub 연결 → 이 저장소 선택
4. 브랜치를 이 코드가 있는 브랜치로 고르고, 나머지 설정은 그대로 두고 **Deploy**
5. 끝나면 `https://mintube.<내-서브도메인>.workers.dev` 주소가 생깁니다

이후 이 브랜치에 push 할 때마다 자동으로 다시 배포됩니다.

## 터미널로 올리기

```bash
npm install
npx wrangler login
npm run deploy
```

## 내 컴퓨터에서 실행

```bash
npm install
npm run dev        # http://localhost:8787
npm test
```

## 구조

| 파일 | 역할 |
|------|------|
| `src/worker.js` | Worker 진입점: `/api/*` 는 API, 나머지는 `public/` 화면 파일 |
| `src/api.js` | API 라우트 (`/api/home`, `/api/search`, `/api/suggest`, `/api/video`, `/api/channel`) + 5분 캐시 |
| `src/youtube.js` | YouTube 내부 API 호출과 응답에서 영상 정보 추출 |
| `public/` | 화면 (HTML/CSS/JS, 빌드 불필요) |
| `wrangler.jsonc` | Cloudflare Workers 설정 |

## 참고

- YouTube가 응답 형식을 바꾸면 일부 정보가 안 나올 수 있습니다. 그땐 `src/youtube.js` 의 추출 부분만 고치면 됩니다.
- YouTube가 Cloudflare 서버 IP를 가끔 막을 수 있습니다. 그럴 땐 화면에 "다시 시도" 안내가 나옵니다.
