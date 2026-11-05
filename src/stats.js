// 사용량 통계 (관리자 화면). Cloudflare 무료 플랜 한도(요청/KV 쓰기)를 가늠하라고 둔다.
//
// KV 쓰기가 하루 1000번뿐이라, 요청 수는 메모리에 모았다가 10분에 한 번만 stat:req:<YYYYMMDD> 에 더한다.
// 서버(isolate)가 여러 개면 서로의 메모리를 못 봐서 수가 조금 모자랄 수 있다 (대략값이라고 보면 된다).
// 날짜별 키는 40일 뒤 저절로 사라진다.

const FLUSH_EVERY = 10 * 60 * 1000;
const DAY_TTL = 60 * 60 * 24 * 40;

const dayKey = (d = new Date()) => {
  const kst = new Date(d.getTime() + 9 * 60 * 60 * 1000); // 한국 시간 기준 하루
  return `stat:req:${kst.getUTCFullYear()}${String(kst.getUTCMonth() + 1).padStart(2, '0')}${String(kst.getUTCDate()).padStart(2, '0')}`;
};

// 서버(isolate)마다: 아직 KV 에 더하지 않은 요청 수와, 마지막으로 더한 시각
const pending = new WeakMap(); // env.DB → { count, day, flushedAt }

function state(env) {
  if (!pending.has(env.DB)) pending.set(env.DB, { count: 0, day: dayKey(), flushedAt: 0 });
  return pending.get(env.DB);
}

// 요청 하나를 센다. 가끔(10분마다) KV 에 모아서 더한다.
export async function bumpRequest(env) {
  if (!env.DB) return;
  const s = state(env);
  const today = dayKey();
  // 날짜가 바뀌었으면 어제치를 먼저 비운다
  if (s.day !== today) {
    await flush(env, s);
    s.day = today;
  }
  s.count++;
  if (Date.now() - s.flushedAt >= FLUSH_EVERY) await flush(env, s);
}

async function flush(env, s) {
  if (s.count <= 0) { s.flushedAt = Date.now(); return; }
  const add = s.count;
  s.count = 0;
  s.flushedAt = Date.now();
  try {
    const prev = Number(await env.DB.get(`stat:req:${s.day.slice('stat:req:'.length)}`)) || 0;
    const total = prev + add;
    await env.DB.put(s.day, String(total), { expirationTtl: DAY_TTL, metadata: { t: total } });
  } catch {
    s.count += add; // 실패하면 다음에 다시 시도
  }
}

// 관리자용: 최근 n일 요청 수 (오늘은 아직 안 비운 메모리 수까지 더해서 보여 준다)
export async function handleStats(request, env, session) {
  if (session.role !== 'admin') {
    return new Response(JSON.stringify({ error: '관리자 로그인이 필요해요.', code: 'ADMIN_REQUIRED' }), { status: 401, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
  }
  const s = state(env);
  const days = [];
  for (let i = 6; i >= 0; i--) {
    const key = dayKey(new Date(Date.now() - i * 86400000));
    let count = Number(await env.DB.get(key)) || 0;
    if (i === 0) count += s.count; // 오늘은 아직 안 비운 수도 더한다
    days.push({ date: key.slice('stat:req:'.length), count });
  }
  return new Response(JSON.stringify({ days, flushEverySec: FLUSH_EVERY / 1000 }), {
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
  });
}
