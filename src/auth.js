// 회원가입 / 로그인 / 관리자 승인.
// 계정과 세션은 Cloudflare KV(env.DB)에 저장하고, 관리자 비밀번호는 env.ADMIN_PASSWORD(비밀 값)로 받는다.
//
// KV 키
//   user:<아이디(소문자)>   → { username, name, salt, hash, status, createdAt, pwv, mustChange }
//                              (metadata 에 username, name, status, createdAt)
//   session:<토큰>          → { role: 'user' | 'admin', username?, pwv? }    (만료 시간 있음)
//   msg:<시각>-<임의값>      → 관리자에게 보낸 문의 { id, name, username, contact, message, at, read, hasTicket, reply? }
//   ticket:<표의 해시>       → 문의 id. 문의한 브라우저만 가진 '답장 받기 표'로 관리자 답장을 볼 수 있다 (30일)
//   rl:contact:<IP>         → 1시간 동안 보낸 문의 수 (스팸 막기)
//
// pwv(비밀번호 버전): 비밀번호를 바꾸거나 초기화하면 1 올라가고, 예전 버전으로 만든 로그인은 모두 풀린다.

export const SESSION_COOKIE = 'sy_session';
const USER_SESSION_TTL = 60 * 60 * 24 * 30; // 30일
const ADMIN_SESSION_TTL = 60 * 60 * 12; // 12시간
// Workers 무료 플랜 CPU 제한(요청당 10ms) 안에 들어오는 정도로 정했다.
const PBKDF2_ITERATIONS = 10000;

const USERNAME = /^[a-zA-Z0-9_가-힣]{2,20}$/;
// 본인 이름: 글자(한글, 영문 등), 공백, . - ' 만 1~20자
const REAL_NAME = /^[\p{L}\p{M}][\p{L}\p{M} .'-]{0,19}$/u;
const STATUSES = ['pending', 'approved', 'rejected', 'blocked'];

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

// 비밀번호 지문: 차단된 계정과 같은 비밀번호로 새로 가입하는 걸 알아보려고 쓴다.
// 관리자 비밀번호를 열쇠로 한 HMAC 이라 KV 만으로는 비밀번호를 알아낼 수 없고, 계산이 가벼워
// 가입할 때 비밀번호 해시(PBKDF2)를 한 번 더 하지 않아도 된다 (Workers CPU 제한).
async function passwordFingerprint(env, password) {
  if (!env.ADMIN_PASSWORD) return '';
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(`pwf:${env.ADMIN_PASSWORD}`),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return toHex(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(password)));
}
const blockedPasswordKey = (fingerprint) => `bpw:${fingerprint}`;

async function addBlockedPassword(env, user) {
  if (user.pwf) await env.DB.put(blockedPasswordKey(user.pwf), JSON.stringify({ username: user.username }));
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

// 기기 차단: 차단된 계정으로 쓰던 브라우저나, 차단된 계정으로 로그인을 시도한(비밀번호까지 맞게) 브라우저에
// 기기 번호 쿠키를 남기고 KV 에 blockdev:<번호> 로 적어 둔다. 그 브라우저는 30일 동안 사이트 전체를 못 쓴다
// (문의하기만 됨). 관리자가 그 계정의 차단을 풀면 그 계정 때문에 막힌 기기도 같이 풀린다.
const DEVICE_COOKIE = 'sy_device';
const DEVICE_BLOCK_TTL = 60 * 60 * 24 * 30;
const deviceCookie = (id, maxAge) => `${DEVICE_COOKIE}=${id}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
const deviceKey = (id) => `blockdev:${id}`;

function blockedMessage(user) {
  const base = '관리자가 이 계정과 이 기기의 접속을 차단했어요.';
  return user?.blockReason ? `${base}\n이유: ${user.blockReason}` : base;
}

function blockedJson(message, setCookies) {
  const headers = new Headers({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  for (const c of setCookies) headers.append('Set-Cookie', c);
  return new Response(JSON.stringify({ error: message, code: 'BLOCKED' }), { status: 403, headers });
}

// 이 브라우저를 차단 기기로 적어 두고, 로그인은 지운다.
export async function blockDevice(request, env, user) {
  const old = getCookie(request, DEVICE_COOKIE);
  const id = /^[0-9a-f]{32}$/.test(old) ? old : randomHex(16);
  await env.DB.put(deviceKey(id), JSON.stringify({ username: user.username, at: Date.now() }),
    { expirationTtl: DEVICE_BLOCK_TTL, metadata: { username: user.username } });
  return blockedJson(blockedMessage(user), [deviceCookie(id, DEVICE_BLOCK_TTL), sessionCookie('', 0)]);
}

// 이 브라우저가 차단된 기기면 차단 응답을, 아니면 null 을 돌려준다.
export async function deviceBlockResponse(request, env) {
  const id = getCookie(request, DEVICE_COOKIE);
  if (!/^[0-9a-f]{32}$/.test(id)) return null;
  const mark = await env.DB.get(deviceKey(id), 'json');
  if (!mark) return null;
  const user = await env.DB.get(userKey(mark.username), 'json');
  // 차단이 풀린 계정 때문에 남아 있던 표시는 지운다 (계정을 삭제했으면 차단은 그대로 둔다)
  if (user && user.status !== 'blocked') {
    await env.DB.delete(deviceKey(id));
    return null;
  }
  return blockedJson(blockedMessage(user), [sessionCookie('', 0)]);
}

async function unblockDevices(env, username) {
  let cursor;
  do {
    const page = await env.DB.list({ prefix: 'blockdev:', cursor });
    for (const key of page.keys) {
      if (key.metadata?.username?.toLowerCase() === username.toLowerCase()) await env.DB.delete(key.name);
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
}

// 다른 사이트에서 폼으로 몰래 요청을 보내지 못하게 JSON 요청만 받는다.
async function readJson(request, maxLength = 2000) {
  if (!(request.headers.get('Content-Type') || '').includes('application/json')) return null;
  const text = await request.text();
  if (text.length > maxLength) return null;
  try {
    const body = JSON.parse(text);
    return body && typeof body === 'object' ? body : null;
  } catch {
    return null;
  }
}

const userKey = (username) => `user:${username.toLowerCase()}`;

async function putUser(env, user) {
  await env.DB.put(userKey(user.username), JSON.stringify(user), {
    metadata: { username: user.username, name: user.name || '', status: user.status, createdAt: user.createdAt, blockReason: user.blockReason || '' }
  });
}

async function setPassword(user, password) {
  user.salt = randomHex(16);
  user.hash = await hashPassword(password, user.salt);
  user.pwv = (user.pwv || 0) + 1;
  delete user.pwf;
}

const TEMP_PASSWORD_TTL = 24 * 60 * 60 * 1000; // 임시 비밀번호는 24시간 안에 써야 한다
const TICKET_TTL = 60 * 60 * 24 * 30;

// 비밀번호를 임시 비밀번호로 바꾸고(예전 로그인은 풀림) 그 임시 비밀번호를 돌려준다.
async function resetToTemp(env, user) {
  const temp = tempPassword();
  await setPassword(user, temp);
  user.mustChange = true;
  user.tempExpires = Date.now() + TEMP_PASSWORD_TTL;
  await putUser(env, user);
  return temp;
}

// 헷갈리는 글자(0 O 1 l I)를 뺀 8자 임시 비밀번호
function tempPassword() {
  const chars = 'abcdefghjkmnpqrstuvwxyz23456789';
  return [...crypto.getRandomValues(new Uint8Array(8))].map((b) => chars[b % chars.length]).join('');
}

// 줄바꿈과 탭만 남기고 보이지 않는 제어 문자는 뺀다.
function cleanText(value, max) {
  return String(value ?? '').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim().slice(0, max);
}

async function createSession(env, data, ttl) {
  const token = randomHex(32);
  await env.DB.put(`session:${token}`, JSON.stringify(data), { expirationTtl: ttl });
  return token;
}

// ---------- 세션 확인 (다른 API 에서 사용) ----------

// info 를 넘기면 차단된 계정일 때 info.blockedUser 에 그 계정을 넣어 준다.
export async function getSession(request, env, info = {}) {
  const token = getCookie(request, SESSION_COOKIE);
  if (!/^[0-9a-f]{64}$/.test(token)) return null;
  const session = await env.DB.get(`session:${token}`, 'json');
  if (!session) return null;
  if (session.role === 'admin') return { role: 'admin', token };
  if (session.role === 'trial') return Date.now() < session.expiresAt ? { role: 'trial', expiresAt: session.expiresAt, token } : null;
  // 승인이 취소되거나 계정이 지워지면 바로 못 쓰게, 매번 계정 상태를 확인한다.
  const user = await env.DB.get(userKey(session.username), 'json');
  if (user?.status === 'blocked') info.blockedUser = user;
  if (!user || user.status !== 'approved') return null;
  // 비밀번호가 바뀌었으면(초기화 포함) 예전 로그인은 풀린다.
  if ((session.pwv || 0) !== (user.pwv || 0)) return null;
  return { role: 'user', username: user.username, name: user.name || '', mustChange: !!user.mustChange, token };
}

// ---------- 라우트 ----------

async function signup(request, env) {
  const body = await readJson(request);
  const username = String(body?.username ?? '').trim();
  const password = String(body?.password ?? '');
  const name = String(body?.name ?? '').trim().replace(/\s+/g, ' ');
  if (!REAL_NAME.test(name)) return fail('이름을 1~20자로 적어 주세요. (글자와 띄어쓰기만)', 400);
  if (!USERNAME.test(username)) return fail('아이디는 한글, 영문, 숫자, _ 로 2~20자로 정해 주세요.', 400);
  if (password.length < 6 || password.length > 100) return fail('비밀번호는 6자 이상으로 정해 주세요.', 400);
  if (await env.DB.get(userKey(username))) return fail('이미 있는 아이디예요.', 409);

  const salt = randomHex(16);
  const createdAt = Date.now();
  // 차단된 계정과 비밀번호가 같으면 가입을 막고 이 기기도 차단한다.
  const pwf = await passwordFingerprint(env, password);
  if (pwf) {
    const mark = await env.DB.get(blockedPasswordKey(pwf), 'json');
    if (mark) {
      const owner = await env.DB.get(userKey(mark.username), 'json');
      if (!owner || owner.status === 'blocked') return blockDevice(request, env, owner || { username: mark.username });
      await env.DB.delete(blockedPasswordKey(pwf)); // 차단이 풀린 계정 것이면 지운다
    }
  }
  const user = { username, name, salt, hash: await hashPassword(password, salt), status: 'pending', createdAt, pwf };
  await putUser(env, user);
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
  if (user.mustChange && user.tempExpires && Date.now() > user.tempExpires) {
    return fail('임시 비밀번호가 만료됐어요. 관리자에게 다시 문의해 주세요.', 401, 'TEMP_EXPIRED');
  }
  // 지문이 없던 계정(이 기능 전에 가입)은 비밀번호가 맞았을 때 만들어 둔다. 임시 비밀번호는 빼고.
  const pwf = user.mustChange ? '' : await passwordFingerprint(env, password);
  if (pwf && user.pwf !== pwf) {
    user.pwf = pwf;
    await putUser(env, user);
  }
  if (user.status === 'blocked') {
    await addBlockedPassword(env, user);
    return blockDevice(request, env, user);
  }
  if (user.status === 'pending') return fail('아직 관리자 승인을 기다리고 있어요.', 403, 'PENDING');
  if (user.status !== 'approved') return fail('가입이 승인되지 않았어요.', 403, 'REJECTED');

  const token = await createSession(env, { role: 'user', username: user.username, pwv: user.pwv || 0 }, USER_SESSION_TTL);
  return json({ username: user.username, name: user.name || '', role: 'user', mustChange: !!user.mustChange }, 200,
    { 'Set-Cookie': sessionCookie(token, USER_SESSION_TTL) });
}

// 내 비밀번호 바꾸기 (임시 비밀번호로 로그인했을 때도 여기서 바꾼다)
async function changePassword(request, env) {
  const session = await getSession(request, env);
  if (session?.role !== 'user') return fail('로그인이 필요해요.', 401, 'LOGIN_REQUIRED');
  const body = await readJson(request);
  const current = String(body?.current ?? '');
  const next = String(body?.next ?? '');
  const user = await env.DB.get(userKey(session.username), 'json');
  if (!user || !safeEqual(await hashPassword(current, user.salt), user.hash)) return fail('지금 비밀번호가 맞지 않아요.', 400, 'BAD_PASSWORD');
  if (next.length < 6 || next.length > 100) return fail('새 비밀번호는 6자 이상으로 정해 주세요.', 400);
  if (next === current) return fail('지금과 다른 비밀번호로 정해 주세요.', 400);
  await setPassword(user, next);
  user.pwf = await passwordFingerprint(env, next);
  user.mustChange = false;
  delete user.tempExpires;
  await putUser(env, user);
  // 다른 기기의 로그인은 풀리고, 지금 기기는 새로 로그인된 상태로 둔다.
  await env.DB.delete(`session:${session.token}`);
  const token = await createSession(env, { role: 'user', username: user.username, pwv: user.pwv }, USER_SESSION_TTL);
  return json({ ok: true }, 200, { 'Set-Cookie': sessionCookie(token, USER_SESSION_TTL) });
}

// ---------- 관리자에게 문의 (로그인 안 해도 보낼 수 있음) ----------

const CONTACT_PER_HOUR = 5;
const MESSAGE_ID = /^\d{13}-[0-9a-f]{8}$/;

async function contact(request, env) {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const limitKey = `rl:contact:${ip}`;
  const sent = Number(await env.DB.get(limitKey)) || 0;
  if (sent >= CONTACT_PER_HOUR) return fail('문의를 너무 많이 보냈어요. 1시간 뒤에 다시 보내 주세요.', 429, 'RATE_LIMIT');

  const body = await readJson(request, 8000);
  const session = await getSession(request, env);
  const name = cleanText(body?.name, 20) || session?.name || '';
  const message = cleanText(body?.message, 1000);
  const contactInfo = cleanText(body?.contact, 100);
  const typedId = cleanText(body?.username, 20);
  const username = session?.role === 'user' ? session.username : (USERNAME.test(typedId) ? typedId : '');
  if (!name) return fail('이름을 적어 주세요.', 400);
  if (message.length < 2) return fail('문의 내용을 적어 주세요.', 400);

  const at = Date.now();
  const id = `${at}-${randomHex(4)}`;
  // 답장 받기 표: 보낸 브라우저에만 돌려주고, 서버에는 해시만 둔다.
  const ticket = randomHex(16);
  await env.DB.put(`msg:${id}`, JSON.stringify({ id, name, username, contact: contactInfo, message, at, read: false, hasTicket: true }),
    { metadata: { at, read: false } });
  await env.DB.put(`ticket:${await sha256Hex(ticket)}`, id, { expirationTtl: TICKET_TTL });
  await env.DB.put(limitKey, String(sent + 1), { expirationTtl: 3600 });
  return json({ ok: true, ticket }, 201);
}

// 문의한 브라우저가 가진 표들로 관리자 답장을 확인한다 (POST 로 받아서 주소에 표가 남지 않게).
async function contactReplies(request, env) {
  const body = await readJson(request);
  const tickets = (Array.isArray(body?.tickets) ? body.tickets : []).filter((t) => /^[0-9a-f]{32}$/.test(t)).slice(0, 10);
  const out = await Promise.all(tickets.map(async (ticket) => {
    const id = await env.DB.get(`ticket:${await sha256Hex(ticket)}`);
    const msg = id && await env.DB.get(`msg:${id}`, 'json');
    if (!msg) return { ticket, gone: true };
    return { ticket, at: msg.at, message: msg.message.slice(0, 200), reply: msg.reply || null };
  }));
  return json(out);
}

async function listMessages(env) {
  const keys = [];
  let cursor;
  do {
    const page = await env.DB.list({ prefix: 'msg:', cursor });
    keys.push(...page.keys);
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  const latest = keys.sort((a, b) => (b.metadata?.at || 0) - (a.metadata?.at || 0)).slice(0, 100);
  const messages = await Promise.all(latest.map((k) => env.DB.get(k.name, 'json')));
  return messages.filter(Boolean);
}

async function updateMessage(request, env) {
  const body = await readJson(request);
  const id = String(body?.id ?? '');
  if (!MESSAGE_ID.test(id)) return fail('잘못된 요청', 400);
  const key = `msg:${id}`;
  if (body?.action === 'delete') {
    await env.DB.delete(key);
    return json({ ok: true });
  }
  const msg = await env.DB.get(key, 'json');
  if (!msg) return fail('없는 문의예요.', 404);

  // 답장: 문의한 브라우저에서 볼 수 있다. resetPassword 면 그 아이디의 비밀번호를 초기화해서 임시 비밀번호를 같이 보낸다.
  if (body?.action === 'reply') {
    if (!msg.hasTicket) return fail('예전 방식으로 받은 문의라 답장을 보낼 수 없어요.', 400);
    let text = cleanText(body.reply, 1000);
    let temp = null;
    if (body.resetPassword) {
      const user = msg.username && await env.DB.get(userKey(msg.username), 'json');
      if (!user) return fail('문의에 적힌 아이디의 계정이 없어요.', 404);
      temp = await resetToTemp(env, user);
      text = `${text ? `${text}\n\n` : ''}임시 비밀번호: ${temp}\n이 비밀번호로 24시간 안에 로그인하면 새 비밀번호를 정하게 돼요.`;
    }
    if (!text) return fail('답장 내용을 적어 주세요.', 400);
    msg.reply = { text, at: Date.now() };
    msg.read = true;
    await env.DB.put(key, JSON.stringify(msg), { metadata: { at: msg.at, read: true } });
    return json({ ok: true, reply: msg.reply, tempPassword: temp });
  }

  if (body?.action !== 'read' && body?.action !== 'unread') return fail('잘못된 요청', 400);
  msg.read = body.action === 'read';
  await env.DB.put(key, JSON.stringify(msg), { metadata: { at: msg.at, read: msg.read } });
  return json({ ok: true });
}

// 체험하기: 가입·로그인 없이 1시간 동안 쓸 수 있다. 한 브라우저에서 하루에 한 번만 (쿠키로 기억),
// 쿠키를 지워 가며 계속 쓰는 걸 줄이려고 한 연결(IP)당 1시간에 30번까지. 학교처럼 여럿이 같은 IP 를 쓸 수 있어서 넉넉하게 잡았다.
const TRIAL_TTL = 60 * 60;
const TRIAL_COOLDOWN = 60 * 60 * 24;
const TRIAL_COOKIE = 'sy_trial';
const TRIAL_PER_HOUR_PER_IP = 30;

async function startTrial(request, env) {
  if (await getSession(request, env)) return fail('이미 로그인돼 있어요.', 400, 'ALREADY');
  if (getCookie(request, TRIAL_COOKIE)) return fail('체험은 하루에 한 번만 할 수 있어요. 계속 쓰려면 가입해 주세요.', 429, 'TRIAL_USED');
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const limitKey = `rl:trial:${ip}`;
  const count = Number(await env.DB.get(limitKey)) || 0;
  if (count >= TRIAL_PER_HOUR_PER_IP) return fail('지금은 체험을 시작할 수 없어요. 잠시 뒤에 다시 해 보거나 가입해 주세요.', 429, 'RATE_LIMIT');
  await env.DB.put(limitKey, String(count + 1), { expirationTtl: 3600 });

  const expiresAt = Date.now() + TRIAL_TTL * 1000;
  const token = await createSession(env, { role: 'trial', expiresAt }, TRIAL_TTL);
  const headers = new Headers({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  headers.append('Set-Cookie', sessionCookie(token, TRIAL_TTL));
  headers.append('Set-Cookie', `${TRIAL_COOKIE}=1; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${TRIAL_COOLDOWN}`);
  return new Response(JSON.stringify({ username: '체험', name: '', role: 'trial', expiresAt, mustChange: false }), { status: 200, headers });
}

async function logout(request, env) {
  const session = await getSession(request, env);
  if (session) await env.DB.delete(`session:${session.token}`);
  return json({ ok: true }, 200, { 'Set-Cookie': sessionCookie('', 0) });
}

async function me(request, env) {
  const info = {};
  const session = await getSession(request, env, info);
  if (info.blockedUser) return blockDevice(request, env, info.blockedUser);
  if (!session) return fail('로그인이 필요해요.', 401, 'LOGIN_REQUIRED');
  if (session.role === 'trial') return json({ username: '체험', name: '', role: 'trial', expiresAt: session.expiresAt, mustChange: false });
  return json({ username: session.username || '관리자', name: session.name || '', role: session.role, mustChange: !!session.mustChange });
}

async function adminLogin(request, env) {
  if (!env.ADMIN_PASSWORD) return fail('관리자 비밀번호(ADMIN_PASSWORD)가 아직 설정되지 않았어요.', 500, 'NO_ADMIN_PASSWORD');
  const body = await readJson(request);
  // 길이가 달라도 비교 시간이 같도록 해시끼리 비교한다.
  const ok = safeEqual(await sha256Hex(String(body?.password ?? '')), await sha256Hex(env.ADMIN_PASSWORD));
  if (!ok) return fail('관리자 비밀번호가 맞지 않아요.', 401, 'BAD_LOGIN');
  const token = await createSession(env, { role: 'admin' }, ADMIN_SESSION_TTL);
  // 관리자가 로그인한 기기는 차단 표시를 지운다 (공용 컴퓨터가 잘못 막혔을 때 풀 수 있게)
  const device = getCookie(request, DEVICE_COOKIE);
  if (/^[0-9a-f]{32}$/.test(device)) await env.DB.delete(deviceKey(device));
  const headers = new Headers({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  headers.append('Set-Cookie', sessionCookie(token, ADMIN_SESSION_TTL));
  headers.append('Set-Cookie', deviceCookie('', 0));
  return new Response(JSON.stringify({ username: '관리자', role: 'admin' }), { status: 200, headers });
}

async function listUsers(env) {
  const users = [];
  let cursor;
  do {
    const page = await env.DB.list({ prefix: 'user:', cursor });
    for (const key of page.keys) {
      users.push({
        username: key.metadata?.username || key.name.slice('user:'.length),
        name: key.metadata?.name || '',
        status: key.metadata?.status || 'pending',
        createdAt: key.metadata?.createdAt || 0,
        blockReason: key.metadata?.blockReason || ''
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
  // 비밀번호 초기화: 원래 비밀번호는 아무도 볼 수 없어서, 임시 비밀번호를 만들어 관리자에게 한 번만 보여 준다.
  // 그 사람은 임시 비밀번호로 로그인하면 바로 새 비밀번호를 정해야 하고, 예전 로그인은 모두 풀린다.
  if (action === 'reset') {
    return json({ ok: true, tempPassword: await resetToTemp(env, user) });
  }
  // 차단: 그 계정은 바로 로그아웃되고(매 요청마다 상태를 확인함) 다시 로그인할 수 없다.
  const status = { approve: 'approved', reject: 'rejected', pending: 'pending', block: 'blocked', unblock: 'approved' }[action];
  if (!STATUSES.includes(status)) return fail('잘못된 요청', 400);
  user.status = status;
  if (status === 'blocked') user.blockReason = cleanText(body?.reason, 100);
  else delete user.blockReason;
  if (status === 'blocked') await addBlockedPassword(env, user);
  if (action === 'unblock') {
    await unblockDevices(env, user.username);
    if (user.pwf) await env.DB.delete(blockedPasswordKey(user.pwf));
  }
  await putUser(env, user);
  return json({ ok: true, status });
}

export async function handleAuth(request, env) {
  const { pathname } = new URL(request.url);
  const method = request.method;

  if (pathname === '/api/auth/me' && method === 'GET') return me(request, env);
  if (pathname === '/api/auth/signup' && method === 'POST') return signup(request, env);
  if (pathname === '/api/auth/login' && method === 'POST') return login(request, env);
  if (pathname === '/api/auth/logout' && method === 'POST') return logout(request, env);
  if (pathname === '/api/auth/trial' && method === 'POST') return startTrial(request, env);
  if (pathname === '/api/auth/password' && method === 'POST') return changePassword(request, env);
  if (pathname === '/api/auth/contact' && method === 'POST') return contact(request, env);
  if (pathname === '/api/auth/contact/replies' && method === 'POST') return contactReplies(request, env);
  if (pathname === '/api/admin/login' && method === 'POST') return adminLogin(request, env);

  if (pathname.startsWith('/api/admin/')) {
    const session = await getSession(request, env);
    if (session?.role !== 'admin') return fail('관리자 로그인이 필요해요.', 401, 'ADMIN_REQUIRED');
    if (pathname === '/api/admin/users' && method === 'GET') return json(await listUsers(env));
    if (pathname === '/api/admin/users' && method === 'POST') return updateUser(request, env);
    if (pathname === '/api/admin/messages' && method === 'GET') return json(await listMessages(env));
    if (pathname === '/api/admin/messages' && method === 'POST') return updateMessage(request, env);
  }
  return fail('Not found', 404);
}
