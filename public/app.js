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
const PAGE_TITLE = '새 탭';

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
  closeMobileSearch();
  updateAccountUI();

  if (parts[0] === 'admin') return renderAdmin(token);
  document.body.classList.toggle('auth-mode', !me);
  if (!me) return renderAuth(token);

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

function authCard(...children) {
  return el('div', { class: 'auth' }, el('div', { class: 'auth-card' }, ...children));
}

function field(label, input) {
  return el('label', { class: 'field' }, el('span', { text: label }), input);
}

function renderAuth(token, mode = 'login', notice = '') {
  setTitle(mode === 'login' ? '로그인' : '가입하기');
  setActiveNav('');
  const realName = el('input', { name: 'name', autocomplete: 'name', required: '', maxlength: '20' });
  // 가입할 때는 브라우저가 저장된 이메일을 아이디 칸에 추천하지 않게 자동 완성을 끈다.
  const username = el('input', {
    name: 'username', required: '', maxlength: '20', autocapitalize: 'off', spellcheck: 'false',
    autocomplete: mode === 'login' ? 'username' : 'off'
  });
  const password = el('input', {
    name: 'password', type: 'password', required: '', minlength: '6', maxlength: '100',
    autocomplete: mode === 'login' ? 'current-password' : 'new-password'
  });
  const message = el('p', { class: `auth-message${notice ? ' ok' : ''}`, text: notice, role: 'alert' });
  const submit = el('button', { class: 'auth-submit', type: 'submit', text: mode === 'login' ? '로그인' : '가입 신청' });
  const tab = (key, label) => el('button', {
    type: 'button', class: `auth-tab${mode === key ? ' active' : ''}`, text: label,
    onclick: () => renderAuth(token, key)
  });

  const form = el('form', { class: 'auth-form' },
    mode === 'signup' ? field('이름 (본인 실명)', realName) : null,
    field('아이디', username),
    field('비밀번호', password),
    mode === 'signup' ? el('p', { class: 'auth-hint', text: '이메일은 필요 없어요. 아이디는 한글·영문·숫자 2~20자, 비밀번호는 6자 이상이에요. 가입하면 관리자가 승인한 뒤에 쓸 수 있어요.' }) : null,
    message,
    submit);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    submit.disabled = true;
    message.className = 'auth-message';
    message.textContent = '';
    try {
      const body = { username: username.value.trim(), password: password.value };
      if (mode === 'signup') body.name = realName.value.trim();
      if (mode === 'signup') {
        await api('/api/auth/signup', { method: 'POST', body });
        renderAuth(token, 'login', '가입 신청이 완료됐어요! 관리자가 승인하면 로그인할 수 있어요.');
        return;
      }
      me = await api('/api/auth/login', { method: 'POST', body });
      route();
    } catch (err) {
      message.textContent = err.message;
      submit.disabled = false;
    }
  });

  app.replaceChildren(authCard(
    el('h1', { class: 'auth-title', text: 'School YouTube' }),
    el('div', { class: 'auth-tabs' }, tab('login', '로그인'), tab('signup', '가입하기')),
    form));
  (mode === 'signup' ? realName : username).focus();
}

// ---------- 관리자: 가입 승인 ----------

const STATUS_LABELS = { pending: '승인 대기', approved: '승인됨', rejected: '거절됨' };

async function renderAdmin(token) {
  setTitle('가입 승인 관리');
  setActiveNav('');
  document.body.classList.toggle('auth-mode', !me);

  if (me?.role !== 'admin') {
    const password = el('input', { type: 'password', autocomplete: 'current-password', required: '' });
    const message = el('p', { class: 'auth-message', role: 'alert' });
    const submit = el('button', { class: 'auth-submit', type: 'submit', text: '관리자 로그인' });
    const form = el('form', { class: 'auth-form' }, field('관리자 비밀번호', password), message, submit);
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
    app.replaceChildren(authCard(el('h1', { class: 'auth-title', text: '관리자' }), form));
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

// ---------- 빠른 나가기 ----------
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

// ---------- 빠른 나가기 단축키 (설정에서 바꿀 수 있고, 이 브라우저에 저장된다) ----------
// 키는 e.code 로 비교해서 한/영 상태와 상관없이 같은 키로 동작한다.

const DEFAULT_SHORTCUT = { code: 'Backquote', ctrl: false, alt: false, shift: false, meta: false };
const MODIFIER_CODES = /^(Control|Shift|Alt|Meta|OS)(Left|Right)?$|^(CapsLock|Fn|HangulMode|Hanja|Lang1|Lang2)$/;
const CODE_NAMES = {
  Backquote: '`', Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Backslash: '\\',
  Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/', Space: 'Space', Escape: 'Esc',
  Enter: 'Enter', Tab: 'Tab', Backspace: 'Backspace', Delete: 'Delete', Insert: 'Insert',
  Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown',
  ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', IntlBackslash: '\\'
};

let shortcut = loadShortcut();
let recording = false;

function loadShortcut() {
  try {
    const saved = localStorage.getItem('exitShortcut');
    if (saved === 'off') return null;
    if (saved) {
      const parsed = JSON.parse(saved);
      if (parsed && typeof parsed.code === 'string') return parsed;
    }
  } catch {}
  return DEFAULT_SHORTCUT;
}

function saveShortcut(value) {
  shortcut = value;
  try { localStorage.setItem('exitShortcut', value ? JSON.stringify(value) : 'off'); } catch {}
  updateShortcutLabels();
}

function keyName(code) {
  if (CODE_NAMES[code]) return CODE_NAMES[code];
  const m = code.match(/^(?:Key|Digit)(.)$/) || code.match(/^Numpad(.+)$/);
  if (m) return code.startsWith('Numpad') ? `Num ${m[1]}` : m[1];
  return code; // F1 등
}

function shortcutLabel(sc) {
  if (!sc) return '없음';
  return [sc.ctrl && 'Ctrl', sc.alt && 'Alt', sc.shift && 'Shift', sc.meta && 'Cmd', keyName(sc.code)].filter(Boolean).join(' + ');
}

function matchesShortcut(e, sc) {
  return !!sc && e.code === sc.code && e.ctrlKey === !!sc.ctrl && e.altKey === !!sc.alt &&
    e.shiftKey === !!sc.shift && e.metaKey === !!sc.meta;
}

// 글자/숫자/스페이스만 단독으로 정했다면, 검색창에 입력하는 중에는 나가지 않는다 (글자를 칠 수 있게).
function isTypingKey(sc) {
  return !sc.ctrl && !sc.alt && !sc.meta && /^(Key.|Digit.|Space|Numpad\d)$/.test(sc.code);
}

function isTypingTarget(target) {
  return target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
}

window.addEventListener('keydown', (e) => {
  if (recording) return;
  if (!matchesShortcut(e, shortcut)) return;
  if (isTypingKey(shortcut) && isTypingTarget(e.target)) return;
  e.preventDefault();
  quickExit();
}, true);

// ---------- 단축키 설정 창 ----------

const settingsDialog = document.getElementById('settingsDialog');
const shortcutLabelEl = document.getElementById('shortcutLabel');
const shortcutChangeBtn = document.getElementById('shortcutChange');
const exitBtn = document.getElementById('exitBtn');

function updateShortcutLabels() {
  shortcutLabelEl.textContent = shortcutLabel(shortcut);
  exitBtn.title = shortcut ? `빠른 나가기 (${shortcutLabel(shortcut)})` : '빠른 나가기';
}

function stopRecording() {
  recording = false;
  shortcutChangeBtn.textContent = '바꾸기';
  shortcutChangeBtn.classList.remove('recording');
  window.removeEventListener('keydown', recordKey, true);
}

function recordKey(e) {
  if (MODIFIER_CODES.test(e.code) || !e.code) return; // Ctrl 같은 키만 누른 상태면 다음 키를 기다린다
  e.preventDefault();
  e.stopPropagation();
  saveShortcut({ code: e.code, ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey, meta: e.metaKey });
  stopRecording();
}

shortcutChangeBtn.addEventListener('click', () => {
  if (recording) return stopRecording();
  recording = true;
  shortcutChangeBtn.textContent = '원하는 키를 누르세요…';
  shortcutChangeBtn.classList.add('recording');
  window.addEventListener('keydown', recordKey, true);
});

document.getElementById('shortcutReset').addEventListener('click', () => { stopRecording(); saveShortcut(DEFAULT_SHORTCUT); });
document.getElementById('shortcutOff').addEventListener('click', () => { stopRecording(); saveShortcut(null); });
document.getElementById('settingsClose').addEventListener('click', () => settingsDialog.close());
document.getElementById('settingsBtn').addEventListener('click', () => {
  updateShortcutLabels();
  settingsDialog.showModal();
});

// 키를 기다리는 중에 Esc 를 누르면 창이 닫히는 대신 Esc 가 단축키로 저장되게 한다.
settingsDialog.addEventListener('cancel', (e) => { if (recording) e.preventDefault(); });
settingsDialog.addEventListener('close', stopRecording);
settingsDialog.addEventListener('click', (e) => { if (e.target === settingsDialog) settingsDialog.close(); });

updateShortcutLabels();

// 플레이어(iframe)를 클릭하면 키 입력이 플레이어로 가버려서 단축키가 안 먹힌다.
// 클릭은 그대로 전달하고, 포커스만 바로 페이지로 되돌린다.
const focusSink = el('div', { tabindex: '-1', 'aria-hidden': 'true', style: 'position:fixed;width:0;height:0;overflow:hidden' });
document.body.append(focusSink);
window.addEventListener('blur', () => {
  setTimeout(() => {
    if (document.activeElement?.tagName === 'IFRAME') focusSink.focus({ preventScroll: true });
  }, 0);
});

loadMe().then(route);
