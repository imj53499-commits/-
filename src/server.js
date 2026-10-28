import { handleApi } from './api.js';
import { handleAuth, getSession, json } from './auth.js';

// /api/* 요청의 입구. 계정 관련 요청은 auth 로, 나머지(영상 API)는 승인된 사용자만 쓸 수 있다.
export async function handleRequest(request, env, yt) {
  if (!env.DB) {
    return json({ error: '사이트 설정이 아직 끝나지 않았어요. (KV 저장소 DB 연결 필요)', code: 'NO_DB' }, 500);
  }
  const url = new URL(request.url);
  if (url.pathname.startsWith('/api/auth/') || url.pathname.startsWith('/api/admin/')) {
    return handleAuth(request, env);
  }
  if (!(await getSession(request, env))) {
    return json({ error: '로그인이 필요해요.', code: 'LOGIN_REQUIRED' }, 401);
  }
  return handleApi(url, yt);
}
