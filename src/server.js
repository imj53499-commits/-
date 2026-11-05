import { handleApi } from './api.js';
import { handleAuth, getSession, blockDevice, deviceBlockResponse, json, ELSEWHERE_MESSAGE } from './auth.js';
import { tokenResponse } from './proxy.js';
import { handleApps, loadAccess, canUseApp } from './apps.js';
import { handleNotice } from './notice.js';
import { handleWatch } from './watch.js';
import { handleFriends } from './friends.js';
import { loadMaintenance, maintenanceResponse, handleMaintenanceAdmin } from './maintenance.js';
import { bumpRequest, handleStats } from './stats.js';

// /api/* 요청의 입구. 계정 관련 요청은 auth 로, 나머지(영상 API)는 승인된 사용자만 쓸 수 있다.
// 로그인 없이는 아무것도 못 쓴다. KV 저장소(DB)를 연결하지 않았으면 로그인을 할 수 없으니 전부 막는다.
export async function handleRequest(request, env, yt) {
  const url = new URL(request.url);
  // 봇·크롤러(ClaudeBot, GPTBot, Googlebot 등)는 막는다. 로그인해야 쓰는 사이트라 사람만 들어온다.
  const ua = request.headers.get('User-Agent') || '';
  if (/bot|crawl|spider|slurp|scrape|wget|python-requests|httpclient|gptbot|claudebot|ccbot|bytespider|petalbot|ahrefs|semrush|dataforseo|facebookexternalhit|bingpreview|yandex|baidu|googlebot/i.test(ua)) {
    return new Response('이 사이트는 사람만 쓸 수 있어요.', { status: 403, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'X-Robots-Tag': 'noindex, nofollow' } });
  }
  const isAuth = url.pathname.startsWith('/api/auth/') || url.pathname.startsWith('/api/admin/');
  if (!env.DB) return json({ error: '로그인 기능이 아직 설정되지 않았어요. (KV 저장소 DB 연결 필요)', code: 'NO_DB' }, 503);
  // 사용량 통계용으로 요청 수를 센다 (10분에 한 번만 KV 에 모아서 적음)
  await bumpRequest(env);
  // 차단된 기기는 관리자 화면과 문의하기 말고는 아무것도 못 쓴다.
  const allowed = url.pathname.startsWith('/api/admin/') || url.pathname.startsWith('/api/auth/contact');
  if (!allowed) {
    const blocked = await deviceBlockResponse(request, env);
    if (blocked) return blocked;
  }
  // 점검 중이면 관리자 말고는 못 쓴다 (관리자 화면·관리자 로그인·문의하기는 됨)
  if (!url.pathname.startsWith('/api/admin/') && !url.pathname.startsWith('/api/auth/contact')) {
    const maintenance = await loadMaintenance(env);
    if (maintenance?.on && (await getSession(request, env))?.role !== 'admin') return maintenanceResponse(maintenance);
  }
  // 사용량 통계 (관리자만)
  if (url.pathname === '/api/admin/stats') {
    const s = await getSession(request, env);
    if (s?.role !== 'admin') return json({ error: '관리자 로그인이 필요해요.', code: 'ADMIN_REQUIRED' }, 401);
    return handleStats(request, env, s);
  }
  // 점검 켜기·끄기 (관리자만)
  if (url.pathname === '/api/admin/maintenance') {
    if ((await getSession(request, env))?.role !== 'admin') return json({ error: '관리자 로그인이 필요해요.', code: 'ADMIN_REQUIRED' }, 401);
    return handleMaintenanceAdmin(request, env);
  }
  // 앱 보이기 설정 (/api/apps, /api/apps/check, 관리자용 /api/admin/apps)
  const isApps = ['/api/apps', '/api/apps/check', '/api/admin/apps'].includes(url.pathname);
  // 공지·패치노트 (/api/notice, 관리자용 /api/admin/notice)
  const isNotice = url.pathname === '/api/notice' || url.pathname === '/api/admin/notice';
  if (isAuth && !isApps && !isNotice) return handleAuth(request, env);
  const info = {};
  const session = await getSession(request, env, info);
  if (!session) {
    if (info.blockedUser) return blockDevice(request, env, info.blockedUser);
    if (info.elsewhere) return json({ error: ELSEWHERE_MESSAGE, code: 'LOGGED_IN_ELSEWHERE' }, 401);
    if (url.pathname === '/api/admin/apps' || url.pathname === '/api/admin/notice') return json({ error: '관리자 로그인이 필요해요.', code: 'ADMIN_REQUIRED' }, 401);
    return json({ error: '로그인이 필요해요.', code: 'LOGIN_REQUIRED' }, 401);
  }
  if (isApps) return handleApps(request, env, session);
  if (isNotice) return handleNotice(request, env, session);
  // 프록시 앱: 로그인한 사람에게 /p/* 주소에 쓸 표를 준다 (프록시 앱을 볼 수 없는 사람은 못 받음)
  if (url.pathname === '/api/proxy/token') {
    if (!canUseApp(await loadAccess(env), session, 'proxy')) {
      return json({ error: '이 앱은 쓸 수 없어요. 관리자에게 문의해 주세요.', code: 'APP_HIDDEN' }, 403);
    }
    return tokenResponse(env, session);
  }
  // 유튜브 앱을 볼 수 없는 사람은 영상 API 도 못 쓴다
  if (!canUseApp(await loadAccess(env), session, 'youtube')) {
    return json({ error: '이 앱은 쓸 수 없어요. 관리자에게 문의해 주세요.', code: 'APP_HIDDEN' }, 403);
  }
  // 같이 보기 (유튜브를 볼 수 있는 사람만)
  if (url.pathname.startsWith('/api/watch/')) return handleWatch(request, env, session);
  if (url.pathname === '/api/friends' || url.pathname.startsWith('/api/friends/')) return handleFriends(request, env, session);
  return handleApi(url, yt);
}
