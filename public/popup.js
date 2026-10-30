// 팝업 플레이어: /popup.html?v=<영상ID>&t=<시작 초>
// 정해 둔 단축키(기본 Q)를 누르면 팝업 창이 바로 닫힌다. 자동재생이 켜져 있으면 끝난 뒤 다음 영상으로 넘어간다.
import {
  POPUP_SHORTCUT_KEY, DEFAULT_POPUP_SHORTCUT, loadShortcut, matchesShortcut, keepKeyboardFocus,
  loadJump, jumpChannel, isTypingKey, isTypingTarget
} from './shortcuts.js';
import {
  embedUrl, listenTo, readPlayerMessage, autostart, loadAutoplay, recordWatch, pickNext, savePopupBounds, ENDED, PAUSED,
  resumeTime, saveProgress, forgetProgress
} from './player.js';
import { applyDisguise, isDisguiseKey } from './disguise.js';

const VIDEO_ID = /^[\w-]{11}$/;
// 항상 위에 뜨는 창(Document Picture-in-Picture) 안에 넣어서 열었으면 그 창이 host 다.
// 닫기·크기 조절·크기 기억은 host 창에 한다. (일반 팝업 창으로 열었으면 host 는 자기 자신)
const host = window.parent !== window ? window.parent : window;
const inPip = host !== window;
const params = new URLSearchParams(location.search);
let currentId = params.get('v') || '';
// t 가 없으면(목록에서 바로 연 경우 등) 전에 보던 위치부터
const start = Math.max(0, Number.parseInt(params.get('t') || '0', 10) || 0) || resumeTime(currentId);

let playerState = -1;
let playerTime = 0;
let playerDuration = 0;
let currentMeta = null;
let lastSaved = 0;
let iframe = null;

// 이어보기: 몇 초마다, 멈췄을 때, 창을 닫을 때 위치를 저장한다
function saveNow(force) {
  if (playerState === ENDED || !(playerTime > 0)) return;
  if (!force && Date.now() - lastSaved < 5000) return;
  lastSaved = Date.now();
  saveProgress(currentId, playerTime, playerDuration, currentMeta);
}

function play(id, startAt = 0, meta = null) {
  currentId = id;
  currentMeta = meta;
  playerState = -1;
  playerTime = 0;
  playerDuration = 0;
  history.replaceState(null, '', `?v=${id}&t=${startAt}`);
  document.querySelector('.unmute-btn')?.remove();
  if (!iframe) {
    iframe = document.createElement('iframe');
    iframe.title = '동영상 플레이어';
    iframe.allow = 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share';
    iframe.allowFullscreen = true;
    iframe.referrerPolicy = 'strict-origin-when-cross-origin';
    iframe.addEventListener('load', () => {
      listenTo(iframe);
      autostart(iframe, () => playerState, document.body);
    });
    document.body.append(iframe);
  }
  iframe.src = embedUrl(id, `&start=${startAt}`);
}

async function playNext() {
  if (!loadAutoplay()) return;
  try {
    const res = await fetch(`/api/video?id=${encodeURIComponent(currentId)}`);
    if (!res.ok) return;
    const next = pickNext((await res.json()).related, currentId);
    if (!next) return;
    recordWatch(next.id);
    play(next.id, 0, { title: next.title, channel: next.channel });
  } catch {}
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
    if (ended) {
      forgetProgress(currentId);
      playNext();
    }
    if (paused) saveNow(true);
  }
  saveNow(false);
});
window.addEventListener('pagehide', () => saveNow(true));

if (VIDEO_ID.test(currentId)) {
  play(currentId, start);
} else {
  const p = document.createElement('p');
  p.className = 'message';
  p.textContent = '영상을 찾을 수 없어요.';
  document.body.append(p);
}

let shortcut = loadShortcut(POPUP_SHORTCUT_KEY, DEFAULT_POPUP_SHORTCUT);
// 메인 화면 설정에서 단축키를 바꾸면 열려 있는 팝업에도 바로 적용한다.
window.addEventListener('storage', (e) => {
  if (e.key === POPUP_SHORTCUT_KEY) shortcut = loadShortcut(POPUP_SHORTCUT_KEY, DEFAULT_POPUP_SHORTCUT);
});

const channel = jumpChannel();

function onKey(e) {
  // 이동 단축키: 메인 화면에 알려서 정한 사이트로 바꾸고 팝업은 닫는다
  const jump = loadJump();
  if (jump && matchesShortcut(e, jump.shortcut) && !(isTypingKey(jump.shortcut) && isTypingTarget(e.target))) {
    e.preventDefault();
    saveNow(true);
    channel?.postMessage('jump');
    document.body.replaceChildren();
    host.close();
    return;
  }
  if (matchesShortcut(e, shortcut)) {
    e.preventDefault();
    saveNow(true);
    rememberBounds();
    document.body.replaceChildren();
    host.close();
    return;
  }
  // - 와 = 키로 창 크기 조절
  if (e.ctrlKey || e.altKey || e.metaKey) return;
  if (e.code === 'Minus' || e.code === 'NumpadSubtract') { e.preventDefault(); resizePopup(1 / 1.25); }
  if (e.code === 'Equal' || e.code === 'NumpadAdd') { e.preventDefault(); resizePopup(1.25); }
}
window.addEventListener('keydown', onKey, true);
// 항상 위 창에서는 바깥 창에 초점이 있을 때도 키를 받는다.
if (inPip) host.addEventListener('keydown', onKey, true);

// ---------- 창 크기 조절: 오른쪽 위 − + 버튼, - = 키. 16:9 비율을 유지한다 ----------

const MIN_WIDTH = 320;

function resizePopup(factor) {
  const width = Math.round(Math.min(Math.max(host.innerWidth * factor, MIN_WIDTH), screen.availWidth - 20));
  const height = Math.round(width * 9 / 16);
  try {
    host.resizeTo(width + (host.outerWidth - host.innerWidth), height + (host.outerHeight - host.innerHeight));
  } catch {}
}

const sizeBar = document.createElement('div');
sizeBar.className = 'size-bar';
for (const [label, title, factor] of [['−', '작게 (- 키)', 1 / 1.25], ['+', '크게 (= 키)', 1.25]]) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.textContent = label;
  btn.title = title;
  btn.setAttribute('aria-label', title);
  btn.addEventListener('click', () => resizePopup(factor));
  sizeBar.append(btn);
}
document.body.append(sizeBar);

// 다음에 열 때 같은 크기와 위치로 열리도록 기억한다.
function rememberBounds() {
  savePopupBounds({ width: host.innerWidth, height: host.innerHeight, left: host.screenX, top: host.screenY });
}
let resizeTimer;
host.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(rememberBounds, 300);
});
window.addEventListener('pagehide', rememberBounds);
if (inPip) host.addEventListener('pagehide', () => { saveNow(true); rememberBounds(); });

// 탭 모양(제목·아이콘)은 메인 화면 설정을 따른다.
applyDisguise();
window.addEventListener('storage', (e) => {
  if (isDisguiseKey(e.key)) applyDisguise();
});

keepKeyboardFocus();
