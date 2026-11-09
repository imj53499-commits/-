// 모든 요청(화면 HTML·JS·CSS 포함)에 가장 먼저 걸린다.
// (Pages Functions 는 보통 /api, /p 만 돌지만, 이 _middleware 는 정적 파일 요청에도 걸린다.)
//  1) 봇·크롤러는 화면 파일도 못 읽게 막는다.
//  2) Cloudflare 기본 주소(*.pages.dev)로 들어오면 막는다. 진짜 주소(내 도메인)로만 들어오게.
//     - 주소를 바꿔도 .pages.dev 는 안 바뀌어서, 그 주소를 아는 사람이 계속 들어오는 걸 막는다.
//     - 내 도메인(kro.kr 등)은 .pages.dev 가 아니라서 그대로 열린다.
import { isBot } from '../src/bots.js';

// 기본 주소로 들어왔을 때 보여 줄 안내 (진짜 주소는 알려 주지 않는다)
const GONE = `<!DOCTYPE html><html lang="ko"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>페이지 없음</title>
<style>body{font-family:system-ui,sans-serif;display:grid;place-items:center;min-height:90vh;margin:0;color:#444;background:#fff}
@media(prefers-color-scheme:dark){body{background:#0f0f0f;color:#ccc}}div{text-align:center;padding:24px;line-height:1.6}</style></head>
<body><div><h1>페이지를 찾을 수 없어요</h1><p>주소를 확인해 주세요.</p></div></body></html>`;

export const onRequest = ({ request, next }) => {
  const url = new URL(request.url);

  // Cloudflare 기본 주소(xxx.pages.dev)로는 못 들어오게 막는다
  const host = (request.headers.get('Host') || url.hostname).toLowerCase().split(':')[0];
  if (host.endsWith('.pages.dev')) {
    return new Response(GONE, {
      status: 404,
      headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow' }
    });
  }

  // robots.txt 는 누구나 읽을 수 있게 둔다 (착한 크롤러가 '긁지 마' 규칙을 읽도록)
  if (url.pathname === '/robots.txt') return next();
  // 봇·크롤러는 화면 파일도 못 읽게 막는다
  if (isBot(request.headers.get('User-Agent'))) {
    return new Response('이 사이트는 사람만 쓸 수 있어요.', {
      status: 403,
      headers: { 'Content-Type': 'text/plain; charset=utf-8', 'X-Robots-Tag': 'noindex, nofollow' }
    });
  }
  return next();
};
