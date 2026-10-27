import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeList, isVideoId } from './normalize.js';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

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

const CACHE_TTL = 5 * 60 * 1000;

function str(v) {
  return v == null ? '' : String(v.toString?.() ?? v).trim();
}

export function createApp(getYt) {
  const app = express();
  const cache = new Map();

  async function cached(key, fn) {
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_TTL) return hit.value;
    const value = await fn();
    cache.set(key, { at: Date.now(), value });
    if (cache.size > 500) cache.delete(cache.keys().next().value);
    return value;
  }

  async function searchVideos(query) {
    const yt = await getYt();
    const result = await yt.search(query, { type: 'video' });
    return normalizeList(result.videos, 40);
  }

  // 여러 검색 결과를 번갈아 섞는다.
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

  const route = (handler) => async (req, res) => {
    try {
      res.json(await handler(req, res));
    } catch (err) {
      console.error(`[${req.path}]`, err?.message || err);
      if (!res.headersSent) res.status(502).json({ error: '영상 정보를 불러오지 못했어요. 잠시 후 다시 시도해 주세요.' });
    }
  };

  app.get('/api/categories', (req, res) => {
    res.json(Object.keys(CATEGORIES));
  });

  app.get('/api/home', route(async (req) => {
    const category = CATEGORIES[req.query.category] ? req.query.category : 'all';
    return cached(`home:${category}`, async () => {
      let items = [];
      if (category === 'all') {
        try {
          const yt = await getYt();
          const feed = await yt.getHomeFeed();
          items = normalizeList(feed.videos, 40).filter((v) => !v.isShort);
        } catch (err) {
          console.warn('[home] 홈 피드 실패, 검색으로 대체:', err?.message || err);
        }
      }
      if (items.length < 12) {
        const settled = await Promise.allSettled(CATEGORIES[category].map(searchVideos));
        const lists = settled.filter((s) => s.status === 'fulfilled').map((s) => s.value);
        if (!lists.length && !items.length) throw settled[0].reason;
        items = interleave([items, ...lists], 40);
      }
      return items;
    });
  }));

  app.get('/api/search', route(async (req) => {
    const q = str(req.query.q).slice(0, 200);
    if (!q) return [];
    return cached(`search:${q}`, () => searchVideos(q));
  }));

  app.get('/api/suggest', route(async (req) => {
    const q = str(req.query.q).slice(0, 100);
    if (!q) return [];
    return cached(`suggest:${q}`, async () => {
      const yt = await getYt();
      return (await yt.getSearchSuggestions(q)).slice(0, 10);
    });
  }));

  app.get('/api/video', route(async (req, res) => {
    const id = str(req.query.id);
    if (!isVideoId(id)) {
      res.status(400);
      return { error: '잘못된 영상 ID' };
    }
    return cached(`video:${id}`, async () => {
      const yt = await getYt();
      const info = await yt.getInfo(id);
      const basic = info.basic_info || {};
      const primary = info.primary_info;
      const secondary = info.secondary_info;
      const owner = secondary?.owner;
      return {
        id,
        title: str(primary?.title) || basic.title || '',
        views: str(primary?.view_count?.view_count) || (basic.view_count ? `조회수 ${Number(basic.view_count).toLocaleString('ko-KR')}회` : ''),
        published: str(primary?.relative_date) || str(primary?.published),
        description: str(secondary?.description) || basic.short_description || '',
        channel: owner?.author?.name || basic.author || '',
        channelId: owner?.author?.id || basic.channel_id || '',
        channelAvatar: owner?.author?.thumbnails?.[0]?.url || '',
        subscribers: str(owner?.subscriber_count),
        related: normalizeList(info.watch_next_feed, 20).filter((v) => !v.isShort)
      };
    });
  }));

  app.get('/api/channel', route(async (req, res) => {
    const id = str(req.query.id);
    if (!/^UC[\w-]{22}$/.test(id)) {
      res.status(400);
      return { error: '잘못된 채널 ID' };
    }
    return cached(`channel:${id}`, async () => {
      const yt = await getYt();
      const channel = await yt.getChannel(id);
      const meta = channel.metadata || {};
      const header = channel.header;
      const banner =
        header?.content?.banner?.image ||
        header?.banner?.image ||
        header?.banner ||
        [];
      let videos = [];
      try {
        const tab = channel.has_videos ? await channel.getVideos() : channel;
        videos = normalizeList(tab.videos, 48);
      } catch (err) {
        console.warn('[channel] 동영상 탭 실패:', err?.message || err);
      }
      const name = meta.title || '';
      return {
        id,
        name,
        avatar: meta.avatar?.[0]?.url || meta.thumbnail?.[0]?.url || '',
        banner: Array.isArray(banner) && banner.length ? banner[banner.length - 1].url : '',
        description: meta.description || '',
        videos: videos.map((v) => ({ ...v, channel: v.channel || name, channelId: v.channelId || id }))
      };
    });
  }));

  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

  app.use(express.static(PUBLIC_DIR, { extensions: ['html'] }));

  // 새로고침해도 화면이 뜨도록 나머지 경로는 index.html 로 보낸다.
  app.get('*', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));

  return app;
}
