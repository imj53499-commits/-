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

async function api(path) {
  const res = await fetch(path);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `요청 실패 (${res.status})`);
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

function setTitle(text) {
  document.title = text ? `${text} - MinTube` : 'MinTube';
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

  try {
    const items = await api(`/api/home?category=${encodeURIComponent(category)}`);
    if (token !== renderToken) return;
    body.replaceChildren(items.length ? videoGrid(items) : errorView('표시할 영상이 없어요.'));
  } catch (err) {
    if (token !== renderToken) return;
    body.replaceChildren(errorView(err.message, () => route()));
  }
}

async function renderSearch(q, token) {
  setTitle(q);
  setActiveNav('');
  searchInput.value = q;
  app.replaceChildren(skeletonGrid(8));
  try {
    const items = await api(`/api/search?q=${encodeURIComponent(q)}`);
    if (token !== renderToken) return;
    app.replaceChildren(items.length
      ? videoGrid(items, 'list search-results')
      : errorView(`'${q}'에 대한 검색 결과가 없어요.`));
  } catch (err) {
    if (token !== renderToken) return;
    app.replaceChildren(errorView(err.message, () => route()));
  }
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
      src: `https://www.youtube-nocookie.com/embed/${id}?autoplay=1&rel=0&playsinline=1`,
      title: '동영상 플레이어',
      allow: 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share',
      allowfullscreen: '',
      referrerpolicy: 'strict-origin-when-cross-origin'
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

    info.replaceChildren(el('h1', { class: 'watch-title', text: v.title }), owner, desc);
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
    app.replaceChildren(
      banner ?? '',
      el('div', { class: 'channel-head' },
        safeImg(c.avatar) ? el('img', { src: c.avatar, alt: '' }) : null,
        el('div', {}, el('h1', { text: c.name }), el('p', { text: c.description }))),
      el('h2', { class: 'section-title', text: '동영상' }),
      c.videos.length ? videoGrid(c.videos) : errorView('영상이 없어요.'));
  } catch (err) {
    if (token !== renderToken) return;
    app.replaceChildren(errorView(err.message, () => route()));
  }
}

// ---------- 라우터 ----------

function route() {
  const token = ++renderToken;
  const hash = location.hash.replace(/^#/, '') || '/';
  const [path, query = ''] = hash.split('?');
  const parts = path.split('/').filter(Boolean);
  document.body.classList.remove('sidebar-open');
  hideSuggestions();

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

// ---------- 검색 + 자동완성 ----------

let suggestTimer;
let activeSuggestion = -1;

function hideSuggestions() {
  suggestions.hidden = true;
  activeSuggestion = -1;
}

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
  if (suggestions.hidden) return;
  const items = [...suggestions.children];
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    // -1(선택 없음) → 0 → … → 마지막 → -1 순으로 순환
    const n = items.length + 1;
    activeSuggestion = ((activeSuggestion + 1 + (e.key === 'ArrowDown' ? 1 : -1) + n) % n) - 1;
    items.forEach((li, i) => li.classList.toggle('active', i === activeSuggestion));
  } else if (e.key === 'Escape') {
    hideSuggestions();
  }
});

searchInput.addEventListener('blur', () => setTimeout(hideSuggestions, 100));

// ---------- 메뉴 / 테마 ----------

document.getElementById('menuBtn').addEventListener('click', () => {
  if (window.matchMedia('(max-width: 800px)').matches) document.body.classList.toggle('sidebar-open');
  else document.body.classList.toggle('sidebar-collapsed');
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

route();
