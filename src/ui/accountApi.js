/**
 * ODD ROULETTE - 계정 API (아이디 · 비밀번호 · 닉네임) — 서버 server/index.js 의 POST /api/signup · /api/login · /api/rename
 *
 *   signUp({ username, password, nickname })  회원가입 → 성공하면 바로 로그인 (session.signIn — 토큰 · user_id · 아이디 · 닉네임을 이 기기에)
 *   logIn({ username, password })             로그인 → 같은 계정의 전적 · MMR 을 이어서 (다른 기기 · 브라우저에서도)
 *   changeNickname(nickname)                  닉네임 변경 — 서버가 players 를 바로 UPDATE (다른 계정이 쓰는 닉네임이면 거절) → 이 기기 세션도
 *   토큰이 틀리거나 만료되면(AUTH_REQUIRED) 로그아웃하고 로그인 화면을 다시 연다 (window 'lastchamber:need-login').
 *   서버 주소는 multiplayer.js 와 같다: window.LAST_CHAMBER_SERVER → 페이지를 서빙한 서버 → 클라우드 기본 주소. 비밀번호는 이 기기에 저장하지 않는다.
 */
import { userSession, validateNickname, validateUsername, validatePassword, nicknameErrorText } from './session.js';

const DEFAULT_SERVER = 'https://last-chamber-aaz9.onrender.com';
const TIMEOUT_MS = 75_000; // 무료 서버가 잠들어 있으면 첫 응답까지 1분 가까이 걸린다

export const ACCOUNT_ERROR_TEXT = Object.freeze({
  USERNAME_TAKEN: '이미 사용 중인 아이디예요.',
  NICKNAME_TAKEN: '이미 사용 중인 닉네임이에요.',
  BAD_CREDENTIALS: '아이디 또는 비밀번호가 맞지 않아요.',
  LOGIN_LOCKED: '비밀번호를 여러 번 틀렸어요. 잠시 뒤에 다시 시도해 주세요.',
  INVALID_USERNAME: '아이디는 영문 소문자 · 숫자 · _ 4~16자로 정해 주세요.',
  INVALID_PASSWORD: '비밀번호는 6자 이상이어야 해요.',
  INVALID_NICKNAME: '닉네임 규칙에 맞지 않아요.',
  AUTH_REQUIRED: '로그인이 풀렸어요. 다시 로그인해 주세요.',
  RATE_LIMITED: '시도가 너무 많아요. 잠시 뒤에 다시 시도해 주세요.',
  ACCOUNT_SETUP_REQUIRED: '서버 계정 설정이 아직 끝나지 않았어요. 잠시 뒤에 다시 시도해 주세요.',
  SERVER_BUSY: '서버가 바빠요. 잠시 뒤에 다시 시도해 주세요.',
  OFFLINE: '서버에 연결할 수 없어요. 인터넷 연결을 확인하고 다시 시도해 주세요.',
  TIMEOUT: '서버가 응답하지 않아요. 잠시 뒤에 다시 시도해 주세요.',
  WALLET_SETUP_REQUIRED: '탄피 · 스킨 서버 저장을 준비하고 있어요.',
  SERVER_ERROR: '서버 오류가 났어요. 잠시 뒤에 다시 시도해 주세요.',
  BAD_REQUEST: '요청을 처리할 수 없어요.',
  NOT_LOGGED_IN: '먼저 로그인해 주세요.',
});

/** 오류 코드 → 화면 문장 (잠금이면 남은 시간까지) */
export function accountErrorText(code, res = {}) {
  if (code === 'LOGIN_LOCKED' && res.retryAfterSec > 0) return `비밀번호를 여러 번 틀렸어요. ${Math.ceil(res.retryAfterSec / 60)}분 뒤에 다시 시도해 주세요.`;
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

const failed = (error, message) => ({ ok: false, error, message: message ?? accountErrorText(error) });

/** 가입 · 로그인 응답 → 이 기기 세션에 저장 */
function keep(res, session) {
  if (!res.ok) return { ...res, message: accountErrorText(res.error, res) };
  const signed = session.signIn({ token: res.token, id: res.user_id, username: res.username, nickname: res.nickname });
  if (!signed.ok) return failed('SERVER_ERROR');
  return { ok: true, user: signed.user, me: res.me ?? null };
}

/**
 * 회원가입 → { ok: true, user, me } | { ok: false, error, message } (성공하면 바로 로그인 상태)
 * nickname 은 선택 — 비우면 서버가 느와르 닉네임('붉은총잡이' 등)을 중복 없이 붙여 준다 (user.nickname 으로 돌아온다). 로비 · 계정 창에서 언제든 바꿀 수 있다.
 */
export async function signUp({ username, password, nickname = '' }, { session = userSession, ...opts } = {}) {
  const u = validateUsername(username);
  if (!u.ok) return failed('INVALID_USERNAME', nicknameErrorText(u.reason));
  const p = validatePassword(password);
  if (!p.ok) return failed('INVALID_PASSWORD', nicknameErrorText(p.reason));
  const body = { username: u.username, password: p.password };
  if (typeof nickname === 'string' && nickname !== '') {
    const n = validateNickname(nickname);
    if (!n.ok) return failed('INVALID_NICKNAME', nicknameErrorText(n.reason));
    body.nickname = n.nickname;
  }
  return keep(await post('signup', body, opts), session);
}

/** 로그인 → { ok: true, user, me } | { ok: false, error, message } */
export async function logIn({ username, password }, { session = userSession, ...opts } = {}) {
  const u = validateUsername(username);
  if (!u.ok) return failed('INVALID_USERNAME', nicknameErrorText(u.reason));
  if (typeof password !== 'string' || !password) return failed('BAD_CREDENTIALS', '비밀번호를 입력해 주세요.');
  return keep(await post('login', { username: u.username, password }, opts), session);
}

/**
 * 서버 지갑 호출 (POST /api/wallet) — 로그인한 계정의 탄피 · 스킨 · 출석 · 긴급 보급은 서버가 원본이다 (src/ui/walletClient.js 가 쓴다).
 * → { ok: true, result, wallet, state } | { ok: false, error: 'AUTH_REQUIRED' | 'RATE_LIMITED' | 'WALLET_SETUP_REQUIRED' | 'OFFLINE' | 'TIMEOUT' | …, message }
 */
export async function walletCall(action, args = {}, { session = userSession, ...opts } = {}) {
  if (!session.isLoggedIn) return failed('NOT_LOGGED_IN');
  const res = await post('wallet', { ...args, action, token: session.token }, opts);
  if (!res.ok) {
    if (res.error === 'AUTH_REQUIRED') requireLogin(session);
    return { ...res, message: accountErrorText(res.error, res) };
  }
  return res;
}

/** 토큰이 더는 통하지 않는다 → 로그아웃하고 로그인 화면을 다시 연다 */
export function requireLogin(session = userSession, message = ACCOUNT_ERROR_TEXT.AUTH_REQUIRED) {
  session.logout();
  globalThis.window?.dispatchEvent?.(new CustomEvent('lastchamber:need-login', { detail: { message } }));
}

/** 닉네임 변경 (로그인 중) → { ok: true, user, unchanged? } | { ok: false, error, message } */
export async function changeNickname(nickname, { session = userSession, ...opts } = {}) {
  if (!session.isLoggedIn) return failed('NOT_LOGGED_IN');
  const n = validateNickname(nickname);
  if (!n.ok) return failed('INVALID_NICKNAME', nicknameErrorText(n.reason));
  if (n.nickname === session.user.nickname) return { ok: true, unchanged: true, user: session.user };
  const res = await post('rename', { token: session.token, nickname: n.nickname }, opts);
  if (!res.ok) {
    if (res.error === 'AUTH_REQUIRED') requireLogin(session);
    return { ...res, message: accountErrorText(res.error, res) };
  }
  const local = session.setNickname(res.nickname ?? n.nickname);
  return local.ok ? { ok: true, user: local.user } : failed('SERVER_ERROR', nicknameErrorText(local.reason));
}
