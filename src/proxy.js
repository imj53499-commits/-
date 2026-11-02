// 웹 프록시 (/p/*): 로그인한 사람만, 다른 사이트를 이 서버를 거쳐서 열어 준다.
//
// 주소 모양: /p/<표>/<https|http>/<호스트>/<경로>?<쿼리>
//   예) /p/1767000000.ab12…/https/ko.wikipedia.org/wiki/서울
// <표>는 /api/proxy/token 에서 받는 서명된 표(만료 시각 + HMAC). 페이지 안의 그림·CSS 요청마다
// KV 를 읽지 않으려고 쿠키 대신 주소에 넣는다 (KV 무료 읽기 한도 보호).
//
// 안전장치
//   - 프록시로 연 페이지에는 항상 `Content-Security-Policy: sandbox` 를 붙인다. 그래서 그 페이지는
//     이 사이트와 다른 출처(opaque origin)가 되어, 이 사이트의 로그인 쿠키·저장소·/api 를 건드릴 수 없다.
//   - 이 사이트 쿠키는 다른 사이트로 보내지 않고, 다른 사이트의 쿠키(Set-Cookie)도 받지 않는다.
//   - localhost, 사설 IP 등 내부 주소는 열지 않는다.

const TOKEN_TTL = 12 * 60 * 60 * 1000; // 12시간
export const PREFIX = '/p/';

const SANDBOX_CSP = 'sandbox allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads allow-pointer-lock';

// ---------- 표 (서명) ----------

async function hmacHex(secret, text) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(`proxy:${secret}`),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(text));
  return [...new Uint8Array(sig)].slice(0, 16).map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function makeToken(secret, expiresAt) {
  const exp = String(Math.floor(expiresAt));
  return `${exp}.${await hmacHex(secret, exp)}`;
}

export async function checkToken(secret, token, now = Date.now()) {
  const m = /^(\d{10,16})\.([0-9a-f]{32})$/.exec(token || '');
  if (!m || Number(m[1]) < now) return false;
  const want = await hmacHex(secret, m[1]);
  let diff = 0;
  for (let i = 0; i < want.length; i++) diff |= want.charCodeAt(i) ^ m[2].charCodeAt(i);
  return diff === 0;
}

// 로그인한 사람에게 표를 준다 (server.js 에서 세션 확인 뒤 부름)
export async function tokenResponse(env, session) {
  if (!env.ADMIN_PASSWORD) return jsonRes({ error: '프록시를 쓰려면 ADMIN_PASSWORD 를 설정해야 해요.' }, 503);
  let expiresAt = Date.now() + TOKEN_TTL;
  if (session.role === 'trial') expiresAt = Math.min(expiresAt, session.expiresAt);
  return jsonRes({ token: await makeToken(env.ADMIN_PASSWORD, expiresAt), expiresAt });
}

function jsonRes(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
  });
}

// ---------- 주소 바꾸기 ----------

// 내부망 주소는 막는다
export function isBlockedHost(hostname) {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!h || h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true;
  if (/^\d+$/.test(h)) return true; // 10진수 IP (예: 2130706433)
  const v4 = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(h);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  if (h.includes(':')) return h === '::' || h === '::1' || /^f[cd]/.test(h) || /^fe[89ab]/.test(h) || h.startsWith('::ffff:');
  return false;
}

// /p/<표>/https/host/path?q → { token, target: URL }
export function parseProxyUrl(url) {
  const m = /^\/p\/([^/]+)\/(https?)\/([^/?#]+)(\/[^?#]*)?$/.exec(url.pathname);
  if (!m) return null;
  let target;
  try {
    target = new URL(`${m[2]}://${m[3]}${m[4] || '/'}${url.search}`);
  } catch {
    return null;
  }
  return { token: m[1], target };
}

export function encodeTarget(u) {
  return `${u.protocol.slice(0, -1)}/${u.host}${u.pathname}${u.search}${u.hash}`;
}

// 페이지 안의 주소 하나를 프록시 주소로 바꾼다. base 는 원래 사이트 기준 주소.
export function proxify(raw, base, prefix) {
  const s = String(raw ?? '').trim();
  if (!s || s.startsWith('#') || /^(javascript|data|blob|mailto|tel|about|sms):/i.test(s)) return raw;
  if (s.startsWith(prefix)) return raw;
  let u;
  try {
    u = new URL(s, base);
  } catch {
    return raw;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return raw;
  return prefix + encodeTarget(u);
}

export function rewriteSrcset(value, base, prefix) {
  return String(value).split(',').map((part) => {
    const bits = part.trim().split(/\s+/);
    if (!bits[0]) return part;
    bits[0] = proxify(bits[0], base, prefix);
    return bits.join(' ');
  }).join(', ');
}

export function rewriteCss(css, base, prefix) {
  return css
    .replace(/url\(\s*(['"]?)([^'")]*)\1\s*\)/gi, (all, q, u) => `url(${q}${proxify(u, base, prefix)}${q})`)
    .replace(/@import\s+(['"])([^'"]+)\1/gi, (all, q, u) => `@import ${q}${proxify(u, base, prefix)}${q}`);
}

// ---------- 페이지에 넣는 스크립트 ----------
// fetch / XHR / window.open / 나중에 생기는 링크·그림 주소를 바꾸고, 바깥 화면(주소창)에 지금 주소를 알려 준다.

function clientScript(target, prefix) {
  return `<script>(function(){
var T=${JSON.stringify(target)},P=${JSON.stringify(prefix)},O=location.origin;
function px(r){try{var s=String(r);if(!s||/^(#|javascript:|data:|blob:|mailto:|tel:|about:)/i.test(s))return r;
if(s.indexOf(O+P)===0||s.indexOf(P)===0)return r;var u=new URL(s,T);if(u.origin===O)u=new URL(u.pathname+u.search+u.hash,T);
if(!/^https?:$/.test(u.protocol))return r;return P+u.protocol.slice(0,-1)+'/'+u.host+u.pathname+u.search+u.hash}catch(e){return r}}
window.__px=px;
var f=window.fetch;if(f)window.fetch=function(i,o){try{if(typeof i==='string'||i instanceof URL)i=px(String(i));else if(i&&i.url)i=new Request(px(i.url),i)}catch(e){}return f.call(this,i,o)};
var xo=XMLHttpRequest.prototype.open;XMLHttpRequest.prototype.open=function(m,u){arguments[1]=px(u);return xo.apply(this,arguments)};
var wo=window.open;window.open=function(u){if(u)arguments[0]=px(u);return wo.apply(this,arguments)};
if(navigator.sendBeacon){var sb=navigator.sendBeacon.bind(navigator);navigator.sendBeacon=function(u,d){return sb(px(u),d)}}
try{navigator.serviceWorker&&Object.defineProperty(navigator,'serviceWorker',{get:function(){return undefined}})}catch(e){}
var A=['src','href','action','poster','data'];
function fix(el){if(!el||el.nodeType!==1)return;for(var i=0;i<A.length;i++){var a=A[i];if(el.hasAttribute&&el.hasAttribute(a)){var v=el.getAttribute(a),n=px(v);if(n!==v)el.setAttribute(a,n)}}
if(el.hasAttribute&&el.hasAttribute('integrity'))el.removeAttribute('integrity')}
new MutationObserver(function(ms){ms.forEach(function(m){if(m.type==='attributes')fix(m.target);else m.addedNodes.forEach(function(n){fix(n);n.querySelectorAll&&n.querySelectorAll('[src],[href],[action],[poster]').forEach(fix)})})})
.observe(document.documentElement,{childList:true,subtree:true,attributes:true,attributeFilter:A});
document.addEventListener('submit',function(e){var fm=e.target;if(fm&&fm.getAttribute){var a=fm.getAttribute('action');if(a==null||a==='')fm.setAttribute('action',px(T));}},true);
function tell(){try{var p=location.pathname.split('/');var real=p[3]+'://'+p.slice(4).join('/')+location.search;parent!==window&&parent.postMessage({type:'proxy-page',url:decodeURI(real),title:document.title},'*')}catch(e){}}
tell();addEventListener('load',tell);addEventListener('popstate',tell);
})();</script>`;
}

// ---------- HTML 바꾸기 (Cloudflare HTMLRewriter) ----------

const ATTRS = [
  ['a', 'href'], ['area', 'href'], ['link', 'href'], ['img', 'src'], ['script', 'src'], ['iframe', 'src'],
  ['frame', 'src'], ['embed', 'src'], ['source', 'src'], ['track', 'src'], ['video', 'src'], ['video', 'poster'],
  ['audio', 'src'], ['input', 'src'], ['form', 'action'], ['button', 'formaction'], ['input', 'formaction'],
  ['object', 'data'], ['image', 'href'], ['use', 'href']
];

function rewriteHtml(res, target, prefix) {
  const state = { base: target.href, injected: false };
  const script = clientScript(target.href, prefix);
  let rw = new HTMLRewriter()
    .on('base[href]', {
      element(el) {
        try { state.base = new URL(el.getAttribute('href'), target.href).href; } catch { /* 그대로 */ }
        el.setAttribute('href', proxify(state.base, target.href, prefix));
      }
    })
    .on('head', {
      element(el) {
        if (!state.injected) { el.prepend(script, { html: true }); state.injected = true; }
      }
    })
    .on('body', {
      element(el) {
        if (!state.injected) { el.prepend(script, { html: true }); state.injected = true; }
      }
    })
    .on('[integrity]', { element(el) { el.removeAttribute('integrity'); } })
    .on('meta[http-equiv]', {
      element(el) {
        const eq = (el.getAttribute('http-equiv') || '').toLowerCase();
        if (eq === 'content-security-policy') el.remove();
        if (eq === 'refresh') {
          const c = el.getAttribute('content') || '';
          const m = /^(\s*\d+\s*;\s*url\s*=\s*)(['"]?)(.+?)\2\s*$/i.exec(c);
          if (m) el.setAttribute('content', m[1] + proxify(m[3], state.base, prefix));
        }
      }
    })
    .on('img[srcset], source[srcset]', {
      element(el) { el.setAttribute('srcset', rewriteSrcset(el.getAttribute('srcset'), state.base, prefix)); }
    })
    .on('[style]', {
      element(el) { el.setAttribute('style', rewriteCss(el.getAttribute('style'), state.base, prefix)); }
    });
  for (const [tag, attr] of ATTRS) {
    rw = rw.on(`${tag}[${attr}]`, {
      element(el) { el.setAttribute(attr, proxify(el.getAttribute(attr), state.base, prefix)); }
    });
  }
  // <style> 안의 url(...) 은 글자를 모아서 한 번에 바꾼다
  let buf = '';
  rw = rw.on('style', {
    text(t) {
      buf += t.text;
      if (t.lastInTextNode) { t.replace(rewriteCss(buf, state.base, prefix), { html: true }); buf = ''; }
      else t.remove();
    }
  });
  // <head>·<body> 가 없는 짧은 페이지는 맨 끝에 넣는다
  rw = rw.onDocument({
    end(end) {
      if (!state.injected) { end.append(script, { html: true }); state.injected = true; }
    }
  });
  return rw.transform(res);
}

// ---------- 안내 페이지 ----------

function notice(message, status) {
  const html = `<!DOCTYPE html><html lang="ko"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Google</title>
<style>body{font-family:system-ui,sans-serif;display:grid;place-items:center;min-height:90vh;margin:0;color:#333;background:#fff}
@media(prefers-color-scheme:dark){body{background:#0f0f0f;color:#eee}}div{max-width:420px;padding:24px;text-align:center;line-height:1.6}</style></head>
<body><div><p>${message}</p></div></body></html>`;
  return new Response(html, {
    status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': SANDBOX_CSP }
  });
}

// ---------- 요청 처리 ----------

const PASS_REQUEST_HEADERS = ['accept', 'accept-language', 'content-type', 'range', 'user-agent', 'if-none-match', 'if-modified-since', 'cache-control'];
const DROP_RESPONSE_HEADERS = [
  'content-security-policy', 'content-security-policy-report-only', 'x-frame-options', 'set-cookie',
  'strict-transport-security', 'cross-origin-opener-policy', 'cross-origin-embedder-policy',
  'cross-origin-resource-policy', 'permissions-policy', 'report-to', 'nel', 'clear-site-data',
  'access-control-allow-origin', 'access-control-allow-credentials', 'alt-svc', 'link'
];

export async function handleProxy(request, env, fetchFn = fetch) {
  const url = new URL(request.url);
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, HEAD',
        'Access-Control-Allow-Headers': request.headers.get('Access-Control-Request-Headers') || '*', 'Access-Control-Max-Age': '600'
      }
    });
  }
  if (!env.DB || !env.ADMIN_PASSWORD) return notice('프록시는 로그인 기능(KV 저장소 DB)과 ADMIN_PASSWORD 를 설정해야 쓸 수 있어요.', 503);
  const parsed = parseProxyUrl(url);
  if (!parsed) return notice('주소가 올바르지 않아요.', 400);
  if (!(await checkToken(env.ADMIN_PASSWORD, parsed.token))) {
    return notice('프록시 사용 시간이 끝났어요. 앱 목록에서 프록시를 다시 열어 주세요.', 403);
  }
  const { target } = parsed;
  if (isBlockedHost(target.hostname) || target.host === url.host) return notice('이 주소는 열 수 없어요.', 403);

  const prefix = `${PREFIX}${parsed.token}/`;
  const headers = new Headers();
  for (const h of PASS_REQUEST_HEADERS) {
    const v = request.headers.get(h);
    if (v) headers.set(h, v);
  }
  if (!headers.has('user-agent')) headers.set('user-agent', 'Mozilla/5.0');
  headers.set('referer', target.origin + '/');
  if (!['GET', 'HEAD'].includes(request.method)) headers.set('origin', target.origin);

  let upstream;
  try {
    upstream = await fetchFn(target.href, {
      method: request.method,
      headers,
      body: ['GET', 'HEAD'].includes(request.method) ? undefined : request.body,
      redirect: 'manual'
    });
  } catch {
    return notice(`${escapeHtml(target.host)} 에 연결하지 못했어요. 주소를 확인하거나 잠시 뒤 다시 해 보세요.`, 502);
  }

  const out = new Headers(upstream.headers);
  for (const h of DROP_RESPONSE_HEADERS) out.delete(h);
  out.set('Content-Security-Policy', SANDBOX_CSP);
  out.set('Access-Control-Allow-Origin', '*');
  out.set('X-Content-Type-Options', 'nosniff');
  out.set('X-Robots-Tag', 'noindex, nofollow');
  out.set('Referrer-Policy', 'no-referrer');

  const loc = upstream.headers.get('location');
  if (loc) out.set('location', proxify(loc, target.href, prefix));

  const type = (upstream.headers.get('content-type') || '').toLowerCase();
  const init = { status: upstream.status, statusText: upstream.statusText, headers: out };
  if (upstream.status >= 300 && upstream.status < 400 || request.method === 'HEAD' || !upstream.body) {
    return new Response(upstream.status === 204 || upstream.status === 304 || request.method === 'HEAD' ? null : upstream.body, init);
  }
  if (type.includes('text/html')) {
    out.delete('content-length');
    out.delete('content-encoding');
    out.delete('etag');
    return rewriteHtml(new Response(upstream.body, init), target, prefix);
  }
  if (type.includes('text/css')) {
    out.delete('content-length');
    out.delete('content-encoding');
    out.delete('etag');
    return new Response(rewriteCss(await upstream.text(), target.href, prefix), init);
  }
  return new Response(upstream.body, init);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
