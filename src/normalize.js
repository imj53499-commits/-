// youtubei.js 노드(Video, CompactVideo, GridVideo, LockupView, ReelItem, ShortsLockupView 등)를
// 프런트엔드가 쓰는 하나의 형태로 변환한다.

const str = (v) => (v == null ? '' : String(v.toString?.() ?? v)).trim();
const firstUrl = (arr) => (Array.isArray(arr) && arr.length ? arr[0].url : '');
const bestUrl = (arr) => (Array.isArray(arr) && arr.length ? arr.reduce((a, b) => ((b.width || 0) > (a.width || 0) ? b : a)).url : '');
const fixUrl = (u) => (u && u.startsWith('//') ? `https:${u}` : u || '');
const thumbFor = (id) => `https://i.ytimg.com/vi/${id}/mqdefault.jpg`;

const VIDEO_ID = /^[\w-]{11}$/;

export function isVideoId(id) {
  return typeof id === 'string' && VIDEO_ID.test(id);
}

function fromLockup(node) {
  if (node.content_type !== 'VIDEO' && node.content_type !== 'SHORT') return null;
  const id = node.content_id;
  const meta = node.metadata;
  const rows = meta?.metadata?.metadata_rows || [];
  const parts = rows.flatMap((r) => r.metadata_parts || []);
  const channelText = parts[0]?.text;
  const rest = parts.slice(1).map((p) => str(p.text)).filter(Boolean);
  const avatar = meta?.image?.avatar?.image || meta?.image?.avatars?.[0]?.image;
  return {
    id,
    title: str(meta?.title),
    channel: str(channelText),
    channelId: channelText?.endpoint?.payload?.browseId || '',
    channelAvatar: fixUrl(firstUrl(avatar)),
    meta: rest.join(' · '),
    duration: node.duration?.text || '',
    thumbnail: thumbFor(id),
    isShort: node.content_type === 'SHORT'
  };
}

function fromShorts(node) {
  const id = node.on_tap_endpoint?.payload?.videoId || node.entity_id?.replace(/^shorts-shelf-item-/, '') || node.id;
  const title = str(node.overlay_metadata?.primary_text) || str(node.title) || str(node.accessibility_text);
  return {
    id,
    title,
    channel: '',
    channelId: '',
    channelAvatar: '',
    meta: str(node.overlay_metadata?.secondary_text) || str(node.views),
    duration: '',
    thumbnail: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
    isShort: true
  };
}

function fromVideo(node) {
  const id = node.video_id || node.id;
  const author = node.author;
  const meta = [str(node.short_view_count) || str(node.view_count), str(node.published)].filter(Boolean);
  return {
    id,
    title: str(node.title),
    channel: author?.name && author.name !== 'N/A' ? author.name : str(node.short_byline_text || node.long_byline_text),
    channelId: author?.id && author.id !== 'N/A' ? author.id : '',
    channelAvatar: fixUrl(bestUrl(author?.thumbnails)),
    meta: meta.join(' · '),
    duration: node.duration?.text || str(node.length_text),
    thumbnail: thumbFor(id),
    isShort: false
  };
}

export function normalizeVideo(node) {
  if (!node || typeof node !== 'object') return null;
  let item;
  switch (node.type) {
    case 'LockupView':
      item = fromLockup(node);
      break;
    case 'ReelItem':
    case 'ShortsLockupView':
      item = fromShorts(node);
      break;
    case 'Video':
    case 'CompactVideo':
    case 'GridVideo':
    case 'PlaylistVideo':
    case 'PlaylistPanelVideo':
    case 'WatchCardCompactVideo':
      item = fromVideo(node);
      break;
    default:
      return null;
  }
  if (!item || !isVideoId(item.id) || !item.title) return null;
  return item;
}

export function normalizeList(nodes, limit = 40) {
  const seen = new Set();
  const out = [];
  for (const node of nodes || []) {
    const item = normalizeVideo(node);
    if (!item || seen.has(item.id)) continue;
    seen.add(item.id);
    out.push(item);
    if (out.length >= limit) break;
  }
  return out;
}
