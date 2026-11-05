// 봇·크롤러 판별. 서버(src/server.js)와 모든 경로 미들웨어(functions/_middleware.js)가 같이 쓴다.
// 이름을 밝히는 봇만 걸러낸다. 이름을 숨긴 봇(보통 브라우저인 척)은 사람과 구별할 수 없어 막지 않는다.
const BOT_RE = /bot\b|bot\/|crawl|spider|slurp|scrape|wget|curl|python-requests|python-urllib|httpclient|http-client|okhttp|libwww|java\/|go-http|node-fetch|axios|headlesschrome|phantomjs|gptbot|claudebot|claude-web|anthropic|oai-searchbot|chatgpt|ccbot|bytespider|petalbot|ahrefs|semrush|mj12bot|dotbot|dataforseo|facebookexternalhit|meta-externalagent|bingbot|bingpreview|yandex|baidu|googlebot|applebot|amazonbot|perplexitybot/i;

export function isBot(userAgent) {
  return BOT_RE.test(String(userAgent || ''));
}
