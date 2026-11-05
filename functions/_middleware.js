// 모든 요청(화면 HTML·JS·CSS 포함)에 가장 먼저 걸린다. 봇·크롤러는 화면 파일도 못 읽게 막는다.
// (Pages Functions 는 보통 /api, /p 만 돌지만, 이 _middleware 는 정적 파일 요청에도 걸린다.)
import { isBot } from '../src/bots.js';

export const onRequest = ({ request, next }) => {
  // robots.txt 는 누구나 읽을 수 있게 둔다 (착한 크롤러가 '긁지 마' 규칙을 읽도록)
  if (new URL(request.url).pathname === '/robots.txt') return next();
  if (isBot(request.headers.get('User-Agent'))) {
    return new Response('이 사이트는 사람만 쓸 수 있어요.', {
      status: 403,
      headers: { 'Content-Type': 'text/plain; charset=utf-8', 'X-Robots-Tag': 'noindex, nofollow' }
    });
  }
  return next();
};
