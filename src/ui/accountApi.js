/**
 * LAST CHAMBER - 계정 API (닉네임 + 4자리 PIN) — 서버 server/index.js 의 POST /api/login · POST /api/rename
 *
 *   loginWithPin(nickname, pin)  닉네임 + PIN 으로 계정을 만들거나 불러온다 → 성공하면 이 기기 세션(session.js)에 user_id · 닉네임 · PIN 저장
 *     · 처음 보는 닉네임 → 서버가 새 user_id 를 만든다 (클라이언트는 더 이상 UUID 를 만들지 않는다 → 다시 들어와도 계정이 새로 생기지 않는다)
 *     · 이미 있는 닉네임 → PIN 이 맞으면 그 계정(전적 · MMR)을 이 기기로 불러온다, 틀리면 NICKNAME_TAKEN
 *     · 이 기기에 남아 있던 user_id 도 함께 보낸다 → PIN 없던 예전 계정이면 거기에 PIN 을 붙인다
 *   changeNickname(nickname)     서버에서 먼저 확인(남의 PIN 닉네임이면 거절)한 뒤 이 기기 세션도 바꾼다
 *   서버 주소는 multiplayer.js 와 같다: window.LAST_CHAMBER_SERVER → 페이지를 서빙한 서버 → 클라우드 기본 주소
 */
import { userSession, validateNickname, nicknameErrorText, cleanPin } from './session.js';

const DEFAULT_SERVER = 'https://last-chamber-aaz9.onrender.com';
const TIMEOUT_MS = 75_000; // 무료 서버가 잠들어 있으면 첫 응답까지 1분 가까이 걸린다

export const ACCOUNT_ERROR_TEXT = Object.freeze({
  NICKNAME_TAKEN: '이미 사용 중인 닉네임입니다. 본인 계정이라면 PIN 번호를 확인해 주세요.',
  NICKNAME_IN_USE: '이미 사용 중인 닉네임입니다. 이 닉네임으로 플레이하던 기기에서 계정 메뉴의 [PIN 설정]을 먼저 해 주세요.',
  PIN_LOCKED: 'PIN을 여러 번 틀렸어요. 잠시 뒤에 다시 시도해 주세요.',
  INVALID_PIN: 'PIN은 숫자 4자리로 입력해 주세요.',
  INVALID_NICKNAME: '닉네임 규칙에 맞지 않아요.',
  RATE_LIMITED: '시도가 너무 많아요. 잠시 뒤에 다시 시도해 주세요.',
  PIN_SETUP_REQUIRED: '서버 계정 설정이 아직 끝나지 않았어요. 잠시 뒤에 다시 시도해 주세요.',
  SERVER_BUSY: '서버가 바빠요. 잠시 뒤에 다시 시도해 주세요.',
  OFFLINE: '서버에 연결할 수 없어요. 인터넷 연결을 확인하고 다시 시도해 주세요.',
  TIMEOUT: '서버가 응답하지 않아요. 잠시 뒤에 다시 시도해 주세요.',
  SERVER_ERROR: '서버 오류가 났어요. 잠시 뒤에 다시 시도해 주세요.',
  BAD_REQUEST: '요청을 처리할 수 없어요.',
  NOT_LOGGED_IN: '먼저 로그인해 주세요.',
});

/** 오류 코드 → 화면 문장 (잠금이면 남은 시간까지) */
export function accountErrorText(code, res = {}) {
  if (code === 'PIN_LOCKED' && res.retryAfterSec > 0) return `PIN을 여러 번 틀렸어요. ${Math.ceil(res.retryAfterSec / 60)}분 뒤에 다시 시도해 주세요.`;
  return ACCOUNT_ERROR_TEXT[code] ?? ACCOUNT_ERROR_TEXT.SERVER_ERROR;
}

/** 계정 API 서버 주소 (끝의 / 없음) */
export function serverBase(win = globalThis.window) {
  const custom = typeof win?.LAST_CHAMBER_SERVER === 'string' ? win.LAST_CHAMBER_SERVER.trim() : '';
  if (custom) return custom.replace(/\/+$/, '');
  const loc = win?.location;
  return /^https?:$/.test(loc?.protocol ?? '') ? loc.origin : DEFAULT_SERVER;
}

/** POST /api/<route> → 서버 응답 { ok, ... } | { ok: false, error: 'OFFLINE' | 'TIMEOUT' | 'SERVER_ERROR' | … } (던지지 않는다) */
async function post(route, body, { fetchImpl = globalThis.fetch, base = serverBase(), timeoutMs = TIMEOUT_MS } = {}) {
  const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : 0;
  try {
    const res = await fetchImpl(`${base}/api/${route}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl?.signal,
    });
    let data = null;
    try {
      data = await res.json();
    } catch {
      data = null;
    }
    if (data && typeof data === 'object' && typeof data.ok === 'boolean') return data;
    return { ok: false, error: res.status >= 500 ? 'SERVER_ERROR' : 'BAD_REQUEST' };
  } catch (err) {
    return { ok: false, error: err?.name === 'AbortError' ? 'TIMEOUT' : 'OFFLINE' };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 닉네임 + PIN 로그인 → { ok: true, user, created, recovered, secured, me } | { ok: false, error, message }
 * 성공하면 session.signIn 으로 이 기기에 저장한다 (다른 기기의 계정을 불러왔으면 이 기기의 user_id 도 그것으로 바뀐다)
 */
export async function loginWithPin(nickname, pin, { session = userSession, ...opts } = {}) {
  const nick = validateNickname(nickname);
  if (!nick.ok) return { ok: false, error: 'INVALID_NICKNAME', message: nicknameErrorText(nick.reason) };
  const p = cleanPin(pin);
  if (!p) return { ok: false, error: 'INVALID_PIN', message: ACCOUNT_ERROR_TEXT.INVALID_PIN };
  const res = await post('login', { nickname: nick.nickname, pin: p, ...(session.userId ? { user_id: session.userId } : {}) }, opts);
  if (!res.ok) return { ...res, message: accountErrorText(res.error, res) };
  const signed = session.signIn({ id: res.user_id, nickname: res.nickname, pin: p });
  if (!signed.ok) return { ok: false, error: 'SERVER_ERROR', message: ACCOUNT_ERROR_TEXT.SERVER_ERROR };
  return { ok: true, user: signed.user, created: Boolean(res.created), recovered: Boolean(res.recovered), secured: Boolean(res.secured), me: res.me ?? null };
}

/** 닉네임 변경 (로그인 중) → { ok: true, user, unchanged? } | { ok: false, error, message } */
export async function changeNickname(nickname, { session = userSession, ...opts } = {}) {
  if (!session.isLoggedIn) return { ok: false, error: 'NOT_LOGGED_IN', message: ACCOUNT_ERROR_TEXT.NOT_LOGGED_IN };
  const nick = validateNickname(nickname);
  if (!nick.ok) return { ok: false, error: 'INVALID_NICKNAME', message: nicknameErrorText(nick.reason) };
  if (nick.nickname === session.user.nickname) return { ok: true, unchanged: true, user: session.user };
  const res = await post('rename', { user_id: session.userId, nickname: nick.nickname }, opts);
  if (!res.ok) return { ...res, message: res.error === 'NICKNAME_TAKEN' ? '이미 사용 중인 닉네임입니다.' : accountErrorText(res.error, res) };
  const local = session.rename(nick.nickname);
  return local.ok ? { ok: true, user: local.user } : { ok: false, error: 'SERVER_ERROR', message: nicknameErrorText(local.reason) };
}
