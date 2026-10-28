// Cloudflare Pages 용 진입점: /api/* 요청을 처리한다. 화면 파일은 Pages가 public/ 에서 바로 내보낸다.
import { handleRequest } from '../../src/server.js';
import { createYouTube } from '../../src/youtube.js';

const yt = createYouTube((input, init) => fetch(input, init));

export const onRequest = ({ request, env }) => handleRequest(request, env, yt);
