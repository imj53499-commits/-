import {
  COVER_SHORTCUT_KEY, POPUP_SHORTCUT_KEY, DEFAULT_COVER_SHORTCUT, DEFAULT_POPUP_SHORTCUT, MODIFIER_CODES,
  loadShortcut, storeShortcut, shortcutFromEvent, shortcutLabel, matchesShortcut, isTypingKey, isTypingTarget,
  keepKeyboardFocus
} from './shortcuts.js';
import {
  embedUrl, sendToPlayer, listenTo, readPlayerMessage, autostart, loadAutoplay, saveAutoplay,
  loadHistory, recordWatch, clearHistory, pickNext, loadPopupBounds, ENDED, PAUSED
} from './player.js';

const app = document.getElementById('app');
const cardTpl = document.getElementById('cardTpl');
const searchForm = document.getElementById('searchForm');
const searchInput = document.getElementById('searchInput');
const suggestions = document.getElementById('suggestions');

const CATEGORY_LABELS = {
  all: '전체', music: '음악', game: '게임', news: '뉴스',
  sports: '스포츠', food: '음식', vlog: '브이로그', animal: '동물'
};

let renderToken = 0;
let me = null; // 로그인한 계정 { username, role } 또는 null

// ---------- 유틸 ----------

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value);
  }
  node.append(...children.filter((c) => c != null));
  return node;
}

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, body === undefined
    ? { method }
    : { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    // 로그인이 풀렸으면(승인 취소, 만료 등) 로그인 화면으로 돌아간다.
    if (data.code === 'LOGIN_REQUIRED' && me) {
      me = null;
      setTimeout(route, 0);
    }
    const err = new Error(data.error || `요청 실패 (${res.status})`);
    err.code = data.code;
    throw err;
  }
  return data;
}

function safeImg(url) {
  return /^https:\/\//.test(url || '') ? url : '';
}

function errorView(message, retry) {
  return el('div', { class: 'message' },
    el('div', { text: message }),
    retry ? el('button', { text: '다시 시도', onclick: retry }) : null);
}

function skeletonGrid(count = 12) {
  const grid = el('div', { class: 'grid skeleton' });
  for (let i = 0; i < count; i++) {
    grid.append(el('div', { class: 'card' },
      el('div', { class: 'thumb' }),
      el('div', { class: 'card-body' },
        el('div', { class: 'avatar' }),
        el('div', { class: 'card-text', style: 'flex:1' },
          el('div', { class: 'line', style: 'width:90%' }),
          el('div', { class: 'line', style: 'width:60%' })))));
  }
  return grid;
}

// 브라우저 방문 기록·탭에는 이 제목만 남는다. 영상 제목이나 검색어, 사이트 이름은 넣지 않는다.
const PAGE_TITLE = 'Google';

function setTitle() {
  document.title = PAGE_TITLE;
}

function setActiveNav(key) {
  document.querySelectorAll('.sidebar a').forEach((a) => a.classList.toggle('active', a.dataset.nav === key));
}

// ---------- 카드 ----------

function videoCard(v) {
  const card = cardTpl.content.firstElementChild.cloneNode(true);
  card.href = `#/watch/${v.id}`;
  card.querySelector('.thumb img').src = safeImg(v.thumbnail);
  card.querySelector('.duration').textContent = v.duration || '';
  card.querySelector('.card-title').textContent = v.title;
  card.querySelector('.card-title').title = v.title;

  const avatar = card.querySelector('.avatar');
  if (safeImg(v.channelAvatar)) avatar.src = v.channelAvatar;
  else avatar.hidden = true;

  const channel = card.querySelector('.card-channel');
  channel.textContent = v.channel || '';
  if (v.channelId) {
    const goChannel = (e) => {
      e.preventDefault();
      e.stopPropagation();
      location.hash = `#/channel/${v.channelId}`;
    };
    channel.addEventListener('click', goChannel);
    if (!avatar.hidden) avatar.addEventListener('click', goChannel);
  }
  card.querySelector('.card-meta').textContent = v.meta || '';

  if (!v.isShort) {
    const popup = el('span', { class: 'card-popup', role: 'button', title: '팝업으로 보기', 'aria-label': '팝업으로 보기' });
    popup.innerHTML = '<svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="2"/><rect x="12" y="11" width="7" height="6" rx="1"/></svg>';
    popup.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      recordWatch(v.id);
      openPopup(v.id, 0);
    });
    card.querySelector('.thumb').append(popup);
  }
  return card;
}

function videoGrid(items, className = 'grid') {
  const grid = el('div', { class: className });
  grid.append(...items.map(videoCard));
  return grid;
}

// ---------- 페이지 ----------

async function renderHome(category, token) {
  setTitle('');
  setActiveNav(category === 'all' ? 'home' : category);

  const chips = el('div', { class: 'chips' });
  for (const [key, label] of Object.entries(CATEGORY_LABELS)) {
    chips.append(el('a', {
      class: `chip${key === category ? ' active' : ''}`,
      href: key === 'all' ? '#/' : `#/c/${key}`,
      text: label
    }));
  }
  const body = el('div', {}, skeletonGrid());
  app.replaceChildren(chips, body);

  // 전체 탭에서는 최근 본 영상의 관련 영상(추천)과 인기 영상을 섞어서 보여 준다.
  // 방문할 때마다 seed 를 새로 뽑아서 사람마다, 들어올 때마다 다른 영상이 나오고,
  // 아래 끝에 닿으면 다음 페이지(다른 검색어, 더 예전에 본 영상의 추천)를 이어 붙인다.
  const history = category === 'all' ? loadHistory() : [];
  const seen = new Set(history.map((h) => h.id));
  const seed = 1 + Math.floor(Math.random() * 2 ** 30);
  const grid = el('div', { class: 'grid' });
  const status = el('div', { class: 'feed-status' });
  let page = 0;
  let loading = false;
  let done = false;
  let emptyPages = 0;

  const observer = new IntersectionObserver((entries) => {
    if (token !== renderToken) return observer.disconnect();
    if (entries.some((e) => e.isIntersecting)) loadPage();
  }, { rootMargin: '1200px 0px' });

  async function loadPage() {
    if (loading || done || token !== renderToken) return;
    loading = true;
    const p = page;
    status.replaceChildren(el('div', { class: 'feed-loading', text: '불러오는 중…' }));
    const recSeeds = history.slice(p * 2, p * 2 + 2).map((h) => h.id).join(',');
    const [homeRes, recRes] = await Promise.allSettled([
      api(`/api/home?category=${encodeURIComponent(category)}&page=${p}&seed=${seed}`),
      recSeeds ? api(`/api/recommend?ids=${recSeeds}`) : Promise.resolve([])
    ]);
    if (token !== renderToken) return;
    loading = false;

    if (homeRes.status === 'rejected' && !(recRes.value?.length)) {
      if (p === 0) {
        observer.disconnect();
        body.replaceChildren(errorView(homeRes.reason.message, () => route()));
      } else {
        status.replaceChildren(errorView(homeRes.reason.message, () => loadPage()));
      }
      return;
    }
    page++;
    const fresh = (list) => (list || []).filter((v) => !seen.has(v.id));
    const recs = fresh(recRes.value);
    const items = mixFeed(recs, shuffle(fresh(homeRes.value)));
    for (const v of items) seen.add(v.id);

    if (p === 0) {
      body.replaceChildren(recs.length ? el('p', { class: 'feed-note', text: '최근 본 영상을 바탕으로 골랐어요' }) : '', grid, status);
      observer.observe(status);
    }
    grid.append(...items.map(videoCard));
    status.replaceChildren();

    emptyPages = items.length ? 0 : emptyPages + 1;
    if (emptyPages >= 3 || page > MAX_HOME_PAGE) {
      done = true;
      observer.disconnect();
      status.replaceChildren(el('p', { class: 'feed-end', text: grid.children.length ? '더 볼 영상이 없어요' : '표시할 영상이 없어요.' }));
      return;
    }
    // 화면이 아직 안 찼으면(새 영상이 적었으면) 바로 다음 페이지
    const rect = status.getBoundingClientRect();
    if (rect.top < innerHeight + 1200) loadPage();
  }

  loadPage();
}

const MAX_HOME_PAGE = 60;

function shuffle(list) {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// 추천 2개, 인기 1개 순서로 섞는다. 같은 영상은 한 번만.
function mixFeed(recs, popular) {
  const out = [];
  const seen = new Set();
  const add = (v) => { if (v && !seen.has(v.id)) { seen.add(v.id); out.push(v); } };
  let r = 0;
  let p = 0;
  while (r < recs.length || p < popular.length) {
    add(recs[r++]);
    add(recs[r++]);
    add(popular[p++]);
  }
  return out;
}

async function renderSearch(q, token) {
  setTitle(q);
  setActiveNav('');
  searchInput.value = q;
  app.replaceChildren(skeletonGrid(8));
  try {
    const data = await api(`/api/search?q=${encodeURIComponent(q)}`);
    if (token !== renderToken) return;
    if (!data.items.length) {
      app.replaceChildren(errorView(`'${q}'에 대한 검색 결과가 없어요.`));
      return;
    }
    const list = videoGrid(data.items, 'list search-results');
    const status = el('div', { class: 'feed-status' });
    app.replaceChildren(list, status);
    const seen = new Set(data.items.map((v) => v.id));
    let next = data.next;
    if (next) {
      infiniteScroll(token, status, async () => {
        const page = await api(`/api/search?cont=${encodeURIComponent(next)}`);
        next = page.next;
        appendNew(list, page.items, seen);
        return !!next;
      });
    }
  } catch (err) {
    if (token !== renderToken) return;
    app.replaceChildren(errorView(err.message, () => route()));
  }
}

function appendNew(container, items, seen) {
  const fresh = items.filter((v) => !seen.has(v.id));
  for (const v of fresh) seen.add(v.id);
  container.append(...fresh.map(videoCard));
}

// 목록 아래 끝(status)이 가까워지면 loadMore() 로 다음 페이지를 붙인다. loadMore 는 더 있으면 true.
function infiniteScroll(token, status, loadMore) {
  let busy = false;
  let done = false;
  const observer = new IntersectionObserver((entries) => {
    if (token !== renderToken) return observer.disconnect();
    if (entries.some((e) => e.isIntersecting)) run();
  }, { rootMargin: '1200px 0px' });

  async function run() {
    if (busy || done || token !== renderToken) return;
    busy = true;
    status.replaceChildren(el('div', { class: 'feed-loading', text: '불러오는 중…' }));
    try {
      const more = await loadMore();
      if (token !== renderToken) return;
      status.replaceChildren();
      if (!more) {
        done = true;
        observer.disconnect();
        return;
      }
    } catch (err) {
      if (token !== renderToken) return;
      status.replaceChildren(errorView(err.message, () => { busy = false; run(); }));
      return;
    }
    busy = false;
    // 새로 붙은 게 적어서 아직 끝이 보이면 바로 다음 페이지
    if (status.getBoundingClientRect().top < innerHeight + 1200) run();
  }

  observer.observe(status);
}

function linkify(text) {
  const frag = document.createDocumentFragment();
  const re = /https?:\/\/[^\s<>"']+/g;
  let last = 0;
  for (const m of text.matchAll(re)) {
    frag.append(text.slice(last, m.index));
    frag.append(el('a', { href: m[0], target: '_blank', rel: 'noopener noreferrer', text: m[0] }));
    last = m.index + m[0].length;
  }
  frag.append(text.slice(last));
  return frag;
}

async function renderWatch(id, token) {
  setActiveNav('');
  const player = el('div', { class: 'player' },
    el('iframe', {
      src: embedUrl(id),
      title: '동영상 플레이어',
      onload: (e) => listenToPlayer(e.target),
      allow: 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share',
      allowfullscreen: '',
      referrerpolicy: 'strict-origin-when-cross-origin',
      'data-player': ''
    }));
  const info = el('div', {}, el('div', { class: 'skeleton' },
    el('div', { class: 'line', style: 'width:70%;height:22px;margin-top:14px' }),
    el('div', { class: 'line', style: 'width:30%' })));
  const related = el('div', { class: 'list' }, ...Array.from({ length: 8 }, () =>
    el('div', { class: 'card skeleton' }, el('div', { class: 'thumb' }),
      el('div', { class: 'card-text', style: 'flex:1' }, el('div', { class: 'line' }), el('div', { class: 'line', style: 'width:60%' })))));

  app.replaceChildren(el('div', { class: 'watch' },
    el('div', {}, player, info),
    el('aside', {}, related)));
  window.scrollTo({ top: 0 });

  try {
    const v = await api(`/api/video?id=${encodeURIComponent(id)}`);
    if (token !== renderToken) return;
    setTitle(v.title);
    recordWatch(id);

    const owner = el('a', { class: 'owner', href: v.channelId ? `#/channel/${v.channelId}` : '#' },
      safeImg(v.channelAvatar) ? el('img', { src: v.channelAvatar, alt: '' }) : null,
      el('div', {},
        el('div', { class: 'owner-name', text: v.channel }),
        el('div', { class: 'owner-subs', text: v.subscribers || '' })));

    const desc = el('div', { class: 'description' },
      el('div', { class: 'description-meta', text: [v.views, v.published].filter(Boolean).join('  ') }),
      linkify(v.description || ''));
    desc.addEventListener('click', (e) => {
      if (e.target.tagName !== 'A') desc.classList.add('open');
    });

    const popupBtn = el('button', { class: 'popup-btn', type: 'button', onclick: () => openPopup(id) },
      el('span', { text: '팝업으로 보기' }));
    const autoplayBox = el('input', { type: 'checkbox', role: 'switch' });
    autoplayBox.checked = loadAutoplay();
    autoplayBox.addEventListener('change', () => saveAutoplay(autoplayBox.checked));
    const autoplay = el('label', { class: 'autoplay-toggle', title: '영상이 끝나면 다음 영상을 자동으로 재생' },
      autoplayBox, el('span', { text: '자동재생' }));
    info.replaceChildren(el('h1', { class: 'watch-title', text: v.title }),
      el('div', { class: 'watch-actions' }, owner, el('div', { class: 'watch-buttons' }, autoplay, popupBtn)), desc);

    // 영상이 끝나면 관련 영상 중 안 본 영상으로 넘어간다 (자동재생이 켜져 있고 화면을 가리지 않았을 때)
    onPlayerEnded = () => {
      if (!loadAutoplay() || !cover.hidden) return;
      const next = pickNext(v.related, id);
      if (next) location.hash = `#/watch/${next.id}`;
    };
    related.replaceChildren(...v.related.map(videoCard));
  } catch (err) {
    if (token !== renderToken) return;
    info.replaceChildren(el('div', { class: 'message', style: 'padding:24px', text: err.message }));
    related.replaceChildren();
  }
}

async function renderChannel(id, token) {
  setActiveNav('');
  app.replaceChildren(skeletonGrid(8));
  try {
    const c = await api(`/api/channel?id=${encodeURIComponent(id)}`);
    if (token !== renderToken) return;
    setTitle(c.name);
    const banner = safeImg(c.banner) ? el('div', { class: 'channel-banner' }) : null;
    if (banner) banner.style.backgroundImage = `url("${c.banner.replace(/"/g, '%22')}")`;
    const grid = videoGrid(c.videos);
    const status = el('div', { class: 'feed-status' });
    app.replaceChildren(
      banner ?? '',
      el('div', { class: 'channel-head' },
        safeImg(c.avatar) ? el('img', { src: c.avatar, alt: '' }) : null,
        el('div', {}, el('h1', { text: c.name }), el('p', { text: c.description }))),
      el('h2', { class: 'section-title', text: '동영상' }),
      c.videos.length ? grid : errorView('영상이 없어요.'),
      status);
    const seen = new Set(c.videos.map((v) => v.id));
    let next = c.next;
    if (next && c.videos.length) {
      infiniteScroll(token, status, async () => {
        const page = await api(`/api/channel?cont=${encodeURIComponent(next)}`);
        next = page.next;
        const videos = page.videos.map((v) => ({
          ...v, channel: v.channel || c.name, channelId: v.channelId || c.id, channelAvatar: v.channelAvatar || c.avatar
        }));
        appendNew(grid, videos, seen);
        return !!next;
      });
    }
  } catch (err) {
    if (token !== renderToken) return;
    app.replaceChildren(errorView(err.message, () => route()));
  }
}

// ---------- 쇼츠: 세로로 한 개씩 넘겨 보기 ----------

// 본 쇼츠 ID (최근 500개). 다음에 쇼츠를 열 때 이미 본 건 건너뛴다.
const SHORTS_SEEN_KEY = 'shortsSeen';

function loadShortsSeen() {
  try {
    const list = JSON.parse(localStorage.getItem(SHORTS_SEEN_KEY) || '[]');
    return Array.isArray(list) ? list.filter((id) => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

function rememberShort(id) {
  const list = [id, ...loadShortsSeen().filter((x) => x !== id)].slice(0, 500);
  try { localStorage.setItem(SHORTS_SEEN_KEY, JSON.stringify(list)); } catch {}
}
// 화면에 보이는 쇼츠 하나에만 플레이어를 넣고, 나머지는 썸네일로 둔다 (가볍게).

// preload: 다음 쇼츠를 미리 불러 두기만 하고(재생 X), 넘겨서 보이게 되면 바로 재생한다.
function shortPlayer(id, preload = false) {
  const iframe = el('iframe', {
    src: embedUrl(id, `&loop=1&playlist=${id}`, !preload),
    title: '쇼츠 플레이어',
    allow: 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share',
    allowfullscreen: '',
    referrerpolicy: 'strict-origin-when-cross-origin'
  });
  if (!preload) iframe.setAttribute('data-player', '');
  iframe.addEventListener('load', () => {
    iframe.dataset.loaded = '1';
    if (iframe.hasAttribute('data-player')) startShort(iframe);
  });
  return iframe;
}

function startShort(iframe) {
  listenToPlayer(iframe);
  sendToPlayer(iframe, 'playVideo');
}

function shortSlide(v) {
  const frame = el('div', { class: 'short-frame' },
    el('img', { src: safeImg(v.thumbnail), alt: '', loading: 'lazy' }),
    el('div', { class: 'short-info' },
      el('div', { class: 'short-title', text: v.title }),
      v.meta ? el('div', { class: 'short-meta', text: v.meta }) : null));
  const slide = el('section', { class: 'short' }, frame);
  slide.dataset.id = v.id;
  return slide;
}

async function renderShorts(token) {
  setTitle();
  setActiveNav('shorts');
  const feed = el('div', { class: 'shorts', tabindex: '-1' });
  app.replaceChildren(feed);
  document.body.classList.add('shorts-mode');

  // 방문마다 다른 순서(seed)로 검색하고, 전에 본 쇼츠는 빼서 같은 쇼츠가 반복되지 않게 한다.
  const seed = 1 + Math.floor(Math.random() * 2 ** 30);
  const watchedShorts = loadShortsSeen();
  const seen = new Set(watchedShorts);
  let page = 0;
  let loading = false;
  let active = null;

  function activate(slide) {
    if (active === slide) return;
    const slides = [...feed.querySelectorAll('.short')];
    const next = slides[slides.indexOf(slide) + 1];
    // 지금 쇼츠와 바로 다음 쇼츠에만 플레이어를 둔다 (나머지는 치워서 가볍게)
    for (const s of slides) if (s !== slide && s !== next) s.querySelector('iframe')?.remove();
    const previous = active?.querySelector('iframe');
    if (previous) {
      previous.removeAttribute('data-player');
      sendToPlayer(previous, 'pauseVideo');
    }
    active = slide;
    rememberShort(slide.dataset.id);
    playerState = -1;
    const ready = slide.querySelector('iframe');
    if (ready) {
      // 미리 불러 둔 플레이어 → 기다리지 않고 바로 재생
      ready.setAttribute('data-player', '');
      if (ready.dataset.loaded) startShort(ready);
    } else {
      slide.querySelector('.short-frame').append(shortPlayer(slide.dataset.id));
    }
    if (next && !next.querySelector('iframe')) next.querySelector('.short-frame').append(shortPlayer(next.dataset.id, true));
    // 끝에서 여덟 번째쯤 오면 다음 쇼츠 목록을 미리 불러온다
    if (slides.indexOf(slide) >= slides.length - 8) loadMore();
  }

  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) if (entry.isIntersecting) activate(entry.target);
  }, { root: feed, threshold: 0.6 });

  async function loadMore(tries = 0) {
    if (loading) return;
    loading = true;
    try {
      const items = await api(`/api/shorts?page=${page++}&seed=${seed}`);
      if (token !== renderToken) return;
      let added = 0;
      for (const v of shuffle(items)) {
        if (seen.has(v.id)) continue;
        seen.add(v.id);
        const slide = shortSlide(v);
        feed.append(slide);
        observer.observe(slide);
        added++;
      }
      // 새 쇼츠가 거의 없었으면(다 본 것) 다음 검색어로 바로 더 찾는다
      if (added < 5 && tries < 4) {
        loading = false;
        return await loadMore(tries + 1);
      }
      feed.querySelector('.shorts-loading')?.remove();
      if (!feed.querySelector('.short')) feed.replaceChildren(errorView('쇼츠를 찾지 못했어요.', () => route()));
    } catch (err) {
      if (token !== renderToken) return;
      if (!feed.querySelector('.short')) feed.replaceChildren(errorView(err.message, () => route()));
    } finally {
      loading = false;
    }
  }

  // 컴퓨터에서는 ↑ ↓ 키로도 넘긴다
  function onKey(e) {
    if (token !== renderToken) return window.removeEventListener('keydown', onKey);
    if (isTypingTarget(e.target) || (e.key !== 'ArrowDown' && e.key !== 'ArrowUp')) return;
    e.preventDefault();
    feed.scrollBy({ top: (e.key === 'ArrowDown' ? 1 : -1) * feed.clientHeight, behavior: 'smooth' });
  }
  window.addEventListener('keydown', onKey);

  feed.append(el('div', { class: 'message shorts-loading', text: '쇼츠 불러오는 중…' }));
  loadMore();
}

// ---------- 라우터 ----------

function route() {
  const token = ++renderToken;
  const hash = location.hash.replace(/^#/, '') || '/';
  const [path, query = ''] = hash.split('?');
  const parts = path.split('/').filter(Boolean);
  onPlayerEnded = null;
  closeMobileSearch();
  updateAccountUI();
  document.body.classList.remove('shorts-mode');

  if (parts[0] === 'admin') return renderAdmin(token);
  document.body.classList.toggle('auth-mode', !me);
  if (!me) return renderAuth(token);

  if (parts[0] === 'shorts') return renderShorts(token);
  if (parts[0] === 'watch' && /^[\w-]{11}$/.test(parts[1] || '')) return renderWatch(parts[1], token);
  if (parts[0] === 'channel' && parts[1]) return renderChannel(parts[1], token);
  if (parts[0] === 'search') {
    const q = new URLSearchParams(query).get('q') || '';
    if (q.trim()) return renderSearch(q.trim(), token);
  }
  searchInput.value = '';
  const category = parts[0] === 'c' && CATEGORY_LABELS[parts[1]] ? parts[1] : 'all';
  return renderHome(category, token);
}

window.addEventListener('hashchange', route);

// ---------- 로그인 / 가입 ----------

const ICONS = {
  user: '<svg viewBox="0 0 24 24"><circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 4-6 8-6s8 2 8 6"/></svg>',
  id: '<svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="3"/><circle cx="9" cy="12" r="2.2"/><path d="M14 10h4M14 14h3"/></svg>',
  lock: '<svg viewBox="0 0 24 24"><rect x="5" y="11" width="14" height="10" rx="2.5"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>',
  eye: '<svg viewBox="0 0 24 24"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>',
  eyeOff: '<svg viewBox="0 0 24 24"><path d="M3 3l18 18M10.6 5.1A10.4 10.4 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-3.1 4M6.6 6.6C3.8 8.4 2 12 2 12s3.5 7 10 7c1.6 0 3-.4 4.3-1"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/></svg>',
  check: '<svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>'
};

function icon(name, cls = 'auth-icon') {
  const span = el('span', { class: cls, 'aria-hidden': 'true' });
  span.innerHTML = ICONS[name];
  return span;
}

// 로그인·가입·관리자 로그인 공통 카드: 로고, 제목, 한 줄 설명
function authCard(title, subtitle, ...children) {
  return el('div', { class: 'auth' },
    el('div', { class: 'auth-card' },
      el('div', { class: 'auth-head' },
        el('span', { class: 'auth-logo', 'aria-hidden': 'true' }),
        el('h1', { class: 'auth-title', text: title }),
        subtitle ? el('p', { class: 'auth-subtitle', text: subtitle }) : null),
      ...children));
}

// 입력칸: 왼쪽 아이콘 + 입력 + (비밀번호면 보기 버튼) + 아래 안내 문구
function field(label, input, iconName, { hint = '', check } = {}) {
  const hintEl = el('span', { class: 'field-hint', text: hint });
  const box = el('div', { class: 'field-box' }, icon(iconName), input);
  if (input.type === 'password') {
    const toggle = el('button', { type: 'button', class: 'field-eye', 'aria-label': '비밀번호 보기' });
    toggle.innerHTML = ICONS.eye;
    toggle.addEventListener('click', () => {
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      toggle.innerHTML = show ? ICONS.eyeOff : ICONS.eye;
      toggle.setAttribute('aria-label', show ? '비밀번호 숨기기' : '비밀번호 보기');
      input.focus();
    });
    box.append(toggle);
  }
  const wrap = el('label', { class: 'field' }, el('span', { class: 'field-label', text: label }), box, hintEl);
  if (check) {
    // 입력하는 동안 형식이 맞는지 바로 보여 준다
    const update = () => {
      const value = input.value.trim();
      const ok = check(value);
      wrap.classList.toggle('valid', !!value && ok);
      wrap.classList.toggle('invalid', !!value && !ok && document.activeElement !== input);
    };
    input.addEventListener('input', update);
    input.addEventListener('blur', update);
  }
  return wrap;
}

const RULES = {
  name: (v) => /^[\p{L}\p{M}][\p{L}\p{M} .'-]{0,19}$/u.test(v),
  username: (v) => /^[a-zA-Z0-9_가-힣]{2,20}$/.test(v),
  password: (v) => v.length >= 6 && v.length <= 100
};

function renderAuth(token, mode = 'login', notice = '', prefill = '') {
  setTitle();
  setActiveNav('');
  const signup = mode === 'signup';
  const realName = el('input', { name: 'name', autocomplete: 'name', required: '', maxlength: '20', placeholder: '홍길동' });
  // 가입할 때는 브라우저가 저장된 이메일을 아이디 칸에 추천하지 않게 자동 완성을 끈다.
  const username = el('input', {
    name: 'username', required: '', maxlength: '20', autocapitalize: 'off', spellcheck: 'false',
    autocomplete: signup ? 'off' : 'username', placeholder: signup ? '사용할 아이디' : '아이디'
  });
  username.value = prefill;
  const password = el('input', {
    name: 'password', type: 'password', required: '', minlength: '6', maxlength: '100',
    autocomplete: signup ? 'new-password' : 'current-password', placeholder: signup ? '6자 이상' : '비밀번호'
  });
  const message = el('p', { class: `auth-message${notice ? ' ok' : ''}`, text: notice, role: 'alert' });
  const submit = el('button', { class: 'auth-submit', type: 'submit' }, el('span', { text: signup ? '가입 신청하기' : '로그인' }));
  const tab = (key, label) => el('button', {
    type: 'button', class: `auth-tab${mode === key ? ' active' : ''}`, text: label, 'aria-pressed': String(mode === key),
    onclick: () => { if (mode !== key) renderAuth(token, key, '', username.value.trim()); }
  });

  const form = el('form', { class: 'auth-form', novalidate: '' },
    signup ? field('이름', realName, 'user', { hint: '본인 실명 (관리자가 누군지 알 수 있게)', check: RULES.name }) : null,
    field('아이디', username, 'id', signup ? { hint: '한글·영문·숫자·_ 2~20자', check: RULES.username } : {}),
    field('비밀번호', password, 'lock', signup ? { hint: '6자 이상', check: RULES.password } : {}),
    message,
    submit,
    el('p', { class: 'auth-foot', text: signup ? '이메일은 필요 없어요 · 관리자가 승인하면 바로 쓸 수 있어요' : '처음이라면 위에서 가입하기를 눌러 주세요' }));

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    message.className = 'auth-message';
    message.textContent = '';
    const body = { username: username.value.trim(), password: password.value };
    if (signup) body.name = realName.value.trim();
    // 형식이 틀린 칸이 있으면 서버에 보내기 전에 알려 준다
    if (signup) {
      const wrong = [[realName, RULES.name, '이름을 확인해 주세요.'], [username, RULES.username, '아이디는 한글·영문·숫자·_ 2~20자예요.'], [password, RULES.password, '비밀번호는 6자 이상이에요.']]
        .find(([input, rule]) => !rule(input === password ? input.value : input.value.trim()));
      if (wrong) {
        message.textContent = wrong[2];
        wrong[0].closest('.field').classList.add('invalid');
        wrong[0].focus();
        return;
      }
    } else if (!body.username || !body.password) {
      message.textContent = '아이디와 비밀번호를 입력해 주세요.';
      (body.username ? password : username).focus();
      return;
    }
    submit.disabled = true;
    submit.classList.add('loading');
    try {
      if (signup) {
        await api('/api/auth/signup', { method: 'POST', body });
        if (token !== renderToken) return;
        renderSignupDone(token, body.name, body.username);
        return;
      }
      me = await api('/api/auth/login', { method: 'POST', body });
      route();
    } catch (err) {
      message.textContent = err.message;
      message.className = err.code === 'PENDING' ? 'auth-message wait' : 'auth-message';
      submit.disabled = false;
      submit.classList.remove('loading');
    }
  });

  app.replaceChildren(authCard('School YouTube', signup ? '가입 신청을 하면 관리자가 확인해요' : '다시 오신 걸 환영해요',
    el('div', { class: `auth-tabs${signup ? ' signup' : ''}` }, tab('login', '로그인'), tab('signup', '가입하기')),
    form));
  (signup ? realName : (prefill ? password : username)).focus();
}

// 가입 신청을 마친 뒤 보여 주는 화면
function renderSignupDone(token, name, username) {
  const badge = icon('check', 'auth-done-badge');
  app.replaceChildren(authCard('가입 신청 완료!', '',
    el('div', { class: 'auth-done' },
      badge,
      el('p', { class: 'auth-done-text', text: `${name}님, 신청이 들어갔어요.` }),
      el('p', { class: 'auth-done-sub', text: '관리자가 승인하면 아이디와 비밀번호로 로그인할 수 있어요.' }),
      el('div', { class: 'auth-done-id' }, el('span', { text: '아이디' }), el('strong', { text: username })),
      el('button', { class: 'auth-submit', type: 'button', onclick: () => renderAuth(token, 'login', '', username) },
        el('span', { text: '로그인 화면으로' })))));
}

// ---------- 관리자: 가입 승인 ----------

const STATUS_LABELS = { pending: '승인 대기', approved: '승인됨', rejected: '거절됨' };

async function renderAdmin(token) {
  setTitle('가입 승인 관리');
  setActiveNav('');
  document.body.classList.toggle('auth-mode', !me);

  if (me?.role !== 'admin') {
    const password = el('input', { type: 'password', autocomplete: 'current-password', required: '', placeholder: '관리자 비밀번호' });
    const message = el('p', { class: 'auth-message', role: 'alert' });
    const submit = el('button', { class: 'auth-submit', type: 'submit' }, el('span', { text: '관리자 로그인' }));
    const form = el('form', { class: 'auth-form' }, field('비밀번호', password, 'lock'), message, submit);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      submit.disabled = true;
      try {
        me = await api('/api/admin/login', { method: 'POST', body: { password: password.value } });
        route();
      } catch (err) {
        message.textContent = err.message;
        submit.disabled = false;
      }
    });
    app.replaceChildren(authCard('관리자', '가입 신청을 승인하려면 로그인하세요', form));
    password.focus();
    return;
  }

  const body = el('div', { class: 'admin-body' }, el('p', { class: 'message', text: '불러오는 중…' }));
  app.replaceChildren(el('div', { class: 'admin' },
    el('div', { class: 'admin-head' },
      el('h1', { text: '가입 승인 관리' }),
      el('button', { class: 'admin-refresh', text: '새로고침', onclick: () => route() })),
    body));

  let users;
  try {
    users = await api('/api/admin/users');
  } catch (err) {
    if (token !== renderToken) return;
    if (err.code === 'ADMIN_REQUIRED') { me = null; return route(); }
    body.replaceChildren(errorView(err.message, () => route()));
    return;
  }
  if (token !== renderToken) return;

  // 저장소 목록은 바로 반영되지 않을 수 있어서, 버튼을 누르면 화면에서 직접 바꾼다.
  async function act(user, action, row) {
    row.querySelectorAll('button').forEach((b) => (b.disabled = true));
    try {
      await api('/api/admin/users', { method: 'POST', body: { username: user.username, action } });
      if (action === 'delete') users = users.filter((u) => u !== user);
      else user.status = { approve: 'approved', reject: 'rejected' }[action];
      draw();
    } catch (err) {
      alert(err.message);
      row.querySelectorAll('button').forEach((b) => (b.disabled = false));
    }
  }

  function userRow(user) {
    const row = el('li', { class: 'admin-row' });
    const date = user.createdAt ? new Date(user.createdAt).toLocaleString('ko-KR', { dateStyle: 'short', timeStyle: 'short' }) : '';
    const btn = (text, action, cls = '') => el('button', { class: cls, text, onclick: () => act(user, action, row) });
    const actions = {
      pending: [btn('승인', 'approve', 'approve'), btn('거절', 'reject')],
      approved: [btn('승인 취소', 'reject'), btn('삭제', 'delete', 'danger')],
      rejected: [btn('승인', 'approve', 'approve'), btn('삭제', 'delete', 'danger')]
    }[user.status] || [];
    row.append(
      el('div', { class: 'admin-user' },
        el('strong', { text: user.name || '(이름 없음)' }),
        el('span', { text: [`아이디 ${user.username}`, date].filter(Boolean).join(' · ') })),
      el('div', { class: 'admin-actions' }, ...actions));
    return row;
  }

  function draw() {
    const sections = ['pending', 'approved', 'rejected'].map((status) => {
      const list = users.filter((u) => u.status === status);
      return el('section', { class: 'admin-section' },
        el('h2', { text: `${STATUS_LABELS[status]} ${list.length}` }),
        list.length
          ? el('ul', { class: 'admin-list' }, ...list.map(userRow))
          : el('p', { class: 'admin-empty', text: status === 'pending' ? '기다리는 사람이 없어요.' : '없음' }));
    });
    body.replaceChildren(...sections);
  }
  draw();
}

// ---------- 계정 (설정 창) ----------

const accountSection = document.getElementById('accountSection');

function updateAccountUI() {
  accountSection.hidden = !me || me.role === 'guest';
  if (!me) return;
  document.getElementById('accountName').textContent = me.name ? `${me.name} (${me.username})` : me.username;
  document.getElementById('adminLink').hidden = me.role !== 'admin';
}

document.getElementById('logoutBtn').addEventListener('click', async () => {
  try { await api('/api/auth/logout', { method: 'POST', body: {} }); } catch {}
  me = null;
  settingsDialog.close();
  location.hash = '#/';
  route();
});

document.getElementById('adminLink').addEventListener('click', () => settingsDialog.close());

async function loadMe() {
  try {
    me = await api('/api/auth/me');
  } catch (err) {
    // 로그인 기능을 아직 설정하지 않은 사이트는 로그인 없이 그대로 쓴다.
    me = err.code === 'NO_DB' ? { username: '', role: 'guest' } : null;
  }
}

// ---------- 검색 + 자동완성 ----------

let suggestTimer;
let activeSuggestion = -1;

function hideSuggestions() {
  suggestions.hidden = true;
  activeSuggestion = -1;
}

// 휴대폰: 돋보기를 누르면 상단 바가 검색창으로 바뀐다.
function openMobileSearch() {
  document.body.classList.add('search-open');
  searchInput.focus();
}

function closeMobileSearch() {
  document.body.classList.remove('search-open');
  hideSuggestions();
}

document.getElementById('searchOpenBtn').addEventListener('click', openMobileSearch);
document.getElementById('searchBack').addEventListener('click', closeMobileSearch);

function doSearch(q) {
  q = q.trim();
  if (!q) return;
  hideSuggestions();
  searchInput.blur();
  const target = `#/search?q=${encodeURIComponent(q)}`;
  if (location.hash === target) route();
  else location.hash = target;
}

searchForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const active = suggestions.querySelector('li.active');
  doSearch(active && !suggestions.hidden ? active.textContent : searchInput.value);
});

searchInput.addEventListener('input', () => {
  clearTimeout(suggestTimer);
  const q = searchInput.value.trim();
  if (!q) return hideSuggestions();
  suggestTimer = setTimeout(async () => {
    try {
      const list = await api(`/api/suggest?q=${encodeURIComponent(q)}`);
      if (searchInput.value.trim() !== q || !list.length) return hideSuggestions();
      suggestions.replaceChildren(...list.map((s) => el('li', {
        text: s,
        onmousedown: (e) => { e.preventDefault(); doSearch(s); }
      })));
      activeSuggestion = -1;
      suggestions.hidden = false;
    } catch {
      hideSuggestions();
    }
  }, 200);
});

searchInput.addEventListener('keydown', (e) => {
  if (suggestions.hidden || e.key === 'Escape') return;
  const items = [...suggestions.children];
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    // -1(선택 없음) → 0 → … → 마지막 → -1 순으로 순환
    const n = items.length + 1;
    activeSuggestion = ((activeSuggestion + 1 + (e.key === 'ArrowDown' ? 1 : -1) + n) % n) - 1;
    items.forEach((li, i) => li.classList.toggle('active', i === activeSuggestion));
  }
});

searchInput.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeMobileSearch();
});

searchInput.addEventListener('blur', () => setTimeout(hideSuggestions, 100));

// ---------- 메뉴 / 테마 ----------

document.getElementById('menuBtn').addEventListener('click', () => {
  document.body.classList.toggle('sidebar-collapsed');
});

function applyTheme(theme) {
  if (theme) document.documentElement.dataset.theme = theme;
  else delete document.documentElement.dataset.theme;
}

try { applyTheme(localStorage.getItem('theme')); } catch {}

document.getElementById('themeBtn').addEventListener('click', () => {
  const current = document.documentElement.dataset.theme ||
    (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  const next = current === 'dark' ? 'light' : 'dark';
  applyTheme(next);
  try { localStorage.setItem('theme', next); } catch {}
});

// ---------- 플레이어 제어 (가리기 할 때 멈추고, 돌아오면 다시 재생) ----------
// YouTube 임베드 플레이어와 postMessage 로 주고받는다. playerState 1 = 재생 중

let playerState = -1;
let playerTime = 0;
let onPlayerEnded = null; // 지금 화면에서 영상이 끝났을 때 할 일 (시청 화면의 다음 영상 자동재생)

function listenToPlayer(iframe) {
  playerState = -1;
  playerTime = 0;
  listenTo(iframe);
  // 자동재생이 막혔으면 음소거로 시작한다. 화면을 가린 중에는 건드리지 않는다.
  autostart(iframe, () => (cover.hidden ? playerState : PAUSED), iframe.parentElement);
}

function playerCommand(func) {
  sendToPlayer(document.querySelector('iframe[data-player]'), func);
}

window.addEventListener('message', (e) => {
  const msg = readPlayerMessage(e);
  if (!msg) return;
  if (msg.state !== undefined) {
    const ended = msg.state === ENDED && playerState !== ENDED;
    playerState = msg.state;
    if (ended) onPlayerEnded?.();
  }
  if (msg.time !== undefined) playerTime = msg.time;
});

// ---------- 팝업으로 보기 (롱폼) ----------
// 지금 보던 위치부터 작은 창에서 이어 보고, 원래 화면의 영상은 멈춘다. 팝업에서는 정한 키(기본 Q)로 바로 닫힌다.

let popupWin = null;

function openPopup(id, start = Math.floor(playerTime || 0)) {
  // 지난번 팝업 크기와 위치를 그대로 쓰고, 처음이면 오른쪽 아래에 적당한 크기로 연다.
  const saved = loadPopupBounds();
  const width = Math.min(saved?.width ?? 854, screen.availWidth - 20);
  const height = Math.min(saved?.height ?? Math.round(width * 9 / 16), screen.availHeight - 20);
  const left = saved?.left ?? screen.availWidth - width - 20;
  const top = saved?.top ?? screen.availHeight - height - 60;
  const win = window.open(`/popup.html?v=${encodeURIComponent(id)}&t=${start}`, 'sy_popup',
    `popup,width=${width},height=${height},left=${left},top=${top}`);
  if (!win) {
    alert('팝업이 차단됐어요. 주소창 오른쪽의 팝업 차단 아이콘을 눌러 이 사이트의 팝업을 허용해 주세요.');
    return;
  }
  popupWin = win;
  playerCommand('pauseVideo');
}

function closePopup() {
  if (popupWin && !popupWin.closed) popupWin.close();
  popupWin = null;
}

// ---------- 가리기 (단축키: 한 번 누르면 빈 화면, 다시 누르면 원래 화면) ----------

const cover = el('div', { class: 'cover', hidden: '' });
document.body.append(cover);
let resumeAfterCover = false;

// 가린 화면: 검색 시작 페이지처럼 보이게 하고, 검색하면 실제 Google 검색으로 간다.
// 가릴 때만 그리고 돌아오면 지운다 (평소 페이지에는 이 모양이 없도록).
function showDecoy() {
  const input = el('input', { type: 'text', name: 'q', autocomplete: 'off', spellcheck: 'false', 'aria-label': '검색' });
  const form = el('form', { class: 'decoy-search', role: 'search' },
    el('span', { class: 'decoy-icon', 'aria-hidden': 'true' }),
    input);
  const submit = () => {
    const q = input.value.trim();
    if (q) location.href = `https://www.google.com/search?q=${encodeURIComponent(q)}`;
  };
  form.addEventListener('submit', (e) => { e.preventDefault(); submit(); });
  cover.replaceChildren(el('div', { class: 'decoy' },
    el('div', { class: 'decoy-logo', 'aria-label': 'Google' },
      ...[...'Google'].map((ch, i) => el('span', { class: `decoy-c${i}`, text: ch }))),
    form,
    el('div', { class: 'decoy-buttons' },
      el('button', { type: 'button', text: 'Google 검색', onclick: submit }),
      el('button', { type: 'button', text: "I'm Feeling Lucky", onclick: submit }))));
}

function toggleCover() {
  if (cover.hidden) {
    resumeAfterCover = playerState === 1;
    playerCommand('pauseVideo');
    closePopup();
    document.querySelectorAll('dialog[open]').forEach((d) => d.close());
    closeMobileSearch();
    showDecoy();
    cover.hidden = false;
    focusSink.focus({ preventScroll: true });
  } else {
    cover.hidden = true;
    cover.replaceChildren();
    if (resumeAfterCover) playerCommand('playVideo');
    resumeAfterCover = false;
  }
}

// ---------- 빠른 나가기 (버튼: Google 로 완전히 나가기) ----------
// 웹페이지는 자기 탭을 닫을 수 없어서, 화면을 바로 지우고 영상을 멈춘 뒤 다른 사이트로 이동한다.
// location.replace 라서 이 페이지가 방문 기록에 남지 않는다.

const EXIT_URL = 'https://www.google.com';

function quickExit() {
  document.documentElement.style.visibility = 'hidden';
  document.title = 'Google';
  document.querySelectorAll('iframe').forEach((f) => f.remove());
  location.replace(EXIT_URL);
}

document.getElementById('exitBtn').addEventListener('click', quickExit);

// ---------- 단축키 (가리기 / 팝업 닫기). 설정에서 바꿀 수 있고 이 브라우저에 저장된다 ----------

let coverShortcut = loadShortcut(COVER_SHORTCUT_KEY, DEFAULT_COVER_SHORTCUT);
let popupShortcut = loadShortcut(POPUP_SHORTCUT_KEY, DEFAULT_POPUP_SHORTCUT);
let recordingFor = null; // 키를 기다리는 중인 설정 줄

window.addEventListener('keydown', (e) => {
  if (recordingFor) return;
  if (!matchesShortcut(e, coverShortcut)) return;
  if (isTypingKey(coverShortcut) && isTypingTarget(e.target)) return;
  e.preventDefault();
  toggleCover();
}, true);

// ---------- 설정 창: 단축키 바꾸기 ----------

const settingsDialog = document.getElementById('settingsDialog');

const shortcutRows = {
  cover: {
    label: document.getElementById('shortcutLabel'),
    change: document.getElementById('shortcutChange'),
    get: () => coverShortcut,
    set: (sc) => { coverShortcut = sc; storeShortcut(COVER_SHORTCUT_KEY, sc); },
    fallback: DEFAULT_COVER_SHORTCUT,
    reset: 'shortcutReset',
    off: 'shortcutOff'
  },
  popup: {
    label: document.getElementById('popupShortcutLabel'),
    change: document.getElementById('popupShortcutChange'),
    get: () => popupShortcut,
    set: (sc) => { popupShortcut = sc; storeShortcut(POPUP_SHORTCUT_KEY, sc); },
    fallback: DEFAULT_POPUP_SHORTCUT,
    reset: 'popupShortcutReset',
    off: 'popupShortcutOff'
  }
};

function updateShortcutLabels() {
  for (const row of Object.values(shortcutRows)) row.label.textContent = shortcutLabel(row.get());
}

function stopRecording() {
  if (!recordingFor) return;
  const row = shortcutRows[recordingFor];
  row.change.textContent = '바꾸기';
  row.change.classList.remove('recording');
  recordingFor = null;
  window.removeEventListener('keydown', recordKey, true);
}

function recordKey(e) {
  if (MODIFIER_CODES.test(e.code) || !e.code) return; // Ctrl 같은 키만 누른 상태면 다음 키를 기다린다
  e.preventDefault();
  e.stopPropagation();
  shortcutRows[recordingFor].set(shortcutFromEvent(e));
  stopRecording();
  updateShortcutLabels();
}

for (const [name, row] of Object.entries(shortcutRows)) {
  row.change.addEventListener('click', () => {
    const wasThis = recordingFor === name;
    stopRecording();
    if (wasThis) return;
    recordingFor = name;
    row.change.textContent = '원하는 키를 누르세요…';
    row.change.classList.add('recording');
    window.addEventListener('keydown', recordKey, true);
  });
  document.getElementById(row.reset).addEventListener('click', () => { stopRecording(); row.set(row.fallback); updateShortcutLabels(); });
  document.getElementById(row.off).addEventListener('click', () => { stopRecording(); row.set(null); updateShortcutLabels(); });
}

document.getElementById('settingsClose').addEventListener('click', () => settingsDialog.close());
function updateHistoryInfo() {
  document.getElementById('historyCount').textContent = `${loadHistory().length}개`;
}

document.getElementById('clearHistoryBtn').addEventListener('click', () => {
  clearHistory();
  try { localStorage.removeItem(SHORTS_SEEN_KEY); } catch {}
  updateHistoryInfo();
});

document.getElementById('settingsBtn').addEventListener('click', () => {
  updateShortcutLabels();
  updateHistoryInfo();
  settingsDialog.showModal();
});

// 키를 기다리는 중에 Esc 를 누르면 창이 닫히는 대신 Esc 가 단축키로 저장되게 한다.
settingsDialog.addEventListener('cancel', (e) => { if (recordingFor) e.preventDefault(); });
settingsDialog.addEventListener('close', stopRecording);
settingsDialog.addEventListener('click', (e) => { if (e.target === settingsDialog) settingsDialog.close(); });

updateShortcutLabels();

const focusSink = keepKeyboardFocus();

loadMe().then(route);
