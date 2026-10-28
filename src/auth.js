// 회원가입 / 로그인 / 관리자 승인.
// 계정과 세션은 Cloudflare KV(env.DB)에 저장하고, 관리자 비밀번호는 env.ADMIN_PASSWORD(비밀 값)로 받는다.
//
// KV 키
//   user:<아이디(소문자)>   → { username, salt, hash, status, createdAt }   (metadata 에 username, status, createdAt)
//   session:<토큰>          → { role: 'user' | 'admin', username? }          (만료 시간 있음)

export const SESSION_COOKIE = 'sy_session';
const USER_SESSION_TTL = 60 * 60 * 24 * 30; // 30일
const ADMIN_SESSION_TTL = 60 * 60 * 12; // 12시간
// Workers 무료 플랜 CPU 제한(요청당 10ms) 안에 들어오는 정도로 정했다.
const PBKDF2_ITERATIONS = 10000;

const USERNAME = /^[a-zA-Z0-9_가-힣]{2,20}$/;
const STATUSES = ['pending', 'approved', 'rejected'];

// ---------- 공통 ----------

export function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers }
  });
}

const fail = (error, status, code) => json({ error, code }, status);

function toHex(buf) {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function randomHex(bytes) {
  return toHex(crypto.getRandomValues(new Uint8Array(bytes)));
}

// 길이가 같으면 끝까지 다 비교해서, 걸린 시간으로 비밀번호를 추측할 수 없게 한다.
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function sha256Hex(text) {
  return toHex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
}

export async function hashPassword(password, salt) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: new TextEncoder().encode(salt), iterations: PBKDF2_ITERATIONS },
    key,
    256
  );
  return toHex(bits);
}

function getCookie(request, name) {
  const header = request.headers.get('Cookie') || '';
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return '';
}

function sessionCookie(token, maxAge) {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

// 다른 사이트에서 폼으로 몰래 요청을 보내지 못하게 JSON 요청만 받는다.
async function readJson(request) {
  if (!(request.headers.get('Content-Type') || '').includes('application/json')) return null;
  const text = await request.text();
  if (text.length > 2000) return null;
  try {
    const body = JSON.parse(text);
    return body && typeof body === 'object' ? body : null;
  } catch {
    return null;
  }
}

const userKey = (username) => `user:${username.toLowerCase()}`;

async function createSession(env, data, ttl) {
  const token = randomHex(32);
  await env.DB.put(`session:${token}`, JSON.stringify(data), { expirationTtl: ttl });
  return token;
}

// ---------- 세션 확인 (다른 API 에서 사용) ----------

export async function getSession(request, env) {
  const token = getCookie(request, SESSION_COOKIE);
  if (!/^[0-9a-f]{64}$/.test(token)) return null;
  const session = await env.DB.get(`session:${token}`, 'json');
  if (!session) return null;
  if (session.role === 'admin') return { role: 'admin', token };
  // 승인이 취소되거나 계정이 지워지면 바로 못 쓰게, 매번 계정 상태를 확인한다.
  const user = await env.DB.get(userKey(session.username), 'json');
  if (!user || user.status !== 'approved') return null;
  return { role: 'user', username: user.username, token };
}

// ---------- 라우트 ----------

async function signup(request, env) {
  const body = await readJson(request);
  const username = String(body?.username ?? '').trim();
  const password = String(body?.password ?? '');
  if (!USERNAME.test(username)) return fail('아이디는 한글, 영문, 숫자, _ 로 2~20자로 정해 주세요.', 400);
  if (password.length < 6 || password.length > 100) return fail('비밀번호는 6자 이상으로 정해 주세요.', 400);
  if (await env.DB.get(userKey(username))) return fail('이미 있는 아이디예요.', 409);

  const salt = randomHex(16);
  const createdAt = Date.now();
  const user = { username, salt, hash: await hashPassword(password, salt), status: 'pending', createdAt };
  await env.DB.put(userKey(username), JSON.stringify(user), { metadata: { username, status: 'pending', createdAt } });
  return json({ ok: true, status: 'pending' }, 201);
}

async function login(request, env) {
  const body = await readJson(request);
  const username = String(body?.username ?? '').trim();
  const password = String(body?.password ?? '');
  const user = USERNAME.test(username) ? await env.DB.get(userKey(username), 'json') : null;
  // 아이디가 없을 때도 똑같이 계산해서, 응답 시간으로 아이디 존재 여부를 알 수 없게 한다.
  const hash = await hashPassword(password, user?.salt || 'no-user');
  if (!user || !safeEqual(hash, user.hash)) return fail('아이디 또는 비밀번호가 맞지 않아요.', 401, 'BAD_LOGIN');
  if (user.status === 'pending') return fail('아직 관리자 승인을 기다리고 있어요.', 403, 'PENDING');
  if (user.status !== 'approved') return fail('가입이 승인되지 않았어요.', 403, 'REJECTED');

  const token = await createSession(env, { role: 'user', username: user.username }, USER_SESSION_TTL);
  return json({ username: user.username, role: 'user' }, 200, { 'Set-Cookie': sessionCookie(token, USER_SESSION_TTL) });
}

async function logout(request, env) {
  const session = await getSession(request, env);
  if (session) await env.DB.delete(`session:${session.token}`);
  return json({ ok: true }, 200, { 'Set-Cookie': sessionCookie('', 0) });
}

async function me(request, env) {
  const session = await getSession(request, env);
  if (!session) return fail('로그인이 필요해요.', 401, 'LOGIN_REQUIRED');
  return json({ username: session.username || '관리자', role: session.role });
}

async function adminLogin(request, env) {
  if (!env.ADMIN_PASSWORD) return fail('관리자 비밀번호(ADMIN_PASSWORD)가 아직 설정되지 않았어요.', 500, 'NO_ADMIN_PASSWORD');
  const body = await readJson(request);
  // 길이가 달라도 비교 시간이 같도록 해시끼리 비교한다.
  const ok = safeEqual(await sha256Hex(String(body?.password ?? '')), await sha256Hex(env.ADMIN_PASSWORD));
  if (!ok) return fail('관리자 비밀번호가 맞지 않아요.', 401, 'BAD_LOGIN');
  const token = await createSession(env, { role: 'admin' }, ADMIN_SESSION_TTL);
  return json({ username: '관리자', role: 'admin' }, 200, { 'Set-Cookie': sessionCookie(token, ADMIN_SESSION_TTL) });
}

async function listUsers(env) {
  const users = [];
  let cursor;
  do {
    const page = await env.DB.list({ prefix: 'user:', cursor });
    for (const key of page.keys) {
      users.push({
        username: key.metadata?.username || key.name.slice('user:'.length),
        status: key.metadata?.status || 'pending',
        createdAt: key.metadata?.createdAt || 0
      });
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return users.sort((a, b) => b.createdAt - a.createdAt);
}

async function updateUser(request, env) {
  const body = await readJson(request);
  const username = String(body?.username ?? '');
  const action = body?.action;
  if (!USERNAME.test(username)) return fail('잘못된 아이디', 400);
  const user = await env.DB.get(userKey(username), 'json');
  if (!user) return fail('없는 아이디예요.', 404);

  if (action === 'delete') {
    await env.DB.delete(userKey(username));
    return json({ ok: true });
  }
  const status = { approve: 'approved', reject: 'rejected', pending: 'pending' }[action];
  if (!STATUSES.includes(status)) return fail('잘못된 요청', 400);
  user.status = status;
  await env.DB.put(userKey(username), JSON.stringify(user), { metadata: { username: user.username, status, createdAt: user.createdAt } });
  return json({ ok: true, status });
}

export async function handleAuth(request, env) {
  const { pathname } = new URL(request.url);
  const method = request.method;

  if (pathname === '/api/auth/me' && method === 'GET') return me(request, env);
  if (pathname === '/api/auth/signup' && method === 'POST') return signup(request, env);
  if (pathname === '/api/auth/login' && method === 'POST') return login(request, env);
  if (pathname === '/api/auth/logout' && method === 'POST') return logout(request, env);
  if (pathname === '/api/admin/login' && method === 'POST') return adminLogin(request, env);

  if (pathname.startsWith('/api/admin/')) {
    const session = await getSession(request, env);
    if (session?.role !== 'admin') return fail('관리자 로그인이 필요해요.', 401, 'ADMIN_REQUIRED');
    if (pathname === '/api/admin/users' && method === 'GET') return json(await listUsers(env));
    if (pathname === '/api/admin/users' && method === 'POST') return updateUser(request, env);
  }
  return fail('Not found', 404);
}
