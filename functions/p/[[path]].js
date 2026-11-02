// Cloudflare Pages 용 진입점: /p/* (웹 프록시) 요청을 처리한다.
import { handleProxy } from '../../src/proxy.js';

export const onRequest = ({ request, env }) => handleProxy(request, env);
