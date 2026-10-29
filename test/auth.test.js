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

const fakeYt = { searchPage: async () => ({ items: [{ id: 'aaaaaaaaaaa', title: '영상' }], next: null }) };

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
  assert.deepEqual((await call('/api/auth/me', { cookie: ok.cookie })).body, { username: '민수', name: '홍길동', role: 'user', mustChange: false });
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

test('관리자에게 문의: 로그인 없이 보내고, 관리자만 보고 읽음/삭제, 1시간 5개까지', async () => {
  const send = (body, cookie) => call('/api/auth/contact', { method: 'POST', body, cookie });
  assert.equal((await send({ name: '', message: '안녕하세요' })).status, 400);
  assert.equal((await send({ name: '김민수', message: '' })).status, 400);
  const ok = await send({ name: '김민수', username: 'minsu', contact: '010-0000-0000', message: '비밀번호를 잊어버렸어요\n도와주세요' });
  assert.equal(ok.status, 201);

  assert.equal((await call('/api/admin/messages')).status, 401);
  const a = await adminLogin();
  const list = (await call('/api/admin/messages', { cookie: a.cookie })).body;
  assert.equal(list.length, 1);
  assert.deepEqual([list[0].name, list[0].username, list[0].contact, list[0].message, list[0].read],
    ['김민수', 'minsu', '010-0000-0000', '비밀번호를 잊어버렸어요\n도와주세요', false]);

  assert.equal((await call('/api/admin/messages', { method: 'POST', body: { id: list[0].id, action: 'read' }, cookie: a.cookie })).status, 200);
  assert.equal((await call('/api/admin/messages', { cookie: a.cookie })).body[0].read, true);
  await call('/api/admin/messages', { method: 'POST', body: { id: list[0].id, action: 'delete' }, cookie: a.cookie });
  assert.deepEqual((await call('/api/admin/messages', { cookie: a.cookie })).body, []);

  for (let i = 0; i < 4; i++) assert.equal((await send({ name: '도배', message: '테스트 ' + i })).status, 201);
  const blocked = await send({ name: '도배', message: '여섯 번째' });
  assert.equal(blocked.status, 429);
  assert.equal(blocked.body.code, 'RATE_LIMIT');
});

test('로그인한 사람이 문의하면 아이디가 자동으로 붙는다', async () => {
  await signup('kim');
  const a = await adminLogin();
  await admin('approve', 'kim', a.cookie);
  const u = await login('kim');
  await call('/api/auth/contact', { method: 'POST', body: { name: '', username: 'someoneelse', message: '영상이 안 나와요' }, cookie: u.cookie });
  const msg = (await call('/api/admin/messages', { cookie: a.cookie })).body[0];
  assert.deepEqual([msg.name, msg.username], ['홍길동', 'kim']);
});

test('비밀번호 초기화: 임시 비밀번호로만 로그인되고, 예전 로그인은 풀리고, 새 비밀번호를 정해야 한다', async () => {
  await signup('lee', 'oldpass1');
  const a = await adminLogin();
  await admin('approve', 'lee', a.cookie);
  const before = await login('lee', 'oldpass1');
  assert.equal(before.body.mustChange, false);

  const reset = await admin('reset', 'lee', a.cookie);
  assert.equal(reset.status, 200);
  const temp = reset.body.tempPassword;
  assert.match(temp, /^[a-z2-9]{8}$/);
  assert.ok(!JSON.stringify([...env.DB.store.values()]).includes(temp)); // 임시 비밀번호도 그대로 저장하지 않는다

  assert.equal((await call('/api/auth/me', { cookie: before.cookie })).status, 401); // 예전 로그인 풀림
  assert.equal((await login('lee', 'oldpass1')).status, 401);
  const tempLogin = await login('lee', temp);
  assert.equal(tempLogin.status, 200);
  assert.equal(tempLogin.body.mustChange, true);
  assert.equal((await call('/api/auth/me', { cookie: tempLogin.cookie })).body.mustChange, true);

  const change = (body, cookie = tempLogin.cookie) => call('/api/auth/password', { method: 'POST', body, cookie });
  assert.equal((await change({ current: 'wrong', next: 'newpass9' })).status, 400);
  assert.equal((await change({ current: temp, next: '123' })).status, 400);
  const changed = await change({ current: temp, next: 'newpass9' });
  assert.equal(changed.status, 200);
  assert.equal((await call('/api/auth/me', { cookie: tempLogin.cookie })).status, 401); // 바꾸기 전 쿠키는 풀림
  const me2 = await call('/api/auth/me', { cookie: changed.cookie }); // 새 쿠키로 계속 로그인 상태
  assert.equal(me2.body.mustChange, false);
  assert.equal((await login('lee', temp)).status, 401);
  assert.equal((await login('lee', 'newpass9')).status, 200);
});

test('비밀번호 바꾸기는 로그인해야 하고, 관리자 초기화는 관리자만', async () => {
  assert.equal((await call('/api/auth/password', { method: 'POST', body: { current: 'a', next: 'bbbbbb' } })).status, 401);
  await signup('park');
  const a = await adminLogin();
  await admin('approve', 'park', a.cookie);
  const u = await login('park');
  assert.equal((await admin('reset', 'park', u.cookie)).status, 401);
});

test('문의 답장: 보낸 브라우저의 표로만 보이고, 초기화해서 보내면 임시 비밀번호가 답장에 들어간다', async () => {
  await signup('choi', 'oldpass1', '최지우');
  const a = await adminLogin();
  await admin('approve', 'choi', a.cookie);

  const sent = await call('/api/auth/contact', { method: 'POST', body: { name: '최지우', username: 'choi', message: '비밀번호를 잊었어요' } });
  const ticket = sent.body.ticket;
  assert.match(ticket, /^[0-9a-f]{32}$/);
  assert.ok(!JSON.stringify([...env.DB.store.entries()]).includes(ticket)); // 표 자체는 서버에 없다

  const replies = (tickets) => call('/api/auth/contact/replies', { method: 'POST', body: { tickets } });
  assert.equal((await replies([ticket])).body[0].reply, null); // 아직 답장 없음
  assert.equal((await replies(['0'.repeat(32)])).body[0].gone, true); // 남의 표는 아무것도 안 보인다

  const msg = (await call('/api/admin/messages', { cookie: a.cookie })).body[0];
  const reply = (body) => call('/api/admin/messages', { method: 'POST', body: { id: msg.id, action: 'reply', ...body }, cookie: a.cookie });
  assert.equal((await reply({ reply: '' })).status, 400);
  assert.equal((await call('/api/admin/messages', { method: 'POST', body: { id: msg.id, action: 'reply', reply: 'x' } })).status, 401); // 관리자만

  const done = await reply({ reply: '본인 확인했어요.', resetPassword: true });
  assert.equal(done.status, 200);
  const temp = done.body.tempPassword;
  assert.match(temp, /^[a-z2-9]{8}$/);

  const got = (await replies([ticket])).body[0];
  assert.ok(got.reply.text.startsWith('본인 확인했어요.'));
  assert.ok(got.reply.text.includes(`임시 비밀번호: ${temp}`));
  assert.equal((await login('choi', 'oldpass1')).status, 401);
  const tempLogin = await login('choi', temp);
  assert.equal(tempLogin.status, 200);
  assert.equal(tempLogin.body.mustChange, true);
});

test('임시 비밀번호는 24시간이 지나면 못 쓴다', async () => {
  await signup('jung');
  const a = await adminLogin();
  await admin('approve', 'jung', a.cookie);
  const temp = (await admin('reset', 'jung', a.cookie)).body.tempPassword;
  const stored = env.DB.store.get('user:jung');
  const user = JSON.parse(stored.value);
  user.tempExpires = Date.now() - 1000;
  stored.value = JSON.stringify(user);
  const res = await login('jung', temp);
  assert.equal(res.status, 401);
  assert.equal(res.body.code, 'TEMP_EXPIRED');
});

test('아이디가 없는 문의는 초기화해서 보낼 수 없고, 그냥 답장은 된다', async () => {
  const sent = await call('/api/auth/contact', { method: 'POST', body: { name: '손님', message: '승인 언제 돼요?' } });
  const a = await adminLogin();
  const msg = (await call('/api/admin/messages', { cookie: a.cookie })).body[0];
  const reset = await call('/api/admin/messages', { method: 'POST', body: { id: msg.id, action: 'reply', reply: '', resetPassword: true }, cookie: a.cookie });
  assert.equal(reset.status, 404);
  await call('/api/admin/messages', { method: 'POST', body: { id: msg.id, action: 'reply', reply: '오늘 안에 승인할게요' }, cookie: a.cookie });
  const got = (await call('/api/auth/contact/replies', { method: 'POST', body: { tickets: [sent.body.ticket] } })).body[0];
  assert.equal(got.reply.text, '오늘 안에 승인할게요');
});

test('차단: 바로 로그아웃되고, 다시 로그인 못 하고, 그 브라우저에서는 새로 가입도 못 한다', async () => {
  await signup('민수');
  const a = await adminLogin();
  await admin('approve', '민수', a.cookie);
  const user = await login('민수');
  assert.equal((await call('/api/search?q=x', { cookie: user.cookie })).status, 200);

  const blocked = await call('/api/admin/users', { method: 'POST', body: { action: 'block', username: '민수', reason: '욕설' }, cookie: a.cookie });
  assert.deepEqual(blocked.body, { ok: true, status: 'blocked' });
  const list = await call('/api/admin/users', { cookie: a.cookie });
  assert.deepEqual(list.body.map((u) => [u.status, u.blockReason]), [['blocked', '욕설']]);

  // 쓰던 로그인은 바로 막히고, 차단 이유가 보이고, 브라우저에 차단 표시가 남는다
  const kicked = await call('/api/search?q=x', { cookie: user.cookie });
  assert.equal(kicked.status, 403);
  assert.equal(kicked.body.code, 'BLOCKED');
  assert.match(kicked.body.error, /이유: 욕설/);
  assert.match(kicked.setCookie, /sy_blocked=1/);
  assert.equal((await call('/api/auth/me', { cookie: user.cookie })).body.code, 'BLOCKED');

  const again = await login('민수');
  assert.equal(again.status, 403);
  assert.equal(again.body.code, 'BLOCKED');
  // 비밀번호가 틀리면 차단 여부를 알려 주지 않는다
  assert.equal((await login('민수', 'wrong-pass')).body.code, 'BAD_LOGIN');

  const newAccount = await call('/api/auth/signup', { method: 'POST', body: { username: '민수2', password: 'pass1234', name: '홍길동' }, cookie: 'sy_blocked=1' });
  assert.equal(newAccount.status, 403);
  assert.equal(newAccount.body.code, 'BLOCKED');

  // 차단을 풀면 다시 로그인되고 이유는 지워진다
  assert.equal((await admin('unblock', '민수', a.cookie)).body.status, 'approved');
  assert.equal((await login('민수')).status, 200);
  assert.equal((await call('/api/admin/users', { cookie: a.cookie })).body[0].blockReason, '');
});

test('차단은 관리자만', async () => {
  await signup('민수');
  const res = await call('/api/admin/users', { method: 'POST', body: { action: 'block', username: '민수' } });
  assert.equal(res.status, 401);
});
