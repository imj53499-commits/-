# MinTube

로그인 없이 접속하자마자 바로 영상을 볼 수 있는 YouTube 뷰어입니다.

- 홈: 들어가면 바로 인기/추천 영상 목록 (카테고리: 음악, 게임, 뉴스, 스포츠 …)
- 검색 + 자동완성
- 영상 재생 (YouTube 공식 임베드 플레이어), 설명, 관련 영상
- 채널 페이지
- 다크 모드, 모바일 화면 지원

YouTube 데이터는 [youtubei.js](https://github.com/LuanRT/YouTube.js)로 익명 요청해서 가져오기 때문에 API 키나 로그인이 필요 없습니다.

## 실행

Node.js 20 이상이 필요합니다.

```bash
npm install
npm start          # http://localhost:3000
```

포트를 바꾸려면 `PORT=8080 npm start`.

## 테스트

```bash
npm test
```

## 구조

| 파일 | 역할 |
|------|------|
| `server.js` | 서버 시작, 익명 YouTube 클라이언트 생성 |
| `src/app.js` | API 라우트 (`/api/home`, `/api/search`, `/api/suggest`, `/api/video`, `/api/channel`) + 5분 캐시 |
| `src/normalize.js` | YouTube 응답을 화면용 데이터로 변환 |
| `public/` | 화면 (HTML/CSS/JS, 빌드 불필요) |

## 참고

- Render, Railway, Fly.io 같은 Node 서버 호스팅에 그대로 올릴 수 있습니다.
- 클라우드 서버 IP는 YouTube가 가끔 막을 수 있습니다. 그럴 땐 화면에 "다시 시도" 안내가 나옵니다.
