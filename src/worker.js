import { handleApi } from './api.js';
import { createYouTube } from './youtube.js';

const yt = createYouTube((input, init) => fetch(input, init));

// /api/* 만 이 코드가 처리하고, 나머지(화면 파일)는 Workers 정적 자산(public/)에서 바로 나간다.
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) return handleApi(url, yt);
    return env.ASSETS.fetch(request);
  }
};
