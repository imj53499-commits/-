// 점검 모드: 관리자가 켜면 관리자 말고는 아무도 사이트를 못 쓴다 (관리자 화면·문의하기는 됨).
// KV(maintenance)에 { on, message, until, startedAt } 로 저장한다. until 은 끝날 예정 시각(없으면 0).
import { json } from './auth.js';

const MAINTENANCE_KEY = 'maintenance';
const DEFAULT_MESSAGE = '지금 사이트를 점검하고 있어요. 잠시 뒤에 다시 들어와 주세요.';
const CACHE_MS = 10 * 1000; // 매 요청마다 KV 를 읽지 않게 잠깐 기억한다

const fail = (error, status, code) => json({ error, code }, status);
const cache = new WeakMap(); // KV 저장소마다 { at, value }

export async function loadMaintenance(env) {
  const hit = cache.get(env.DB);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  const value = await env.DB.get(MAINTENANCE_KEY, 'json');
  cache.set(env.DB, { at: Date.now(), value });
  return value;
}

export function maintenanceResponse(m) {
  return json({ error: m.message || DEFAULT_MESSAGE, code: 'MAINTENANCE', until: m.until || 0 }, 503);
}

async function readJson(request) {
  if (!(request.headers.get('Content-Type') || '').includes('application/json')) return null;
  try { return await request.json(); } catch { return null; }
}

// /api/admin/maintenance (관리자만): GET 지금 상태, POST { on, message, until } 켜기·끄기
export async function handleMaintenanceAdmin(request, env) {
  if (request.method === 'GET') return json({ maintenance: await env.DB.get(MAINTENANCE_KEY, 'json') });
  if (request.method !== 'POST') return fail('Not found', 404);
  const body = await readJson(request);
  let value = null;
  if (body?.on) {
    const message = String(body.message ?? '').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim().slice(0, 500) || DEFAULT_MESSAGE;
    const until = Number(body.until) > Date.now() ? Number(body.until) : 0;
    value = { on: true, message, until, startedAt: Date.now() };
    await env.DB.put(MAINTENANCE_KEY, JSON.stringify(value));
  } else {
    await env.DB.delete(MAINTENANCE_KEY);
  }
  cache.set(env.DB, { at: Date.now(), value });
  return json({ maintenance: value });
}
