import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bumpRequest, handleStats } from '../src/stats.js';

function fakeKV() {
  const store = new Map();
  return {
    async get(key) { return store.get(key) ?? null; },
    async put(key, value) { store.set(key, String(value)); },
    _store: store
  };
}

test('요청 수를 세고 관리자에게 7일치를 준다', async () => {
  const env = { DB: fakeKV() };
  for (let i = 0; i < 5; i++) await bumpRequest(env); // 첫 bump 가 flush (flushedAt 0)
  const res = await handleStats(new Request('https://x/api/admin/stats'), env, { role: 'admin' });
  const body = await res.json();
  assert.equal(body.days.length, 7);
  assert.equal(body.days[6].count, 5); // 오늘치 = 5 (메모리까지 합산)
});

test('관리자가 아니면 막는다', async () => {
  const env = { DB: fakeKV() };
  const res = await handleStats(new Request('https://x/api/admin/stats'), env, { role: 'user' });
  assert.equal(res.status, 401);
});

test('DB 가 없으면 조용히 넘어간다', async () => {
  await bumpRequest({});
});
