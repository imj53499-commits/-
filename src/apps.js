// 앱별로 볼 수 있는 사람 정하기. 관리자가 정하고 KV(appAccess)에 저장한다.
//   { <앱 id>: { mode: 'all' | 'some' | 'none', users: [아이디(소문자), ...] } }
// 정해 두지 않은 앱은 모두에게 보인다. 관리자는 언제나 모든 앱을 본다.
import { json } from './auth.js';

const ACCESS_KEY = 'appAccess';
const APP_ID = /^[a-z0-9_-]{1,30}$/;
const MODES = ['all', 'some', 'none'];
const MAX_USERS = 500;
const CACHE_MS = 30 * 1000; // 매 요청마다 KV 를 읽지 않게 잠깐 기억한다

const fail = (error, status, code) => json({ error, code }, status);
const cache = new WeakMap(); // KV 저장소마다 { at, value }

export async function loadAccess(env) {
  const hit = cache.get(env.DB);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  const value = (await env.DB.get(ACCESS_KEY, 'json')) || {};
  cache.set(env.DB, { at: Date.now(), value });
  return value;
}

export function canUseApp(access, session, appId) {
  if (session.role === 'admin') return true;
  const rule = access[appId];
  if (!rule || rule.mode === 'all') return true;
  if (rule.mode === 'none') return false;
  return session.role === 'user' && rule.users.includes(session.username.toLowerCase());
}

async function readJson(request) {
  if (!(request.headers.get('Content-Type') || '').includes('application/json')) return null;
  try { return await request.json(); } catch { return null; }
}

async function saveRule(request, env) {
  const body = await readJson(request);
  const id = String(body?.id ?? '');
  const mode = body?.mode;
  if (!APP_ID.test(id)) return fail('앱 id 가 잘못됐어요.', 400);
  if (!MODES.includes(mode)) return fail('보이기 설정이 잘못됐어요.', 400);
  const users = Array.isArray(body?.users)
    ? [...new Set(body.users.map((u) => String(u).trim().toLowerCase()).filter((u) => u && u.length <= 20))].slice(0, MAX_USERS)
    : [];
  const access = (await env.DB.get(ACCESS_KEY, 'json')) || {};
  if (mode === 'all') delete access[id];
  else access[id] = { mode, users: mode === 'some' ? users : [] };
  await env.DB.put(ACCESS_KEY, JSON.stringify(access));
  cache.set(env.DB, { at: Date.now(), value: access });
  return json({ ok: true, access });
}

// /api/apps: 나에게 안 보이는 앱 목록, /api/apps/check?id=: 이 앱을 써도 되는지
// /api/admin/apps: 관리자용 (GET 전체 설정, POST 한 앱 설정 바꾸기)
export async function handleApps(request, env, session) {
  const url = new URL(request.url);
  const route = `${request.method} ${url.pathname}`;
  if (route === 'GET /api/apps') {
    const access = await loadAccess(env);
    return json({ hidden: Object.keys(access).filter((id) => !canUseApp(access, session, id)) });
  }
  if (route === 'GET /api/apps/check') {
    const id = String(url.searchParams.get('id') || '');
    if (!APP_ID.test(id)) return fail('앱 id 가 잘못됐어요.', 400);
    return canUseApp(await loadAccess(env), session, id) ? json({ ok: true }) : fail('이 앱은 쓸 수 없어요.', 403, 'APP_HIDDEN');
  }
  if (session.role !== 'admin') return fail('관리자 로그인이 필요해요.', 401, 'ADMIN_REQUIRED');
  if (route === 'GET /api/admin/apps') return json((await env.DB.get(ACCESS_KEY, 'json')) || {});
  if (route === 'POST /api/admin/apps') return saveRule(request, env);
  return fail('Not found', 404);
}
