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
  return {
    prepare: (sql) => statement(sql),
    batch: async (list) => Promise.all(list.map((s) => s.run()))
  };
}

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
beforeEach(() => {
  env = { DB: fakeKV(), CHESS: fakeD1(), ADMIN_PASSWORD: 'admin-secret' };
});

// 로그인한 사용자 두 명(민수, 지수)과 체험 손님 한 명
async function sessionFor(username, name) {
  const token = (username + '0'.repeat(64)).replace(/[^0-9a-f]/g, 'a').slice(0, 64);
  await env.DB.put(`session:${token}`, JSON.stringify({ role: 'user', username, pwv: 0 }));
  await env.DB.put(`user:${username}`, JSON.stringify({ username, name, status: 'approved', pwv: 0 }));
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

async function twoPlayers({ base = 0, inc = 0, color = 'w', isPublic = false } = {}) {
  const a = await sessionFor('minsu', '김민수');
  const b = await sessionFor('jisu', '이지수');
  const created = await call(a, '/api/chess/rooms', { public: isPublic, color, base, inc });
  assert.equal(created.status, 201);
  return { a, b, code: created.body.code };
}

test('로그인해야 쓸 수 있다', async () => {
  const res = await call('', '/api/chess/rooms');
  assert.equal(res.status, 401);
});

test('D1 이 없으면 설정이 필요하다고 알려 준다', async () => {
  const a = await sessionFor('minsu', '김민수');
  delete env.CHESS;
  const res = await call(a, '/api/chess/rooms');
  assert.equal(res.status, 503);
  assert.equal(res.body.code, 'NO_CHESS_DB');
});

test('방 만들기 → 공개 방 목록 → 코드로 참여하면 게임 시작', async () => {
  const { a, b, code } = await twoPlayers({ isPublic: true });
  assert.match(code, /^[A-Z2-9]{6}$/);
  const list = await call(b, '/api/chess/rooms');
  assert.deepEqual(list.body.map((r) => [r.code, r.host, r.mine]), [[code, '김민수', false]]);

  const waiting = await call(a, `/api/chess/room?code=${code}`);
  assert.equal(waiting.body.status, 'waiting');
  assert.equal(waiting.body.you, 'w');

  const joined = await call(b, '/api/chess/join', { code: code.toLowerCase() });
  assert.equal(joined.body.status, 'playing');
  assert.equal(joined.body.you, 'b');
  assert.equal(joined.body.white.name, '김민수');
  assert.equal(joined.body.black.name, '이지수');
  // 시작한 방은 목록에서 빠진다
  assert.equal((await call(b, '/api/chess/rooms')).body.length, 0);
});

test('차례대로만 둘 수 있고, 틀린 수는 거절, 바뀐 게 없으면 짧은 응답', async () => {
  const { a, b, code } = await twoPlayers();
  await call(b, '/api/chess/join', { code });
  assert.equal((await call(b, '/api/chess/move', { code, from: 'e7', to: 'e5' })).body.code, 'NOT_YOUR_TURN');
  assert.equal((await call(a, '/api/chess/move', { code, from: 'e2', to: 'e5' })).body.code, 'ILLEGAL');
  const m1 = await call(a, '/api/chess/move', { code, from: 'e2', to: 'e4' });
  assert.equal(m1.status, 200);
  assert.deepEqual(m1.body.moves, ['e4']);
  assert.deepEqual(m1.body.lastMove, { from: 'e2', to: 'e4' });

  const seen = await call(b, `/api/chess/room?code=${code}&v=0`);
  assert.deepEqual(seen.body.moves, ['e4']);
  const same = await call(b, `/api/chess/room?code=${code}&v=${seen.body.v}`);
  assert.equal(same.body.same, true);

  // 구경꾼은 둘 수 없다
  const c = await sessionFor('cheolsu', '박철수');
  const watcher = await call(c, '/api/chess/join', { code });
  assert.equal(watcher.body.you, null);
  assert.equal((await call(c, '/api/chess/move', { code, from: 'e7', to: 'e5' })).body.code, 'NOT_PLAYER');
});

test('외통수(바보의 메이트)로 끝나고, 재대결하면 색이 바뀐다', async () => {
  const { a, b, code } = await twoPlayers();
  await call(b, '/api/chess/join', { code });
  for (const [who, from, to] of [[a, 'f2', 'f3'], [b, 'e7', 'e5'], [a, 'g2', 'g4'], [b, 'd8', 'h4']]) {
    assert.equal((await call(who, '/api/chess/move', { code, from, to })).status, 200);
  }
  const end = await call(a, `/api/chess/room?code=${code}`);
  assert.equal(end.body.status, 'ended');
  assert.equal(end.body.result, '0-1');
  assert.equal(end.body.reason, 'checkmate');

  assert.equal((await call(a, '/api/chess/action', { code, action: 'rematch' })).body.status, 'ended');
  const again = await call(b, '/api/chess/action', { code, action: 'rematch' });
  assert.equal(again.body.status, 'playing');
  assert.equal(again.body.you, 'w'); // 지수가 이번엔 백
  assert.deepEqual(again.body.moves, []);
});

test('기권, 무승부 제안·수락·거절', async () => {
  const { a, b, code } = await twoPlayers();
  await call(b, '/api/chess/join', { code });
  assert.equal((await call(a, '/api/chess/action', { code, action: 'draw-offer' })).body.drawOffer, 'w');
  assert.equal((await call(b, '/api/chess/action', { code, action: 'draw-decline' })).body.drawOffer, null);
  await call(a, '/api/chess/action', { code, action: 'draw-offer' });
  const draw = await call(b, '/api/chess/action', { code, action: 'draw-accept' });
  assert.deepEqual([draw.body.status, draw.body.result, draw.body.reason], ['ended', '1/2-1/2', 'agreement']);

  await call(a, '/api/chess/action', { code, action: 'rematch' });
  await call(b, '/api/chess/action', { code, action: 'rematch' });
  const resign = await call(a, '/api/chess/action', { code, action: 'resign' }); // 민수는 이제 흑
  assert.deepEqual([resign.body.result, resign.body.reason], ['1-0', 'resign']);
});

test('시간: 첫 수 뒤부터 흐르고, 추가 시간이 붙고, 다 쓰면 진다', async () => {
  const { a, b, code } = await twoPlayers({ base: 1, inc: 2 });
  await call(b, '/api/chess/join', { code });
  const realNow = Date.now;
  let now = realNow();
  Date.now = () => now;
  try {
    await call(a, '/api/chess/move', { code, from: 'e2', to: 'e4' });
    now += 5000;
    await call(b, '/api/chess/move', { code, from: 'e7', to: 'e5' });
    now += 10_000;
    const m3 = await call(a, '/api/chess/move', { code, from: 'g1', to: 'f3' });
    assert.equal(m3.body.clock.w, 60_000 - 10_000 + 2000); // 첫 수들은 시간이 안 흐름
    assert.equal(m3.body.clock.b, 60_000);
    now += 61_000;
    const late = await call(a, `/api/chess/room?code=${code}`);
    assert.deepEqual([late.body.status, late.body.result, late.body.reason], ['ended', '1-0', 'timeout']);
  } finally {
    Date.now = realNow;
  }
});

test('상대가 1분 넘게 안 보이면 승리 처리할 수 있다', async () => {
  const { a, b, code } = await twoPlayers();
  await call(b, '/api/chess/join', { code });
  assert.equal((await call(a, '/api/chess/action', { code, action: 'claim' })).status, 409);
  const realNow = Date.now;
  const start = realNow();
  Date.now = () => start + 70_000;
  try {
    const view = await call(a, `/api/chess/room?code=${code}`);
    assert.equal(view.body.opponentAway, true);
    const claimed = await call(a, '/api/chess/action', { code, action: 'claim' });
    assert.deepEqual([claimed.body.result, claimed.body.reason], ['1-0', 'abandon']);
  } finally {
    Date.now = realNow;
  }
});

test('대기 중인 방은 만든 사람만 없앨 수 있다', async () => {
  const { a, b, code } = await twoPlayers();
  assert.equal((await call(b, '/api/chess/action', { code, action: 'cancel' })).status, 409);
  assert.equal((await call(a, '/api/chess/action', { code, action: 'cancel' })).status, 200);
  assert.equal((await call(b, '/api/chess/join', { code })).body.code, 'NO_ROOM');
});

test('잘못된 입력', async () => {
  const a = await sessionFor('minsu', '김민수');
  assert.equal((await call(a, '/api/chess/rooms', { public: true, color: 'w', base: 7, inc: 0 })).status, 400);
  assert.equal((await call(a, '/api/chess/rooms', { public: true, color: 'x', base: 5, inc: 0 })).status, 400);
  assert.equal((await call(a, '/api/chess/join', { code: '12' })).body.code, 'BAD_CODE');
  assert.equal((await call(a, '/api/chess/join', { code: 'ABCDEF' })).body.code, 'NO_ROOM');
});
