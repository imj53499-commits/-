import { test } from 'node:test';
import assert from 'node:assert/strict';
import { proxify, rewriteCss, rewriteSrcset, isBlockedHost, parseProxyUrl, makeToken, checkToken, handleProxy } from '../src/proxy.js';

const P = '/p/tok/';
const BASE = 'https://example.com/dir/page.html';

test('proxify: 상대·절대·루트 주소를 프록시 주소로', () => {
  assert.equal(proxify('img/a.png', BASE, P), '/p/tok/https/example.com/dir/img/a.png');
  assert.equal(proxify('/x?y=1', BASE, P), '/p/tok/https/example.com/x?y=1');
  assert.equal(proxify('//cdn.net/a.js', BASE, P), '/p/tok/https/cdn.net/a.js');
  assert.equal(proxify('http://other.org/', BASE, P), '/p/tok/http/other.org/');
  for (const keep of ['#top', 'javascript:void 0', 'data:image/png;base64,AA', 'mailto:a@b.c', '/p/tok/https/a.com/']) {
    assert.equal(proxify(keep, BASE, P), keep);
  }
});

test('CSS·srcset 바꾸기', () => {
  assert.equal(rewriteCss('a{background:url("b.png")} @import "c.css";', BASE, P),
    'a{background:url("/p/tok/https/example.com/dir/b.png")} @import "/p/tok/https/example.com/dir/c.css";');
  assert.equal(rewriteCss('url(data:x)', BASE, P), 'url(data:x)');
  assert.equal(rewriteSrcset('a.png 1x, /b.png 2x', BASE, P),
    '/p/tok/https/example.com/dir/a.png 1x, /p/tok/https/example.com/b.png 2x');
});

test('내부 주소는 막는다', () => {
  for (const h of ['localhost', '127.0.0.1', '10.1.2.3', '192.168.0.1', '172.20.0.1', '169.254.169.254', '[::1]', '2130706433', 'x.internal']) {
    assert.equal(isBlockedHost(h), true, h);
  }
  for (const h of ['example.com', '8.8.8.8', '172.32.0.1']) assert.equal(isBlockedHost(h), false, h);
});

test('주소 해석', () => {
  const r = parseProxyUrl(new URL('https://me.dev/p/abc/https/ko.wikipedia.org/wiki/A?x=1'));
  assert.equal(r.token, 'abc');
  assert.equal(r.target.href, 'https://ko.wikipedia.org/wiki/A?x=1');
  assert.equal(parseProxyUrl(new URL('https://me.dev/p/abc/ftp/x.com/')), null);
});

test('표: 서명·만료 확인', async () => {
  const t = await makeToken('pw', Date.now() + 1000);
  assert.equal(await checkToken('pw', t), true);
  assert.equal(await checkToken('other', t), false);
  assert.equal(await checkToken('pw', t, Date.now() + 5000), false);
  assert.equal(await checkToken('pw', t.slice(0, -1) + (t.endsWith('0') ? '1' : '0')), false);
});

test('handleProxy: 표가 없으면 막고, 쿠키는 안 보내고, 응답에 sandbox 를 붙인다', async () => {
  const env = { DB: {}, ADMIN_PASSWORD: 'pw' };
  let sent = null;
  const fake = async (url, init) => {
    sent = { url, init };
    return new Response('body{background:url(/bg.png)}', {
      headers: { 'content-type': 'text/css', 'set-cookie': 'a=1', 'x-frame-options': 'DENY' }
    });
  };
  const bad = await handleProxy(new Request('https://me.dev/p/nope/https/example.com/a.css'), env, fake);
  assert.equal(bad.status, 403);
  assert.equal(sent, null);

  const tok = await makeToken('pw', Date.now() + 60000);
  const res = await handleProxy(new Request(`https://me.dev/p/${tok}/https/example.com/a.css`, {
    headers: { cookie: 'sy_session=secret' }
  }), env, fake);
  assert.equal(sent.url, 'https://example.com/a.css');
  assert.equal(sent.init.headers.get('cookie'), null);
  assert.equal(res.headers.get('set-cookie'), null);
  assert.equal(res.headers.get('x-frame-options'), null);
  assert.match(res.headers.get('content-security-policy'), /^sandbox /);
  assert.equal(await res.text(), `body{background:url(/p/${tok}/https/example.com/bg.png)}`);

  const local = await handleProxy(new Request(`https://me.dev/p/${tok}/http/127.0.0.1/`), env, fake);
  assert.equal(local.status, 403);
});

test('handleProxy: 다른 곳으로 보내기(redirect) 주소도 바꾼다', async () => {
  const env = { DB: {}, ADMIN_PASSWORD: 'pw' };
  const tok = await makeToken('pw', Date.now() + 60000);
  const res = await handleProxy(new Request(`https://me.dev/p/${tok}/https/example.com/`), env,
    async () => new Response(null, { status: 301, headers: { location: 'https://www.example.com/' } }));
  assert.equal(res.status, 301);
  assert.equal(res.headers.get('location'), `/p/${tok}/https/www.example.com/`);
});

test('표는 6시간 단위라 같은 시간대엔 같고, 6~12시간 남는다', async () => {
  const { tokenResponse } = await import('../src/proxy.js');
  const env = { ADMIN_PASSWORD: 'pw' };
  const a = await (await tokenResponse(env, { role: 'user' })).json();
  const b = await (await tokenResponse(env, { role: 'user' })).json();
  assert.equal(a.token, b.token);
  const left = a.expiresAt - Date.now();
  assert.ok(left > 6 * 3600e3 - 1000 && left <= 12 * 3600e3, String(left));
});

test('그림은 캐시 시간을 붙이고, 페이지(HTML 아님)·API 응답은 그대로 둔다', async () => {
  const env = { DB: {}, ADMIN_PASSWORD: 'pw' };
  const tok = await makeToken('pw', Date.now() + 60000);
  let init = null;
  const img = await handleProxy(new Request(`https://me.dev/p/${tok}/https/example.com/a.png`, { headers: { 'sec-fetch-dest': 'image' } }), env,
    async (u, i) => { init = i; return new Response('x', { headers: { 'content-type': 'image/png', 'cache-control': 'no-cache' } }); });
  assert.equal(img.headers.get('cache-control'), 'public, max-age=86400');
  assert.equal(init.cf.cacheEverything, true);
  const apiRes = await handleProxy(new Request(`https://me.dev/p/${tok}/https/example.com/api`, { headers: { 'sec-fetch-dest': 'empty' } }), env,
    async (u, i) => { init = i; return new Response('{}', { headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } }); });
  assert.equal(apiRes.headers.get('cache-control'), 'no-store');
  assert.equal(init.cf, undefined);
});
