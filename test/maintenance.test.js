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
  return { status: res.status, body: await res.json(), setCookie: res.headers.get('Set-Cookie') };
}

const adminCookie = async () => (await call('', '/api/admin/login', { password: 'admin-secret' })).setCookie.split(';')[0];

test('점검을 켜면 관리자 말고는 못 쓰고, 끄면 다시 된다', async () => {
  const admin = await adminCookie();
  const a = await userCookie('minsu');
  assert.equal((await call(a, '/api/search?q=x')).status, 200);

  const until = Date.now() + 3600_000;
  const on = await call(admin, '/api/admin/maintenance', { on: true, message: '서버 정리 중', until });
  assert.equal(on.body.maintenance.on, true);

  for (const res of [
    await call(a, '/api/search?q=x'),
    await call(a, '/api/auth/me'),
    await call('', '/api/auth/login', { username: 'minsu', password: 'x' }),
    await call('', '/api/auth/signup', { username: 'newbie', password: 'pass1234', name: '새사람' })
  ]) {
    assert.equal(res.status, 503);
    assert.equal(res.body.code, 'MAINTENANCE');
    assert.equal(res.body.error, '서버 정리 중');
    assert.equal(res.body.until, until);
  }
  // 관리자, 관리자 로그인, 문의하기는 된다
  assert.equal((await call(admin, '/api/search?q=x')).status, 200);
  assert.equal((await call(admin, '/api/admin/users')).status, 200);
  assert.equal((await call('', '/api/admin/login', { password: 'admin-secret' })).status, 200);
  assert.equal((await call('', '/api/auth/contact', { name: '김민수', message: '언제 끝나요?' })).status, 201);

  await call(admin, '/api/admin/maintenance', { on: false });
  assert.equal((await call(a, '/api/search?q=x')).status, 200);
  assert.deepEqual((await call(admin, '/api/admin/maintenance')).body, { maintenance: null });
});

test('안내를 비우면 기본 문구, 지난 시각은 무시', async () => {
  const admin = await adminCookie();
  const res = await call(admin, '/api/admin/maintenance', { on: true, message: '  ', until: Date.now() - 1000 });
  assert.match(res.body.maintenance.message, /점검/);
  assert.equal(res.body.maintenance.until, 0);
});

test('점검 켜기는 관리자만', async () => {
  const a = await userCookie('minsu');
  assert.equal((await call(a, '/api/admin/maintenance', { on: true })).status, 401);
  assert.equal((await call('', '/api/admin/maintenance')).status, 401);
});
