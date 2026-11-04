import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { handleRequest } from '../src/server.js';
import { FIRST_NOTICE } from '../src/notice.js';

function fakeKV() {
  const store = new Map();
  return {
    async get(key, type) { const v = store.get(key); return v === undefined ? null : type === 'json' ? JSON.parse(v) : v; },
    async put(key, value) { store.set(key, value); },
    async delete(key) { store.delete(key); },
    async list() { return { keys: [], list_complete: true }; }
  };
}

let env;
beforeEach(() => { env = { DB: fakeKV(), ADMIN_PASSWORD: 'admin-secret' }; });

async function userCookie(username) {
  const token = username.padEnd(64, 'a').replace(/[^0-9a-f]/g, 'b').slice(0, 64);
  await env.DB.put(`session:${token}`, JSON.stringify({ role: 'user', username, pwv: 0 }));
  await env.DB.put(`user:${username}`, JSON.stringify({ username, name: username, status: 'approved', pwv: 0 }));
  return `sy_session=${token}`;
}

async function adminCookie() {
  const res = await handleRequest(new Request('https://site.test/api/admin/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'admin-secret' })
  }), env, {});
  return res.headers.get('Set-Cookie').split(';')[0];
}

async function call(cookie, path, body) {
  const init = { method: body ? 'POST' : 'GET', headers: cookie ? { Cookie: cookie } : {} };
  if (body) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const res = await handleRequest(new Request(`https://site.test${path}`, init), env, {});
  return { status: res.status, body: await res.json() };
}

test('아직 게시한 적이 없으면 첫 패치노트, 관리자가 게시하면 그게 보인다', async () => {
  const a = await userCookie('minsu');
  assert.deepEqual((await call(a, '/api/notice')).body, { notice: FIRST_NOTICE });
  const admin = await adminCookie();
  const posted = await call(admin, '/api/admin/notice', { title: '패치노트', body: '- 첫째\r\n- 둘째' });
  assert.equal(posted.status, 200);
  const { notice } = (await call(a, '/api/notice')).body;
  assert.equal(notice.title, '패치노트');
  assert.equal(notice.body, '- 첫째\n- 둘째');
  assert.ok(notice.id);

  // 고쳐서 다시 게시하면 id 가 바뀐다 ('다시 보지 않기' 한 사람에게도 다시 뜨게)
  const again = await call(admin, '/api/admin/notice', { title: '패치노트', body: '- 셋째' });
  assert.notEqual(again.body.notice.id, notice.id);

  // 내리기 (첫 패치노트도 다시 안 뜬다)
  await call(admin, '/api/admin/notice', { clear: true });
  assert.deepEqual((await call(a, '/api/notice')).body, { notice: null });
  assert.deepEqual((await call(admin, '/api/admin/notice')).body, { notice: null });
});

test('첫 패치노트도 내릴 수 있다', async () => {
  const a = await userCookie('minsu');
  const admin = await adminCookie();
  assert.equal((await call(admin, '/api/admin/notice')).body.notice.id, FIRST_NOTICE.id);
  await call(admin, '/api/admin/notice', { clear: true });
  assert.deepEqual((await call(a, '/api/notice')).body, { notice: null });
});

test('공지는 관리자만 쓰고, 로그인 안 하면 못 본다', async () => {
  const a = await userCookie('minsu');
  assert.equal((await call(a, '/api/admin/notice', { title: 't', body: 'b' })).status, 401);
  assert.equal((await call('', '/api/admin/notice')).status, 401);
  assert.equal((await call('', '/api/notice')).status, 401);
  const admin = await adminCookie();
  assert.equal((await call(admin, '/api/admin/notice', { title: '', body: 'b' })).status, 400);
  assert.equal((await call(admin, '/api/admin/notice', { title: 't', body: '  ' })).status, 400);
});
