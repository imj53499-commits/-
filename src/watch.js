// 같이 보기: 방장이 친구를 초대하면 친구 화면에 알림이 뜨고, 수락하면 방장 영상을 같은 시간으로 같이 본다.
// Cloudflare D1(binding: D1)에 저장한다. KV 는 하루 쓰기가 1000번이라 자주 바뀌는 재생 상태를 못 담는다.
//   watch_rooms   방: 방장, 지금 영상, 재생 중인지, 위치(pos 초, at 시각 기준)
//   watch_members 방에 들어온 사람 (seen: 마지막으로 방 상태를 확인한 시각)
//   watch_invites 초대 (2분 지나면 사라짐)
import { json } from './auth.js';
import { ensureFriendTable, listFriends, areFriends, incomingRequests, withOnline } from './friends.js';

const fail = (error, status, code) => json({ error, code }, status);

const VIDEO_ID = /^[\w-]{11}$/;
const ROOM_ID = /^[0-9a-f]{16}$/;
const INVITE_TTL = 2 * 60 * 1000; // 초대는 2분 안에 받아야 한다
const ROOM_TTL = 6 * 60 * 60 * 1000; // 6시간 동안 아무 변화 없는 방은 지운다
const SEEN_EVERY = 10 * 1000; // 방 확인 기록은 10초에 한 번만 쓴다 (쓰기 줄이기)
const AWAY_AFTER = 45 * 1000; // 45초 넘게 안 보이면 나간 걸로 본다
const MAX_INVITES = 10;

const readyDbs = new WeakSet();

async function ensureTables(db) {
  if (readyDbs.has(db)) return;
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS watch_rooms (
      id TEXT PRIMARY KEY, host TEXT NOT NULL, host_name TEXT NOT NULL,
      video TEXT NOT NULL, title TEXT NOT NULL DEFAULT '', playing INTEGER NOT NULL DEFAULT 0,
      pos REAL NOT NULL DEFAULT 0, at INTEGER NOT NULL, updated INTEGER NOT NULL)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS watch_members (
      room TEXT NOT NULL, user TEXT NOT NULL, name TEXT NOT NULL, seen INTEGER NOT NULL,
      PRIMARY KEY (room, user))`),
    db.prepare(`CREATE TABLE IF NOT EXISTS watch_invites (
      id TEXT PRIMARY KEY, room TEXT NOT NULL, from_user TEXT NOT NULL, from_name TEXT NOT NULL,
      to_user TEXT NOT NULL, title TEXT NOT NULL DEFAULT '', created INTEGER NOT NULL, status TEXT NOT NULL)`),
    db.prepare('CREATE INDEX IF NOT EXISTS watch_invites_to ON watch_invites (to_user, status, created)'),
    db.prepare('CREATE INDEX IF NOT EXISTS watch_rooms_host ON watch_rooms (host)')
  ]);
  readyDbs.add(db);
}

const randomId = () => [...crypto.getRandomValues(new Uint8Array(8))].map((b) => b.toString(16).padStart(2, '0')).join('');
const me = (session) => ({ id: session.username.toLowerCase(), name: session.name || session.username });

async function readJson(request) {
  if (!(request.headers.get('Content-Type') || '').includes('application/json')) return null;
  try { return await request.json(); } catch { return null; }
}

function cleanState(body) {
  const video = String(body?.video ?? '');
  if (!VIDEO_ID.test(video)) return null;
  const playing = body?.playing ? 1 : 0;
  // 방장이 위치를 잰 시각. serverAt(방장이 서버 시계로 계산한 시각)이 있으면 그걸 쓰고,
  // 없으면 age(잰 뒤 보내기까지 걸린 ms)만큼 앞당긴다. 이상한 값이면 지금으로 본다.
  const now = Date.now();
  const serverAt = Number(body?.serverAt);
  const at = serverAt > now - 5000 && serverAt <= now + 1000
    ? Math.min(serverAt, now)
    : now - Math.max(0, Math.min(Number(body?.age) || 0, 5000));
  const raw = Math.max(0, Math.min(Number(body?.pos) || 0, 24 * 60 * 60));
  // 저장은 '지금(now) 기준 위치'로 바꿔서 한다
  const pos = raw + (playing ? (now - at) / 1000 : 0);
  return { video, title: String(body?.title ?? '').slice(0, 200), playing, pos, now };
}

// 방 상태 + 지금 있는 사람들
async function roomView(db, room, now) {
  const { results } = await db.prepare('SELECT user, name, seen FROM watch_members WHERE room = ?').bind(room.id).all();
  return {
    id: room.id,
    host: room.host,
    hostName: room.host_name,
    video: room.video,
    title: room.title,
    playing: !!room.playing,
    pos: room.pos,
    at: room.at,
    members: results.filter((m) => now - m.seen < AWAY_AFTER).map((m) => ({ user: m.user, name: m.name })),
    serverNow: now
  };
}

// 방에 있다고 적는다. force 가 아니면 10초에 한 번만 (쓰기 줄이기)
async function touchMember(db, roomId, user, now, force = false) {
  if (force) {
    await db.prepare('INSERT INTO watch_members (room, user, name, seen) VALUES (?, ?, ?, ?) ON CONFLICT (room, user) DO UPDATE SET seen = excluded.seen, name = excluded.name')
      .bind(roomId, user.id, user.name, now).run();
  } else {
    await db.prepare('UPDATE watch_members SET seen = ? WHERE room = ? AND user = ? AND seen < ?')
      .bind(now, roomId, user.id, now - SEEN_EVERY).run();
  }
}

// 초대할 수 있는 사람: 내 친구 (접속 중인 친구 먼저)
async function friends(env, session) {
  return json(await withOnline(env, await listFriends(env.D1, session.username.toLowerCase())));
}

// 초대하기: 내 방이 없으면 만들고(지금 보는 영상·위치로), 고른 친구들에게 초대를 보낸다
async function invite(request, env, session) {
  const body = await readJson(request);
  const state = cleanState(body);
  if (!state) return fail('영상 정보가 잘못됐어요.', 400);
  const to = [...new Set((Array.isArray(body?.to) ? body.to : []).map((u) => String(u).toLowerCase()))].filter((u) => u && u.length <= 20).slice(0, MAX_INVITES);
  const host = me(session);
  if (!to.length || to.includes(host.id)) return fail('초대할 친구를 골라 주세요.', 400);
  const db = env.D1;
  for (const user of to) {
    if (!(await areFriends(db, host.id, user))) return fail('친구에게만 초대할 수 있어요.', 403, 'NOT_FRIEND');
  }
  const now = state.now;
  if (Math.random() < 0.1) await cleanup(db, now);

  let room = await db.prepare('SELECT * FROM watch_rooms WHERE host = ?').bind(host.id).first();
  if (!room) {
    room = { id: randomId(), host: host.id, host_name: host.name, video: state.video, title: state.title, playing: state.playing, pos: state.pos, at: now, updated: now };
    await db.prepare('INSERT INTO watch_rooms (id, host, host_name, video, title, playing, pos, at, updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(room.id, room.host, room.host_name, room.video, room.title, room.playing, room.pos, now, now).run();
  } else {
    await db.prepare('UPDATE watch_rooms SET video = ?, title = ?, playing = ?, pos = ?, at = ?, updated = ? WHERE id = ?')
      .bind(state.video, state.title, state.playing, state.pos, now, now, room.id).run();
    room = { ...room, video: state.video, title: state.title, playing: state.playing, pos: state.pos, at: now, updated: now };
  }
  await touchMember(db, room.id, host, now, true);
  await db.batch(to.map((user) => db.prepare(
    'INSERT INTO watch_invites (id, room, from_user, from_name, to_user, title, created, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).bind(randomId(), room.id, host.id, host.name, user, state.title, now, 'pending')));
  return json(await roomView(db, room, now));
}

// 나에게 온 초대 (2분 안에 온 것만)
async function inbox(env, session) {
  const now = Date.now();
  const { results } = await env.D1.prepare(
    'SELECT id, room, from_name, title, created FROM watch_invites WHERE to_user = ? AND status = ? AND created > ? ORDER BY created DESC LIMIT 5'
  ).bind(session.username.toLowerCase(), 'pending', now - INVITE_TTL).all();
  return json({
    invites: results.map((r) => ({ id: r.id, room: r.room, from: r.from_name, title: r.title, created: r.created })),
    requests: await incomingRequests(env.D1, session.username.toLowerCase())
  });
}

async function answer(request, env, session) {
  const body = await readJson(request);
  const id = String(body?.id ?? '');
  const db = env.D1;
  const user = me(session);
  const inv = await db.prepare('SELECT * FROM watch_invites WHERE id = ? AND to_user = ?').bind(id, user.id).first();
  if (!inv || inv.status !== 'pending') return fail('이미 끝난 초대예요.', 404, 'NO_INVITE');
  const now = Date.now();
  if (!body?.accept) {
    await db.prepare('UPDATE watch_invites SET status = ? WHERE id = ?').bind('declined', id).run();
    return json({ ok: true });
  }
  const room = await db.prepare('SELECT * FROM watch_rooms WHERE id = ?').bind(inv.room).first();
  if (!room || now - inv.created > INVITE_TTL) return fail('초대가 끝났어요. 다시 초대해 달라고 해 주세요.', 404, 'NO_ROOM');
  // 다른 방에 있었으면 거기서는 나간다
  await db.batch([
    db.prepare('UPDATE watch_invites SET status = ? WHERE id = ?').bind('accepted', id),
    db.prepare('DELETE FROM watch_members WHERE user = ? AND room != ?').bind(user.id, room.id)
  ]);
  await touchMember(db, room.id, user, now, true);
  return json(await roomView(db, room, now));
}

async function getRoom(url, env, session) {
  const id = String(url.searchParams.get('id') || '');
  if (!ROOM_ID.test(id)) return fail('방이 잘못됐어요.', 400);
  const db = env.D1;
  const room = await db.prepare('SELECT * FROM watch_rooms WHERE id = ?').bind(id).first();
  if (!room) return fail('같이 보기가 끝났어요.', 404, 'NO_ROOM');
  const user = me(session);
  const member = await db.prepare('SELECT seen FROM watch_members WHERE room = ? AND user = ?').bind(id, user.id).first();
  if (!member) return fail('이 방에 없어요.', 403, 'NOT_MEMBER');
  const now = Date.now();
  await touchMember(db, id, user, now);
  return json(await roomView(db, room, now));
}

// 방장이 재생·멈춤·건너뛰기·영상 바꾸기를 하면 알린다
async function setState(request, env, session) {
  const body = await readJson(request);
  const id = String(body?.id ?? '');
  const state = cleanState(body);
  if (!ROOM_ID.test(id) || !state) return fail('잘못된 요청', 400);
  const db = env.D1;
  const now = state.now;
  const res = await db.prepare('UPDATE watch_rooms SET video = ?, title = ?, playing = ?, pos = ?, at = ?, updated = ? WHERE id = ? AND host = ?')
    .bind(state.video, state.title, state.playing, state.pos, now, now, id, session.username.toLowerCase()).run();
  if (res.meta.changes !== 1) return fail('방장만 바꿀 수 있어요.', 403, 'NOT_HOST');
  await touchMember(db, id, me(session), now);
  return json({ ok: true, serverNow: now });
}

// 나가기: 방장이 나가면 방이 없어진다
async function leave(request, env, session) {
  const body = await readJson(request);
  const id = String(body?.id ?? '');
  if (!ROOM_ID.test(id)) return fail('잘못된 요청', 400);
  const db = env.D1;
  const user = session.username.toLowerCase();
  const room = await db.prepare('SELECT host FROM watch_rooms WHERE id = ?').bind(id).first();
  if (room?.host === user) await removeRoom(db, id);
  else await db.prepare('DELETE FROM watch_members WHERE room = ? AND user = ?').bind(id, user).run();
  return json({ ok: true });
}

async function removeRoom(db, id) {
  await db.batch([
    db.prepare('DELETE FROM watch_rooms WHERE id = ?').bind(id),
    db.prepare('DELETE FROM watch_members WHERE room = ?').bind(id),
    db.prepare('DELETE FROM watch_invites WHERE room = ?').bind(id)
  ]);
}

async function cleanup(db, now) {
  const { results } = await db.prepare('SELECT id FROM watch_rooms WHERE updated < ?').bind(now - ROOM_TTL).all();
  for (const r of results) await removeRoom(db, r.id);
  await db.prepare('DELETE FROM watch_invites WHERE created < ?').bind(now - ROOM_TTL).run();
}

export async function handleWatch(request, env, session) {
  if (!env.D1) return fail('같이 보기는 아직 설정되지 않았어요. (관리자: D1 데이터베이스 연결 필요)', 503, 'NO_WATCH_DB');
  if (session.role !== 'user') return fail('관리자 계정으로는 같이 보기를 할 수 없어요.', 403, 'NOT_USER');
  await ensureTables(env.D1);
  await ensureFriendTable(env.D1);
  const url = new URL(request.url);
  const route = `${request.method} ${url.pathname}`;
  if (route === 'GET /api/watch/friends') return friends(env, session);
  if (route === 'POST /api/watch/invite') return invite(request, env, session);
  if (route === 'GET /api/watch/inbox') return inbox(env, session);
  if (route === 'POST /api/watch/answer') return answer(request, env, session);
  if (route === 'GET /api/watch/room') return getRoom(url, env, session);
  if (route === 'POST /api/watch/state') return setState(request, env, session);
  if (route === 'POST /api/watch/leave') return leave(request, env, session);
  return fail('Not found', 404);
}
