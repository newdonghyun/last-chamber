/**
 * LAST CHAMBER - 친선 비밀방 초대 링크 (DOM 비의존 — 저장소 · window 를 주입받는다)
 *
 *   buildInviteLink('A7K9', base) → 'https://…/?room=A7K9'   방장이 [초대 링크 복사]로 친구에게 보낸다
 *   captureInvite()               링크로 들어온 사람: 주소의 ?room=코드 를 저장소에 보관하고 주소창에서는 지운다 (새로고침해도 다시 입장하지 않게)
 *   peekInvite() / clearInvite()  보관한 코드를 보거나(만료됐으면 지움) 쓴 뒤 지운다
 *
 *   신규 유저의 흐름: 링크 → 회원가입(또는 로그인) 화면 → 코드는 저장소에 남아 있다가 가입 직후 multiplayer.js 가 꺼내 곧바로 그 비밀방에 입장한다.
 *   코드 모양은 서버(server/roomManager.js)의 방 코드와 같다 — 헷갈리는 글자(0 O 1 I)를 뺀 영문 대문자 + 숫자 4자리.
 *   방은 상대를 기다리다 10분이면 서버가 닫으므로 보관도 15분 안에 쓰지 않으면 버린다.
 */

export const INVITE_KEY = 'lastchamber.invite';
export const INVITE_TTL_MS = 15 * 60_000;
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
    return fallback; // 저장소를 못 쓰는 환경(비공개 창 등) — 초대는 이번 접속에서만 동작하지 않을 뿐 게임은 그대로
  }
};

export function rememberInvite(code, storage = globalThis.localStorage, now = Date.now()) {
  if (!INVITE_CODE.test(code)) return false;
  return safe(() => {
    storage.setItem(INVITE_KEY, JSON.stringify({ code, at: now }));
    return true;
  }, false);
}

/** 보관 중인 초대 코드 | null (15분이 지났거나 깨진 값이면 지우고 null) */
export function peekInvite(storage = globalThis.localStorage, now = Date.now()) {
  const saved = safe(() => JSON.parse(storage.getItem(INVITE_KEY) ?? 'null'));
  const valid = saved && typeof saved === 'object' && INVITE_CODE.test(saved.code) && Number.isFinite(saved.at) && now - saved.at >= 0 && now - saved.at < INVITE_TTL_MS;
  if (valid) return saved.code;
  if (saved !== null) clearInvite(storage);
  return null;
}

export function clearInvite(storage = globalThis.localStorage) {
  safe(() => storage.removeItem(INVITE_KEY));
}

/**
 * 지금 주소에 ?room=코드 가 있으면 보관하고 주소창에서 지운다 → 보관 중인 코드(없으면 null).
 * 여러 모듈이 불러도 한 번만 읽는다 (처음 부른 쪽이 주소를 정리한다).
 */
export function captureInvite({ win = globalThis.window, storage = globalThis.localStorage, now = Date.now() } = {}) {
  const loc = win?.location;
  const code = parseInviteCode(loc?.search ?? '');
  if (code) {
    rememberInvite(code, storage, now);
    safe(() => {
      const url = new URL(loc.href);
      url.searchParams.delete('room');
      win.history?.replaceState?.(win.history.state, '', `${url.pathname}${url.search}${url.hash}`);
    });
  }
  return peekInvite(storage, now);
}
