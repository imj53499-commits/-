// 공지·패치노트: 관리자가 쓰면 KV(notice)에 저장되고, 로그인한 사람이 들어올 때 팝업으로 뜬다.
//   { id, title, body, updatedAt }  id 는 고칠 때마다 바뀌어서 '다시 보지 않기' 한 사람에게도 새 공지는 다시 뜬다.
import { json } from './auth.js';

const NOTICE_KEY = 'notice';
const MAX_TITLE = 60;
const MAX_BODY = 4000;

const fail = (error, status, code) => json({ error, code }, status);

function clean(value, max) {
  return String(value ?? '').replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim().slice(0, max);
}

async function readJson(request) {
  if (!(request.headers.get('Content-Type') || '').includes('application/json')) return null;
  try { return await request.json(); } catch { return null; }
}

async function saveNotice(request, env) {
  const body = await readJson(request);
  if (body?.clear) {
    await env.DB.delete(NOTICE_KEY);
    return json({ notice: null });
  }
  const title = clean(body?.title, MAX_TITLE);
  const text = clean(body?.body, MAX_BODY);
  if (!title) return fail('제목을 적어 주세요.', 400);
  if (!text) return fail('내용을 적어 주세요.', 400);
  const updatedAt = Date.now();
  const notice = { id: `${updatedAt.toString(36)}${crypto.getRandomValues(new Uint32Array(1))[0].toString(36)}`, title, body: text, updatedAt };
  await env.DB.put(NOTICE_KEY, JSON.stringify(notice));
  return json({ notice });
}

// /api/notice: 지금 공지 (없으면 null), /api/admin/notice: 관리자용 (GET 보기, POST 쓰기·지우기)
export async function handleNotice(request, env, session) {
  const { pathname } = new URL(request.url);
  const route = `${request.method} ${pathname}`;
  if (route === 'GET /api/notice') return json({ notice: await env.DB.get(NOTICE_KEY, 'json') });
  if (session.role !== 'admin') return fail('관리자 로그인이 필요해요.', 401, 'ADMIN_REQUIRED');
  if (route === 'GET /api/admin/notice') return json({ notice: await env.DB.get(NOTICE_KEY, 'json') });
  if (route === 'POST /api/admin/notice') return saveNotice(request, env);
  return fail('Not found', 404);
}
