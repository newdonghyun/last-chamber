/**
 * LAST CHAMBER - 친선 비밀방 초대 링크 (DOM 비의존 — 저장소 · window 를 주입받는다)
 *
 *   buildInviteLink('A7K9', base) → 'https://…/?room=A7K9'   방장이 [초대 링크 복사]로 친구에게 보낸다
 *   captureInvite()               링크로 들어온 사람: 주소의 ?room=코드 를 sessionStorage 'pending_invite_room' 에 보관한다
 *   peekInvite()                  보관 중인 코드 (없으면 null)
 *   clearInvite() · cleanInviteUrl()   입장에 성공했거나 · 방이 없다고 확인됐거나 · 사용자가 그만뒀을 때에만 지운다
 *
 *   보관한 코드는 로그인 · 회원가입 화면을 오가거나 서버 연결을 기다리는 동안 지워지지 않는다. 입장 시도는 multiplayer.js 가
 *   '로그인 완료 + 소켓 연결' 이 모두 갖춰진 순간에 한다. 주소창의 ?room= 도 결과가 정해질 때까지 남겨 둔다 (새로고침 · 다른 브라우저로 열기에도 초대가 이어지게).
 *   코드 모양은 서버(server/roomManager.js)의 방 코드와 같다 — 헷갈리는 글자(0 O 1 I)를 뺀 영문 대문자 + 숫자 4자리.
 */

export const INVITE_KEY = 'pending_invite_room';
export const INVITE_CODE = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}$/;

/** '?room=a7k9' → 'A7K9' | null (모양이 틀리면 무시 — 아무 문자열이나 방에 넣지 않는다) */
export function parseInviteCode(search) {
  if (typeof search !== 'string') return null;
  let raw;
  try {
    raw = new URLSearchParams(search).get('room');
  } catch {
    return null;
  }
  const code = typeof raw === 'string' ? raw.trim().toUpperCase() : '';
  return INVITE_CODE.test(code) ? code : null;
}

/** 초대 링크: base(서버 주소 — 웹이면 지금 도메인, 앱 · 토스면 클라우드 서버) 끝의 / 는 있어도 없어도 된다 */
export function buildInviteLink(code, base) {
  const clean = typeof code === 'string' ? code.trim().toUpperCase() : '';
  if (!INVITE_CODE.test(clean)) return '';
  return `${String(base ?? '').replace(/\/+$/, '')}/?room=${clean}`;
}

const safe = (fn, fallback = null) => {
  try {
    return fn();
  } catch {
    return fallback;
  }
};
const defaultStorage = () => safe(() => globalThis.sessionStorage); // 접근만으로 던지는 환경이 있다
let memory = null; // 저장소를 못 쓰는 환경(일부 비공개 창 · 인앱 브라우저) — 이 페이지가 살아 있는 동안은 기억한다

export function rememberInvite(code, storage = defaultStorage()) {
  if (!INVITE_CODE.test(code)) return false;
  memory = code;
  safe(() => storage.setItem(INVITE_KEY, code));
  return true;
}

/** 보관 중인 초대 코드 | null */
export function peekInvite(storage = defaultStorage()) {
  const read = safe(() => ({ value: storage.getItem(INVITE_KEY) }));
  if (!read) return memory; // 저장소를 읽을 수 없다
  return INVITE_CODE.test(read.value ?? '') ? read.value : null;
}

export function clearInvite(storage = defaultStorage()) {
  memory = null;
  safe(() => storage.removeItem(INVITE_KEY));
}

/** 주소창에서 room 만 지운다 (history.replaceState — 다른 쿼리 · 해시는 그대로) */
export function cleanInviteUrl(win = globalThis.window) {
  safe(() => {
    const url = new URL(win.location.href);
    if (!url.searchParams.has('room')) return;
    url.searchParams.delete('room');
    win.history.replaceState(win.history.state, '', `${url.pathname}${url.search}${url.hash}`);
  });
}

/** 지금 주소에 ?room=코드 가 있으면 보관한다 → 보관 중인 코드(없으면 null). 여러 번 불러도 같다 */
export function captureInvite({ win = globalThis.window, storage = defaultStorage() } = {}) {
  const code = parseInviteCode(win?.location?.search ?? '');
  if (code) rememberInvite(code, storage);
  return peekInvite(storage);
}
