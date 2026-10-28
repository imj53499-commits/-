import { VIDEO_ID, CHANNEL_ID } from './youtube.js';

// 로그인하지 않은 상태의 홈 피드는 비어 있고 모두에게 똑같아서, 카테고리별 검색어 묶음으로 채운다.
// 방문할 때마다 다른 순서(seed)로 검색어를 고르고, 아래로 내릴 때마다(page) 다음 검색어를 쓴다.
export const CATEGORIES = {
  all: [
    '인기 급상승', '오늘의 추천 영상', '최신 뮤직비디오', '웃긴 영상', '게임 하이라이트', '먹방', '브이로그',
    '스포츠 하이라이트', '귀여운 동물', '요리 레시피', '여행 브이로그', '예능 하이라이트', '드라마 명장면',
    '영화 리뷰', '과학 다큐', '역사 이야기', '자동차 리뷰', '테크 리뷰', '아이돌 무대', '커버곡',
    '공부 자극', '운동 루틴', '캠핑', '낚시', 'ASMR', '마술', '실험 영상', '애니메이션', '웹툰', '축구 골 모음'
  ],
  music: ['최신 뮤직비디오', '인기 음악', '아이돌 무대', '커버곡', '플레이리스트', '라이브 콘서트', '힙합', '발라드', '밴드 라이브', 'OST'],
  game: ['게임 하이라이트', '인기 게임 영상', '마인크래프트', '롤 하이라이트', '배그', '게임 공략', '신작 게임', '스팀 게임', '닌텐도', '게임 리뷰'],
  news: ['오늘의 뉴스', '경제 뉴스', '과학 뉴스', 'IT 뉴스', '세계 뉴스', '스포츠 뉴스', '날씨', '뉴스 브리핑'],
  sports: ['스포츠 하이라이트', '축구 골 모음', '야구 하이라이트', '농구 하이라이트', '배구 하이라이트', 'UFC', 'F1', '테니스', '올림픽', 'e스포츠'],
  food: ['먹방', '요리 레시피', '맛집 탐방', '디저트 만들기', '길거리 음식', '자취 요리', '베이킹', '편의점 신상', '캠핑 요리', '대식가'],
  vlog: ['브이로그', '여행 브이로그', '일상 브이로그', '학생 브이로그', '직장인 브이로그', '해외 브이로그', '자취 브이로그', '캠핑 브이로그'],
  animal: ['귀여운 동물', '강아지', '고양이', '웃긴 동물', '동물 다큐', '아기 동물', '햄스터', '앵무새', '수족관', '야생 동물']
};

// 검색어를 다 쓰면 이런 말을 붙여서 새 검색어를 만든다 (아래로 계속 내릴 수 있게).
const QUERY_VARIANTS = ['', ' 최신', ' 인기', ' 모음', ' 레전드', ' 추천', ' 하이라이트', ' 몰아보기'];
const QUERIES_PER_PAGE = 2;
export const MAX_HOME_PAGE = 60;

// seed 로 항상 같은 결과가 나오는 섞기 (같은 방문 안에서는 페이지마다 이어지게)
function seededShuffle(list, seed) {
  const out = [...list];
  let x = (seed >>> 0) || 1;
  for (let i = out.length - 1; i > 0; i--) {
    x ^= x << 13; x ^= x >>> 17; x ^= x << 5; x >>>= 0;
    const j = x % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export function homeQueries(category, page, seed) {
  const pool = seededShuffle(CATEGORIES[category], seed);
  const queries = [];
  for (let i = 0; i < QUERIES_PER_PAGE; i++) {
    const n = page * QUERIES_PER_PAGE + i;
    queries.push(pool[n % pool.length] + QUERY_VARIANTS[Math.floor(n / pool.length) % QUERY_VARIANTS.length]);
  }
  return queries;
}

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

async function home(yt, category, page, seed) {
  // 검색어별로 캐시해서, 사람마다 순서는 달라도 YouTube 요청은 서로 나눠 쓴다.
  const tasks = homeQueries(category, page, seed).map((query) => cached(`search:${query}`, () => yt.search(query)));
  // 전체 탭 첫 페이지에는 YouTube 홈 피드도 시도해서 섞는다 (비어 있으면 무시).
  if (category === 'all' && page === 0) tasks.unshift(cached('homefeed', () => yt.homeFeed()));
  const settled = await Promise.allSettled(tasks);
  const lists = settled.filter((s) => s.status === 'fulfilled').map((s) => s.value);
  if (!lists.some((l) => l.length)) {
    const failure = settled.find((s) => s.status === 'rejected');
    if (failure) throw failure.reason;
  }
  return interleave(lists, 40);
}

export async function handleApi(url, yt) {
  const q = (name, max) => (url.searchParams.get(name) || '').trim().slice(0, max);
  try {
    switch (url.pathname) {
      case '/api/home': {
        const category = CATEGORIES[q('category', 20)] ? q('category', 20) : 'all';
        const page = Math.max(0, Math.min(Number.parseInt(q('page', 3), 10) || 0, MAX_HOME_PAGE));
        const seed = Number.parseInt(q('seed', 10), 10) || 1;
        return json(await home(yt, category, page, seed));
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
