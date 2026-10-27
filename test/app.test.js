import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { normalizeVideo } from '../src/normalize.js';

const text = (s) => ({ toString: () => s });

const video = (id, title) => ({
  type: 'Video',
  video_id: id,
  title: text(title),
  author: { id: 'UCaaaaaaaaaaaaaaaaaaaaaa', name: '테스트 채널', thumbnails: [{ url: 'https://yt3.ggpht.com/a.jpg', width: 68 }] },
  short_view_count: text('조회수 1.2만회'),
  published: text('3일 전'),
  duration: { text: '10:01' }
});

const lockup = (id, title) => ({
  type: 'LockupView',
  content_type: 'VIDEO',
  content_id: id,
  duration: { text: '3:21' },
  metadata: {
    title: text(title),
    image: { avatar: { image: [{ url: 'https://yt3.ggpht.com/b.jpg' }] } },
    metadata: {
      metadata_rows: [
        { metadata_parts: [{ text: { toString: () => '락업 채널', endpoint: { payload: { browseId: 'UCbbbbbbbbbbbbbbbbbbbbbb' } } } }] },
        { metadata_parts: [{ text: text('조회수 5천회') }, { text: text('1주 전') }] }
      ]
    }
  }
});

const fakeYt = {
  calls: [],
  async getHomeFeed() {
    this.calls.push('home');
    return { videos: [] }; // 비로그인 홈 피드가 비어 있는 상황
  },
  async search(q) {
    this.calls.push(`search:${q}`);
    return { videos: [video(`${q.length.toString().padStart(2, '0')}aaaaaaaaa`, `${q} 영상`), { type: 'Channel' }] };
  },
  async getSearchSuggestions(q) {
    return [`${q} 추천`, `${q} 노래`];
  },
  async getInfo(id) {
    return {
      basic_info: { title: '기본 제목', view_count: 1234 },
      primary_info: { title: text('영상 제목 <script>'), view_count: { view_count: text('조회수 1,234회') }, relative_date: text('1일 전') },
      secondary_info: {
        description: text('설명 https://example.com'),
        owner: { author: { id: 'UCaaaaaaaaaaaaaaaaaaaaaa', name: '테스트 채널', thumbnails: [{ url: 'https://yt3.ggpht.com/a.jpg' }] }, subscriber_count: text('구독자 10만명') }
      },
      watch_next_feed: [lockup('rel00000001', '관련 영상'), { type: 'CompactMovie' }]
    };
  },
  async getChannel(id) {
    return {
      metadata: { title: '테스트 채널', description: '채널 설명', avatar: [{ url: 'https://yt3.ggpht.com/a.jpg' }] },
      header: { content: { banner: { image: [{ url: 'https://yt3.ggpht.com/s.jpg' }, { url: 'https://yt3.ggpht.com/l.jpg' }] } } },
      has_videos: true,
      async getVideos() {
        return { videos: [video('chv00000001', '채널 영상')] };
      }
    };
  }
};

let server;
let base;

before(async () => {
  server = createApp(async () => fakeYt).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

const get = async (path) => {
  const res = await fetch(base + path);
  return { status: res.status, type: res.headers.get('content-type'), body: res.headers.get('content-type')?.includes('json') ? await res.json() : await res.text() };
};

test('메인 페이지가 로그인 없이 바로 UTF-8 HTML로 열린다', async () => {
  const res = await get('/');
  assert.equal(res.status, 200);
  assert.match(res.type, /text\/html; charset=utf-8/i);
  assert.match(res.body, /<title>MinTube<\/title>/);
  assert.match(res.body, /검색/);
});

test('없는 경로도 index.html 로 응답한다 (새로고침 대응)', async () => {
  const res = await get('/anything/else');
  assert.equal(res.status, 200);
  assert.match(res.body, /MinTube/);
});

test('홈 피드가 비어 있으면 검색 결과로 채운다', async () => {
  const res = await get('/api/home');
  assert.equal(res.status, 200);
  assert.ok(res.body.length >= 1);
  assert.ok(fakeYt.calls.includes('home'));
  assert.ok(fakeYt.calls.some((c) => c.startsWith('search:')));
  assert.equal(res.body[0].channel, '테스트 채널');
});

test('검색, 자동완성', async () => {
  const s = await get('/api/search?q=' + encodeURIComponent('고양이'));
  assert.equal(s.body.length, 1);
  assert.equal(s.body[0].title, '고양이 영상');
  assert.deepEqual((await get('/api/search')).body, []);
  assert.deepEqual((await get('/api/suggest?q=abc')).body, ['abc 추천', 'abc 노래']);
});

test('영상 정보와 관련 영상', async () => {
  const res = await get('/api/video?id=dQw4w9WgXcQ');
  assert.equal(res.status, 200);
  assert.equal(res.body.title, '영상 제목 <script>');
  assert.equal(res.body.subscribers, '구독자 10만명');
  assert.equal(res.body.related.length, 1);
  assert.equal(res.body.related[0].channelId, 'UCbbbbbbbbbbbbbbbbbbbbbb');
  assert.equal((await get('/api/video?id=bad')).status, 400);
});

test('채널 페이지', async () => {
  const res = await get('/api/channel?id=UCaaaaaaaaaaaaaaaaaaaaaa');
  assert.equal(res.status, 200);
  assert.equal(res.body.name, '테스트 채널');
  assert.equal(res.body.banner, 'https://yt3.ggpht.com/l.jpg');
  assert.equal(res.body.videos[0].channelId, 'UCaaaaaaaaaaaaaaaaaaaaaa');
  assert.equal((await get('/api/channel?id=nope')).status, 400);
});

test('YouTube 오류 시 502 와 안내 메시지', async () => {
  const broken = createApp(async () => { throw new Error('blocked'); }).listen(0);
  await new Promise((r) => broken.once('listening', r));
  const res = await fetch(`http://127.0.0.1:${broken.address().port}/api/search?q=x`);
  assert.equal(res.status, 502);
  assert.ok((await res.json()).error);
  broken.close();
});

test('normalizeVideo 는 영상이 아닌 노드를 거른다', () => {
  assert.equal(normalizeVideo({ type: 'Channel' }), null);
  assert.equal(normalizeVideo({ type: 'LockupView', content_type: 'PLAYLIST', content_id: 'PLxxxxxxxxx' }), null);
  assert.equal(normalizeVideo(lockup('abcdefghijk', '제목')).channel, '락업 채널');
});
