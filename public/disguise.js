// 탭 모양 (탭·방문 기록에 보이는 제목과 아이콘). 이 브라우저에만 저장되고, 메인 화면과 팝업이 같이 쓴다.
// 아이콘은 정한 사이트 주소의 파비콘을 Google 파비콘 서비스에서 불러온다.

const DISGUISE_KEY = 'tabDisguise';

// 기본 아이콘: 회색 지구본
export const DEFAULT_ICON = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32' fill='none' stroke='%239aa0a6' stroke-width='2.2'%3E%3Ccircle cx='16' cy='16' r='12'/%3E%3Cpath d='M4 16h24M16 4c4 4 4 20 0 24M16 4c-4 4-4 20 0 24'/%3E%3C/svg%3E";

export const PRESETS = [
  { id: 'default', label: '기본 (Google, 회색 아이콘)', title: 'Google', domain: '' },
  { id: 'google', label: 'Google', title: 'Google', domain: 'google.com' },
  { id: 'classroom', label: 'Google 클래스룸', title: 'Classroom', domain: 'classroom.google.com' },
  { id: 'docs', label: 'Google 문서', title: 'Google 문서', domain: 'docs.google.com' },
  { id: 'naver', label: '네이버', title: 'NAVER', domain: 'naver.com' },
  { id: 'wiki', label: '위키백과', title: '위키백과, 우리 모두의 백과사전', domain: 'ko.wikipedia.org' },
  { id: 'ebs', label: 'EBS', title: 'EBS', domain: 'ebs.co.kr' },
  { id: 'blank', label: '빈 새 탭', title: '새 탭', domain: '' }
];

// "https://classroom.google.com/u/0" 처럼 넣어도 classroom.google.com 만 꺼낸다. 틀리면 ''.
export function cleanDomain(input) {
  const text = String(input || '').trim().toLowerCase();
  if (!text) return '';
  let host;
  try {
    host = new URL(text.includes('://') ? text : `https://${text}`).hostname;
  } catch {
    return '';
  }
  return /^([a-z0-9-]+\.)+[a-z]{2,}$/.test(host) ? host : '';
}

export function iconFor(domain) {
  return domain ? `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=64` : DEFAULT_ICON;
}

export function loadDisguise() {
  try {
    const d = JSON.parse(localStorage.getItem(DISGUISE_KEY) || 'null');
    if (d && typeof d.title === 'string' && d.title.trim()) {
      return { preset: d.preset || 'custom', title: d.title.slice(0, 80), domain: cleanDomain(d.domain) };
    }
  } catch {}
  return { preset: 'default', title: PRESETS[0].title, domain: '' };
}

export function saveDisguise(d) {
  try { localStorage.setItem(DISGUISE_KEY, JSON.stringify(d)); } catch {}
}

export function isDisguiseKey(key) {
  return key === DISGUISE_KEY;
}

// 지금 페이지의 제목과 아이콘을 저장된 탭 모양으로 바꾼다.
export function applyDisguise(d = loadDisguise()) {
  document.title = d.title;
  let link = document.querySelector('link[rel="icon"]');
  if (!link) {
    link = document.createElement('link');
    link.rel = 'icon';
    document.head.append(link);
  }
  link.href = iconFor(d.domain);
  return d;
}
