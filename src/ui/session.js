/**
 * LAST CHAMBER - 유저 세션: 간편 로그인(닉네임) · 고유 유저 ID(UUID) · 자동 로그인
 *
 *   DOM 을 건드리지 않는 순수 모듈이다 (저장소만 주입받는다 — Node 테스트에서도 그대로 돈다). 화면은 src/ui/loginGate.js.
 *   · 닉네임 규칙(validateNickname): 2~10자 · 공백 없음 · 글자/숫자와 ( _ . - · ) 만 — 서버(server/userStore.js cleanNickname)와 같은 규칙
 *   · 처음 로그인할 때 UUID(v4)를 하나 발급해 이 기기에 저장한다. 다시 접속하면 로그인 화면 없이 바로 들어간다(자동 로그인).
 *   · 로그아웃은 '로그인 상태'만 끈다. 유저 ID 는 기기에 남아 다음 로그인에서 그대로 쓰므로 서버 전적이 이어진다
 *     (탄피 · 스킨 · 로컬 전적도 이 기기에 저장된 프로필 하나라서 그 짝을 맞춘 것 — 로그아웃해도 아무것도 지워지지 않는다).
 *   · 저장 형식 (localStorage 'lastchamber.session'):  { v: 1, id, nickname, loggedIn, createdAt, loginAt }
 *     ⚠ src/ui/sessionBoot.js (첫 화면을 그리기 전에 도는 일반 스크립트)가 같은 키 · 같은 모양을 읽는다 — 바꿀 때 함께 고칠 것.
 *
 *   쓰는 법:
 *     import { userSession } from './session.js';
 *     userSession.user              → { id, nickname } | null   (로그인 중일 때만)
 *     userSession.login(nickname)   → { ok: true, user } | { ok: false, reason }
 *     userSession.rename(nickname)  → 같은 모양 (로그인 중일 때만, 같은 닉네임이면 { ok: true, unchanged: true })
 *     userSession.logout()
 *     userSession.subscribe(fn)     → 해제 함수. fn(user | null) 은 로그인 · 닉네임 변경 · 로그아웃 · reload(다른 탭의 변경) 때마다 불린다
 */

export const SESSION_KEY = 'lastchamber.session';
export const NICK_RULE = Object.freeze({ min: 2, max: 10 });
export const NICK_HINT = `${NICK_RULE.min}~${NICK_RULE.max}자 · 공백 없이 · 한글 · 영문 · 숫자 · ( _ . - · )`;
export const USER_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const NICK_CHARS = /^[\p{L}\p{N}_.\-·]+$/u; // 공백 · 제어문자 · 보이지 않는 문자(\p{Cf}) · 이모지 · 결합 문자는 여기서 걸린다
const HAS_WORD = /[\p{L}\p{N}]/u; // 기호만으로 된 이름 금지
const WHITESPACE = /\s/u; // 일반 공백 + 전각 공백(U+3000) · NBSP 등
const INVISIBLE_LETTERS = /[ᅟᅠㅤﾠ]/u; // 글자(\p{L})로 분류되지만 화면에 안 보이는 한글 채움 문자 — '빈 닉네임' 방지

const ERROR_TEXT = Object.freeze({
  empty: '닉네임을 입력해 주세요',
  whitespace: '공백 없이 입력해 주세요',
  too_short: `닉네임은 ${NICK_RULE.min}자 이상이어야 해요`,
  too_long: `닉네임은 ${NICK_RULE.max}자까지 쓸 수 있어요`,
  invalid_chars: '한글 · 영문 · 숫자와 ( _ . - · ) 만 쓸 수 있어요',
  not_logged_in: '먼저 로그인해 주세요',
});

/** validateNickname 의 reason → 화면에 보여 줄 문장 */
export const nicknameErrorText = (reason) => ERROR_TEXT[reason] ?? '닉네임을 저장할 수 없어요';

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

export const isUserId = (value) => typeof value === 'string' && USER_ID_PATTERN.test(value);

/** UUID v4 발급. crypto.randomUUID 는 보안 컨텍스트(https · localhost)에서만 있으므로, 없으면 getRandomValues 로 같은 형식을 만든다 */
export function createUserId(cryptoImpl = globalThis.crypto) {
  if (typeof cryptoImpl?.randomUUID === 'function') return cryptoImpl.randomUUID().toLowerCase();
  const b = new Uint8Array(16);
  if (typeof cryptoImpl?.getRandomValues === 'function') cryptoImpl.getRandomValues(b);
  else for (let i = 0; i < b.length; i += 1) b[i] = Math.floor(Math.random() * 256); // 아주 오래된 WebView 대비 (형식만 맞으면 된다)
  b[6] = (b[6] & 0x0f) | 0x40; // version 4
  b[8] = (b[8] & 0x3f) | 0x80; // variant 10xx
  const hex = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

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

/** 저장된 값을 믿지 않고 검사한다. ID 가 깨졌으면 세션 전체를 버리고(다음 로그인에서 새로 발급), 닉네임만 규칙에 안 맞으면 로그아웃 상태로 */
function sanitize(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = typeof raw.id === 'string' ? raw.id.trim().toLowerCase() : '';
  if (!isUserId(id)) return null;
  const nick = validateNickname(raw.nickname);
  return {
    v: 1,
    id,
    nickname: nick.ok ? nick.nickname : null,
    loggedIn: raw.loggedIn === true && nick.ok,
    createdAt: toTime(raw.createdAt),
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
  #newId;
  #data = null; // { v, id, nickname, loggedIn, createdAt, loginAt } | null(처음)
  #listeners = new Set();

  /** storage: getItem/setItem 을 가진 객체 (생략하면 localStorage, 못 쓰면 이번 방문에서만 유지) · now / newId 는 테스트용 */
  constructor({ storage = defaultStorage(), key = SESSION_KEY, now = () => Date.now(), newId = createUserId } = {}) {
    this.#storage = storage;
    this.#key = key;
    this.#now = now;
    this.#newId = newId;
    this.#read();
  }

  /** 로그인 중인 유저 { id, nickname } — 로그아웃 상태 · 처음이면 null */
  get user() {
    const d = this.#data;
    return d?.loggedIn ? { id: d.id, nickname: d.nickname } : null;
  }

  get isLoggedIn() { return this.#data?.loggedIn === true; }
  /** 로그아웃 뒤에도 남는 마지막 닉네임 (로그인 화면의 기본값) */
  get lastNickname() { return this.#data?.nickname ?? null; }
  /** 이 기기에 발급된 유저 ID (로그아웃 중에도 남는다) */
  get userId() { return this.#data?.id ?? null; }

  /** 저장소에서 다시 읽고, 바뀌었으면 구독자에게 알린다 (다른 탭의 storage 이벤트 · 앱 복귀 때) */
  reload() {
    const before = this.#signature();
    this.#read();
    if (this.#signature() !== before) this.#emit();
    return this;
  }

  /** 닉네임으로 로그인 (처음이면 UUID 발급). 규칙에 맞지 않으면 아무것도 바꾸지 않는다 */
  login(raw) {
    const res = validateNickname(raw);
    if (!res.ok) return res;
    const now = this.#now();
    const prev = this.#data;
    this.#data = { v: 1, id: prev?.id ?? this.#newId(), nickname: res.nickname, loggedIn: true, createdAt: prev?.createdAt || now, loginAt: now };
    this.#save();
    this.#emit();
    return { ok: true, user: this.user };
  }

  /** 닉네임 변경 (로그인 중일 때만) */
  rename(raw) {
    if (!this.isLoggedIn) return { ok: false, reason: 'not_logged_in' };
    const res = validateNickname(raw);
    if (!res.ok) return res;
    if (res.nickname === this.#data.nickname) return { ok: true, user: this.user, unchanged: true };
    this.#data = { ...this.#data, nickname: res.nickname };
    this.#save();
    this.#emit();
    return { ok: true, user: this.user };
  }

  /** 로그아웃: 로그인 상태만 끈다 (유저 ID · 마지막 닉네임은 남는다 → 다음 로그인 화면의 기본값) */
  logout() {
    if (!this.isLoggedIn) return { ok: true };
    this.#data = { ...this.#data, loggedIn: false };
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
        console.error('[LAST CHAMBER] 세션 구독 오류', err);
      }
    }
  }

  #signature() {
    const d = this.#data;
    return d ? `${d.id}|${d.nickname}|${d.loggedIn}` : '';
  }
}

/** 앱 전체가 같이 쓰는 세션 (ES 모듈은 한 번만 실행되므로 app.js · loginGate.js · multiplayer.js 가 같은 인스턴스를 본다) */
export const userSession = new UserSession();
