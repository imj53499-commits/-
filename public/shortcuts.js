// 단축키 저장/비교 도우미. 메인 화면(app.js)과 팝업(popup.js)이 같이 쓴다.
// 키는 e.code 로 비교해서 한/영 상태와 상관없이 같은 키로 동작한다. 설정은 이 브라우저의 localStorage 에 저장된다.

export const COVER_SHORTCUT_KEY = 'exitShortcut';
export const POPUP_SHORTCUT_KEY = 'popupShortcut';
export const DEFAULT_COVER_SHORTCUT = { code: 'Backquote', ctrl: false, alt: false, shift: false, meta: false };
export const DEFAULT_POPUP_SHORTCUT = { code: 'KeyQ', ctrl: false, alt: false, shift: false, meta: false };

export const MODIFIER_CODES = /^(Control|Shift|Alt|Meta|OS)(Left|Right)?$|^(CapsLock|Fn|HangulMode|Hanja|Lang1|Lang2)$/;

const CODE_NAMES = {
  Backquote: '`', Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Backslash: '\\',
  Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/', Space: 'Space', Escape: 'Esc',
  Enter: 'Enter', Tab: 'Tab', Backspace: 'Backspace', Delete: 'Delete', Insert: 'Insert',
  Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown',
  ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', IntlBackslash: '\\'
};

export function loadShortcut(storageKey, fallback) {
  try {
    const saved = localStorage.getItem(storageKey);
    if (saved === 'off') return null;
    if (saved) {
      const parsed = JSON.parse(saved);
      if (parsed && typeof parsed.code === 'string') return parsed;
    }
  } catch {}
  return fallback;
}

export function storeShortcut(storageKey, value) {
  try { localStorage.setItem(storageKey, value ? JSON.stringify(value) : 'off'); } catch {}
}

export function shortcutFromEvent(e) {
  return { code: e.code, ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey, meta: e.metaKey };
}

function keyName(code) {
  if (CODE_NAMES[code]) return CODE_NAMES[code];
  const m = code.match(/^(?:Key|Digit)(.)$/) || code.match(/^Numpad(.+)$/);
  if (m) return code.startsWith('Numpad') ? `Num ${m[1]}` : m[1];
  return code; // F1 등
}

export function shortcutLabel(sc) {
  if (!sc) return '없음';
  return [sc.ctrl && 'Ctrl', sc.alt && 'Alt', sc.shift && 'Shift', sc.meta && 'Cmd', keyName(sc.code)].filter(Boolean).join(' + ');
}

export function matchesShortcut(e, sc) {
  return !!sc && e.code === sc.code && e.ctrlKey === !!sc.ctrl && e.altKey === !!sc.alt &&
    e.shiftKey === !!sc.shift && e.metaKey === !!sc.meta;
}

// 글자/숫자/스페이스만 단독으로 정했다면, 입력칸에 글자를 치는 중에는 단축키로 보지 않는다.
export function isTypingKey(sc) {
  return !sc.ctrl && !sc.alt && !sc.meta && /^(Key.|Digit.|Space|Numpad\d)$/.test(sc.code);
}

export function isTypingTarget(target) {
  return target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
}

// 플레이어(iframe)를 클릭하면 키 입력이 플레이어로 가버려서 단축키가 안 먹힌다.
// 클릭은 그대로 전달하고, 포커스만 바로 페이지로 되돌린다.
export function keepKeyboardFocus() {
  const sink = document.createElement('div');
  sink.tabIndex = -1;
  sink.setAttribute('aria-hidden', 'true');
  sink.style.cssText = 'position:fixed;width:0;height:0;overflow:hidden';
  document.body.append(sink);
  window.addEventListener('blur', () => {
    setTimeout(() => {
      if (document.activeElement?.tagName === 'IFRAME') sink.focus({ preventScroll: true });
    }, 0);
  });
  return sink;
}
