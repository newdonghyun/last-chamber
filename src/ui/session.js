/**
 * ODD ROULETTE - 유저 세션: 아이디 · 비밀번호 계정의 로그인 상태 · 자동 로그인 · 손님(둘러보기)
 *
 *   DOM 을 건드리지 않는 순수 모듈이다 (저장소만 주입받는다 — Node 테스트에서도 그대로 돈다). 화면은 src/ui/loginGate.js, 서버 호출은 src/ui/accountApi.js.
 *   · 로그인 · 회원가입에 성공하면 서버가 준 로그인 토큰 · user_id · 아이디 · 닉네임을 이 기기에 저장한다(signIn) → 다시 접속하면 로그인 화면 없이 바로 들어간다.
 *     비밀번호는 저장하지 않는다. 토큰은 서버(server/auth.js)가 서명한 것이라 서버가 확인한다 (틀리거나 만료되면 다시 로그인).
 *   · 손님(둘러보기): 로그인 없이 AI 딜러 연습만 — continueAsGuest() 로 기억해 두면 다음에도 로그인 화면 없이 타이틀로 (온라인 대전은 로그인해야 열린다).
 *   · 로그아웃은 토큰을 지운다 (아이디는 남겨 다음 로그인 화면의 기본값으로).
 *   · validateNickname: 이미 있는 닉네임(저장된 세션 · 서버가 알려 준 값)용 느슨한 규칙 — 2~10자 · 공백 없음 · 글자/숫자와 ( _ . - · ) — 예전 규칙으로 만든 계정이 로그아웃되지 않게.
 *     새로 정하는 닉네임(가입 · 변경)은 더 엄격한 src/engine/nicknameRules.js checkNewNickname.
 *     아이디 규칙(validateUsername): 영문 소문자 · 숫자 · _ 4~16자 · 비밀번호(validatePassword): 6~64자 — 서버(server/auth.js)와 같은 규칙
 *   · 저장 형식 (localStorage 'lastchamber.session'):  { v: 3, token, id, username, nickname, loggedIn, guest, loginAt }
 *     예전 형식(v1 닉네임만 · v2 PIN)은 토큰이 없으므로 로그아웃 상태로 읽는다 (예전 닉네임은 가입 화면의 기본값으로만).
 *     ⚠ src/ui/sessionBoot.js (첫 화면을 그리기 전에 도는 일반 스크립트)가 같은 키 · 같은 모양을 읽는다 — 바꿀 때 함께 고칠 것.
 *
 *   쓰는 법:
 *     import { userSession } from './session.js';
 *     userSession.user              → { id, username, nickname } | null   (로그인 중일 때만)
 *     userSession.token             → 로그인 토큰 | null (소켓 · 계정 API 에 실어 보낸다)
 *     userSession.isLoggedIn / isGuest
 *     userSession.signIn({ token, id, username, nickname }) → { ok: true, user } | { ok: false, reason }   (서버가 확인한 계정)
 *     userSession.setNickname(nickname)  서버에서 바꾼 닉네임을 이 기기에도
 *     userSession.continueAsGuest() · userSession.logout()
 *     userSession.subscribe(fn)     → 해제 함수. fn(user | null) 은 로그인 · 닉네임 변경 · 로그아웃 · 손님 · reload(다른 탭의 변경) 때마다 불린다
 */

import { NEW_NICK_HINT } from '../engine/nicknameRules.js';

export const SESSION_KEY = 'lastchamber.session';
export const NICK_RULE = Object.freeze({ min: 2, max: 10 });
export const NICK_HINT = NEW_NICK_HINT; // 닉네임을 새로 정하는 칸의 안내문
export const USERNAME_RULE = Object.freeze({ min: 4, max: 16 });
export const USERNAME_HINT = `영문 소문자 · 숫자 · _ ${USERNAME_RULE.min}~${USERNAME_RULE.max}자`;
export const PASSWORD_RULE = Object.freeze({ min: 6, max: 64 });
export const PASSWORD_HINT = `${PASSWORD_RULE.min}자 이상`;
export const USER_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const TOKEN_PATTERN = /^t1\.[0-9a-f-]{36}\.\d{9,11}\.[A-Za-z0-9_-]{43}$/; // server/auth.js issueToken 모양

const NICK_CHARS = /^[\p{L}\p{N}_.\-·]+$/u; // 공백 · 제어문자 · 보이지 않는 문자(\p{Cf}) · 이모지 · 결합 문자는 여기서 걸린다
const HAS_WORD = /[\p{L}\p{N}]/u; // 기호만으로 된 이름 금지
const WHITESPACE = /\s/u; // 일반 공백 + 전각 공백(U+3000) · NBSP 등
const INVISIBLE_LETTERS = /[ᅟᅠㅤﾠ]/u; // 글자(\p{L})로 분류되지만 화면에 안 보이는 한글 채움 문자 — '빈 닉네임' 방지
const USERNAME_CHARS = /^[a-z0-9_]+$/;

const ERROR_TEXT = Object.freeze({
  empty: '닉네임을 입력해 주세요',
  whitespace: '공백 없이 입력해 주세요',
  too_short: `닉네임은 ${NICK_RULE.min}자 이상이어야 해요`,
  too_long: `닉네임은 ${NICK_RULE.max}자까지 쓸 수 있어요`,
  invalid_chars: '한글 · 영문 · 숫자와 ( _ . - · ) 만 쓸 수 있어요',
  not_logged_in: '먼저 로그인해 주세요',
  bad_account: '계정 정보를 저장하지 못했어요. 다시 로그인해 주세요',
  username_empty: '아이디를 입력해 주세요',
  username_rule: `아이디는 ${USERNAME_HINT}로 정해 주세요`,
  password_short: `비밀번호는 ${PASSWORD_RULE.min}자 이상이어야 해요`,
  password_long: `비밀번호는 ${PASSWORD_RULE.max}자까지 쓸 수 있어요`,
});

/** validate* 의 reason → 화면에 보여 줄 문장 */
export const nicknameErrorText = (reason) => ERROR_TEXT[reason] ?? '저장할 수 없어요';

/** 닉네임 검사 · 정리 (NFC 정규화 + 앞뒤 공백 제거) → { ok: true, nickname } | { ok: false, reason: 'empty' | 'whitespace' | 'too_short' | 'too_long' | 'invalid_chars' } */
export function validateNickname(raw) {
  if (typeof raw !== 'string') return { ok: false, reason: 'empty' };
  const name = raw.normalize('NFC').trim();
  if (!name) return { ok: false, reason: 'empty' };
  if (WHITESPACE.test(name)) return { ok: false, reason: 'whitespace' };
  const length = [...name].length; // 글자 수는 코드 포인트 기준 (한글 1자 = 1)
  if (length < NICK_RULE.min) return { ok: false, reason: 'too_short' };
  if (length > NICK_RULE.max) return { ok: false, reason: 'too_long' };
  if (!NICK_CHARS.test(name) || !HAS_WORD.test(name) || INVISIBLE_LETTERS.test(name)) return { ok: false, reason: 'invalid_chars' };
  return { ok: true, nickname: name };
}

/** 아이디 검사 (앞뒤 공백 제거 · 소문자로) → { ok: true, username } | { ok: false, reason } */
export function validateUsername(raw) {
  const name = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (!name) return { ok: false, reason: 'username_empty' };
  if (name.length < USERNAME_RULE.min || name.length > USERNAME_RULE.max || !USERNAME_CHARS.test(name)) return { ok: false, reason: 'username_rule' };
  return { ok: true, username: name };
}

/** 비밀번호 검사 (글자 수만) → { ok: true, password } | { ok: false, reason } */
export function validatePassword(raw) {
  const length = typeof raw === 'string' ? [...raw].length : 0;
  if (length < PASSWORD_RULE.min) return { ok: false, reason: 'password_short' };
  if (length > PASSWORD_RULE.max) return { ok: false, reason: 'password_long' };
  return { ok: true, password: raw };
}

export const isUserId = (value) => typeof value === 'string' && USER_ID_PATTERN.test(value);
export const isToken = (value) => typeof value === 'string' && TOKEN_PATTERN.test(value);

/**
 * 닉네임 입력칸에 붙이는 공백 차단기: 입력하는 즉시 공백을 지운다 (한글 IME 조합 중에는 건드리지 않고 조합이 끝나면 정리).
 * onChange(value) 는 정리된 뒤마다 불린다 (글자 수 표시 · 안내문 갱신용). → 떼어 내는 함수
 */
export function attachNicknameFilter(input, onChange) {
  const clean = () => {
    const raw = input.value;
    const value = raw.replace(/\s+/gu, '');
    if (value !== raw) {
      const caret = input.selectionStart ?? raw.length;
      const at = raw.slice(0, caret).replace(/\s+/gu, '').length; // 지운 공백만큼 커서를 앞으로
      input.value = value;
      try { input.setSelectionRange(at, at); } catch { /* 선택 범위를 지원하지 않는 입력칸 */ }
    }
    onChange?.(input.value);
  };
  const onInput = (e) => {
    if (e.isComposing) onChange?.(input.value);
    else clean();
  };
  input.addEventListener('input', onInput);
  input.addEventListener('compositionend', clean);
  return () => {
    input.removeEventListener('input', onInput);
    input.removeEventListener('compositionend', clean);
  };
}

const toTime = (v) => (Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);

/** 저장된 값을 믿지 않고 검사한다. 토큰 · ID · 아이디 · 닉네임 중 하나라도 틀리면 로그아웃 상태로 (아이디 · 마지막 닉네임은 기본값으로 남긴다) */
function sanitize(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const nick = validateNickname(raw.nickname);
  const user = validateUsername(raw.username);
  const id = typeof raw.id === 'string' ? raw.id.trim().toLowerCase() : '';
  const signedIn = raw.loggedIn === true && isToken(raw.token) && isUserId(id) && user.ok && nick.ok;
  return {
    v: 3,
    token: signedIn ? raw.token : null,
    id: signedIn ? id : null,
    username: user.ok ? user.username : null,
    nickname: nick.ok ? nick.nickname : null,
    loggedIn: signedIn,
    guest: !signedIn && raw.guest === true,
    loginAt: toTime(raw.loginAt),
  };
}

function defaultStorage() {
  try {
    return globalThis.localStorage ?? null; // 접근만으로 예외가 나는 환경(비공개 창 등) 대비
  } catch {
    return null;
  }
}

export class UserSession {
  #storage;
  #key;
  #now;
  #data = null; // sanitize 결과 | null(처음)
  #listeners = new Set();

  /** storage: getItem/setItem 을 가진 객체 (생략하면 localStorage, 못 쓰면 이번 방문에서만 유지) · now 는 테스트용 */
  constructor({ storage = defaultStorage(), key = SESSION_KEY, now = () => Date.now() } = {}) {
    this.#storage = storage;
    this.#key = key;
    this.#now = now;
    this.#read();
  }

  /** 로그인 중인 계정 { id, username, nickname } — 로그아웃 · 손님 · 처음이면 null */
  get user() {
    const d = this.#data;
    return d?.loggedIn ? { id: d.id, username: d.username, nickname: d.nickname } : null;
  }

  get isLoggedIn() { return this.#data?.loggedIn === true; }
  /** 로그인 없이 둘러보는 중 (AI 딜러 연습만) */
  get isGuest() { return !this.isLoggedIn && this.#data?.guest === true; }
  /** 로그인 토큰 (소켓 handshake · 계정 API) */
  get token() { return this.#data?.loggedIn ? this.#data.token : null; }
  get userId() { return this.#data?.loggedIn ? this.#data.id : null; }
  /** 로그아웃 뒤에도 남는 아이디 · 마지막 닉네임 (로그인 · 가입 화면의 기본값) */
  get lastUsername() { return this.#data?.username ?? null; }
  get lastNickname() { return this.#data?.nickname ?? null; }

  /** 저장소에서 다시 읽고, 바뀌었으면 구독자에게 알린다 (다른 탭의 storage 이벤트 · 앱 복귀 때) */
  reload() {
    const before = this.#signature();
    this.#read();
    if (this.#signature() !== before) this.#emit();
    return this;
  }

  /** 서버가 확인한 계정으로 로그인 (회원가입 · 로그인 응답) → { ok: true, user } | { ok: false, reason } — 모양이 틀리면 아무것도 바꾸지 않는다 */
  signIn({ token, id, username, nickname } = {}) {
    const uid = typeof id === 'string' ? id.trim().toLowerCase() : '';
    const user = validateUsername(username);
    const nick = validateNickname(nickname);
    if (!isToken(token) || !isUserId(uid) || !user.ok) return { ok: false, reason: 'bad_account' };
    if (!nick.ok) return nick;
    this.#data = { v: 3, token, id: uid, username: user.username, nickname: nick.nickname, loggedIn: true, guest: false, loginAt: this.#now() };
    this.#save();
    this.#emit();
    return { ok: true, user: this.user };
  }

  /** 서버에서 바꾼 닉네임을 이 기기에도 (로그인 중일 때만) */
  setNickname(raw) {
    if (!this.isLoggedIn) return { ok: false, reason: 'not_logged_in' };
    const res = validateNickname(raw);
    if (!res.ok) return res;
    if (res.nickname === this.#data.nickname) return { ok: true, user: this.user, unchanged: true };
    this.#data = { ...this.#data, nickname: res.nickname };
    this.#save();
    this.#emit();
    return { ok: true, user: this.user };
  }

  /** 로그인 없이 둘러보기 (AI 딜러 연습만) — 다음 접속에도 로그인 화면 없이 타이틀로 */
  continueAsGuest() {
    if (this.isLoggedIn) return { ok: false, reason: 'logged_in' };
    this.#data = { ...(this.#data ?? { v: 3, token: null, id: null, username: null, nickname: null, loginAt: 0 }), loggedIn: false, guest: true };
    this.#save();
    this.#emit();
    return { ok: true };
  }

  /** 로그아웃: 토큰을 지운다 (아이디 · 마지막 닉네임은 다음 로그인 화면의 기본값으로 남긴다) */
  logout() {
    if (!this.isLoggedIn && !this.isGuest) return { ok: true };
    this.#data = { ...this.#data, token: null, id: null, loggedIn: false, guest: false };
    this.#save();
    this.#emit();
    return { ok: true };
  }

  subscribe(fn) {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }

  #read() {
    if (!this.#storage) return; // 저장소 없음 → 지금 메모리 값 유지
    let text;
    try {
      text = this.#storage.getItem(this.#key);
    } catch {
      return; // 읽기 실패 → 지금 값 유지
    }
    if (text == null) {
      this.#data = null;
      return;
    }
    try {
      this.#data = sanitize(JSON.parse(text));
    } catch {
      this.#data = null; // 손상된 값 → 처음부터
    }
  }

  #save() {
    try {
      this.#storage?.setItem(this.#key, JSON.stringify(this.#data));
    } catch {
      // 저장 실패(용량 · 비공개 창) → 이번 방문에서만 유지
    }
  }

  #emit() {
    const user = this.user;
    for (const fn of [...this.#listeners]) {
      try {
        fn(user);
      } catch (err) {
        console.error('[ODD ROULETTE] 세션 구독 오류', err);
      }
    }
  }

  #signature() {
    const d = this.#data;
    return d ? `${d.id}|${d.token}|${d.nickname}|${d.loggedIn}|${d.guest}` : '';
  }
}

/** 앱 전체가 같이 쓰는 세션 (ES 모듈은 한 번만 실행되므로 app.js · loginGate.js · multiplayer.js 가 같은 인스턴스를 본다) */
export const userSession = new UserSession();
