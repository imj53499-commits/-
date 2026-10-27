import { Innertube, UniversalCache } from 'youtubei.js';
import { createApp } from './src/app.js';

const PORT = process.env.PORT || 3000;

let ytPromise = null;

// 로그인 없이(익명) Innertube 클라이언트를 만든다. 실패하면 다음 요청 때 다시 시도한다.
function getYt() {
  if (!ytPromise) {
    ytPromise = Innertube.create({
      lang: 'ko',
      location: 'KR',
      retrieve_player: false,
      cache: new UniversalCache(false)
    }).catch((err) => {
      ytPromise = null;
      throw err;
    });
  }
  return ytPromise;
}

createApp(getYt).listen(PORT, () => {
  console.log(`MinTube 실행 중: http://localhost:${PORT}`);
  getYt().catch((err) => console.error('Innertube 초기화 실패:', err?.message || err));
});
