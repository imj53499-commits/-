// 친구: 아이디로 친구 신청 → 상대가 수락하면 친구. 친구끼리만 같이 보기 초대를 할 수 있다.
// D1 의 friend_links 에 (신청한 사람 a, 받은 사람 b) 한 줄로 저장한다. status: pending | accepted
import { json, lastSeen, findApprovedUser } from './auth.js';

const fail = (error, status, code) => json({ error, code }, status);
const ONLINE_WINDOW = 15 * 60 * 1000; // 이 안에 사이트를 썼으면 '접속 중'
const MAX_FRIENDS = 200;

const readyDbs = new WeakSet();

export async function ensureFriendTable(db) {
  if (readyDbs.has(db)) return;
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS friend_links (
      a TEXT NOT NULL, a_name TEXT NOT NULL, b TEXT NOT NULL, b_name TEXT NOT NULL,
      status TEXT NOT NULL, created INTEGER NOT NULL, PRIMARY KEY (a, b))`),
    db.prepare('CREATE INDEX IF NOT EXISTS friend_links_b ON friend_links (b, status)')
  ]);
  readyDbs.add(db);
}

async function readJson(request) {
  if (!(request.headers.get('Content-Type') || '').includes('application/json')) return null;
  try { return await request.json(); } catch { return null; }
}

// 나와 상대 사이의 줄 (어느 쪽이 신청했든)
async function linkBetween(db, x, y) {
  return db.prepare('SELECT * FROM friend_links WHERE (a = ? AND b = ?) OR (a = ? AND b = ?)').bind(x, y, y, x).first();
}

export async function areFriends(db, x, y) {
  return (await linkBetween(db, x, y))?.status === 'accepted';
}

// 내 친구 목록 { username, name }
export async function listFriends(db, mine) {
  const { results } = await db.prepare('SELECT a, a_name, b, b_name FROM friend_links WHERE status = ? AND (a = ? OR b = ?) LIMIT ?')
    .bind('accepted', mine, mine, MAX_FRIENDS).all();
  return results.map((r) => (r.a === mine ? { username: r.b, name: r.b_name } : { username: r.a, name: r.a_name }));
}

// 나에게 온 친구 신청
export async function incomingRequests(db, mine) {
  const { results } = await db.prepare('SELECT a, a_name, created FROM friend_links WHERE b = ? AND status = ? ORDER BY created DESC LIMIT 20')
    .bind(mine, 'pending').all();
  return results.map((r) => ({ username: r.a, name: r.a_name, created: r.created }));
}

// 친구마다 접속 중인지 붙인다 (접속 중인 친구 먼저)
export async function withOnline(env, list) {
  const now = Date.now();
  const out = await Promise.all(list.map(async (f) => ({ ...f, online: now - (await lastSeen(env, f.username)) < ONLINE_WINDOW })));
  return out.sort((x, y) => Number(y.online) - Number(x.online) || x.name.localeCompare(y.name, 'ko'));
}

async function overview(env, mine) {
  const db = env.D1;
  const { results: outgoing } = await db.prepare('SELECT b, b_name, created FROM friend_links WHERE a = ? AND status = ? ORDER BY created DESC LIMIT 20')
    .bind(mine, 'pending').all();
  return json({
    friends: await withOnline(env, await listFriends(db, mine)),
    incoming: await incomingRequests(db, mine),
    outgoing: outgoing.map((r) => ({ username: r.b, name: r.b_name, created: r.created }))
  });
}

async function request(req, env, session) {
  const body = await readJson(req);
  const mine = session.username.toLowerCase();
  const target = String(body?.username ?? '').trim();
  const other = await findApprovedUser(env, target);
  if (!other) return fail('그런 아이디가 없어요. 아이디를 확인해 주세요.', 404, 'NO_USER');
  const theirs = other.username.toLowerCase();
  if (theirs === mine) return fail('나에게는 친구 신청을 할 수 없어요.', 400);
  const db = env.D1;
  const link = await linkBetween(db, mine, theirs);
  if (link?.status === 'accepted') return fail('이미 친구예요.', 409, 'ALREADY');
  if (link?.a === mine) return fail('이미 친구 신청을 보냈어요. 상대가 수락하면 친구가 돼요.', 409, 'ALREADY');
  // 상대가 먼저 신청했으면 바로 친구
  if (link) {
    await db.prepare('UPDATE friend_links SET status = ? WHERE a = ? AND b = ?').bind('accepted', theirs, mine).run();
    return json({ ok: true, status: 'accepted', name: other.name });
  }
  const { results } = await db.prepare('SELECT COUNT(*) AS n FROM friend_links WHERE a = ? OR b = ?').bind(mine, mine).all();
  if (results[0].n >= MAX_FRIENDS) return fail(`친구는 ${MAX_FRIENDS}명까지예요.`, 400);
  await db.prepare('INSERT INTO friend_links (a, a_name, b, b_name, status, created) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(mine, session.name || session.username, theirs, other.name, 'pending', Date.now()).run();
  return json({ ok: true, status: 'pending', name: other.name });
}

async function respond(req, env, session) {
  const body = await readJson(req);
  const mine = session.username.toLowerCase();
  const from = String(body?.username ?? '').toLowerCase();
  const db = env.D1;
  const res = body?.accept
    ? await db.prepare('UPDATE friend_links SET status = ? WHERE a = ? AND b = ? AND status = ?').bind('accepted', from, mine, 'pending').run()
    : await db.prepare('DELETE FROM friend_links WHERE a = ? AND b = ? AND status = ?').bind(from, mine, 'pending').run();
  if (res.meta.changes !== 1) return fail('이미 끝난 친구 신청이에요.', 404, 'NO_REQUEST');
  return json({ ok: true });
}

// 친구 끊기, 보낸 신청 취소
async function remove(req, env, session) {
  const body = await readJson(req);
  const mine = session.username.toLowerCase();
  const other = String(body?.username ?? '').toLowerCase();
  await env.D1.prepare('DELETE FROM friend_links WHERE (a = ? AND b = ?) OR (a = ? AND b = ? AND status = ?)')
    .bind(mine, other, other, mine, 'accepted').run();
  return json({ ok: true });
}

export async function handleFriends(req, env, session) {
  if (!env.D1) return fail('친구 기능은 아직 설정되지 않았어요. (관리자: D1 데이터베이스 연결 필요)', 503, 'NO_WATCH_DB');
  if (session.role !== 'user') return fail('관리자 계정으로는 친구를 쓸 수 없어요.', 403, 'NOT_USER');
  await ensureFriendTable(env.D1);
  const { pathname } = new URL(req.url);
  const route = `${req.method} ${pathname}`;
  const mine = session.username.toLowerCase();
  if (route === 'GET /api/friends') return overview(env, mine);
  if (route === 'POST /api/friends/request') return request(req, env, session);
  if (route === 'POST /api/friends/respond') return respond(req, env, session);
  if (route === 'POST /api/friends/remove') return remove(req, env, session);
  return fail('Not found', 404);
}
