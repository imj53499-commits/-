// 공지·패치노트: 관리자가 쓰면 KV(notice)에 저장되고, 로그인한 사람이 들어올 때 팝업으로 뜬다.
//   { id, title, body, updatedAt }  id 는 고칠 때마다 바뀌어서 '다시 보지 않기' 한 사람에게도 새 공지는 다시 뜬다.
import { json } from './auth.js';

const NOTICE_KEY = 'notice';
const MAX_TITLE = 60;
const MAX_BODY = 4000;

const fail = (error, status, code) => json({ error, code }, status);

// 관리자가 아직 아무것도 게시하지 않았으면 이 공지를 보여 준다 (관리자 화면에서 고쳐 게시하거나 내릴 수 있음)
export const FIRST_NOTICE = {
  id: 'patch-2026-11-04',
  title: '패치노트 (11월 4일)',
  body: [
    '새로 생긴 것',
    '- 프록시 앱: 앱 목록 → 프록시. 주소나 검색어를 넣으면 이 사이트를 거쳐서 열려요. 방문 기록에는 /#/proxy 만 남아요',
    '- 이동 단축키: 로그인하면 맨 먼저 정해요. Google / Google 클래스룸 / 직접 입력 중에서 고를 수 있어요',
    '- 이동 단축키로 간 사이트에서 ← 키(또는 Alt + ←)를 누르면 보던 화면으로 돌아와요. 프록시로 보던 사이트도 다시 열려요',
    '- 이 공지 창: \'오늘 하루 안 보기\', \'다시 보지 않기\'를 누를 수 있어요',
    '',
    '바뀐 것',
    '- 맨 위 로고가 School 로 바뀌었고, 누르면 처음 화면(앱 목록)으로 가요',
    '- 같은 계정은 한 기기에서만 로그인돼요. 다른 기기에서 로그인하면 먼저 쓰던 기기는 로그아웃돼요',
    '- 화면 가리기(` 키)는 그대로 쓸 수 있어요. 전체 화면에서 눌러도 바로 가려져요',
    '- 팝업 플레이어가 다른 창을 눌러도 위에 떠 있어요 (크롬·엣지)',
    '- 관리자에게 문의는 1시간에 20개까지 보낼 수 있어요',
    '- 1시간 체험과 체스 앱은 없어졌어요'
  ].join('\n'),
  updatedAt: Date.parse('2026-11-04T17:00:00+09:00')
};

// 저장된 게 없으면 FIRST_NOTICE, 내렸으면({ off: true }) null
async function loadNotice(env) {
  const saved = await env.DB.get(NOTICE_KEY, 'json');
  if (saved === null) return FIRST_NOTICE;
  return saved.off ? null : saved;
}

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
    // 지우지 않고 '내림'으로 남겨 둔다 (지우면 FIRST_NOTICE 가 다시 뜨니까)
    await env.DB.put(NOTICE_KEY, JSON.stringify({ off: true }));
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
  if (route === 'GET /api/notice') return json({ notice: await loadNotice(env) });
  if (session.role !== 'admin') return fail('관리자 로그인이 필요해요.', 401, 'ADMIN_REQUIRED');
  if (route === 'GET /api/admin/notice') return json({ notice: await loadNotice(env) });
  if (route === 'POST /api/admin/notice') return saveNotice(request, env);
  return fail('Not found', 404);
}
