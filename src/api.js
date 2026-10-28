import { VIDEO_ID, CHANNEL_ID } from './youtube.js';

// 로그인하지 않은 상태의 홈 피드는 비어 있는 경우가 많아서, 카테고리별 검색어로 채운다.
export const CATEGORIES = {
  all: ['인기 급상승', '오늘의 추천 영상', '최신 뮤직비디오'],
  music: ['최신 뮤직비디오', '인기 음악'],
  game: ['게임 하이라이트', '인기 게임 영상'],
  news: ['오늘의 뉴스'],
  sports: ['스포츠 하이라이트'],
  food: ['먹방', '요리 레시피'],
  vlog: ['브이로그'],
  animal: ['귀여운 동물']
};

// 쇼츠 피드용 검색어. page 마다 다음 검색어 묶음을 써서 계속 새 쇼츠를 불러온다.
export const SHORTS_QUERIES = [
  ['#shorts', '쇼츠 인기'], ['웃긴 쇼츠', '#shorts 동물'], ['#shorts 게임', '#shorts 음악'],
  ['#shorts 먹방', '#shorts 스포츠'], ['#shorts 댄스', '#shorts 꿀팁']
];

// 추천에 쓰는 최근 시청 영상 수. 영상마다 YouTube 요청이 하나씩 들어서 무료 플랜 CPU 제한을 생각해 작게 둔다.
const RECOMMEND_SEEDS = 2;

const CACHE_TTL = 5 * 60 * 1000;
const cache = new Map();

async function cached(key, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL) return hit.value;
  const value = await fn();
  cache.set(key, { at: Date.now(), value });
  if (cache.size > 300) cache.delete(cache.keys().next().value);
  return value;
}

export function clearCache() {
  cache.clear();
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': status === 200 ? 'private, max-age=300' : 'no-store'
    }
  });
}

// 여러 목록을 번갈아 섞으면서 중복을 뺀다.
function interleave(lists, limit) {
  const out = [];
  const seen = new Set();
  for (let i = 0; out.length < limit && lists.some((l) => i < l.length); i++) {
    for (const list of lists) {
      const item = list[i];
      if (item && !seen.has(item.id)) {
        seen.add(item.id);
        out.push(item);
      }
    }
  }
  return out.slice(0, limit);
}

async function home(yt, category) {
  let items = [];
  if (category === 'all') {
    try {
      items = await yt.homeFeed();
    } catch (err) {
      console.warn('[home] 홈 피드 실패, 검색으로 대체:', err?.message || err);
    }
  }
  if (items.length < 12) {
    const settled = await Promise.allSettled(CATEGORIES[category].map((q) => yt.search(q)));
    const lists = settled.filter((s) => s.status === 'fulfilled').map((s) => s.value);
    if (!lists.length && !items.length) throw settled[0].reason;
    items = interleave([items, ...lists], 40);
  }
  return items;
}

export async function handleApi(url, yt) {
  const q = (name, max) => (url.searchParams.get(name) || '').trim().slice(0, max);
  try {
    switch (url.pathname) {
      case '/api/home': {
        const category = CATEGORIES[q('category', 20)] ? q('category', 20) : 'all';
        return json(await cached(`home:${category}`, () => home(yt, category)));
      }
      case '/api/shorts': {
        const page = Math.max(0, Math.min(Number.parseInt(q('page', 3), 10) || 0, 99));
        const queries = SHORTS_QUERIES[page % SHORTS_QUERIES.length];
        return json(await cached(`shorts:${page}`, async () => {
          const settled = await Promise.allSettled(queries.map((query) => yt.shorts(query)));
          const lists = settled.filter((s) => s.status === 'fulfilled').map((s) => s.value);
          if (!lists.length) throw settled[0].reason;
          return interleave(lists, 30);
        }));
      }
      case '/api/search': {
        const query = q('q', 200);
        if (!query) return json([]);
        return json(await cached(`search:${query}`, () => yt.search(query)));
      }
      case '/api/suggest': {
        const query = q('q', 100);
        if (!query) return json([]);
        return json(await cached(`suggest:${query}`, () => yt.suggest(query)));
      }
      case '/api/video': {
        const id = q('id', 20);
        if (!VIDEO_ID.test(id)) return json({ error: '잘못된 영상 ID' }, 400);
        return json(await cached(`video:${id}`, () => yt.video(id)));
      }
      // 최근 본 영상(최대 RECOMMEND_SEEDS 개)의 관련 영상을 섞어서 추천한다. 시청 기록은 브라우저에만 있고 서버에 저장하지 않는다.
      case '/api/recommend': {
        const ids = [...new Set(q('ids', 100).split(','))].filter((id) => VIDEO_ID.test(id)).slice(0, RECOMMEND_SEEDS);
        if (!ids.length) return json([]);
        const settled = await Promise.allSettled(ids.map((id) => cached(`video:${id}`, () => yt.video(id))));
        const lists = settled.filter((s) => s.status === 'fulfilled').map((s) => s.value.related);
        if (!lists.length) throw settled[0].reason;
        return json(interleave(lists, 40).filter((v) => !ids.includes(v.id)));
      }
      case '/api/channel': {
        const id = q('id', 30);
        if (!CHANNEL_ID.test(id)) return json({ error: '잘못된 채널 ID' }, 400);
        return json(await cached(`channel:${id}`, () => yt.channel(id)));
      }
      default:
        return json({ error: 'Not found' }, 404);
    }
  } catch (err) {
    console.error(`[${url.pathname}]`, err?.message || err);
    return json({ error: '영상 정보를 불러오지 못했어요. 잠시 후 다시 시도해 주세요.' }, 502);
  }
}
