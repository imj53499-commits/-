// 팝업 플레이어: /popup.html?v=<영상ID>&t=<시작 초>
// 정해 둔 단축키(기본 Q)를 누르면 팝업 창이 바로 닫힌다.
import {
  POPUP_SHORTCUT_KEY, DEFAULT_POPUP_SHORTCUT, loadShortcut, matchesShortcut, keepKeyboardFocus
} from './shortcuts.js';

const params = new URLSearchParams(location.search);
const id = params.get('v') || '';
const start = Math.max(0, Number.parseInt(params.get('t') || '0', 10) || 0);

if (/^[\w-]{11}$/.test(id)) {
  const iframe = document.createElement('iframe');
  iframe.src = `https://www.youtube-nocookie.com/embed/${id}?autoplay=1&rel=0&playsinline=1&start=${start}`;
  iframe.title = '동영상 플레이어';
  iframe.allow = 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share';
  iframe.allowFullscreen = true;
  iframe.referrerPolicy = 'strict-origin-when-cross-origin';
  document.body.append(iframe);
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
