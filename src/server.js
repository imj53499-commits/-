import { handleApi } from './api.js';
import { handleAuth, getSession, json } from './auth.js';

// /api/* 요청의 입구. 계정 관련 요청은 auth 로, 나머지(영상 API)는 승인된 사용자만 쓸 수 있다.
// KV 저장소(DB)를 아직 연결하지 않았으면 로그인 없이 지금처럼 열어 두고, 연결하는 순간부터 로그인이 필요해진다.
export async function handleRequest(request, env, yt) {
  const url = new URL(request.url);
  const isAuth = url.pathname.startsWith('/api/auth/') || url.pathname.startsWith('/api/admin/');
  if (!env.DB) {
    if (isAuth) return json({ error: '로그인 기능이 아직 설정되지 않았어요. (KV 저장소 DB 연결 필요)', code: 'NO_DB' }, 503);
    return handleApi(url, yt);
  }
  if (isAuth) return handleAuth(request, env);
  if (!(await getSession(request, env))) {
    return json({ error: '로그인이 필요해요.', code: 'LOGIN_REQUIRED' }, 401);
  }
  return handleApi(url, yt);
}
