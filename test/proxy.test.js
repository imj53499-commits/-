import { test } from 'node:test';
import assert from 'node:assert/strict';
import { proxify, rewriteCss, rewriteSrcset, isBlockedHost, parseProxyUrl, makeToken, checkToken, handleProxy } from '../src/proxy.js';

const P = '/p/tok/';
const X = (origin) => 'x/' + Buffer.from(origin).toString('base64url');
const BASE = 'https://example.com/dir/page.html';

test('proxify: 상대·절대·루트 주소를 프록시 주소로', () => {
  assert.equal(proxify('img/a.png', BASE, P), `/p/tok/${X('https://example.com')}/dir/img/a.png`);
  assert.equal(proxify('/x?y=1', BASE, P), `/p/tok/${X('https://example.com')}/x?y=1`);
  assert.equal(proxify('//cdn.net/a.js', BASE, P), `/p/tok/${X('https://cdn.net')}/a.js`);
  assert.equal(proxify('http://other.org/', BASE, P), `/p/tok/${X('http://other.org')}/`);
  assert.doesNotMatch(proxify('https://comic.naver.com/webtoon', BASE, P), /naver/);
  for (const keep of ['#top', 'javascript:void 0', 'data:image/png;base64,AA', 'mailto:a@b.c', '/p/tok/https/a.com/']) {
    assert.equal(proxify(keep, BASE, P), keep);
  }
});

test('CSS·srcset 바꾸기', () => {
  assert.equal(rewriteCss('a{background:url("b.png")} @import "c.css";', BASE, P),
    `a{background:url("/p/tok/${X('https://example.com')}/dir/b.png")} @import "/p/tok/${X('https://example.com')}/dir/c.css";`);
  assert.equal(rewriteCss('url(data:x)', BASE, P), 'url(data:x)');
  assert.equal(rewriteSrcset('a.png 1x, /b.png 2x', BASE, P),
    `/p/tok/${X('https://example.com')}/dir/a.png 1x, /p/tok/${X('https://example.com')}/b.png 2x`);
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
  assert.equal(await checkToken('pw', t), 'admin');
  assert.equal(await checkToken('other', t), '');
  assert.equal(await checkToken('pw', t, Date.now() + 5000), '');
  assert.equal(await checkToken('pw', t.slice(0, -1) + (t.endsWith('0') ? '1' : '0')), '');
  // 누구인지도 표에 들어 있고, 바꿔치기하면 서명이 안 맞는다
  const u = await makeToken('pw', Date.now() + 1000, 'u:민수');
  assert.equal(await checkToken('pw', u), 'u:민수');
  const [exp, , sig] = u.split('.');
  const forged = `${exp}.${Buffer.from('admin').toString('base64url')}.${sig}`;
  assert.equal(await checkToken('pw', forged), '');
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
  assert.equal(await res.text(), `body{background:url(/p/${tok}~${X('https://example.com').slice(2)}/${X('https://example.com')}/bg.png)}`);

  const local = await handleProxy(new Request(`https://me.dev/p/${tok}/http/127.0.0.1/`), env, fake);
  assert.equal(local.status, 403);
});

test('handleProxy: 다른 곳으로 보내기(redirect) 주소도 바꾼다', async () => {
  const env = { DB: {}, ADMIN_PASSWORD: 'pw' };
  const tok = await makeToken('pw', Date.now() + 60000);
  const res = await handleProxy(new Request(`https://me.dev/p/${tok}/https/example.com/`), env,
    async () => new Response(null, { status: 301, headers: { location: 'https://www.example.com/' } }));
  assert.equal(res.status, 301);
  assert.equal(res.headers.get('location'), `/p/${tok}~${X('https://example.com').slice(2)}/${X('https://www.example.com')}/`);
});

test('표는 6시간 단위라 같은 시간대엔 같고, 6~12시간 남는다', async () => {
  const { tokenResponse } = await import('../src/proxy.js');
  const env = { ADMIN_PASSWORD: 'pw' };
  const a = await (await tokenResponse(env, { role: 'user', username: 'MinSu' })).json();
  const b = await (await tokenResponse(env, { role: 'user', username: 'minsu' })).json();
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

test('Referer: 프록시 페이지 주소를 원래 사이트 주소로 바꿔서 보낸다 (네이버웹툰 그림 등)', async () => {
  const { realReferer } = await import('../src/proxy.js');
  assert.equal(realReferer('https://me.dev/p/tok/https/comic.naver.com/webtoon/detail?titleId=1', 'https://me.dev'),
    'https://comic.naver.com/webtoon/detail?titleId=1');
  assert.equal(realReferer('https://evil.dev/p/tok/https/a.com/', 'https://me.dev'), '');
  assert.equal(realReferer(null, 'https://me.dev'), '');

  const env = { DB: {}, ADMIN_PASSWORD: 'pw' };
  const tok = await makeToken('pw', Date.now() + 60000);
  let sent;
  await handleProxy(new Request(`https://me.dev/p/${tok}/https/image-comic.pstatic.net/a.jpg`, {
    headers: { referer: `https://me.dev/p/${tok}/https/comic.naver.com/webtoon/detail?titleId=1` }
  }), env, async (u, i) => { sent = i.headers.get('referer'); return new Response('x', { headers: { 'content-type': 'image/jpeg' } }); });
  assert.equal(sent, 'https://comic.naver.com/webtoon/detail?titleId=1');
});

test('페이지 안 주소에 붙은 사이트를 Referer 로 보낸다 (격리된 페이지는 브라우저가 Referer 를 안 보냄)', async () => {
  const env = { DB: {}, ADMIN_PASSWORD: 'pw' };
  const tok = await makeToken('pw', Date.now() + 60000);
  let sent;
  const fake = async (u, i) => { sent = i.headers.get('referer'); return new Response('x', { headers: { 'content-type': 'image/jpeg' } }); };
  const ok = await handleProxy(new Request(`https://me.dev/p/${tok}~https~comic.naver.com/https/image-comic.pstatic.net/a.jpg`), env, fake);
  assert.equal(ok.status, 200);
  assert.equal(sent, 'https://comic.naver.com/');
  // 이상한 값은 무시하고 원래 사이트 주소를 쓴다
  await handleProxy(new Request(`https://me.dev/p/${tok}~ftp~x y/https/image-comic.pstatic.net/a.jpg`), env, fake);
  assert.equal(sent, 'https://image-comic.pstatic.net/');
  // 표가 틀리면 사이트가 붙어 있어도 막힌다
  assert.equal((await handleProxy(new Request('https://me.dev/p/bad~https~a.com/https/b.com/'), env, fake)).status, 403);
});

test('페이지에 넣는 스크립트는 문법 오류가 없다', async () => {
  const { clientScript } = await import('../src/proxy.js');
  const html = clientScript('https://comic.naver.com/웹툰?a=1', `/p/tok~${X('https://comic.naver.com').slice(2)}/`, 404);
  const js = html.replace(/^<script>/, '').replace(/<\/script>$/, '');
  assert.doesNotThrow(() => new Function(js));
  assert.match(js, /new RegExp\('\^\/p\/\[\^\/\]\+\/\(\?:\(https\?\)\/\(\[\^\/\]\+\)\|x\/\(\[A-Za-z0-9_-\]\+\)\)\(\/\.\*\)\?\$'\)/);
});

test('감춘 사이트 주소 읽기 (새 모양·예전 모양 모두, 이상한 값은 거절)', async () => {
  const { parseProxyUrl } = await import('../src/proxy.js');
  const n = parseProxyUrl(new URL(`https://me.dev/p/tok~${X('https://comic.naver.com').slice(2)}/${X('https://image-comic.pstatic.net')}/a.jpg?x=1`));
  assert.equal(n.token, 'tok');
  assert.equal(n.referer, 'https://comic.naver.com/');
  assert.equal(n.target.href, 'https://image-comic.pstatic.net/a.jpg?x=1');
  const old = parseProxyUrl(new URL('https://me.dev/p/tok~https~comic.naver.com/https/a.com/b'));
  assert.equal(old.referer, 'https://comic.naver.com/');
  assert.equal(old.target.href, 'https://a.com/b');
  assert.equal(parseProxyUrl(new URL(`https://me.dev/p/tok/${X('javascript:alert(1)')}/`)), null);
  assert.equal(parseProxyUrl(new URL(`https://me.dev/p/tok/${X('https://a.com/evil')}/`)), null);
});
