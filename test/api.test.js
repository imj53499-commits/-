import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { handleApi, clearCache, homeQueries, CATEGORIES } from '../src/api.js';
import { createYouTube, extractVideos } from '../src/youtube.js';

// ---------- YouTube 응답과 같은 모양의 가짜 데이터 ----------

const videoRenderer = (id, title) => ({
  videoRenderer: {
    videoId: id,
    title: { runs: [{ text: title }] },
    ownerText: { runs: [{ text: '테스트 채널', navigationEndpoint: { browseEndpoint: { browseId: 'UCaaaaaaaaaaaaaaaaaaaaaa' } } }] },
    channelThumbnailSupportedRenderers: { channelThumbnailWithLinkRenderer: { thumbnail: { thumbnails: [{ url: '//yt3.ggpht.com/a.jpg' }] } } },
    shortViewCountText: { simpleText: '조회수 1.2만회' },
    publishedTimeText: { simpleText: '3일 전' },
    lengthText: { simpleText: '10:01' }
  }
});

const lockup = (id, title, contentType = 'LOCKUP_CONTENT_TYPE_VIDEO') => ({
  lockupViewModel: {
    contentId: id,
    contentType,
    contentImage: {
      thumbnailViewModel: {
        overlays: [{ thumbnailOverlayBadgeViewModel: { thumbnailBadges: [{ thumbnailBadgeViewModel: { text: '3:21' } }] } }]
      }
    },
    metadata: {
      lockupMetadataViewModel: {
        title: { content: title },
        image: { decoratedAvatarViewModel: { avatar: { avatarViewModel: { image: { sources: [{ url: 'https://yt3.ggpht.com/b.jpg' }] } } } } },
        metadata: {
          contentMetadataViewModel: {
            metadataRows: [
              { metadataParts: [{ text: { content: '락업 채널', commandRuns: [{ onTap: { innertubeCommand: { browseEndpoint: { browseId: 'UCbbbbbbbbbbbbbbbbbbbbbb' } } } }] } }] },
              { metadataParts: [{ text: { content: '조회수 5천회' } }, { text: { content: '1주 전' } }] }
            ]
          }
        }
      }
    }
  }
});

const responses = {
  search: (body) => ({
    contents: {
      twoColumnSearchResultsRenderer: {
        primaryContents: {
          sectionListRenderer: {
            contents: [{
              itemSectionRenderer: {
                contents: [
                  videoRenderer(`s${String(body.query.length).padStart(10, '0')}`, `${body.query} 영상`),
                  { channelRenderer: { channelId: 'UCcccccccccccccccccccccc' } },
                  { reelShelfRenderer: { items: [
                    { reelItemRenderer: { videoId: 'short000001', headline: { simpleText: '쇼츠' } } },
                    { shortsLockupViewModel: { onTap: { innertubeCommand: { reelWatchEndpoint: { videoId: 'short000002' } } }, overlayMetadata: { primaryText: { content: '쇼츠 둘' }, secondaryText: { content: '조회수 3만회' } } } }
                  ] } },
                  { videoRenderer: { ...videoRenderer('short000003', '쇼츠 셋').videoRenderer, navigationEndpoint: { reelWatchEndpoint: { videoId: 'short000003' } } } }
                ]
              }
            }]
          }
        }
      }
    }
  }),
  browse: (body) => body.browseId === 'FEwhat_to_watch'
    ? { contents: { twoColumnBrowseResultsRenderer: { tabs: [{ tabRenderer: { content: { richGridRenderer: { contents: [] } } } }] } } }
    : {
        metadata: { channelMetadataRenderer: { title: '테스트 채널', description: '채널 설명', avatar: { thumbnails: [{ url: 'https://yt3.ggpht.com/a.jpg' }] } } },
        header: { pageHeaderRenderer: { content: { pageHeaderViewModel: { banner: { imageBannerViewModel: { image: { sources: [{ url: 'https://yt3.ggpht.com/s.jpg' }, { url: 'https://yt3.ggpht.com/l.jpg' }] } } } } } } },
        contents: { twoColumnBrowseResultsRenderer: { tabs: [{ tabRenderer: { content: { richGridRenderer: { contents: [{ richItemRenderer: { content: videoRenderer('chv00000001', '채널 영상') } }] } } } }] } }
      },
  next: (body) => ({
    contents: {
      twoColumnWatchNextResults: {
        results: {
          results: {
            contents: [
              { videoPrimaryInfoRenderer: { title: { runs: [{ text: '영상 제목 <script>' }] }, viewCount: { videoViewCountRenderer: { viewCount: { simpleText: '조회수 1,234회' } } }, relativeDateText: { simpleText: '1일 전' } } },
              { videoSecondaryInfoRenderer: {
                owner: { videoOwnerRenderer: { title: { runs: [{ text: '테스트 채널', navigationEndpoint: { browseEndpoint: { browseId: 'UCaaaaaaaaaaaaaaaaaaaaaa' } } }] }, thumbnail: { thumbnails: [{ url: 'https://yt3.ggpht.com/a.jpg' }] }, subscriberCountText: { simpleText: '구독자 10만명' } } },
                attributedDescription: { content: '설명 https://example.com' }
              } }
            ]
          }
        },
        secondaryResults: { secondaryResults: { results: [lockup('rel00000001', '관련 영상'), lockup('PLxxxxxxxxx', '재생목록', 'LOCKUP_CONTENT_TYPE_PLAYLIST'), lockup(body.videoId, '자기 자신')] } }
      }
    }
  })
};

let calls = [];
let failing = false;

async function fakeFetch(url, init) {
  calls.push(url);
  if (failing) return new Response('blocked', { status: 403 });
  if (url.includes('suggestqueries')) {
    const q = new URL(url).searchParams.get('q');
    return Response.json([q, [`${q} 추천`, `${q} 노래`]]);
  }
  const endpoint = new URL(url).pathname.split('/').pop();
  const body = JSON.parse(init.body);
  assert.equal(body.context.client.clientName, 'WEB');
  return Response.json(responses[endpoint](body));
}

const yt = createYouTube(fakeFetch);
const get = async (path) => {
  const res = await handleApi(new URL(`https://mintube.test${path}`), yt);
  return { status: res.status, type: res.headers.get('content-type'), body: await res.json() };
};

beforeEach(() => {
  calls = [];
  failing = false;
  clearCache();
});

test('홈 피드가 비어 있으면 검색 결과로 채운다', async () => {
  const res = await get('/api/home');
  assert.equal(res.status, 200);
  assert.match(res.type, /application\/json; charset=utf-8/);
  assert.ok(res.body.length >= 1);
  assert.ok(calls.some((c) => c.includes('/browse')));
  assert.ok(calls.some((c) => c.includes('/search')));
  assert.equal(res.body[0].channel, '테스트 채널');
  assert.equal(res.body[0].channelAvatar, 'https://yt3.ggpht.com/a.jpg');
  assert.ok(res.body.every((v) => !v.isShort));
});

test('알 수 없는 카테고리는 전체로 처리', async () => {
  const res = await get('/api/home?category=zzz');
  assert.equal(res.status, 200);
  assert.ok(calls.some((c) => c.includes('/browse')));
});

test('검색: 영상만 남기고 채널/쇼츠는 뺀다', async () => {
  const s = await get('/api/search?q=' + encodeURIComponent('고양이'));
  assert.equal(s.body.length, 1);
  assert.equal(s.body[0].title, '고양이 영상');
  assert.equal(s.body[0].duration, '10:01');
  assert.equal(s.body[0].meta, '조회수 1.2만회 · 3일 전');
  assert.deepEqual((await get('/api/search')).body, []);
});

test('쇼츠: 쇼츠만 모아서 주고, 일반 검색에서는 빠진다', async () => {
  const res = await get('/api/shorts');
  assert.equal(res.status, 200);
  const ids = res.body.map((v) => v.id);
  assert.ok(ids.includes('short000001') && ids.includes('short000002') && ids.includes('short000003'));
  assert.ok(res.body.every((v) => v.isShort));
  assert.equal(res.body.find((v) => v.id === 'short000002').title, '쇼츠 둘');
  assert.equal(new Set(ids).size, ids.length);
  // page 가 바뀌면 다른 검색어를 쓴다
  calls = [];
  await get('/api/shorts?page=1');
  assert.ok(calls.length > 0);
  const s = await get('/api/search?q=' + encodeURIComponent('고양이'));
  assert.ok(s.body.every((v) => !v.id.startsWith('short')));
});

test('자동완성', async () => {
  assert.deepEqual((await get('/api/suggest?q=abc')).body, ['abc 추천', 'abc 노래']);
});

test('영상 정보와 관련 영상 (재생목록, 자기 자신 제외)', async () => {
  const res = await get('/api/video?id=dQw4w9WgXcQ');
  assert.equal(res.status, 200);
  assert.equal(res.body.title, '영상 제목 <script>');
  assert.equal(res.body.subscribers, '구독자 10만명');
  assert.equal(res.body.channelId, 'UCaaaaaaaaaaaaaaaaaaaaaa');
  assert.equal(res.body.description, '설명 https://example.com');
  assert.deepEqual(res.body.related.map((v) => v.id), ['rel00000001']);
  assert.equal(res.body.related[0].channelId, 'UCbbbbbbbbbbbbbbbbbbbbbb');
  assert.equal(res.body.related[0].duration, '3:21');
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

test('YouTube 가 막으면 502 와 안내 메시지', async () => {
  failing = true;
  const res = await get('/api/search?q=x');
  assert.equal(res.status, 502);
  assert.ok(res.body.error);
  assert.equal((await get('/api/home')).status, 502);
});

test('없는 API 경로는 404', async () => {
  assert.equal((await get('/api/nope')).status, 404);
});

test('extractVideos 는 중복을 빼고 순서를 지킨다', () => {
  const items = extractVideos([videoRenderer('aaaaaaaaaaa', '1'), { x: [videoRenderer('bbbbbbbbbbb', '2')] }, videoRenderer('aaaaaaaaaaa', '1')]);
  assert.deepEqual(items.map((v) => v.id), ['aaaaaaaaaaa', 'bbbbbbbbbbb']);
});

test('추천: 최근 본 영상들의 관련 영상을 섞고, 본 영상은 뺀다', async () => {
  const res = await get('/api/recommend?ids=dQw4w9WgXcQ,aaaaaaaaaaa,bbbbbbbbbbb,bad');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.map((v) => v.id), ['rel00000001']);
  assert.equal(calls.filter((c) => c.includes('/next')).length, 2); // 최대 2개 영상만 본다
  assert.deepEqual((await get('/api/recommend?ids=')).body, []);
  assert.deepEqual((await get('/api/recommend?ids=bad')).body, []);
});

test('홈: 방문(seed)마다 검색어 순서가 다르고, 페이지마다 새 검색어를 쓴다', () => {
  const a = homeQueries('all', 0, 1);
  const b = homeQueries('all', 0, 987654);
  assert.notDeepEqual(a, b);
  assert.deepEqual(homeQueries('all', 0, 1), a); // 같은 seed 는 같은 결과
  const seen = new Set();
  for (let page = 0; page < 40; page++) for (const q of homeQueries('music', page, 42)) seen.add(q);
  assert.equal(seen.size, 80); // 검색어를 다 써도 말을 붙여서 계속 새 검색어
  for (const q of homeQueries('news', 0, 5)) assert.ok(CATEGORIES.news.some((base) => q.startsWith(base)));
});

test('홈: 페이지를 넘기면 다른 검색을 한다', async () => {
  await get('/api/home?category=music&page=0&seed=7');
  const first = calls.filter((c) => c.includes('/search')).length;
  await get('/api/home?category=music&page=1&seed=7');
  assert.equal(calls.filter((c) => c.includes('/search')).length, first + 2);
  assert.equal((await get('/api/home?category=music&page=999&seed=7')).status, 200);
});
