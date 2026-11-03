import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { handleRequest } from '../src/server.js';
import { clearCache } from '../src/api.js';

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
