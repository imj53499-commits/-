import {
  COVER_SHORTCUT_KEY, POPUP_SHORTCUT_KEY, DEFAULT_COVER_SHORTCUT, DEFAULT_POPUP_SHORTCUT, MODIFIER_CODES,
  loadShortcut, storeShortcut, shortcutFromEvent, shortcutLabel, matchesShortcut, isTypingKey, isTypingTarget,
  keepKeyboardFocus
} from './shortcuts.js';
import {
  embedUrl, sendToPlayer, listenTo, readPlayerMessage, autostart, loadAutoplay, saveAutoplay,
  loadHistory, recordWatch, clearHistory, pickNext, loadPopupBounds, ENDED, PAUSED
} from './player.js';
import {
  resumeTime, progressFraction, saveProgress, forgetProgress, continueWatching, clearProgress, formatTime
} from './player.js';
import { PRESETS, loadDisguise, saveDisguise, applyDisguise, cleanDomain, iconFor, isDisguiseKey } from './disguise.js';

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

// 차단된 계정·기기면 서버가 알려 준 안내를 담아 두고 차단 화면만 보여 준다.
let blockedNotice = '';
// 로그인 화면에 한 번 띄울 안내 (예: 체험 시간이 끝났을 때)
let authNotice = '';

const NETWORK_ERROR = '서버에 연결하지 못했어요. 인터넷(와이파이)이 끊겼거나 학교·회사 인터넷이 이 주소를 막았을 수 있어요. 잠시 뒤 다시 해 보거나 다른 인터넷(데이터)으로 해 보세요.';

async function api(path, { method = 'GET', body } = {}) {
  const init = body === undefined
    ? { method }
    : { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
  let res;
  try {
    res = await fetch(path, init);
  } catch {
    // 와이파이가 잠깐 끊기는 경우가 많아서 한 번만 다시 시도한다.
    await new Promise((resolve) => setTimeout(resolve, 1000));
    try { res = await fetch(path, init); } catch { throw new Error(NETWORK_ERROR); }
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    // 로그인이 풀렸으면(승인 취소, 만료 등) 로그인 화면으로 돌아간다.
    if ((data.code === 'LOGIN_REQUIRED' || data.code === 'BLOCKED') && me) {
      if (me.role === 'trial') authNotice = TRIAL_ENDED;
      me = null;
      setTimeout(route, 0);
    }
    if (data.code === 'BLOCKED') blockedNotice = data.error;
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

// 브라우저 방문 기록·탭에는 '탭 모양'에서 정한 제목만 남는다 (기본 Google). 영상 제목이나 검색어는 넣지 않는다.
function setTitle() {
  document.title = loadDisguise().title;
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

  const watched = v.isShort ? 0 : progressFraction(v.id);
  if (watched) {
    const bar = el('div', { class: 'card-progress' }, el('div'));
    bar.firstChild.style.width = `${Math.round(watched * 100)}%`;
    card.querySelector('.thumb').append(bar);
  }

  if (!v.isShort) {
    const popup = el('span', { class: 'card-popup', role: 'button', title: '팝업으로 보기', 'aria-label': '팝업으로 보기' });
    popup.innerHTML = '<svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="2"/><rect x="12" y="11" width="7" height="6" rx="1"/></svg>';
    popup.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      recordWatch(v.id);
      saveProgress(v.id, 0, 0, { title: v.title, channel: v.channel });
      openPopup(v.id, resumeTime(v.id));
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

// ---------- 앱 목록 (처음 화면) ----------
// 앱을 더 넣을 때는 여기에 하나씩 추가한다.
const APPS = [
  { id: 'youtube', name: 'School YouTube', href: '#/youtube', color: 'linear-gradient(135deg, #34d399, #10b981 55%, #0ea5e9)', icon: '<svg viewBox="0 0 24 24"><path d="M9 6.5l9 5.5-9 5.5z"/></svg>' },
  { id: 'chess', name: '체스', href: '#/chess', color: 'linear-gradient(135deg, #a3a3a3, #57534e 55%, #1c1917)', icon: '<svg viewBox="0 0 24 24"><path d="M12 2.5a2 2 0 0 1 1.2 3.6c1.5.6 2.6 1.8 2.6 3.4 0 1-.5 1.9-1.2 2.5l1.4 5H8l1.4-5a3.3 3.3 0 0 1-1.2-2.5c0-1.6 1.1-2.8 2.6-3.4A2 2 0 0 1 12 2.5zM6.5 18.5h11l1 3h-13z"/></svg>' }
];

// ---------- 다른 앱 (체스 등): 필요할 때만 불러온다 ----------

let chessModule = null;

async function openChess(parts, token) {
  setTitle();
  setActiveNav('');
  document.body.classList.add('app-mode');
  appTitle.textContent = '체스';
  if (!chessModule) {
    app.replaceChildren(el('p', { class: 'message', text: '불러오는 중…' }));
    try {
      chessModule = await import('./chess-app.js');
    } catch {
      if (token === renderToken) app.replaceChildren(errorView('체스를 불러오지 못했어요.', () => route()));
      return;
    }
  }
  if (token !== renderToken) return;
  chessModule.renderChess(parts, { app, el, api, me, showToast, isCurrent: () => token === renderToken });
}

function renderLauncher() {
  setTitle();
  setActiveNav('');
  document.body.classList.add('launcher-mode');
  const name = me?.name || (me?.role === 'trial' ? '' : me?.username) || '';
  const tile = (a) => {
    const iconEl = el('span', { class: 'app-icon', style: `background:${a.color}` });
    iconEl.innerHTML = a.icon;
    return el('a', { class: 'app-tile', href: a.href }, iconEl, el('span', { class: 'app-name', text: a.name }));
  };
  app.replaceChildren(el('div', { class: 'launcher' },
    el('h1', { class: 'launcher-title', text: name ? `${name}님, 무엇을 할까요?` : '무엇을 할까요?' }),
    el('div', { class: 'app-grid' },
      ...APPS.map(tile),
      el('div', { class: 'app-tile soon', 'aria-hidden': 'true' },
        el('span', { class: 'app-icon' }, '+'),
        el('span', { class: 'app-name', text: '곧 추가돼요' })))));
}

// ---------- 체험 중 남은 시간 ----------

const TRIAL_ENDED = '체험 시간(1시간)이 끝났어요. 계속 쓰려면 가입해 주세요.';
const trialBar = document.getElementById('trialBar');
const appTitle = document.getElementById('appTitle');
let trialTimer = null;

function updateTrialBar() {
  const on = me?.role === 'trial';
  trialBar.hidden = !on || document.body.classList.contains('auth-mode');
  if (!on) {
    clearInterval(trialTimer);
    trialTimer = null;
    return;
  }
  const left = me.expiresAt - Date.now();
  if (left <= 0) {
    me = null;
    authNotice = TRIAL_ENDED;
    clearInterval(trialTimer);
    trialTimer = null;
    // 주소가 바뀌면 hashchange 가 route 를 부르므로 한 번만 그리게 한다 (안내 문구는 한 번만 쓰임)
    if (location.hash !== '#/') location.hash = '#/';
    else route();
    return;
  }
  trialBar.textContent = `체험 중 · ${Math.ceil(left / 60000)}분 남음 · 가입하기`;
  if (!trialTimer) trialTimer = setInterval(updateTrialBar, 10000);
}

async function renderHome(category, token) {
  setTitle('');
  setActiveNav(category === 'all' ? 'home' : category);

  const chips = el('div', { class: 'chips' });
  for (const [key, label] of Object.entries(CATEGORY_LABELS)) {
    chips.append(el('a', {
      class: `chip${key === category ? ' active' : ''}`,
      href: key === 'all' ? '#/youtube' : `#/c/${key}`,
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
      body.replaceChildren(category === 'all' ? continueRow() ?? '' : '',
        recs.length ? el('p', { class: 'feed-note', text: '최근 본 영상을 바탕으로 골랐어요' }) : '', grid, status);
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
  // 전에 보던 위치가 있으면 거기서부터 시작한다
  const resumeAt = resumeTime(id);
  watching = { id, meta: null };
  const player = el('div', { class: 'player' },
    el('iframe', {
      src: embedUrl(id, resumeAt ? `&start=${resumeAt}` : ''),
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

  const resumeBar = resumeAt ? el('div', { class: 'resume-bar' },
    el('span', { text: `${formatTime(resumeAt)}부터 이어서 재생 중` }),
    el('button', { type: 'button', text: '처음부터', onclick: () => {
      sendToPlayer(player.querySelector('iframe'), 'seekTo', [0, true]);
      forgetProgress(id);
      resumeBar.remove();
    } })) : null;

  app.replaceChildren(el('div', { class: 'watch' },
    el('div', {}, player, resumeBar, info),
    el('aside', {}, related)));
  window.scrollTo({ top: 0 });

  try {
    const v = await api(`/api/video?id=${encodeURIComponent(id)}`);
    if (token !== renderToken) return;
    setTitle(v.title);
    recordWatch(id);
    if (watching?.id === id) watching.meta = { title: v.title, channel: v.channel };

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
      el('div', { class: 'watch-actions' }, owner, el('div', { class: 'watch-buttons' }, autoplay, popupBtn)), desc,
      commentsSection(id, token));

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

// ---------- 댓글 ----------
// 화면에 보이면 그때 불러오고, 아래로 내리면 계속 더 불러온다.

function commentsSection(id, token) {
  const title = el('h2', { class: 'comments-title', text: '댓글' });
  const list = el('div', { class: 'comment-list' });
  const status = el('div', { class: 'feed-status' }, el('div', { class: 'feed-loading', text: '댓글 불러오는 중…' }));
  const section = el('section', { class: 'comments' }, title, list, status);
  const seen = new Set();

  const add = (items) => {
    const fresh = items.filter((c) => !seen.has(c.id || c.text));
    for (const c of fresh) seen.add(c.id || c.text);
    list.append(...fresh.map(commentItem));
  };

  async function loadFirst() {
    try {
      const data = await api(`/api/comments?id=${encodeURIComponent(id)}`);
      if (token !== renderToken) return;
      if (data.count) title.textContent = data.count;
      status.replaceChildren();
      if (!data.items.length) {
        list.replaceChildren(el('p', { class: 'comments-empty', text: data.off ? '댓글을 쓸 수 없는 영상이에요.' : '아직 댓글이 없어요.' }));
        return;
      }
      add(data.items);
      let next = data.next;
      if (next) {
        infiniteScroll(token, status, async () => {
          const page = await api(`/api/comments?cont=${encodeURIComponent(next)}`);
          next = page.next;
          add(page.items);
          return !!next;
        });
      }
    } catch (err) {
      if (token !== renderToken) return;
      status.replaceChildren(errorView(err.message, () => {
        status.replaceChildren(el('div', { class: 'feed-loading', text: '댓글 불러오는 중…' }));
        loadFirst();
      }));
    }
  }

  const observer = new IntersectionObserver((entries) => {
    if (token !== renderToken) return observer.disconnect();
    if (entries.some((e) => e.isIntersecting)) {
      observer.disconnect();
      loadFirst();
    }
  }, { rootMargin: '400px 0px' });
  observer.observe(section);
  return section;
}

function commentItem(c) {
  const avatar = safeImg(c.avatar)
    ? el('img', { class: 'comment-avatar', src: c.avatar, alt: '', loading: 'lazy' })
    : el('div', { class: 'comment-avatar placeholder', text: (c.author || '?').replace(/^@/, '').slice(0, 1) });
  const stats = [c.likes && `👍 ${c.likes}`, c.replies && `답글 ${c.replies}개`].filter(Boolean).join('   ');
  return el('div', { class: 'comment' },
    avatar,
    el('div', { class: 'comment-body' },
      el('div', { class: 'comment-head' },
        el('span', { class: 'comment-author', text: c.author || '' }),
        el('span', { class: 'comment-time', text: c.published || '' })),
      el('div', { class: 'comment-text' }, linkify(c.text || '')),
      stats ? el('div', { class: 'comment-stats', text: stats }) : null));
}

// 홈 맨 위 '이어서 보기' 줄 (보다 만 영상)
function continueRow() {
  const items = continueWatching(12);
  if (!items.length) return null;
  const row = el('div', { class: 'continue-row' }, ...items.map((p) => videoCard({
    id: p.id,
    title: p.title,
    channel: p.channel || '',
    meta: `${formatTime(p.t)} / ${formatTime(p.d)}`,
    duration: '',
    thumbnail: `https://i.ytimg.com/vi/${p.id}/mqdefault.jpg`
  })));
  return el('section', { class: 'continue' }, el('h2', { class: 'section-title', text: '이어서 보기' }), row);
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
  stopWatching();
  closeMobileSearch();
  updateAccountUI();
  document.body.classList.remove('shorts-mode', 'launcher-mode', 'app-mode');
  chessModule?.stopChess();

  if (parts[0] === 'admin') return renderAdmin(token);
  document.body.classList.toggle('auth-mode', !me || !!me.mustChange);
  updateTrialBar();
  if (parts[0] === 'contact') return renderContact(token);
  if (parts[0] === 'replies') return renderReplies(token);
  if (blockedNotice) return renderBlocked();
  if (!me) {
    const notice = authNotice;
    authNotice = '';
    return renderAuth(token, 'login', notice);
  }
  // 체험 중에 가입하기를 누르면 체험은 그대로 두고 가입 화면만 보여 준다
  if (parts[0] === 'signup' && me.role === 'trial') {
    document.body.classList.add('auth-mode');
    trialBar.hidden = true;
    return renderAuth(token, 'signup');
  }
  if (me.mustChange) return renderPassword(token, true);
  if (parts[0] === 'password' && me.role === 'user') return renderPassword(token, false);

  if (parts[0] === 'shorts') return renderShorts(token);
  if (parts[0] === 'watch' && /^[\w-]{11}$/.test(parts[1] || '')) return renderWatch(parts[1], token);
  if (parts[0] === 'channel' && parts[1]) return renderChannel(parts[1], token);
  if (parts[0] === 'search') {
    const q = new URLSearchParams(query).get('q') || '';
    if (q.trim()) return renderSearch(q.trim(), token);
  }
  if (!parts.length) return renderLauncher();
  if (parts[0] === 'chess') return openChess(parts, token);
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
  check: '<svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
  mail: '<svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="2.5"/><path d="M4 7l8 6 8-6"/></svg>'
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

// 차단된 계정·기기: 로그인 화면 대신 이 화면만 보인다 (문의하기는 됨)
function renderBlocked() {
  setTitle();
  setActiveNav('');
  document.body.classList.add('auth-mode');
  app.replaceChildren(authCard('접속이 차단됐어요', '이 기기에서는 사이트를 쓸 수 없어요',
    el('div', { class: 'auth-form' },
      el('p', { class: 'auth-message blocked', role: 'alert', text: blockedNotice }),
      el('button', { type: 'button', class: 'auth-submit', onclick: () => location.reload() }, el('span', { text: '다시 확인' })),
      el('p', { class: 'auth-foot', text: '관리자가 차단을 풀면 다시 확인을 눌러 주세요' }),
      el('a', { class: 'auth-link', href: '#/contact', text: '잘못 막혔나요? 관리자에게 문의하기' }))));
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
    el('p', { class: 'auth-foot', text: signup ? '이메일은 필요 없어요 · 관리자가 승인하면 바로 쓸 수 있어요' : '처음이라면 위에서 가입하기를 눌러 주세요' }),
    el('a', { class: 'auth-link', href: '#/contact', text: signup ? '가입이 안 되나요? 관리자에게 문의하기' : '비밀번호를 잊었나요? 관리자에게 문의하기' }));

  // 다시 입력하기 시작하면 이전 오류 문구는 지운다 (안내/승인 대기 문구는 남겨 둔다)
  form.addEventListener('input', () => {
    if (message.className === 'auth-message') message.textContent = '';
  });

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
      if (err.code === 'BLOCKED') return route();
      message.textContent = err.message;
      message.className = err.code === 'PENDING' ? 'auth-message wait' : 'auth-message';
      submit.disabled = false;
      submit.classList.remove('loading');
    }
  });

  // 체험하기: 가입·로그인 없이 1시간 (체험 중에 가입 화면을 연 경우는 빼고)
  const trialBtn = el('button', { type: 'button', class: 'trial-start', text: '1시간 체험해 보기' });
  trialBtn.addEventListener('click', async () => {
    trialBtn.disabled = true;
    message.className = 'auth-message';
    message.textContent = '';
    try {
      me = await api('/api/auth/trial', { method: 'POST', body: {} });
      location.hash = '#/';
      route();
    } catch (err) {
      if (err.code === 'BLOCKED') return route();
      message.textContent = err.message;
      trialBtn.disabled = false;
    }
  });
  const trialBox = me?.role === 'trial' ? null : el('div', { class: 'trial-box' },
    el('p', { text: '가입·로그인하기 무서우신가요?' }),
    trialBtn,
    el('span', { text: '가입 없이 1시간 동안 써 볼 수 있어요' }));

  app.replaceChildren(authCard('School YouTube', signup ? '가입 신청을 하면 관리자가 확인해요' : '다시 오신 걸 환영해요',
    el('div', { class: `auth-tabs${signup ? ' signup' : ''}` }, tab('login', '로그인'), tab('signup', '가입하기')),
    form, trialBox));
  (signup ? realName : (prefill ? password : username)).focus();
  showReplyBanner(token);
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

// ---------- 관리자에게 문의 (로그인 안 해도 됨) ----------

function backLink(text = '← 돌아가기') {
  return el('a', { class: 'auth-link', href: '#/', text, onclick: (e) => {
    // 바로 전 화면(로그인·가입 화면 등)으로 돌아간다
    if (history.length > 1) { e.preventDefault(); history.back(); }
  } });
}

function renderContact(token) {
  setTitle();
  setActiveNav('');
  const loggedIn = me?.role === 'user';
  const name = el('input', { name: 'name', maxlength: '20', placeholder: '홍길동', autocomplete: 'name' });
  const username = el('input', { name: 'username', maxlength: '20', placeholder: '가입한 아이디 (있으면)', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false' });
  const contactInfo = el('input', { name: 'contact', maxlength: '100', placeholder: '답장 받을 연락처 (선택)' });
  const message = el('textarea', { name: 'message', maxlength: '1000', rows: '5', placeholder: '예) 비밀번호를 잊어버렸어요 / 가입 승인 부탁드려요' });
  if (loggedIn) {
    name.value = me.name || '';
    username.value = me.username;
    username.disabled = true;
  }
  const counter = el('span', { class: 'field-hint', text: '0 / 1000' });
  message.addEventListener('input', () => { counter.textContent = `${message.value.length} / 1000`; });
  const error = el('p', { class: 'auth-message', role: 'alert' });
  const submit = el('button', { class: 'auth-submit', type: 'submit' }, el('span', { text: '보내기' }));

  const form = el('form', { class: 'auth-form', novalidate: '' },
    field('이름', name, 'user'),
    field('아이디', username, 'id', { hint: loggedIn ? '로그인한 아이디로 보내요' : '선택' }),
    field('연락처', contactInfo, 'mail', { hint: '선택 · 관리자가 답장할 수 있게' }),
    el('label', { class: 'field' }, el('span', { class: 'field-label', text: '문의 내용' }), message, counter),
    error,
    submit,
    backLink());
  form.addEventListener('input', () => { if (error.className === 'auth-message') error.textContent = ''; });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!name.value.trim()) { error.textContent = '이름을 적어 주세요.'; name.focus(); return; }
    if (message.value.trim().length < 2) { error.textContent = '문의 내용을 적어 주세요.'; message.focus(); return; }
    submit.disabled = true;
    submit.classList.add('loading');
    try {
      const res = await api('/api/auth/contact', { method: 'POST', body: {
        name: name.value.trim(), username: username.value.trim(), contact: contactInfo.value.trim(), message: message.value
      } });
      if (res.ticket) saveTickets([{ ticket: res.ticket, at: Date.now() }, ...loadTickets()]);
      if (token !== renderToken) return;
      app.replaceChildren(authCard('문의를 보냈어요', '',
        el('div', { class: 'auth-done' },
          icon('check', 'auth-done-badge'),
          el('p', { class: 'auth-done-sub', text: '관리자가 답장하면 이 브라우저의 로그인 화면에 "답장이 왔어요"가 떠요. 다른 기기에서는 볼 수 없어요.' }),
          el('a', { class: 'auth-submit as-link', href: '#/' }, el('span', { text: '처음 화면으로' })))));
    } catch (err) {
      error.textContent = err.message;
      submit.disabled = false;
      submit.classList.remove('loading');
    }
  });

  app.replaceChildren(authCard('관리자에게 문의', '비밀번호를 잊었거나 가입·승인이 안 될 때 남겨 주세요', form));
  (loggedIn ? message : name).focus();
  showReplyBanner(token);
}

// ---------- 관리자 답장 받기 ----------
// 문의를 보내면 이 브라우저에 '답장 받기 표'가 저장되고, 그 표로만 관리자 답장을 볼 수 있다.

const TICKETS_KEY = 'contactTickets';

function loadTickets() {
  try {
    const list = JSON.parse(localStorage.getItem(TICKETS_KEY) || '[]');
    return Array.isArray(list) ? list.filter((t) => /^[0-9a-f]{32}$/.test(t?.ticket || '')).slice(0, 10) : [];
  } catch {
    return [];
  }
}

function saveTickets(list) {
  try { localStorage.setItem(TICKETS_KEY, JSON.stringify(list.slice(0, 10))); } catch {}
}

async function fetchReplies() {
  const tickets = loadTickets();
  if (!tickets.length) return [];
  const list = await api('/api/auth/contact/replies', { method: 'POST', body: { tickets: tickets.map((t) => t.ticket) } });
  // 지워졌거나 기간이 지난 문의의 표는 버린다
  const gone = new Set(list.filter((r) => r.gone).map((r) => r.ticket));
  if (gone.size) saveTickets(tickets.filter((t) => !gone.has(t.ticket)));
  return list.filter((r) => !r.gone);
}

// 로그인·가입·문의 화면 카드 맨 위에 '답장이 왔어요' 띄우기
async function showReplyBanner(token) {
  if (!loadTickets().length) return;
  let replies;
  try { replies = await fetchReplies(); } catch { return; }
  const answered = replies.filter((r) => r.reply);
  const card = app.querySelector('.auth-card');
  if (token !== renderToken || !answered.length || !card) return;
  card.prepend(el('a', { class: 'reply-banner', href: '#/replies' },
    el('span', { text: '📬' }),
    el('span', { text: `관리자 답장이 왔어요${answered.length > 1 ? ` (${answered.length})` : ''}` }),
    el('span', { class: 'reply-banner-go', text: '보기 →' })));
}

// 답장 글에서 임시 비밀번호를 찾아 크게 보여 주고 복사 버튼을 붙인다
function replyText(text) {
  const box = el('div', { class: 'reply-text' });
  const match = text.match(/임시 비밀번호: ([a-z2-9]{8})/);
  box.append(text.replace(/\n?임시 비밀번호: [a-z2-9]{8}/, '').trim());
  if (match) {
    const copy = el('button', { type: 'button', text: '복사', onclick: async () => {
      try { await navigator.clipboard.writeText(match[1]); copy.textContent = '복사됨'; } catch { copy.textContent = '직접 복사해 주세요'; }
    } });
    box.append(el('div', { class: 'temp-password' },
      el('div', {}, el('span', { text: '임시 비밀번호' }), el('code', { text: match[1] })),
      copy,
      el('p', { text: '24시간 안에 이 비밀번호로 로그인하면 새 비밀번호를 정하게 돼요.' })));
  }
  return box;
}

async function renderReplies(token) {
  setTitle();
  setActiveNav('');
  const list = el('div', { class: 'reply-list' }, el('p', { class: 'auth-done-sub', text: '불러오는 중…' }));
  app.replaceChildren(authCard('관리자 답장', '문의를 보낸 이 브라우저에서만 보여요', list,
    el('a', { class: 'auth-submit as-link', href: '#/' }, el('span', { text: '로그인하러 가기' })),
    backLink()));
  let replies;
  try { replies = await fetchReplies(); } catch (err) {
    if (token === renderToken) list.replaceChildren(errorView(err.message, () => route()));
    return;
  }
  if (token !== renderToken) return;
  if (!replies.length) {
    list.replaceChildren(el('p', { class: 'auth-done-sub', text: '보낸 문의가 없어요.' }));
    return;
  }
  list.replaceChildren(...replies.map((r) => {
    const date = new Date(r.at).toLocaleString('ko-KR', { dateStyle: 'short', timeStyle: 'short' });
    const item = el('div', { class: 'reply-item' },
      el('div', { class: 'reply-mine' }, el('span', { text: `내 문의 · ${date}` }), el('p', { text: r.message })),
      r.reply ? replyText(r.reply.text) : el('p', { class: 'reply-waiting', text: '아직 답장이 없어요.' }),
      el('button', { type: 'button', class: 'reply-dismiss', text: r.reply ? '확인했어요 (지우기)' : '이 문의 지우기', onclick: () => {
        saveTickets(loadTickets().filter((t) => t.ticket !== r.ticket));
        item.remove();
        if (!list.children.length) list.append(el('p', { class: 'auth-done-sub', text: '보낸 문의가 없어요.' }));
      } }));
    return item;
  }));
}

// ---------- 비밀번호 바꾸기 (임시 비밀번호로 로그인했으면 꼭 바꿔야 함) ----------

function renderPassword(token, forced) {
  setTitle();
  setActiveNav('');
  const current = el('input', { type: 'password', autocomplete: 'current-password', placeholder: forced ? '관리자에게 받은 임시 비밀번호' : '지금 비밀번호' });
  const next = el('input', { type: 'password', autocomplete: 'new-password', placeholder: '6자 이상' });
  const again = el('input', { type: 'password', autocomplete: 'new-password', placeholder: '한 번 더' });
  const error = el('p', { class: 'auth-message', role: 'alert' });
  const submit = el('button', { class: 'auth-submit', type: 'submit' }, el('span', { text: '비밀번호 바꾸기' }));
  const form = el('form', { class: 'auth-form', novalidate: '' },
    field(forced ? '임시 비밀번호' : '지금 비밀번호', current, 'lock'),
    field('새 비밀번호', next, 'lock', { hint: '6자 이상', check: RULES.password }),
    field('새 비밀번호 확인', again, 'lock', { check: (v) => v.length > 0 && v === next.value }),
    error,
    submit,
    forced ? el('button', { type: 'button', class: 'auth-link as-button', text: '로그아웃', onclick: logoutNow }) : backLink());
  form.addEventListener('input', () => { error.textContent = ''; });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!current.value) { error.textContent = '지금 비밀번호를 적어 주세요.'; current.focus(); return; }
    if (!RULES.password(next.value)) { error.textContent = '새 비밀번호는 6자 이상이에요.'; next.focus(); return; }
    if (next.value !== again.value) { error.textContent = '새 비밀번호가 서로 달라요.'; again.focus(); return; }
    submit.disabled = true;
    submit.classList.add('loading');
    try {
      await api('/api/auth/password', { method: 'POST', body: { current: current.value, next: next.value } });
      if (token !== renderToken) return;
      me.mustChange = false;
      app.replaceChildren(authCard('비밀번호를 바꿨어요', '',
        el('div', { class: 'auth-done' },
          icon('check', 'auth-done-badge'),
          el('p', { class: 'auth-done-sub', text: '다른 기기에서 로그인돼 있었다면 거기서는 다시 로그인해야 해요.' }),
          el('a', { class: 'auth-submit as-link', href: '#/', onclick: () => setTimeout(route, 0) }, el('span', { text: '계속하기' })))));
    } catch (err) {
      error.textContent = err.message;
      submit.disabled = false;
      submit.classList.remove('loading');
    }
  });

  app.replaceChildren(authCard(forced ? '새 비밀번호 정하기' : '비밀번호 바꾸기',
    forced ? '임시 비밀번호로 로그인했어요. 계속하려면 새 비밀번호를 정해 주세요.' : '바꾸면 다른 기기의 로그인은 풀려요.', form));
  current.focus();
}

// ---------- 관리자: 가입 승인 ----------

const STATUS_LABELS = { pending: '승인 대기', approved: '승인됨', rejected: '거절됨', blocked: '차단됨' };

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
        blockedNotice = ''; // 관리자가 로그인하면 이 기기의 차단도 풀린다
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
      el('h1', { text: '관리자' }),
      el('button', { class: 'admin-refresh', text: '새로고침', onclick: () => route() })),
    body));

  let users;
  let messages;
  try {
    [users, messages] = await Promise.all([api('/api/admin/users'), api('/api/admin/messages')]);
  } catch (err) {
    if (token !== renderToken) return;
    if (err.code === 'ADMIN_REQUIRED') { me = null; return route(); }
    body.replaceChildren(errorView(err.message, () => route()));
    return;
  }
  if (token !== renderToken) return;

  // 저장소 목록은 바로 반영되지 않을 수 있어서, 버튼을 누르면 화면에서 직접 바꾼다.
  async function act(user, action, row) {
    if (action === 'reset' && !confirm(`${user.name || user.username}님의 비밀번호를 초기화할까요?\n임시 비밀번호가 만들어지고, 지금 로그인된 기기는 로그아웃돼요.`)) return;
    if (action === 'delete' && !confirm(`${user.name || user.username}님의 계정을 삭제할까요?`)) return;
    let reason = '';
    if (action === 'block') {
      reason = prompt(`${user.name || user.username}님을 차단할까요?\n바로 로그아웃되고 다시 로그인할 수 없어요. 쓰던 기기와 이 계정으로 로그인을 시도한 기기는 30일 동안 사이트 전체가 막혀요.\n\n차단 이유 (본인에게 보여요, 비워 둬도 돼요)`, '');
      if (reason === null) return;
    }
    row.querySelectorAll('button').forEach((b) => (b.disabled = true));
    try {
      const res = await api('/api/admin/users', { method: 'POST', body: { username: user.username, action, reason } });
      if (action === 'reset') {
        user.tempPassword = res.tempPassword;
      } else if (action === 'delete') {
        users = users.filter((u) => u !== user);
      } else {
        user.status = { approve: 'approved', reject: 'rejected', block: 'blocked', unblock: 'approved' }[action];
        user.blockReason = action === 'block' ? reason.trim().slice(0, 100) : '';
      }
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
      pending: [btn('승인', 'approve', 'approve'), btn('거절', 'reject'), btn('차단', 'block', 'danger')],
      approved: [btn('승인 취소', 'reject'), btn('비밀번호 초기화', 'reset'), btn('차단', 'block', 'danger')],
      rejected: [btn('승인', 'approve', 'approve'), btn('차단', 'block', 'danger'), btn('삭제', 'delete', 'danger')],
      blocked: [btn('차단 풀기', 'unblock', 'approve'), btn('삭제', 'delete', 'danger')]
    }[user.status] || [];
    row.append(
      el('div', { class: 'admin-user' },
        el('strong', { text: user.name || '(이름 없음)' }),
        el('span', { text: [`아이디 ${user.username}`, date].filter(Boolean).join(' · ') }),
        user.status === 'blocked' && user.blockReason ? el('span', { text: `차단 이유: ${user.blockReason}` }) : null),
      el('div', { class: 'admin-actions' }, ...actions));
    // 초기화하면 임시 비밀번호를 이 화면에서 한 번만 보여 준다 (저장되지 않아서 다시 볼 수 없음)
    if (user.tempPassword) {
      const copy = el('button', { type: 'button', text: '복사', onclick: async () => {
        try { await navigator.clipboard.writeText(user.tempPassword); copy.textContent = '복사됨'; } catch { copy.textContent = '직접 복사해 주세요'; }
      } });
      row.append(el('div', { class: 'temp-password' },
        el('div', {},
          el('span', { text: '임시 비밀번호' }),
          el('code', { text: user.tempPassword })),
        copy,
        el('p', { text: '본인에게 알려 주세요. 이 화면을 벗어나면 다시 볼 수 없어요. 이 비밀번호로 로그인하면 새 비밀번호를 정하게 돼요.' })));
    }
    return row;
  }

  async function actMessage(msg, action, card) {
    if (action === 'delete' && !confirm('이 문의를 삭제할까요?')) return;
    card.querySelectorAll('button').forEach((b) => (b.disabled = true));
    try {
      await api('/api/admin/messages', { method: 'POST', body: { id: msg.id, action } });
      if (action === 'delete') messages = messages.filter((m) => m !== msg);
      else msg.read = action === 'read';
      draw();
    } catch (err) {
      alert(err.message);
      card.querySelectorAll('button').forEach((b) => (b.disabled = false));
    }
  }

  function messageCard(msg) {
    const card = el('li', { class: `admin-message${msg.read ? ' read' : ''}` });
    const date = new Date(msg.at).toLocaleString('ko-KR', { dateStyle: 'short', timeStyle: 'short' });
    const who = [msg.username && `아이디 ${msg.username}`, msg.contact && `연락처 ${msg.contact}`, date].filter(Boolean).join(' · ');
    card.append(
      el('div', { class: 'admin-message-head' },
        el('div', { class: 'admin-user' },
          el('strong', { text: (msg.read ? '' : '● ') + msg.name }),
          el('span', { text: who })),
        el('div', { class: 'admin-actions' },
          el('button', { text: msg.read ? '안 읽음으로' : '읽음', onclick: () => actMessage(msg, msg.read ? 'unread' : 'read', card) }),
          el('button', { class: 'danger', text: '삭제', onclick: () => actMessage(msg, 'delete', card) }))),
      el('p', { class: 'admin-message-text', text: msg.message }),
      replyArea(msg));
    return card;
  }

  // 답장: 문의한 사람의 브라우저(로그인 화면)에 보인다. 아이디가 있으면 비밀번호를 초기화해서 임시 비밀번호를 같이 보낼 수 있다.
  function replyArea(msg) {
    if (msg.reply) {
      return el('div', { class: 'admin-reply sent' },
        el('span', { text: `보낸 답장 · ${new Date(msg.reply.at).toLocaleString('ko-KR', { dateStyle: 'short', timeStyle: 'short' })}` }),
        el('p', { text: msg.reply.text }));
    }
    if (!msg.hasTicket) return el('p', { class: 'admin-reply-note', text: '예전 방식으로 받은 문의라 사이트로 답장할 수 없어요. 연락처로 연락해 주세요.' });
    const text = el('textarea', { rows: '2', maxlength: '1000', placeholder: '답장 쓰기 (문의한 사람의 로그인 화면에 떠요)' });
    const status = el('span', { class: 'admin-reply-note' });
    const send = async (resetPassword) => {
      if (resetPassword && !confirm(`아이디 ${msg.username}의 비밀번호를 초기화해서 임시 비밀번호를 답장으로 보낼까요?\n\n다른 사람이 ${msg.username}인 척 문의했을 수도 있어요. 이름·연락처로 본인인지 먼저 확인해 주세요.`)) return;
      if (!resetPassword && !text.value.trim()) { status.textContent = '답장 내용을 적어 주세요.'; return; }
      area.querySelectorAll('button').forEach((b) => (b.disabled = true));
      try {
        const res = await api('/api/admin/messages', { method: 'POST', body: { id: msg.id, action: 'reply', reply: text.value, resetPassword } });
        msg.reply = res.reply;
        msg.read = true;
        draw();
      } catch (err) {
        status.textContent = err.message;
        area.querySelectorAll('button').forEach((b) => (b.disabled = false));
      }
    };
    const area = el('div', { class: 'admin-reply' }, text,
      el('div', { class: 'admin-actions' },
        el('button', { class: 'approve', text: '답장 보내기', onclick: () => send(false) }),
        msg.username ? el('button', { text: '비밀번호 초기화해서 보내기', onclick: () => send(true) }) : null),
      status);
    return area;
  }

  function draw() {
    const unread = messages.filter((m) => !m.read).length;
    const inbox = el('section', { class: 'admin-section' },
      el('h2', { text: `문의함 ${messages.length}${unread ? ` (안 읽음 ${unread})` : ''}` }),
      messages.length
        ? el('ul', { class: 'admin-list' }, ...messages.map(messageCard))
        : el('p', { class: 'admin-empty', text: '받은 문의가 없어요.' }));
    const sections = ['pending', 'approved', 'rejected', 'blocked'].map((status) => {
      const list = users.filter((u) => u.status === status);
      return el('section', { class: 'admin-section' },
        el('h2', { text: `${STATUS_LABELS[status]} ${list.length}` }),
        list.length
          ? el('ul', { class: 'admin-list' }, ...list.map(userRow))
          : el('p', { class: 'admin-empty', text: status === 'pending' ? '기다리는 사람이 없어요.' : '없음' }));
    });
    body.replaceChildren(inbox, ...sections);
  }
  draw();
}

// ---------- 계정 (설정 창) ----------

const accountSection = document.getElementById('accountSection');
const topLogoutBtn = document.getElementById('topLogoutBtn');

function updateAccountUI() {
  accountSection.hidden = !me || me.role === 'guest';
  if (me?.role === 'trial') {
    document.getElementById('accountName').textContent = '체험 중 (가입 안 함)';
    document.getElementById('adminLink').hidden = true;
    document.getElementById('passwordLink').hidden = true;
    topLogoutBtn.hidden = false;
    return;
  }
  topLogoutBtn.hidden = accountSection.hidden;
  if (!me) return;
  document.getElementById('accountName').textContent = me.name ? `${me.name} (${me.username})` : me.username;
  document.getElementById('adminLink').hidden = me.role !== 'admin';
  document.getElementById('passwordLink').hidden = me.role !== 'user';
}

async function logoutNow() {
  try { await api('/api/auth/logout', { method: 'POST', body: {} }); } catch {}
  me = null;
  settingsDialog.close();
  location.hash = '#/';
  route();
}

document.getElementById('logoutBtn').addEventListener('click', logoutNow);
// 바로 옆 나가기 버튼과 헷갈려 잘못 누르는 일이 없도록 한 번 묻는다.
topLogoutBtn.addEventListener('click', () => {
  if (confirm('로그아웃할까요?')) logoutNow();
});
document.getElementById('passwordLink').addEventListener('click', () => settingsDialog.close());
document.getElementById('contactLink').addEventListener('click', () => settingsDialog.close());

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

function playerCommand(func, args) {
  sendToPlayer(document.querySelector('iframe[data-player]'), func, args);
}

window.addEventListener('message', (e) => {
  const msg = readPlayerMessage(e);
  if (!msg) return;
  if (msg.duration !== undefined) playerDuration = msg.duration;
  if (msg.time !== undefined) playerTime = msg.time;
  if (msg.state !== undefined) {
    const ended = msg.state === ENDED && playerState !== ENDED;
    const paused = msg.state === PAUSED && playerState !== PAUSED;
    playerState = msg.state;
    if (ended && watching) forgetProgress(watching.id);
    if (paused) saveWatching(true);
    if (ended) onPlayerEnded?.();
  }
  saveWatching(false);
});

// ---------- 이어보기: 보는 중인 영상의 위치를 몇 초마다 저장 ----------

let watching = null; // { id, meta } 시청 화면에서만
let playerDuration = 0;
let lastSaved = 0;

function saveWatching(force) {
  if (!watching || playerState === ENDED || !(playerTime > 0)) return;
  // 팝업에서 같은 영상을 보는 동안은 팝업이 위치를 저장한다 (멈춰 둔 이 화면의 예전 위치로 덮어쓰지 않게)
  if (popupFor === watching.id) return;
  if (!force && Date.now() - lastSaved < 5000) return;
  lastSaved = Date.now();
  saveProgress(watching.id, playerTime, playerDuration, watching.meta);
}

// 다른 화면으로 가거나 탭을 닫을 때 마지막 위치를 저장한다
function stopWatching() {
  saveWatching(true);
  watching = null;
  playerTime = 0;
  playerDuration = 0;
}
window.addEventListener('pagehide', () => saveWatching(true));

// ---------- 팝업으로 보기 (롱폼) ----------
// 지금 보던 위치부터 작은 창에서 이어 보고, 원래 화면의 영상은 멈춘다. 팝업에서는 정한 키(기본 Q)로 바로 닫힌다.
// 크롬·엣지는 다른 창을 눌러도 뒤로 안 가는 '항상 위' 창(Document Picture-in-Picture)으로 열고,
// 그게 안 되는 브라우저는 일반 팝업 창으로 연다.

let popupWin = null;

async function openPinnedPopup(url, width, height) {
  // 이미 열려 있으면 그 창에서 영상만 바꾼다 (탭마다 하나만 열 수 있음)
  const open = window.documentPictureInPicture?.window;
  const pip = open || await window.documentPictureInPicture.requestWindow({ width, height });
  if (!open) {
    const style = pip.document.createElement('style');
    style.textContent = 'html,body{margin:0;height:100%;background:#000;overflow:hidden}iframe{display:block;width:100%;height:100%;border:0}';
    pip.document.head.append(style);
    pip.document.title = document.title;
  }
  let frame = pip.document.querySelector('iframe');
  if (!frame) {
    frame = pip.document.createElement('iframe');
    frame.allow = 'autoplay; encrypted-media; picture-in-picture; clipboard-write';
    frame.allowFullscreen = true;
    pip.document.body.append(frame);
  }
  frame.src = url;
  frame.focus();
  return pip;
}

async function openPopup(id, start = Math.floor(playerTime || 0)) {
  // 지난번 팝업 크기와 위치를 그대로 쓰고, 처음이면 오른쪽 아래에 적당한 크기로 연다.
  const saved = loadPopupBounds();
  const width = Math.min(saved?.width ?? 854, screen.availWidth - 20);
  const height = Math.min(saved?.height ?? Math.round(width * 9 / 16), screen.availHeight - 20);
  const url = `/popup.html?v=${encodeURIComponent(id)}&t=${start}`;
  let why = '이 브라우저는 항상 위 창을 지원하지 않아요 (크롬·엣지 116 이상 필요)';
  if ('documentPictureInPicture' in window) {
    try {
      if (popupWin !== window.documentPictureInPicture.window) closePopup(); // 일반 팝업이 떠 있었으면 닫기
      popupWin = await openPinnedPopup(url, width, height);
      handOffToPopup(id);
      return;
    } catch (err) {
      // 막히면 아래 일반 팝업으로
      why = `항상 위 창을 열지 못했어요 (${err?.name || '오류'}: ${err?.message || ''})`;
    }
  }
  const left = saved?.left ?? screen.availWidth - width - 20;
  const top = saved?.top ?? screen.availHeight - height - 60;
  const win = window.open(url, 'sy_popup',
    `popup,width=${width},height=${height},left=${left},top=${top}`);
  if (!win) {
    alert('팝업이 차단됐어요. 주소창 오른쪽의 팝업 차단 아이콘을 눌러 이 사이트의 팝업을 허용해 주세요.');
    return;
  }
  popupWin = win;
  handOffToPopup(id);
  showToast(`${why}. 일반 팝업으로 열어서 다른 창을 누르면 뒤로 갈 수 있어요.`);
}

// 화면 아래에 잠깐 뜨는 안내
function showToast(text) {
  document.querySelector('.toast')?.remove();
  const toast = el('div', { class: 'toast', role: 'status', text });
  document.body.append(toast);
  setTimeout(() => toast.remove(), 7000);
}

// 팝업이 열려 있는 동안 보는 영상 (그 영상의 이어보기 위치는 팝업이 저장한다)
let popupFor = null;
let popupWatch = null;

function handOffToPopup(id) {
  saveWatching(true); // 여기서 보던 위치를 먼저 저장하고
  playerCommand('pauseVideo');
  popupFor = id;
  clearInterval(popupWatch);
  popupWatch = setInterval(() => {
    if (popupWin && !popupWin.closed) return;
    clearInterval(popupWatch);
    popupWatch = null;
    popupReturned();
  }, 700);
}

// 팝업을 닫으면 이 화면의 플레이어를 팝업에서 본 위치로 옮긴다 (재생은 직접 누를 때까지 멈춰 둠)
function popupReturned() {
  const id = popupFor;
  popupFor = null;
  popupWin = null;
  if (!id || watching?.id !== id) return;
  const t = resumeTime(id);
  playerTime = t;
  playerCommand('seekTo', [t, true]);
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
  clearProgress();
  try { localStorage.removeItem(SHORTS_SEEN_KEY); } catch {}
  updateHistoryInfo();
});

document.getElementById('settingsBtn').addEventListener('click', () => {
  updateShortcutLabels();
  updateDisguiseUI();
  updateHistoryInfo();
  settingsDialog.showModal();
});

// 키를 기다리는 중에 Esc 를 누르면 창이 닫히는 대신 Esc 가 단축키로 저장되게 한다.
settingsDialog.addEventListener('cancel', (e) => { if (recordingFor) e.preventDefault(); });
settingsDialog.addEventListener('close', stopRecording);
settingsDialog.addEventListener('click', (e) => { if (e.target === settingsDialog) settingsDialog.close(); });

updateShortcutLabels();

const focusSink = keepKeyboardFocus();

// ---------- 탭 모양 (설정 창) ----------

const disguisePreset = document.getElementById('disguisePreset');
const disguiseCustom = document.getElementById('disguiseForm');
const disguiseDomain = document.getElementById('disguiseDomain');
const disguiseTitle = document.getElementById('disguiseTitleInput');
const disguiseError = document.getElementById('disguiseError');

for (const p of PRESETS) disguisePreset.append(el('option', { value: p.id, text: p.label }));
disguisePreset.append(el('option', { value: 'custom', text: '직접 입력…' }));

function showDisguisePreview(title, domain) {
  document.getElementById('disguisePreviewTitle').textContent = title || '(제목 없음)';
  document.getElementById('disguisePreviewIcon').src = iconFor(domain);
}

function updateDisguiseUI() {
  const d = loadDisguise();
  disguisePreset.value = d.preset;
  disguiseCustom.hidden = d.preset !== 'custom';
  disguiseDomain.value = d.domain;
  disguiseTitle.value = d.title;
  disguiseError.textContent = '';
  showDisguisePreview(d.title, d.domain);
}

function setDisguise(d) {
  saveDisguise(d);
  applyDisguise(d);
  showDisguisePreview(d.title, d.domain);
}

disguisePreset.addEventListener('change', () => {
  const preset = PRESETS.find((p) => p.id === disguisePreset.value);
  disguiseCustom.hidden = !!preset;
  disguiseError.textContent = '';
  if (preset) setDisguise({ preset: preset.id, title: preset.title, domain: preset.domain });
  else disguiseDomain.focus();
});

// 직접 입력: 주소를 넣으면 미리보기 아이콘이 바로 바뀌고, 적용을 누르면 저장한다.
disguiseDomain.addEventListener('input', () => showDisguisePreview(disguiseTitle.value.trim(), cleanDomain(disguiseDomain.value)));
disguiseTitle.addEventListener('input', () => showDisguisePreview(disguiseTitle.value.trim(), cleanDomain(disguiseDomain.value)));

document.getElementById('disguiseForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const domain = cleanDomain(disguiseDomain.value);
  const title = disguiseTitle.value.trim().slice(0, 80);
  if (disguiseDomain.value.trim() && !domain) {
    disguiseError.textContent = '사이트 주소를 확인해 주세요. 예: classroom.google.com';
    return;
  }
  if (!title) {
    disguiseError.textContent = '탭 제목을 적어 주세요.';
    return;
  }
  disguiseError.textContent = '';
  setDisguise({ preset: 'custom', title, domain });
  disguiseError.textContent = '적용했어요.';
});

// 다른 탭(팝업 포함)에서 바꾸면 여기도 바로 맞춘다.
window.addEventListener('storage', (e) => {
  if (isDisguiseKey(e.key)) applyDisguise();
});

applyDisguise();

loadMe().then(route);
