import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { handleRequest } from '../src/server.js';

// Cloudflare D1 과 같은 모양의 가짜 저장소 (node:sqlite 위에)
function fakeD1() {
  const db = new DatabaseSync(':memory:');
  const statement = (sql, args = []) => ({
    bind: (...a) => statement(sql, a),
    first: async () => db.prepare(sql).get(...args) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...args) }),
    run: async () => ({ meta: { changes: Number(db.prepare(sql).run(...args).changes) } })
  });
  return { prepare: (sql) => statement(sql), batch: async (list) => { for (const s of list) await s.run(); } };
}

function fakeKV() {
  const store = new Map();
  return {
    async get(key, type) { const v = store.get(key)?.value; return v === undefined ? null : type === 'json' ? JSON.parse(v) : v; },
    async put(key, value, opts = {}) { store.set(key, { value, metadata: opts.metadata }); },
    async delete(key) { store.delete(key); },
    async list({ prefix = '' } = {}) {
      return { keys: [...store.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name, metadata: store.get(name).metadata })), list_complete: true };
    }
  };
}

let env;
beforeEach(() => { env = { DB: fakeKV(), D1: fakeD1(), ADMIN_PASSWORD: 'admin-secret' }; });

async function userCookie(username, name) {
  const token = username.padEnd(64, 'a').replace(/[^0-9a-f]/g, 'b').slice(0, 64);
  await env.DB.put(`session:${token}`, JSON.stringify({ role: 'user', username, pwv: 0 }));
  await env.DB.put(`user:${username}`, JSON.stringify({ username, name, status: 'approved', pwv: 0 }), { metadata: { username, name, status: 'approved' } });
  return `sy_session=${token}`;
}

async function call(cookie, path, body) {
  const init = { method: body ? 'POST' : 'GET', headers: { Cookie: cookie } };
  if (body) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const res = await handleRequest(new Request(`https://site.test${path}`, init), env, {});
  return { status: res.status, body: await res.json() };
}

async function makeFriends(x, y, yName) {
  await call(x, '/api/friends/request', { username: yName });
  const req = (await call(y, '/api/friends')).body.incoming[0];
  await call(y, '/api/friends/respond', { username: req.username, accept: true });
}

test('친구 신청 → 알림 → 수락하면 서로 친구, 끊기·취소·거절', async () => {
  const a = await userCookie('minsu', '김민수');
  const b = await userCookie('jisu', '이지수');
  const c = await userCookie('cheolsu', '박철수');
  assert.equal((await call(a, '/api/friends/request', { username: 'nobody' })).body.code, 'NO_USER');
  assert.equal((await call(a, '/api/friends/request', { username: 'minsu' })).status, 400);
  assert.equal((await call(a, '/api/friends/request', { username: 'JISU' })).body.status, 'pending');
  assert.equal((await call(a, '/api/friends/request', { username: 'jisu' })).body.code, 'ALREADY');

  // 지수: 같이 보기 알림 확인 때 친구 신청도 같이 온다
  const inbox = (await call(b, '/api/watch/inbox')).body;
  assert.deepEqual(inbox.requests.map((r) => [r.username, r.name]), [['minsu', '김민수']]);
  assert.deepEqual((await call(a, '/api/friends')).body.outgoing.map((r) => r.name), ['이지수']);
  await call(b, '/api/friends/respond', { username: 'minsu', accept: true });
  const mine = (await call(a, '/api/friends')).body;
  assert.deepEqual(mine.friends.map((f) => [f.username, f.name]), [['jisu', '이지수']]);
  assert.deepEqual(mine.outgoing, []);
  assert.deepEqual((await call(b, '/api/friends')).body.friends.map((f) => f.username), ['minsu']);
  assert.equal((await call(b, '/api/friends/request', { username: 'minsu' })).body.code, 'ALREADY');

  // 서로 신청하면 바로 친구
  await call(c, '/api/friends/request', { username: 'minsu' });
  assert.equal((await call(a, '/api/friends/request', { username: 'cheolsu' })).body.status, 'accepted');
  assert.equal((await call(a, '/api/friends')).body.friends.length, 2);

  // 끊기
  await call(b, '/api/friends/remove', { username: 'minsu' });
  assert.deepEqual((await call(a, '/api/friends')).body.friends.map((f) => f.username), ['cheolsu']);
  // 거절
  await call(a, '/api/friends/request', { username: 'jisu' });
  await call(b, '/api/friends/respond', { username: 'minsu', accept: false });
  assert.deepEqual((await call(b, '/api/friends')).body.incoming, []);
  assert.equal((await call(b, '/api/friends/respond', { username: 'minsu', accept: true })).body.code, 'NO_REQUEST');
});

test('초대 → 알림 → 수락 → 방장 재생 상태를 같이 본다 → 방장이 나가면 끝', async () => {
  const a = await userCookie('minsu', '김민수');
  const b = await userCookie('jisu', '이지수');
  // 친구가 아니면 초대 못 함
  assert.equal((await call(a, '/api/watch/invite', { to: ['jisu'], video: 'aaaaaaaaaaa', pos: 0 })).body.code, 'NOT_FRIEND');
  await makeFriends(a, b, 'jisu');
  await call(b, '/api/watch/inbox'); // 지수도 지금 사용 중

  const friends = await call(a, '/api/watch/friends');
  assert.deepEqual(friends.body.map((f) => [f.username, f.online]), [['jisu', true]]);

  const room = await call(a, '/api/watch/invite', { to: ['jisu'], video: 'aaaaaaaaaaa', title: '영상', pos: 30, playing: true });
  assert.equal(room.status, 200);
  assert.equal(room.body.host, 'minsu');

  const inbox = (await call(b, '/api/watch/inbox')).body.invites;
  assert.equal(inbox.length, 1);
  assert.equal(inbox[0].from, '김민수');
  assert.equal(inbox[0].title, '영상');

  const joined = await call(b, '/api/watch/answer', { id: inbox[0].id, accept: true });
  assert.equal(joined.body.video, 'aaaaaaaaaaa');
  assert.equal(joined.body.playing, true);
  assert.deepEqual(joined.body.members.map((m) => m.name).sort(), ['김민수', '이지수']);
  assert.equal((await call(b, '/api/watch/inbox')).body.invites.length, 0);

  // 방장이 멈추고 다른 영상으로
  assert.equal((await call(a, '/api/watch/state', { id: room.body.id, video: 'bbbbbbbbbbb', title: '다음', pos: 0, playing: false })).status, 200);
  const seen = await call(b, `/api/watch/room?id=${room.body.id}`);
  assert.deepEqual([seen.body.video, seen.body.playing, seen.body.pos], ['bbbbbbbbbbb', false, 0]);
  // 방장 말고는 못 바꾼다
  assert.equal((await call(b, '/api/watch/state', { id: room.body.id, video: 'ccccccccccc', pos: 0 })).body.code, 'NOT_HOST');

  await call(a, '/api/watch/leave', { id: room.body.id });
  assert.equal((await call(b, `/api/watch/room?id=${room.body.id}`)).body.code, 'NO_ROOM');
});

test('거절하면 방에 안 들어가고, 초대받지 않은 사람은 방을 못 본다', async () => {
  const a = await userCookie('minsu', '김민수');
  const b = await userCookie('jisu', '이지수');
  const c = await userCookie('cheolsu', '박철수');
  await makeFriends(a, b, 'jisu');
  const room = await call(a, '/api/watch/invite', { to: ['jisu'], video: 'aaaaaaaaaaa', pos: 0 });
  const inv = (await call(b, '/api/watch/inbox')).body.invites[0];
  await call(b, '/api/watch/answer', { id: inv.id, accept: false });
  assert.equal((await call(b, `/api/watch/room?id=${room.body.id}`)).body.code, 'NOT_MEMBER');
  assert.equal((await call(c, `/api/watch/room?id=${room.body.id}`)).body.code, 'NOT_MEMBER');
  assert.equal((await call(c, '/api/watch/answer', { id: inv.id, accept: true })).body.code, 'NO_INVITE');
});

test('D1 이 없으면 설정 필요, 관리자는 못 씀, 잘못된 입력은 거절', async () => {
  const a = await userCookie('minsu', '김민수');
  assert.equal((await call(a, '/api/watch/invite', { to: ['minsu'], video: 'aaaaaaaaaaa' })).status, 400);
  assert.equal((await call(a, '/api/watch/invite', { to: ['jisu'], video: 'bad' })).status, 400);
  delete env.D1;
  assert.equal((await call(a, '/api/watch/inbox')).body.code, 'NO_WATCH_DB');
});
