// YouTube 임베드 플레이어 공통 도우미. 메인 화면(app.js)과 팝업(popup.js)이 같이 쓴다.
// 플레이어 상태: -1 시작 전, 0 끝남, 1 재생 중, 2 일시정지, 3 버퍼링, 5 대기(재생 안 됨)

export const PLAYER_ORIGIN = /^https:\/\/www\.youtube(-nocookie)?\.com$/;
export const ENDED = 0;
export const PLAYING = 1;
export const PAUSED = 2;
export const BUFFERING = 3;

// 처음 열었을 때 이 시간 안에 재생이 시작되지 않으면(브라우저의 자동재생 차단) 소리를 끄고 다시 재생한다.
const AUTOSTART_TIMEOUT = 2500;

export function embedUrl(id, extra = '') {
  return `https://www.youtube-nocookie.com/embed/${id}?autoplay=1&rel=0&playsinline=1&enablejsapi=1` +
    `&origin=${encodeURIComponent(location.origin)}${extra}`;
}

export function sendToPlayer(iframe, func, args = []) {
  iframe?.contentWindow?.postMessage(JSON.stringify({ event: 'command', func, args }), '*');
}

// 플레이어가 상태를 보내 주도록 등록한다. iframe 의 load 이벤트에서 부른다.
export function listenTo(iframe) {
  iframe?.contentWindow?.postMessage(JSON.stringify({ event: 'listening', id: 1, channel: 'widget' }), '*');
}

// 플레이어가 보낸 메시지에서 { state, time } 을 꺼낸다. YouTube 메시지가 아니면 null.
export function readPlayerMessage(e) {
  if (!PLAYER_ORIGIN.test(e.origin)) return null;
  let data;
  try { data = typeof e.data === 'string' ? JSON.parse(e.data) : e.data; } catch { return null; }
  if (!data || typeof data !== 'object') return null;
  const out = {};
  if (data.event === 'onStateChange' && typeof data.info === 'number') out.state = data.info;
  if (typeof data.info?.playerState === 'number') out.state = data.info.playerState;
  if (typeof data.info?.currentTime === 'number') out.time = data.info.currentTime;
  return out;
}

// 자동재생이 막혀 시작되지 않았으면 음소거로 재생하고 "소리 켜기" 버튼을 띄운다.
// getState: 현재 플레이어 상태를 돌려주는 함수, container: 버튼을 붙일 곳(플레이어를 감싼 요소)
export function autostart(iframe, getState, container) {
  setTimeout(() => {
    if (!iframe.isConnected || ![-1, 5].includes(getState())) return;
    sendToPlayer(iframe, 'mute');
    sendToPlayer(iframe, 'playVideo');
    container.querySelector('.unmute-btn')?.remove();
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'unmute-btn';
    btn.textContent = '🔇 소리 켜기';
    btn.addEventListener('click', () => {
      sendToPlayer(iframe, 'unMute');
      sendToPlayer(iframe, 'playVideo');
      btn.remove();
    });
    container.append(btn);
  }, AUTOSTART_TIMEOUT);
}

// ---------- 다음 영상 자동재생 설정 ----------

const AUTOPLAY_KEY = 'autoplayNext';

export function loadAutoplay() {
  try { return localStorage.getItem(AUTOPLAY_KEY) !== 'off'; } catch { return true; }
}

export function saveAutoplay(on) {
  try { localStorage.setItem(AUTOPLAY_KEY, on ? 'on' : 'off'); } catch {}
}

// ---------- 시청 기록 (이 브라우저에만 저장, 추천과 다음 영상 고르기에 사용) ----------

const HISTORY_KEY = 'watchHistory';
const HISTORY_MAX = 50;

export function loadHistory() {
  try {
    const list = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
    return Array.isArray(list) ? list.filter((h) => /^[\w-]{11}$/.test(h?.id || '')) : [];
  } catch {
    return [];
  }
}

export function recordWatch(id) {
  const list = [{ id, at: Date.now() }, ...loadHistory().filter((h) => h.id !== id)].slice(0, HISTORY_MAX);
  try { localStorage.setItem(HISTORY_KEY, JSON.stringify(list)); } catch {}
}

export function clearHistory() {
  try { localStorage.removeItem(HISTORY_KEY); } catch {}
}

// 관련 영상 중 아직 안 본 첫 영상. 다 봤으면 첫 번째.
export function pickNext(related, currentId) {
  const watched = new Set(loadHistory().map((h) => h.id));
  const candidates = (related || []).filter((v) => v.id !== currentId && !v.isShort);
  return candidates.find((v) => !watched.has(v.id)) || candidates[0] || null;
}
