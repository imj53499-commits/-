// 따로 올린 앱 페이지(public/apps/...)에 넣으면, 그 앱을 볼 수 없는 사람(로그인 안 함 포함)은 앱 목록으로 돌려보낸다.
// 쓰는 법: <head> 안에 <script src="/app-guard.js" data-app="앱 id"></script>  (앱 id 는 app.js 의 APPS 에 쓴 id)
(() => {
  const id = document.currentScript?.dataset.app;
  if (!id) return;
  const root = document.documentElement;
  root.style.visibility = 'hidden'; // 확인될 때까지 안 보이게
  fetch(`/api/apps/check?id=${encodeURIComponent(id)}`, { credentials: 'same-origin' })
    .then((res) => {
      if (res.ok) root.style.visibility = '';
      else location.replace('/#/');
    })
    .catch(() => location.replace('/#/'));
})();
