import { handleApi } from './api.js';
import { handleAuth, getSession, blockDevice, deviceBlockResponse, json } from './auth.js';
import { handleChess } from './chess.js';
import { tokenResponse } from './proxy.js';

// /api/* 요청의 입구. 계정 관련 요청은 auth 로, 나머지(영상 API)는 승인된 사용자만 쓸 수 있다.
// 로그인 없이는 아무것도 못 쓴다. KV 저장소(DB)를 연결하지 않았으면 로그인을 할 수 없으니 전부 막는다.
export async function handleRequest(request, env, yt) {
  const url = new URL(request.url);
  const isAuth = url.pathname.startsWith('/api/auth/') || url.pathname.startsWith('/api/admin/');
  const isChess = url.pathname.startsWith('/api/chess/');
  if (!env.DB) return json({ error: '로그인 기능이 아직 설정되지 않았어요. (KV 저장소 DB 연결 필요)', code: 'NO_DB' }, 503);
  // 차단된 기기는 관리자 화면과 문의하기 말고는 아무것도 못 쓴다.
  const allowed = url.pathname.startsWith('/api/admin/') || url.pathname.startsWith('/api/auth/contact');
  if (!allowed) {
    const blocked = await deviceBlockResponse(request, env);
    if (blocked) return blocked;
  }
  if (isAuth) return handleAuth(request, env);
  const info = {};
  const session = await getSession(request, env, info);
  if (!session) {
    if (info.blockedUser) return blockDevice(request, env, info.blockedUser);
    return json({ error: '로그인이 필요해요.', code: 'LOGIN_REQUIRED' }, 401);
  }
  if (isChess) return handleChess(request, env, session);
  // 프록시 앱: 로그인한 사람에게 /p/* 주소에 쓸 표를 준다
  if (url.pathname === '/api/proxy/token') return tokenResponse(env, session);
  return handleApi(url, yt);
}
