// 팝업 플레이어: /popup.html?v=<영상ID>&t=<시작 초>
// 정해 둔 단축키(기본 Q)를 누르면 팝업 창이 바로 닫힌다. 자동재생이 켜져 있으면 끝난 뒤 다음 영상으로 넘어간다.
import {
  POPUP_SHORTCUT_KEY, DEFAULT_POPUP_SHORTCUT, loadShortcut, matchesShortcut, keepKeyboardFocus
} from './shortcuts.js';
import {
  embedUrl, listenTo, readPlayerMessage, autostart, loadAutoplay, recordWatch, pickNext, ENDED
} from './player.js';

const VIDEO_ID = /^[\w-]{11}$/;
const params = new URLSearchParams(location.search);
let currentId = params.get('v') || '';
const start = Math.max(0, Number.parseInt(params.get('t') || '0', 10) || 0);

let playerState = -1;
let iframe = null;

function play(id, startAt = 0) {
  currentId = id;
  playerState = -1;
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
    play(next.id);
  } catch {}
}

window.addEventListener('message', (e) => {
  const msg = readPlayerMessage(e);
  if (msg?.state === undefined) return;
  const ended = msg.state === ENDED && playerState !== ENDED;
  playerState = msg.state;
  if (ended) playNext();
});

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

window.addEventListener('keydown', (e) => {
  if (!matchesShortcut(e, shortcut)) return;
  e.preventDefault();
  document.body.replaceChildren();
  window.close();
}, true);

keepKeyboardFocus();
