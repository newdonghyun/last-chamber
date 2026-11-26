/**
 * ODD ROULETTE - 계정 인증: 아이디 · 비밀번호(해시) · 로그인 토큰 · 로그인 시도 제한
 *
 *   · 아이디(username): 영문 소문자 · 숫자 · _ 4~16자 (대문자로 넣어도 소문자로 맞춘다 → 'Gunner' 와 'gunner' 는 같은 아이디)
 *   · 비밀번호: 6~64자. 원문은 어디에도 저장하지 않는다 — scrypt(솔트 16바이트) 해시만 players.password_hash 에 둔다. 형식 'p1$<솔트>$<해시>'
 *   · 로그인 토큰(자동 로그인): 't1.<user_id>.<발급 시각(초)>.<서명>' — 서명 = HMAC-SHA256(키 = AUTH_SECRET + 그 계정의 비밀번호 해시, 'user_id.시각')
 *       서버 메모리에 세션을 두지 않으므로 서버가 다시 켜져도(Render 무료 플랜의 잠자기 · 재배포) 로그인이 풀리지 않는다.
 *       비밀번호가 바뀌면 그 전에 발급한 토큰은 모두 무효. 유효 기간 TOKEN_TTL_SEC.
 *       AUTH_SECRET(환경 변수)을 두면 DB 가 새더라도 토큰을 위조할 수 없다 — Render 에 꼭 설정할 것.
 *   · 시도 제한: 같은 아이디로 비밀번호를 maxFails 번 틀리면 lockMs 동안 잠근다 · 같은 IP 는 windowMs 동안 maxPerIp 번까지
 */
import { createHmac, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback);
const SCRYPT = Object.freeze({ N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
const KEY_BYTES = 32;

export const USERNAME_RULE = Object.freeze({ min: 4, max: 16 });
export const PASSWORD_RULE = Object.freeze({ min: 6, max: 64 });
const USERNAME_CHARS = /^[a-z0-9_]+$/;

/** 아이디 검사 → 소문자 아이디 | null */
export function cleanUsername(raw) {
  if (typeof raw !== 'string' || raw.length > 64) return null;
  const name = raw.trim().toLowerCase();
  return name.length >= USERNAME_RULE.min && name.length <= USERNAME_RULE.max && USERNAME_CHARS.test(name) ? name : null;
}

/** 비밀번호 검사 (글자 수만 — 앞뒤 공백도 비밀번호의 일부) → 비밀번호 | null */
export function cleanPassword(raw) {
  if (typeof raw !== 'string' || raw.length > PASSWORD_RULE.max * 4) return null;
  const length = [...raw].length;
  return length >= PASSWORD_RULE.min && length <= PASSWORD_RULE.max ? raw : null;
}

/** 비밀번호 → 저장용 해시 */
export async function hashPassword(password) {
  const salt = randomBytes(16);
  const key = await scrypt(password.normalize('NFC'), salt, KEY_BYTES, SCRYPT);
  return `p1$${salt.toString('base64')}$${key.toString('base64')}`;
}

/** 저장해도 되는 해시 모양인가 (파일 · DB 에서 읽은 값 검사) */
export const isPasswordHash = (v) => typeof v === 'string' && /^p1\$[A-Za-z0-9+/=]{16,40}\$[A-Za-z0-9+/=]{40,60}$/.test(v);

/** 비밀번호가 해시와 맞는가 (모양이 틀린 해시는 false) — 비교는 상수 시간 */
export async function verifyPassword(password, stored) {
  if (typeof password !== 'string' || !isPasswordHash(stored)) return false;
  const [, salt, hash] = stored.split('$');
  const want = Buffer.from(hash, 'base64');
  if (want.length !== KEY_BYTES) return false;
  const got = await scrypt(password.normalize('NFC'), Buffer.from(salt, 'base64'), KEY_BYTES, SCRYPT);
  return timingSafeEqual(want, got);
}

// ── 로그인 토큰 ──
export const TOKEN_TTL_SEC = 180 * 24 * 3600; // 180일
const TOKEN_PATTERN = /^t1\.([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.(\d{9,11})\.([A-Za-z0-9_-]{43})$/;
const sign = (secret, passwordHash, body) => createHmac('sha256', `${secret}|${passwordHash}`).update(body).digest('base64url');
const nowSec = () => Math.floor(Date.now() / 1000);

/** 계정 { id, passwordHash } 의 로그인 토큰 발급 */
export function issueToken({ id, passwordHash }, secret = '', at = nowSec()) {
  const body = `${id}.${at}`;
  return `t1.${body}.${sign(secret, passwordHash, body)}`;
}

/** 토큰 모양만 읽는다 (서명 확인 전) → { id, iat, body, sig } | null */
export function readToken(token) {
  if (typeof token !== 'string' || token.length > 200) return null;
  const m = TOKEN_PATTERN.exec(token);
  return m ? { id: m[1], iat: Number(m[2]), body: `${m[1]}.${m[2]}`, sig: m[3] } : null;
}

/** readToken 결과가 이 계정의 비밀번호 해시로 서명한 · 기한이 남은 토큰인가 */
export function verifyToken(parsed, passwordHash, secret = '', at = nowSec()) {
  if (!parsed || !isPasswordHash(passwordHash)) return false;
  if (parsed.iat > at + 300 || at - parsed.iat > TOKEN_TTL_SEC) return false; // 미래 시각(시계 오차 5분 허용) · 만료
  const want = Buffer.from(sign(secret, passwordHash, parsed.body));
  const got = Buffer.from(parsed.sig);
  return want.length === got.length && timingSafeEqual(want, got);
}

// ── 횟수 제한 (고정 창 · 메모리 — 서버 1대 전제) ──
/** key 마다 windowMs 안에 max 번까지. hit(key) = 한 번 세고 허용이면 true · blocked(key) = 세지 않고 이미 다 썼는지만 */
export function createWindowLimiter({ max, windowMs, now = Date.now, maxKeys = 20_000 }) {
  const hits = new Map(); // key → { n, start }
  const live = (e) => Boolean(e) && now() - e.start < windowMs;
  return {
    hit(key) {
      let e = hits.get(key);
      if (!live(e)) {
        if (hits.size >= maxKeys) for (const [k, v] of hits) if (!live(v)) hits.delete(k);
        e = { n: 0, start: now() };
        hits.set(key, e);
      }
      e.n += 1;
      return e.n <= max;
    },
    blocked(key) {
      const e = hits.get(key);
      return live(e) && e.n >= max;
    },
  };
}

// ── 로그인 시도 제한 (메모리 — 서버 1대 전제) ──
export const LOGIN_LIMITS = Object.freeze({ maxFails: 5, lockMs: 15 * 60_000, maxPerIp: 40, windowMs: 10 * 60_000 });

export function createLoginLimiter({ maxFails = LOGIN_LIMITS.maxFails, lockMs = LOGIN_LIMITS.lockMs, maxPerIp = LOGIN_LIMITS.maxPerIp, windowMs = LOGIN_LIMITS.windowMs, now = Date.now } = {}) {
  const fails = new Map(); // 아이디 → { n, until }
  const ips = new Map(); // IP → { n, start }
  const sweep = () => { // 오래된 기록은 가끔 치운다
    const t = now();
    for (const [k, v] of fails) if (!v.until || v.until < t) fails.delete(k);
    for (const [k, v] of ips) if (t - v.start >= windowMs) ips.delete(k);
  };
  return {
    /** 이 IP 의 시도를 하나 센다 → 허용이면 true */
    allowIp(ip) {
      if (fails.size + ips.size > 10_000) sweep();
      const t = now();
      const e = ips.get(ip);
      if (!e || t - e.start >= windowMs) { ips.set(ip, { n: 1, start: t }); return true; }
      e.n += 1;
      return e.n <= maxPerIp;
    },
    /** 이 아이디가 잠겼으면 남은 ms, 아니면 0 */
    lockedFor(username) {
      const e = fails.get(username);
      return e?.until && e.until > now() ? e.until - now() : 0;
    },
    /** 비밀번호를 틀렸다 → 이번에 잠겼으면 true */
    fail(username) {
      const e = fails.get(username) ?? { n: 0, until: 0 };
      if (e.until && e.until <= now()) { e.n = 0; e.until = 0; }
      e.n += 1;
      if (e.n >= maxFails) e.until = now() + lockMs;
      fails.set(username, e);
      return e.until > 0;
    },
    /** 로그인 성공 → 실패 기록을 지운다 */
    succeed(username) { fails.delete(username); },
  };
}
