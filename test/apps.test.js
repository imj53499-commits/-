import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { handleRequest } from '../src/server.js';
import { clearCache } from '../src/api.js';
import { handleProxy, clearAllowCache } from '../src/proxy.js';

function fakeKV() {
  const store = new Map();
  return {
    async get(key, type) { const v = store.get(key); return v === undefined ? null : type === 'json' ? JSON.parse(v) : v; },
    async put(key, value) { store.set(key, value); },
    async delete(key) { store.delete(key); },
    async list() { return { keys: [], list_complete: true }; }
  };
}

const fakeYt = { searchPage: async () => ({ items: [{ id: 'aaaaaaaaaaa', title: '영상' }], next: null }) };
let env;
beforeEach(() => {
  env = { DB: fakeKV(), ADMIN_PASSWORD: 'admin-secret' };
  clearCache();
});

async function userCookie(username) {
  const token = username.padEnd(64, 'a').replace(/[^0-9a-f]/g, 'b').slice(0, 64);
  await env.DB.put(`session:${token}`, JSON.stringify({ role: 'user', username, pwv: 0 }));
  await env.DB.put(`user:${username}`, JSON.stringify({ username, name: username, status: 'approved', pwv: 0 }));
  return `sy_session=${token}`;
}

async function call(cookie, path, body) {
  const init = { method: body ? 'POST' : 'GET', headers: cookie ? { Cookie: cookie } : {} };
  if (body) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const res = await handleRequest(new Request(`https://site.test${path}`, init), env, fakeYt);
  return { status: res.status, body: await res.json() };
}

async function adminCookie() {
  const res = await handleRequest(new Request('https://site.test/api/admin/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'admin-secret' })
  }), env, fakeYt);
  return res.headers.get('Set-Cookie').split(';')[0];
}

test('정해 두지 않은 앱은 모두에게 보인다', async () => {
  const a = await userCookie('minsu');
  assert.deepEqual((await call(a, '/api/apps')).body, { hidden: [] });
  assert.equal((await call(a, '/api/apps/check?id=game')).status, 200);
});

test('선택한 사람만: 고른 사람만 보이고, 나머지는 목록·확인에서 빠진다', async () => {
  const admin = await adminCookie();
  const a = await userCookie('minsu');
  const b = await userCookie('jisu');
  const saved = await call(admin, '/api/admin/apps', { id: 'game', mode: 'some', users: ['MinSu'] });
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.body.access.game, { mode: 'some', users: ['minsu'] });

  assert.deepEqual((await call(a, '/api/apps')).body.hidden, []);
  assert.equal((await call(a, '/api/apps/check?id=game')).status, 200);
  assert.deepEqual((await call(b, '/api/apps')).body.hidden, ['game']);
  const no = await call(b, '/api/apps/check?id=game');
  assert.equal(no.status, 403);
  assert.equal(no.body.code, 'APP_HIDDEN');

  // 관리자는 언제나 보인다
  assert.equal((await call(admin, '/api/apps/check?id=game')).status, 200);
  // 다시 모두에게
  await call(admin, '/api/admin/apps', { id: 'game', mode: 'all' });
  assert.deepEqual((await call(b, '/api/apps')).body.hidden, []);
});

test('유튜브를 안 보이게 하면 영상 API 도 막힌다', async () => {
  const admin = await adminCookie();
  const a = await userCookie('minsu');
  assert.equal((await call(a, '/api/search?q=x')).status, 200);
  await call(admin, '/api/admin/apps', { id: 'youtube', mode: 'none' });
  const res = await call(a, '/api/search?q=x');
  assert.equal(res.status, 403);
  assert.equal(res.body.code, 'APP_HIDDEN');
});

test('설정은 관리자만 보고 바꿀 수 있고, 로그인 안 하면 확인도 안 된다', async () => {
  const a = await userCookie('minsu');
  assert.equal((await call(a, '/api/admin/apps')).status, 401);
  assert.equal((await call(a, '/api/admin/apps', { id: 'game', mode: 'none' })).status, 401);
  assert.equal((await call('', '/api/admin/apps')).status, 401);
  assert.equal((await call('', '/api/apps/check?id=game')).status, 401);
  const admin = await adminCookie();
  assert.equal((await call(admin, '/api/admin/apps', { id: 'Bad Id!', mode: 'none' })).status, 400);
  assert.equal((await call(admin, '/api/admin/apps', { id: 'game', mode: 'maybe' })).status, 400);
});

test('프록시를 안 보이게 하면 프록시 표도 못 받는다', async () => {
  const admin = await adminCookie();
  const a = await userCookie('minsu');
  assert.equal((await call(a, '/api/proxy/token', {})).status, 200);
  await call(admin, '/api/admin/apps', { id: 'proxy', mode: 'none' });
  const res = await call(a, '/api/proxy/token', {});
  assert.equal(res.status, 403);
  assert.equal(res.body.code, 'APP_HIDDEN');
  assert.equal((await call(admin, '/api/proxy/token', {})).status, 200);
});

test('프록시를 숨기거나 승인 취소하면 이미 받은 표도 바로 못 쓴다', async () => {
  clearAllowCache();
  const admin = await adminCookie();
  const a = await userCookie('minsu');
  const tok = (await call(a, '/api/proxy/token', {})).body.token;
  const fake = async () => new Response('x', { headers: { 'content-type': 'image/png' } });
  const use = (t) => handleProxy(new Request(`https://site.test/p/${t}/https/example.com/a.png`), env, fake);
  assert.equal((await use(tok)).status, 200);

  await call(admin, '/api/admin/apps', { id: 'proxy', mode: 'none' });
  clearAllowCache(); // 실제로는 최대 30초 뒤
  assert.equal((await use(tok)).status, 403);
  // 관리자 표는 그대로 된다
  const adminTok = (await call(admin, '/api/proxy/token', {})).body.token;
  assert.equal((await use(adminTok)).status, 200);

  // 다시 보이게 하면 다시 된다
  await call(admin, '/api/admin/apps', { id: 'proxy', mode: 'all' });
  clearAllowCache();
  assert.equal((await use(tok)).status, 200);

  // 승인 취소(또는 차단)돼도 막힌다
  await env.DB.put('user:minsu', JSON.stringify({ username: 'minsu', name: 'minsu', status: 'blocked', pwv: 0 }));
  clearAllowCache();
  assert.equal((await use(tok)).status, 403);
});

test('봇 User-Agent 는 막고, 보통 브라우저는 통과시킨다', async () => {
  const bot = await handleRequest(new Request('https://site.test/api/home', { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ClaudeBot/1.0)' } }), env, fakeYt);
  assert.equal(bot.status, 403);
  const gpt = await handleRequest(new Request('https://site.test/api/home', { headers: { 'User-Agent': 'GPTBot/1.1' } }), env, fakeYt);
  assert.equal(gpt.status, 403);
  // 보통 브라우저는 봇 차단이 아니라 로그인 필요(401)로 넘어간다
  const human = await handleRequest(new Request('https://site.test/api/home', { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36' } }), env, fakeYt);
  assert.equal(human.status, 401);
});
