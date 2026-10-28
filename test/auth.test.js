import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { handleRequest } from '../src/server.js';
import { clearCache } from '../src/api.js';

// Cloudflare KV 와 같은 동작을 하는 가짜 저장소 (get/put/delete/list + metadata)
function fakeKV() {
  const store = new Map();
  return {
    store,
    async get(key, type) {
      const item = store.get(key);
      if (!item) return null;
      return type === 'json' ? JSON.parse(item.value) : item.value;
    },
    async put(key, value, opts = {}) {
      store.set(key, { value, metadata: opts.metadata, ttl: opts.expirationTtl });
    },
    async delete(key) {
      store.delete(key);
    },
    async list({ prefix = '' } = {}) {
      const keys = [...store.keys()].filter((k) => k.startsWith(prefix)).sort().map((name) => ({ name, metadata: store.get(name).metadata }));
      return { keys, list_complete: true };
    }
  };
}

const fakeYt = { search: async () => [{ id: 'aaaaaaaaaaa', title: '영상' }] };

let env;
beforeEach(() => {
  env = { DB: fakeKV(), ADMIN_PASSWORD: 'admin-secret' };
  clearCache();
});

async function call(path, { method = 'GET', body, cookie, contentType = 'application/json' } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = contentType;
  if (cookie) headers.Cookie = cookie;
  const res = await handleRequest(
    new Request(`https://site.test${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }),
    env,
    fakeYt
  );
  const setCookie = res.headers.get('Set-Cookie');
  return { status: res.status, body: await res.json(), cookie: setCookie ? setCookie.split(';')[0] : null, setCookie };
}

const signup = (username, password = 'pass1234', name = '홍길동') => call('/api/auth/signup', { method: 'POST', body: { username, password, name } });
const login = (username, password = 'pass1234') => call('/api/auth/login', { method: 'POST', body: { username, password } });
const adminLogin = (password = 'admin-secret') => call('/api/admin/login', { method: 'POST', body: { password } });
const admin = async (action, username, cookie) => call('/api/admin/users', { method: 'POST', body: { action, username }, cookie });

test('로그인 안 하면 영상 API 를 쓸 수 없다', async () => {
  const res = await call('/api/search?q=x');
  assert.equal(res.status, 401);
  assert.equal(res.body.code, 'LOGIN_REQUIRED');
  assert.equal((await call('/api/auth/me')).status, 401);
});

test('가입 → 승인 대기 → 관리자 승인 → 로그인 → 영상 API 사용', async () => {
  assert.equal((await signup('민수')).status, 201);
  assert.equal((await signup('민수')).status, 409);

  const pending = await login('민수');
  assert.equal(pending.status, 403);
  assert.equal(pending.body.code, 'PENDING');
  assert.equal(pending.cookie, null);

  const a = await adminLogin();
  assert.equal(a.status, 200);
  assert.match(a.setCookie, /HttpOnly; Secure; SameSite=Lax/);
  const list = await call('/api/admin/users', { cookie: a.cookie });
  assert.deepEqual(list.body.map((u) => [u.username, u.name, u.status]), [['민수', '홍길동', 'pending']]);
  assert.equal((await admin('approve', '민수', a.cookie)).status, 200);

  const ok = await login('민수');
  assert.equal(ok.status, 200);
  assert.ok(ok.cookie.startsWith('sy_session='));
  assert.equal(ok.body.name, '홍길동');
  assert.deepEqual((await call('/api/auth/me', { cookie: ok.cookie })).body, { username: '민수', name: '홍길동', role: 'user' });
  assert.equal((await call('/api/search?q=x', { cookie: ok.cookie })).status, 200);

  // 승인을 취소하면 바로 못 쓴다
  await admin('reject', '민수', a.cookie);
  assert.equal((await call('/api/search?q=x', { cookie: ok.cookie })).status, 401);
  assert.equal((await login('민수')).body.code, 'REJECTED');

  // 다시 승인 후 삭제하면 로그인 불가
  await admin('approve', '민수', a.cookie);
  await admin('delete', '민수', a.cookie);
  assert.equal((await login('민수')).status, 401);
  assert.deepEqual((await call('/api/admin/users', { cookie: a.cookie })).body, []);
});

test('비밀번호가 틀리면 로그인 실패, 아이디 대소문자는 구분하지 않는다', async () => {
  await signup('Tom');
  const a = await adminLogin();
  await admin('approve', 'tom', a.cookie);
  assert.equal((await login('Tom', 'wrong-pass')).status, 401);
  assert.equal((await login('nobody')).status, 401);
  assert.equal((await login('TOM')).status, 200);
  assert.equal((await signup('tom')).status, 409);
});

test('비밀번호는 그대로 저장하지 않는다', async () => {
  await signup('jin', 'mypassword');
  const raw = env.DB.store.get('user:jin').value;
  assert.ok(!raw.includes('mypassword'));
  assert.equal(JSON.parse(raw).hash.length, 64);
});

test('가입 입력값 검사', async () => {
  assert.equal((await signup('a')).status, 400);
  assert.equal((await signup('공백 있음')).status, 400);
  assert.equal((await signup('<script>')).status, 400);
  assert.equal((await signup('okname', '123')).status, 400);
  // 본인 이름은 꼭 적어야 하고, 글자와 띄어쓰기만 된다
  assert.equal((await signup('noname', 'pass1234', '')).status, 400);
  assert.equal((await signup('noname', 'pass1234', '   ')).status, 400);
  assert.equal((await signup('noname', 'pass1234', '<b>김</b>')).status, 400);
  assert.equal((await signup('noname', 'pass1234', '가'.repeat(21))).status, 400);
  assert.equal((await signup('engname', 'pass1234', '  Kim   Min-su ')).status, 201);
  assert.equal(JSON.parse(env.DB.store.get('user:engname').value).name, 'Kim Min-su');
  // JSON 이 아닌 요청(다른 사이트의 폼 전송 등)은 받지 않는다
  assert.equal((await call('/api/auth/signup', { method: 'POST', body: { username: 'formuser', password: 'pass1234' }, contentType: 'application/x-www-form-urlencoded' })).status, 400);
});

test('관리자 기능은 관리자만', async () => {
  await signup('user1');
  assert.equal((await adminLogin('wrong')).status, 401);
  assert.equal((await call('/api/admin/users')).status, 401);
  const a = await adminLogin();
  await admin('approve', 'user1', a.cookie);
  const u = await login('user1');
  assert.equal((await call('/api/admin/users', { cookie: u.cookie })).status, 401);
  assert.equal((await admin('approve', 'user1', u.cookie)).status, 401);
  // 관리자는 영상도 볼 수 있다
  assert.equal((await call('/api/search?q=x', { cookie: a.cookie })).status, 200);
});

test('로그아웃하면 세션이 지워진다', async () => {
  await signup('kim');
  const a = await adminLogin();
  await admin('approve', 'kim', a.cookie);
  const u = await login('kim');
  const out = await call('/api/auth/logout', { method: 'POST', body: {}, cookie: u.cookie });
  assert.match(out.setCookie, /Max-Age=0/);
  assert.equal((await call('/api/auth/me', { cookie: u.cookie })).status, 401);
});

test('KV 를 연결하기 전에는 로그인 없이 열려 있고, 로그인 API 는 설정 필요를 알려 준다', async () => {
  env = { ADMIN_PASSWORD: 'x' };
  assert.equal((await call('/api/search?q=x')).status, 200);
  assert.equal((await call('/api/auth/me')).body.code, 'NO_DB');
  env = { DB: fakeKV() };
  assert.equal((await adminLogin()).body.code, 'NO_ADMIN_PASSWORD');
});

test('세션 만료 시간이 설정된다', async () => {
  await adminLogin();
  const session = [...env.DB.store.entries()].find(([k]) => k.startsWith('session:'))[1];
  assert.ok(session.ttl > 0);
});
