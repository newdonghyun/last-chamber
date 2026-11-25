/**
 * LAST CHAMBER - 계정 PIN (4자리 숫자) 해시 · 검증 · 시도 제한
 *
 *   · PIN 원문은 어디에도 저장하지 않는다 — scrypt(솔트 16바이트) 해시만 players.pin_hash 에 둔다. 형식: 's1$<솔트 base64>$<해시 base64>'
 *     (4자리라 해시만으로 완전히 안전하진 않다 → 아래 시도 제한이 1차 방어, DB 키는 서버 전용으로 둘 것)
 *   · 시도 제한: 같은 닉네임으로 PIN 을 maxFails 번 틀리면 lockMs 동안 잠근다 · 같은 IP 는 windowMs 동안 maxPerIp 번까지 로그인 시도
 */
import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback);
const SCRYPT = Object.freeze({ N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
const KEY_BYTES = 32;

export const PIN_PATTERN = /^\d{4}$/;
/** 4자리 숫자 PIN 검사 → PIN 문자열 | null */
export const cleanPin = (raw) => (typeof raw === 'string' && PIN_PATTERN.test(raw) ? raw : null);

/** PIN → 저장용 해시 문자열 */
export async function hashPin(pin) {
  const salt = randomBytes(16);
  const key = await scrypt(pin, salt, KEY_BYTES, SCRYPT);
  return `s1$${salt.toString('base64')}$${key.toString('base64')}`;
}

/** 저장된 해시와 PIN 이 맞는가 (모양이 틀린 해시는 false) — 비교는 상수 시간 */
export async function verifyPin(pin, stored) {
  const [version, salt, hash] = typeof stored === 'string' ? stored.split('$') : [];
  if (version !== 's1' || !salt || !hash || !cleanPin(pin)) return false;
  const want = Buffer.from(hash, 'base64');
  if (want.length !== KEY_BYTES) return false;
  const got = await scrypt(pin, Buffer.from(salt, 'base64'), KEY_BYTES, SCRYPT);
  return timingSafeEqual(want, got);
}

/** 저장해도 되는 해시 모양인가 (파일 · DB 에서 읽은 값 검사) */
export const isPinHash = (v) => typeof v === 'string' && /^s1\$[A-Za-z0-9+/=]{16,40}\$[A-Za-z0-9+/=]{40,60}$/.test(v);

export const PIN_LIMITS = Object.freeze({ maxFails: 5, lockMs: 15 * 60_000, maxPerIp: 30, windowMs: 10 * 60_000 });

/** 로그인 시도 제한 (메모리 — 서버 1대 전제) */
export function createPinLimiter({ maxFails = PIN_LIMITS.maxFails, lockMs = PIN_LIMITS.lockMs, maxPerIp = PIN_LIMITS.maxPerIp, windowMs = PIN_LIMITS.windowMs, now = Date.now } = {}) {
  const fails = new Map(); // 닉네임 → { n, until }
  const ips = new Map(); // IP → { n, start }
  const sweep = () => { // 오래된 기록은 가끔 치운다
    const t = now();
    for (const [k, v] of fails) if (v.until && v.until < t) fails.delete(k);
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
    /** 이 닉네임이 잠겼으면 남은 ms, 아니면 0 */
    lockedFor(nickname) {
      const e = fails.get(nickname);
      return e?.until && e.until > now() ? e.until - now() : 0;
    },
    /** PIN 을 틀렸다 → 이번에 잠겼으면 true */
    fail(nickname) {
      const e = fails.get(nickname) ?? { n: 0, until: 0 };
      if (e.until && e.until <= now()) { e.n = 0; e.until = 0; }
      e.n += 1;
      if (e.n >= maxFails) e.until = now() + lockMs;
      fails.set(nickname, e);
      return e.until > 0;
    },
    /** PIN 을 맞혔다 → 실패 기록을 지운다 */
    succeed(nickname) { fails.delete(nickname); },
  };
}
