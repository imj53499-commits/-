// 온라인 체스 방: 방 만들기·참여·수 두기·기권·무승부·재대결. Cloudflare D1(binding: CHESS)에 저장한다.
// KV 는 하루 쓰기 횟수가 적고(무료 1000번) 다른 곳에서 쓴 값이 늦게 보일 수 있어서, 수를 자주 쓰는 체스는 D1 을 쓴다.
// 두 사람은 1초마다 방 상태를 확인하고(version 이 같으면 짧은 응답), 수를 둘 때는 version 이 맞을 때만 저장한다.
import { Chess } from '../public/vendor/chess.js';
import { json } from './auth.js';

const fail = (error, status, code) => json({ error, code }, status);

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE = /^[A-Z2-9]{6}$/;
const SQUARE = /^[a-h][1-8]$/;
const BASE_MINUTES = [0, 1, 3, 5, 10, 15, 30]; // 0 = 시간 제한 없음
const MAX_INCREMENT = 30;
const ROOM_TTL = 24 * 60 * 60 * 1000; // 하루 지난 방은 지운다
const WAITING_LIST_AGE = 30 * 60 * 1000; // 방 목록에는 30분 안에 만든 대기 방만
const SEEN_EVERY = 15 * 1000; // 접속 확인은 15초에 한 번만 저장한다 (쓰기 횟수 줄이기)
const AWAY_AFTER = 60 * 1000; // 1분 넘게 안 보이면 나간 걸로 보고 상대가 승리 처리할 수 있다

const readyDbs = new WeakSet(); // 표는 저장소마다 한 번만 만든다

async function ensureTable(db) {
  if (readyDbs.has(db)) return;
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS chess_rooms (
      code TEXT PRIMARY KEY,
      version INTEGER NOT NULL,
      status TEXT NOT NULL,
      public INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      state TEXT NOT NULL
    )`),
    db.prepare('CREATE INDEX IF NOT EXISTS chess_rooms_list ON chess_rooms (status, public, updated_at)')
  ]);
  readyDbs.add(db);
}

function randomCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return [...bytes].map((b) => CODE_CHARS[b % CODE_CHARS.length]).join('');
}

// 로그인한 사람을 방에서 알아보는 값과 보여 줄 이름
export function playerOf(session) {
  if (session.role === 'user') return { id: `u:${session.username.toLowerCase()}`, name: session.name || session.username };
  if (session.role === 'admin') return { id: 'admin', name: '관리자' };
  return { id: `t:${session.token.slice(0, 16)}`, name: '체험 손님' };
}

async function readJson(request) {
  if (!(request.headers.get('Content-Type') || '').includes('application/json')) return null;
  try { return await request.json(); } catch { return null; }
}

async function loadRoom(db, code) {
  const row = await db.prepare('SELECT version, state FROM chess_rooms WHERE code = ?').bind(code).first();
  return row ? { version: row.version, state: JSON.parse(row.state) } : null;
}

// version 이 그대로일 때만 저장한다. 그사이 다른 사람이 바꿨으면 false.
async function saveRoom(db, code, version, state) {
  const now = Date.now();
  const res = await db.prepare('UPDATE chess_rooms SET version = version + 1, status = ?, updated_at = ?, state = ? WHERE code = ? AND version = ?')
    .bind(state.status, now, JSON.stringify(state), code, version).run();
  return res.meta.changes === 1;
}

const colorOf = (state, id) => (state.white?.id === id ? 'w' : state.black?.id === id ? 'b' : null);
const other = (c) => (c === 'w' ? 'b' : 'w');

// 남은 시간: 지금 둘 차례인 쪽은 차례가 시작된 뒤 흐른 시간만큼 뺀다
function clockNow(state, now) {
  if (!state.time.base) return null;
  const c = { w: state.clock.w, b: state.clock.b };
  if (state.status === 'playing' && state.moves.length >= 2) {
    const turn = turnOf(state);
    c[turn] -= now - state.clock.turnStart;
  }
  return c;
}

const turnOf = (state) => (state.moves.length % 2 === 0 ? 'w' : 'b');

function endGame(state, result, reason) {
  state.status = 'ended';
  state.result = result;
  state.reason = reason;
  state.drawOffer = null;
  state.rematch = { w: false, b: false };
}

// 시간이 다 됐으면 끝낸다 (상대가 기물이 왕만 남았으면 무승부). 바뀌었으면 true.
function checkTimeout(state, now) {
  if (state.status !== 'playing') return false;
  const clock = clockNow(state, now);
  if (!clock) return false;
  const turn = turnOf(state);
  if (clock[turn] > 0) return false;
  state.clock[turn] = 0;
  const game = replay(state.moves);
  const winner = other(turn);
  const onlyKing = game.board().flat().filter((p) => p && p.color === winner).length === 1;
  if (onlyKing) endGame(state, '1/2-1/2', 'timeout-draw');
  else endGame(state, winner === 'w' ? '1-0' : '0-1', 'timeout');
  return true;
}

function replay(moves) {
  const game = new Chess();
  for (const san of moves) game.move(san);
  return game;
}

function newGameState(state, now) {
  state.status = 'playing';
  state.moves = [];
  state.fen = new Chess().fen();
  state.lastMove = null;
  state.result = null;
  state.reason = null;
  state.drawOffer = null;
  state.rematch = { w: false, b: false };
  state.clock = { w: state.time.base, b: state.time.base, turnStart: now };
  state.startedAt = now;
}

// 보는 사람에게 돌려줄 방 상태
function view(state, version, me, now) {
  const you = colorOf(state, me.id);
  const away = (seat) => seat && now - (state.seen?.[seat.id] || 0) > AWAY_AFTER;
  return {
    v: version,
    code: state.code,
    public: state.public,
    status: state.status,
    white: state.white && { name: state.white.name },
    black: state.black && { name: state.black.name },
    hostColor: state.hostColor,
    isHost: state.host.id === me.id,
    you,
    moves: state.moves,
    fen: state.fen,
    lastMove: state.lastMove,
    result: state.result,
    reason: state.reason,
    time: state.time,
    clock: clockNow(state, now),
    drawOffer: state.drawOffer,
    rematch: state.rematch,
    opponentAway: you && state.status === 'playing' ? !!away(you === 'w' ? state.black : state.white) : false,
    serverNow: now
  };
}

async function createRoom(request, env, me) {
  const body = await readJson(request);
  const base = Number(body?.base);
  const inc = Number(body?.inc);
  if (!BASE_MINUTES.includes(base)) return fail('시간 설정이 잘못됐어요.', 400);
  if (!Number.isInteger(inc) || inc < 0 || inc > MAX_INCREMENT) return fail('추가 시간 설정이 잘못됐어요.', 400);
  let color = body?.color;
  if (!['w', 'b', 'random'].includes(color)) return fail('색을 골라 주세요.', 400);
  const hostColor = color;
  if (color === 'random') color = crypto.getRandomValues(new Uint8Array(1))[0] % 2 ? 'w' : 'b';

  const now = Date.now();
  // 오래된 방 정리 (가끔만)
  if (Math.random() < 0.1) await env.CHESS.prepare('DELETE FROM chess_rooms WHERE updated_at < ?').bind(now - ROOM_TTL).run();

  const state = {
    code: '',
    public: !!body?.public,
    host: me,
    hostColor,
    white: color === 'w' ? me : null,
    black: color === 'b' ? me : null,
    status: 'waiting',
    moves: [],
    fen: new Chess().fen(),
    lastMove: null,
    result: null,
    reason: null,
    time: { base: base * 60 * 1000, inc: inc * 1000 },
    clock: { w: base * 60 * 1000, b: base * 60 * 1000, turnStart: now },
    drawOffer: null,
    rematch: { w: false, b: false },
    seen: { [me.id]: now },
    createdAt: now
  };
  for (let tries = 0; tries < 5; tries++) {
    state.code = randomCode();
    try {
      await env.CHESS.prepare('INSERT INTO chess_rooms (code, version, status, public, created_at, updated_at, state) VALUES (?, 1, ?, ?, ?, ?, ?)')
        .bind(state.code, state.status, state.public ? 1 : 0, now, now, JSON.stringify(state)).run();
      return json({ code: state.code }, 201);
    } catch (err) {
      if (!/UNIQUE|constraint/i.test(String(err?.message))) throw err;
    }
  }
  return fail('방을 만들지 못했어요. 다시 해 주세요.', 500);
}

async function listRooms(env, me) {
  const now = Date.now();
  const { results } = await env.CHESS.prepare(
    'SELECT code, state FROM chess_rooms WHERE status = ? AND public = 1 AND updated_at > ? ORDER BY updated_at DESC LIMIT 30'
  ).bind('waiting', now - WAITING_LIST_AGE).all();
  return json(results.map((row) => {
    const s = JSON.parse(row.state);
    return {
      code: row.code,
      host: s.host.name,
      mine: s.host.id === me.id,
      hostColor: s.hostColor,
      time: s.time,
      createdAt: s.createdAt
    };
  }));
}

// 방에 들어가기: 빈자리가 있으면 앉고(게임 시작), 없으면 구경
async function joinRoom(request, env, me) {
  const body = await readJson(request);
  const code = String(body?.code ?? '').trim().toUpperCase();
  if (!CODE.test(code)) return fail('방 코드는 6자리예요.', 400, 'BAD_CODE');
  for (let tries = 0; tries < 3; tries++) {
    const room = await loadRoom(env.CHESS, code);
    if (!room) return fail('그런 방이 없어요. 코드를 확인해 주세요.', 404, 'NO_ROOM');
    const { state, version } = room;
    const now = Date.now();
    if (colorOf(state, me.id) || state.status !== 'waiting') return json(view(state, version, me, now));
    if (!state.white) state.white = me;
    else state.black = me;
    state.seen = { ...state.seen, [me.id]: now };
    newGameState(state, now);
    if (await saveRoom(env.CHESS, code, version, state)) return json(view(state, version + 1, me, now));
  }
  return fail('잠시 뒤에 다시 해 주세요.', 409, 'CONFLICT');
}

async function getRoom(url, env, me) {
  const code = String(url.searchParams.get('code') || '').toUpperCase();
  if (!CODE.test(code)) return fail('방 코드는 6자리예요.', 400, 'BAD_CODE');
  const room = await loadRoom(env.CHESS, code);
  if (!room) return fail('방이 없어졌어요.', 404, 'NO_ROOM');
  let { state, version } = room;
  const now = Date.now();
  let changed = checkTimeout(state, now);
  // 앉아 있는 사람이 보고 있다는 표시 (15초에 한 번만 저장)
  if (colorOf(state, me.id) && now - (state.seen?.[me.id] || 0) > SEEN_EVERY) {
    state.seen = { ...state.seen, [me.id]: now };
    changed = true;
  }
  if (changed && await saveRoom(env.CHESS, code, version, state)) version += 1;
  else if (changed) ({ state, version } = await loadRoom(env.CHESS, code));
  const known = Number(url.searchParams.get('v'));
  // 바뀐 게 없으면 짧게 (시계는 화면에서 흘려 보낸다)
  if (known === version) return json({ v: version, same: true, serverNow: now });
  return json(view(state, version, me, now));
}

async function makeMove(request, env, me) {
  const body = await readJson(request);
  const code = String(body?.code ?? '').toUpperCase();
  const from = String(body?.from ?? '');
  const to = String(body?.to ?? '');
  const promotion = body?.promotion ? String(body.promotion) : undefined;
  if (!CODE.test(code) || !SQUARE.test(from) || !SQUARE.test(to)) return fail('잘못된 수예요.', 400);
  if (promotion && !['q', 'r', 'b', 'n'].includes(promotion)) return fail('잘못된 승진이에요.', 400);

  const room = await loadRoom(env.CHESS, code);
  if (!room) return fail('방이 없어졌어요.', 404, 'NO_ROOM');
  const { state, version } = room;
  const now = Date.now();
  const color = colorOf(state, me.id);
  if (!color) return fail('구경하는 중에는 둘 수 없어요.', 403, 'NOT_PLAYER');
  if (checkTimeout(state, now)) {
    await saveRoom(env.CHESS, code, version, state);
    return fail('시간이 다 됐어요.', 409, 'GAME_OVER');
  }
  if (state.status !== 'playing') return fail('게임이 진행 중이 아니에요.', 409, 'GAME_OVER');
  if (turnOf(state) !== color) return fail('상대 차례예요.', 409, 'NOT_YOUR_TURN');

  const game = replay(state.moves);
  let move;
  try {
    move = game.move({ from, to, promotion });
  } catch {
    return fail('둘 수 없는 수예요.', 400, 'ILLEGAL');
  }
  // 시계: 서로 첫 수를 두기 전에는 시간이 안 흐른다. 둔 쪽은 쓴 시간을 빼고 추가 시간을 더한다.
  if (state.time.base && state.moves.length >= 2) {
    state.clock[color] = state.clock[color] - (now - state.clock.turnStart) + state.time.inc;
  }
  state.clock.turnStart = now;
  state.moves.push(move.san);
  state.fen = game.fen();
  state.lastMove = { from: move.from, to: move.to };
  state.seen = { ...state.seen, [me.id]: now };
  // 내 차례에 수를 두면 내가 했던 무승부 제안만 남기고, 상대 제안은 거절한 걸로 본다
  if (state.drawOffer && state.drawOffer !== color) state.drawOffer = null;

  if (game.isCheckmate()) endGame(state, color === 'w' ? '1-0' : '0-1', 'checkmate');
  else if (game.isStalemate()) endGame(state, '1/2-1/2', 'stalemate');
  else if (game.isInsufficientMaterial()) endGame(state, '1/2-1/2', 'material');
  else if (game.isThreefoldRepetition()) endGame(state, '1/2-1/2', 'repetition');
  else if (game.isDrawByFiftyMoves()) endGame(state, '1/2-1/2', 'fifty');

  if (!(await saveRoom(env.CHESS, code, version, state))) return fail('그사이 판이 바뀌었어요. 다시 둬 주세요.', 409, 'CONFLICT');
  return json(view(state, version + 1, me, now));
}

async function roomAction(request, env, me) {
  const body = await readJson(request);
  const code = String(body?.code ?? '').toUpperCase();
  const action = body?.action;
  if (!CODE.test(code)) return fail('방 코드는 6자리예요.', 400);

  for (let tries = 0; tries < 3; tries++) {
    const room = await loadRoom(env.CHESS, code);
    if (!room) return fail('방이 없어졌어요.', 404, 'NO_ROOM');
    const { state, version } = room;
    const now = Date.now();
    const color = colorOf(state, me.id);

    if (action === 'cancel') {
      // 아직 상대가 안 들어온 방은 만든 사람이 없앨 수 있다
      if (state.status !== 'waiting' || state.host.id !== me.id) return fail('지금은 방을 없앨 수 없어요.', 409);
      await env.CHESS.prepare('DELETE FROM chess_rooms WHERE code = ? AND version = ?').bind(code, version).run();
      return json({ ok: true });
    }
    if (!color) return fail('구경하는 중에는 할 수 없어요.', 403, 'NOT_PLAYER');
    checkTimeout(state, now);

    if (action === 'resign') {
      if (state.status !== 'playing') return fail('게임이 진행 중이 아니에요.', 409, 'GAME_OVER');
      endGame(state, color === 'w' ? '0-1' : '1-0', 'resign');
    } else if (action === 'draw-offer') {
      if (state.status !== 'playing') return fail('게임이 진행 중이 아니에요.', 409, 'GAME_OVER');
      if (state.drawOffer === other(color)) endGame(state, '1/2-1/2', 'agreement'); // 서로 제안하면 무승부
      else state.drawOffer = color;
    } else if (action === 'draw-accept') {
      if (state.status !== 'playing' || state.drawOffer !== other(color)) return fail('받을 무승부 제안이 없어요.', 409);
      endGame(state, '1/2-1/2', 'agreement');
    } else if (action === 'draw-decline') {
      if (state.drawOffer === other(color)) state.drawOffer = null;
    } else if (action === 'claim') {
      // 상대가 1분 넘게 안 보이면 승리로 끝낼 수 있다
      const opponent = color === 'w' ? state.black : state.white;
      if (state.status !== 'playing' || now - (state.seen?.[opponent.id] || 0) <= AWAY_AFTER) return fail('상대가 아직 있어요.', 409);
      endGame(state, color === 'w' ? '1-0' : '0-1', 'abandon');
    } else if (action === 'rematch') {
      if (state.status !== 'ended') return fail('게임이 끝난 뒤에 할 수 있어요.', 409);
      state.rematch = { ...state.rematch, [color]: true };
      if (state.rematch.w && state.rematch.b) {
        // 색을 바꿔서 같은 시간으로 다시
        [state.white, state.black] = [state.black, state.white];
        newGameState(state, now);
      }
    } else {
      return fail('잘못된 요청', 400);
    }
    state.seen = { ...state.seen, [me.id]: now };
    if (await saveRoom(env.CHESS, code, version, state)) return json(view(state, version + 1, me, now));
  }
  return fail('잠시 뒤에 다시 해 주세요.', 409, 'CONFLICT');
}

export async function handleChess(request, env, session) {
  if (!env.CHESS) {
    return fail('온라인 대결은 아직 설정되지 않았어요. (관리자: D1 데이터베이스 CHESS 연결 필요)', 503, 'NO_CHESS_DB');
  }
  await ensureTable(env.CHESS);
  const url = new URL(request.url);
  const me = playerOf(session);
  const route = `${request.method} ${url.pathname}`;
  if (route === 'POST /api/chess/rooms') return createRoom(request, env, me);
  if (route === 'GET /api/chess/rooms') return listRooms(env, me);
  if (route === 'POST /api/chess/join') return joinRoom(request, env, me);
  if (route === 'GET /api/chess/room') return getRoom(url, env, me);
  if (route === 'POST /api/chess/move') return makeMove(request, env, me);
  if (route === 'POST /api/chess/action') return roomAction(request, env, me);
  return fail('없는 주소예요.', 404);
}
