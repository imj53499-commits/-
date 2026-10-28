// YouTube 내부 API(InnerTube)를 로그인 없이 직접 호출하고, 응답에서 영상 정보만 골라낸다.
// Workers 무료 플랜의 CPU 제한(요청당 10ms) 안에 들어오도록 라이브러리 없이 가볍게 처리한다.

const API_BASE = 'https://www.youtube.com/youtubei/v1';
const CONTEXT = {
  client: { clientName: 'WEB', clientVersion: '2.20251020.01.00', hl: 'ko', gl: 'KR' }
};
const HEADERS = {
  'Content-Type': 'application/json',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
  'Accept-Language': 'ko-KR,ko;q=0.9',
  Origin: 'https://www.youtube.com',
  Referer: 'https://www.youtube.com/',
  'X-Youtube-Client-Name': '1',
  'X-Youtube-Client-Version': CONTEXT.client.clientVersion
};

// 검색 필터: 동영상만
const SEARCH_VIDEOS_ONLY = 'EgIQAQ==';
// 채널 "동영상" 탭
const CHANNEL_VIDEOS_TAB = 'EgZ2aWRlb3PyBgQKAjoA';

export const VIDEO_ID = /^[\w-]{11}$/;
export const CHANNEL_ID = /^UC[\w-]{22}$/;

// ---------- 텍스트/이미지 헬퍼 ----------

export function text(t) {
  if (t == null) return '';
  if (typeof t === 'string') return t.trim();
  if (t.simpleText != null) return String(t.simpleText).trim();
  if (Array.isArray(t.runs)) return t.runs.map((r) => r.text || '').join('').trim();
  if (t.content != null) return String(t.content).trim();
  return '';
}

function fixUrl(u) {
  if (!u) return '';
  return u.startsWith('//') ? `https:${u}` : u;
}

function lastUrl(list) {
  return Array.isArray(list) && list.length ? fixUrl(list[list.length - 1].url) : '';
}

function browseIdOf(run) {
  return run?.navigationEndpoint?.browseEndpoint?.browseId || '';
}

const thumb = (id) => `https://i.ytimg.com/vi/${id}/mqdefault.jpg`;

// ---------- 영상 노드 → 화면용 데이터 ----------

function fromVideoRenderer(v) {
  const byline = v.ownerText || v.longBylineText || v.shortBylineText;
  const avatar =
    v.channelThumbnailSupportedRenderers?.channelThumbnailWithLinkRenderer?.thumbnail?.thumbnails ||
    v.channelThumbnail?.thumbnails;
  const meta = [text(v.shortViewCountText) || text(v.viewCountText), text(v.publishedTimeText)].filter(Boolean);
  return {
    id: v.videoId,
    title: text(v.title),
    channel: text(byline),
    channelId: browseIdOf(byline?.runs?.[0]),
    channelAvatar: lastUrl(avatar),
    meta: meta.join(' · '),
    duration: text(v.lengthText),
    thumbnail: thumb(v.videoId),
    // 검색 결과에 섞여 나오는 쇼츠는 링크가 쇼츠 플레이어(reelWatchEndpoint)로 걸려 있다.
    isShort: !!v.navigationEndpoint?.reelWatchEndpoint
  };
}

function fromLockup(l) {
  const type = l.contentType || '';
  if (!/VIDEO|SHORT/.test(type) || /PLAYLIST|CHANNEL/.test(type)) return null;
  const meta = l.metadata?.lockupMetadataViewModel;
  const rows = meta?.metadata?.contentMetadataViewModel?.metadataRows || [];
  const parts = rows.flatMap((r) => r.metadataParts || []);
  const channelPart = parts[0]?.text;
  const channelId =
    channelPart?.commandRuns?.[0]?.onTap?.innertubeCommand?.browseEndpoint?.browseId ||
    meta?.image?.decoratedAvatarViewModel?.rendererContext?.commandContext?.onTap?.innertubeCommand?.browseEndpoint?.browseId ||
    '';
  const avatar = meta?.image?.decoratedAvatarViewModel?.avatar?.avatarViewModel?.image?.sources;

  let duration = '';
  for (const o of l.contentImage?.thumbnailViewModel?.overlays || []) {
    const badges =
      o.thumbnailOverlayBadgeViewModel?.thumbnailBadges ||
      o.thumbnailBottomOverlayViewModel?.badges ||
      [];
    const badge = badges.find((b) => b.thumbnailBadgeViewModel?.text);
    if (badge) {
      duration = badge.thumbnailBadgeViewModel.text;
      break;
    }
  }

  return {
    id: l.contentId,
    title: text(meta?.title),
    channel: text(channelPart),
    channelId,
    channelAvatar: lastUrl(avatar),
    meta: parts.slice(1).map((p) => text(p.text)).filter(Boolean).join(' · '),
    duration: /^[\d:]+$/.test(duration) ? duration : '',
    thumbnail: thumb(l.contentId),
    isShort: /SHORT/.test(type)
  };
}

function fromShort(s) {
  const id = s.videoId || s.onTap?.innertubeCommand?.reelWatchEndpoint?.videoId;
  return {
    id,
    title: text(s.headline) || text(s.overlayMetadata?.primaryText),
    channel: '',
    channelId: '',
    channelAvatar: '',
    meta: text(s.viewCountText) || text(s.overlayMetadata?.secondaryText),
    duration: '',
    thumbnail: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
    isShort: true
  };
}

const PARSERS = {
  videoRenderer: fromVideoRenderer,
  compactVideoRenderer: fromVideoRenderer,
  gridVideoRenderer: fromVideoRenderer,
  lockupViewModel: fromLockup,
  reelItemRenderer: fromShort,
  shortsLockupViewModel: fromShort
};

// JSON 트리 전체에서 영상 노드를 찾아 순서대로 꺼낸다.
export function extractVideos(root, limit = 40) {
  const out = [];
  const seen = new Set();
  const stack = [root];
  while (stack.length && out.length < limit) {
    const node = stack.pop();
    if (!node || typeof node !== 'object') continue;
    if (Array.isArray(node)) {
      for (let i = node.length - 1; i >= 0; i--) stack.push(node[i]);
      continue;
    }
    let matched = false;
    for (const key in PARSERS) {
      if (node[key]) {
        matched = true;
        const item = PARSERS[key](node[key]);
        if (item && VIDEO_ID.test(item.id || '') && item.title && !seen.has(item.id)) {
          seen.add(item.id);
          out.push(item);
        }
      }
    }
    if (matched) continue;
    const keys = Object.keys(node);
    for (let i = keys.length - 1; i >= 0; i--) {
      const child = node[keys[i]];
      if (child && typeof child === 'object') stack.push(child);
    }
  }
  return out;
}

// 목록 끝에 있는 '더 보기' 토큰. 이걸 다시 보내면 다음 결과를 준다.
export function findContinuation(root) {
  let token = null;
  const stack = [root];
  while (stack.length) {
    const node = stack.pop();
    if (!node || typeof node !== 'object') continue;
    const t = node.continuationItemRenderer?.continuationEndpoint?.continuationCommand?.token;
    if (t) {
      token = t;
      continue;
    }
    for (const key in node) {
      const child = node[key];
      if (child && typeof child === 'object') stack.push(child);
    }
  }
  return token;
}

export const CONTINUATION = /^[\w%=-]{10,3000}$/;

// ---------- API 호출 ----------

export function createYouTube(fetchFn = fetch) {
  async function call(endpoint, body) {
    const res = await fetchFn(`${API_BASE}/${endpoint}?prettyPrint=false`, {
      method: 'POST',
      headers: HEADERS,
      body: JSON.stringify({ context: CONTEXT, ...body })
    });
    if (!res.ok) throw new Error(`YouTube ${endpoint} 응답 ${res.status}`);
    return res.json();
  }

  return {
    // 검색 한 페이지. continuation 을 주면 그 다음 페이지. → { items, next }
    async searchPage(query, continuation) {
      const data = continuation
        ? await call('search', { continuation })
        : await call('search', { query, params: SEARCH_VIDEOS_ONLY });
      const root = continuation ? data.onResponseReceivedCommands : data.contents;
      return { items: extractVideos(root, 40).filter((v) => !v.isShort), next: findContinuation(root) };
    },

    async search(query) {
      return (await this.searchPage(query)).items;
    },

    // 쇼츠만 골라 온다. 검색 결과의 쇼츠 묶음(reelShelf)과 쇼츠 링크가 걸린 영상을 모은다.
    async shorts(query) {
      const data = await call('search', { query });
      return extractVideos(data.contents, 80).filter((v) => v.isShort);
    },

    async homeFeed() {
      const data = await call('browse', { browseId: 'FEwhat_to_watch' });
      return extractVideos(data.contents, 40).filter((v) => !v.isShort);
    },

    async suggest(query) {
      const url = `https://suggestqueries-clients6.youtube.com/complete/search?client=firefox&ds=yt&hl=ko&gl=kr&ie=utf-8&oe=utf-8&q=${encodeURIComponent(query)}`;
      const res = await fetchFn(url, { headers: { 'User-Agent': HEADERS['User-Agent'] } });
      if (!res.ok) throw new Error(`자동완성 응답 ${res.status}`);
      const data = await res.json();
      return Array.isArray(data?.[1]) ? data[1].map((s) => (Array.isArray(s) ? s[0] : s)).filter((s) => typeof s === 'string').slice(0, 10) : [];
    },

    async video(id) {
      const data = await call('next', { videoId: id });
      const watch = data.contents?.twoColumnWatchNextResults;
      const results = watch?.results?.results?.contents || [];
      const primary = results.find((c) => c.videoPrimaryInfoRenderer)?.videoPrimaryInfoRenderer;
      const secondary = results.find((c) => c.videoSecondaryInfoRenderer)?.videoSecondaryInfoRenderer;
      const owner = secondary?.owner?.videoOwnerRenderer;
      if (!primary) throw new Error('영상 정보를 찾을 수 없음');
      return {
        id,
        title: text(primary.title),
        views: text(primary.viewCount?.videoViewCountRenderer?.viewCount),
        published: text(primary.relativeDateText) || text(primary.dateText),
        description: text(secondary?.attributedDescription) || text(secondary?.description),
        channel: text(owner?.title),
        channelId: browseIdOf(owner?.title?.runs?.[0]) || owner?.navigationEndpoint?.browseEndpoint?.browseId || '',
        channelAvatar: lastUrl(owner?.thumbnail?.thumbnails),
        subscribers: text(owner?.subscriberCountText),
        related: extractVideos(watch?.secondaryResults, 30).filter((v) => !v.isShort && v.id !== id).slice(0, 20)
      };
    },

    async channel(id) {
      const data = await call('browse', { browseId: id, params: CHANNEL_VIDEOS_TAB });
      const meta = data.metadata?.channelMetadataRenderer || {};
      const header = data.header;
      const banner =
        header?.pageHeaderRenderer?.content?.pageHeaderViewModel?.banner?.imageBannerViewModel?.image?.sources ||
        header?.c4TabbedHeaderRenderer?.banner?.thumbnails;
      const name = meta.title || text(header?.pageHeaderRenderer?.pageTitle) || '';
      const avatar = lastUrl(meta.avatar?.thumbnails);
      const videos = extractVideos(data.contents, 48).map((v) => ({
        ...v,
        channel: v.channel || name,
        channelId: v.channelId || id,
        channelAvatar: v.channelAvatar || avatar
      }));
      return { id, name, avatar, banner: lastUrl(banner), description: meta.description || '', videos, next: findContinuation(data.contents) };
    },

    // 채널 동영상 다음 페이지 → { items, next }
    async channelMore(continuation) {
      const data = await call('browse', { continuation });
      const root = data.onResponseReceivedActions || data.onResponseReceivedEndpoints;
      return { items: extractVideos(root, 48), next: findContinuation(root) };
    }
  };
}
