/**
 * LAST CHAMBER - 서버 유저 저장소: 계정(아이디 · 비밀번호 · 닉네임) · 랭킹 전적(승/패 · 연승 · MMR)
 *
 *   계정 하나 = players 행 하나 (user_id 는 서버가 가입 때 만든 UUID):
 *     { id, username, nickname, passwordHash, wins, losses, streak, maxStreak, mmr, createdAt, updatedAt, lastSeenAt }   (시각은 ms)
 *   · 회원가입 signup({ username, password, nickname }) — 아이디 · 닉네임이 다른 계정과 겹치면 USERNAME_TAKEN / NICKNAME_TAKEN. 비밀번호는 해시만(server/auth.js)
 *   · 로그인 login({ username, password }) — 맞으면 그 계정(전적 그대로) · 틀리면 BAD_CREDENTIALS (아이디가 없는지 비밀번호가 틀렸는지는 알려 주지 않는다)
 *   · 자동 로그인 authenticate(token) — server/auth.js 의 로그인 토큰을 그 계정의 비밀번호 해시로 확인 → 계정 | null
 *   · 닉네임 변경 rename(id, nickname) — 다른 계정이 쓰는 닉네임이면 NICKNAME_TAKEN, 아니면 players 를 바로 UPDATE
 *   · 전적: 랭킹전(무작위 매칭 · 공개 방) 판이 끝나면 roomManager 가 recordResult(userId, won) — 친선 비밀방 · AI 딜러 연습은 여기 오지 않는다
 *   · TOP 10(leaderboard): 계정이고 랭킹전을 1판 이상 둔 유저(wins + losses > 0)만
 *   · 저장: file 을 주면 JSON 파일로 남긴다 (바뀐 뒤 saveDelayMs 동안 모아서 한 번 · 임시 파일에 쓴 뒤 바꿔치기 → 쓰다가 꺼져도 파일이 깨지지 않는다).
 *           주지 않으면 메모리에만 (테스트 · 임시 서버). 서버를 시작할 때 파일이 있으면 읽어 온다.
 *   · Supabase: db(Supabase 클라이언트 또는 그 Promise)를 주면 players 테이블이 원본이다 (파일 저장은 끈다). 메모리는 캐시 — 서버 인스턴스 1개 전제.
 *       create table players (user_id text primary key, nickname text not null, wins int not null default 0, losses int not null default 0,
 *                             streak int not null default 0, max_streak int not null default 0, mmr int not null default 1000);
 *       + 계정 컬럼 · 중복 방지 인덱스: 아래 ACCOUNT_SQL (한 번 실행). 없으면 회원가입 · 로그인만 ACCOUNT_SETUP_REQUIRED (서버는 그대로 돈다)
 *     키는 서버 전용 service_role(secret) 키 — 공개(publishable) 키로 테이블을 열어 두면 누구나 비밀번호 해시를 읽고 행을 고칠 수 있다.
 *   · 판정(MMR_RULE): 승 = wins+1 · streak+1 · max_streak 갱신 · mmr+25 / 패 = losses+1 · streak 0 · mmr−20 (0 아래로는 안 내려감)
 *   ⚠ 무료 클라우드 호스팅(Render 무료 플랜 등)의 디스크는 재배포 · 재시작 때 비워진다 — 오래 남기려면 영구 디스크 경로를 USER_DATA_FILE 로 주거나 DB 로 바꿀 것.
 */

import { readFileSync, realpathSync } from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { hashPassword, verifyPassword, isPasswordHash, readToken, verifyToken, cleanUsername } from './auth.js';
import { noirNickname } from './nicknames.js';

// ── Supabase 접속 정보: 환경 변수가 없으면 기본값 ──
const SUPABASE_DEFAULT_URL = 'https://ernxkahepygvweszgtch.supabase.co';
const SUPABASE_DEFAULT_KEY = 'sb_publishable_Kb57Uuv-m8SXWk6CJXtMPA_sXUQjdSI';
/** 'https://xxx.supabase.co/rest/v1/' 처럼 경로까지 넣어도 프로젝트 주소(origin)만 쓴다 — 경로가 붙으면 supabase-js 가 /rest/v1 을 한 번 더 붙여 PGRST125(Invalid path)로 실패한다 */
export const supabaseOrigin = (url) => {
  try {
    return new URL(String(url).trim()).origin;
  } catch {
    return url;
  }
};
export const SUPABASE_URL = supabaseOrigin(process.env.SUPABASE_URL || SUPABASE_DEFAULT_URL);
export const SUPABASE_KEY = process.env.SUPABASE_KEY || SUPABASE_DEFAULT_KEY;

/** node server/index.js 로 실행된 서버인가 (테스트처럼 서버를 import 만 한 경우에는 실제 DB 에 붙지 않는다) */
function startedAsServer() {
  try {
    const same = (a, b) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);
    const dir = realpathSync(path.dirname(fileURLToPath(import.meta.url)));
    const entry = realpathSync(process.argv[1] ?? '');
    return same(entry, path.join(dir, 'index.js')) || same(entry, dir);
  } catch {
    return false;
  }
}

/** Supabase 클라이언트 — Node 22 미만에는 전역 WebSocket 이 없어 createClient 가 실패하므로 ws 로 채운다 (Realtime 은 쓰지 않는다) */
async function connectSupabase(url, key) {
  const { createClient } = await import('@supabase/supabase-js');
  const transport = globalThis.WebSocket ?? (await import('ws')).WebSocket;
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false }, realtime: { transport } });
}

/** 유저 ID = UUID (소문자 16진수, RFC 4122 변형) */
export const USER_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
/** 닉네임 규칙: 2~10자 · 공백 없음 · 글자/숫자와 ( _ . - · ) — 클라이언트 src/ui/session.js validateNickname 과 같다 */
export const NICK_RULE = Object.freeze({ min: 2, max: 10 });
const NICK_CHARS = /^[\p{L}\p{N}_.\-·]+$/u;
const HAS_WORD = /[\p{L}\p{N}]/u;
const INVISIBLE_LETTERS = /[ᅟᅠㅤﾠ]/u; // 글자로 분류되지만 보이지 않는 한글 채움 문자
const MAX_COUNT = 9_999_999;
/** 서버 랭킹 점수 (players.mmr) */
export const MMR_RULE = Object.freeze({ start: 1000, win: 25, loss: 20 });
const TABLE = 'players';
const COLUMNS = 'user_id, nickname, wins, losses, streak, max_streak, mmr';
const ACCOUNT_COLUMNS = `${COLUMNS}, username, password_hash`;
/**
 * players 에 계정을 쓰려면 한 번 실행할 SQL (Supabase 대시보드 → SQL Editor).
 * 아이디는 하나뿐 · 닉네임은 계정끼리 하나뿐 (계정이 아닌 예전 행은 그대로 둔다) · 예전 PIN 컬럼 · 인덱스는 지운다
 */
export const ACCOUNT_SQL = [
  'alter table public.players add column if not exists username text;',
  'alter table public.players add column if not exists password_hash text;',
  'create unique index if not exists players_username_key on public.players (username);',
  'create unique index if not exists players_account_nickname_key on public.players (nickname) where username is not null;',
  'drop index if exists public.players_nickname_pin_key;',
  'alter table public.players drop column if exists pin_hash;',
].join('\n');
const AUTO_NICK_TRIES = 4; // 자동 닉네임이 unique 인덱스에서 겹쳤을 때 다시 뽑는 최대 횟수
const BOARD_CACHE_MS = 3000; // get_leaderboard 연타가 그대로 DB 로 가지 않게
const ACCOUNT_RECHECK_MS = 30_000; // 계정 컬럼이 없을 때 가입 · 로그인 시도에서 다시 확인하는 최소 간격

export const USER_DEFAULTS = Object.freeze({ maxUsers: 50_000, saveDelayMs: 1000 });

/** 유저 ID 검사 → 소문자 UUID | null */
export function cleanUserId(raw) {
  const id = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  return USER_ID_PATTERN.test(id) ? id : null;
}

/** 닉네임 검사 (NFC 정규화 · 앞뒤 공백 제거) → 닉네임 | null */
export function cleanNickname(raw) {
  if (typeof raw !== 'string' || raw.length > 64) return null;
  const name = raw.normalize('NFC').trim();
  const length = [...name].length;
  if (length < NICK_RULE.min || length > NICK_RULE.max) return null;
  if (/\s/u.test(name) || INVISIBLE_LETTERS.test(name) || !NICK_CHARS.test(name) || !HAS_WORD.test(name)) return null;
  return name;
}

const count = (v) => (Number.isFinite(v) ? Math.min(MAX_COUNT, Math.max(0, Math.floor(v))) : 0);
const time = (v, fallback) => (Number.isFinite(v) && v > 0 ? Math.floor(v) : fallback);

/** 파일에서 읽은 기록 한 줄 검사 */
function readRecord(raw, now) {
  const id = cleanUserId(raw?.id);
  const nickname = typeof raw?.nickname === 'string' && raw.nickname.trim() ? raw.nickname.trim().slice(0, 40) : null;
  if (!id || !nickname) return null;
  const createdAt = time(raw.createdAt, now);
  const username = cleanUsername(raw.username);
  const passwordHash = isPasswordHash(raw.passwordHash) ? raw.passwordHash : null;
  return {
    id,
    username: username && passwordHash ? username : null, // 둘 다 있어야 계정
    nickname,
    passwordHash: username && passwordHash ? passwordHash : null,
    wins: count(raw.wins),
    losses: count(raw.losses),
    streak: count(raw.streak),
    maxStreak: count(raw.maxStreak),
    mmr: Number.isFinite(raw.mmr) ? count(raw.mmr) : MMR_RULE.start,
    createdAt,
    updatedAt: time(raw.updatedAt, createdAt),
    lastSeenAt: time(raw.lastSeenAt, createdAt),
  };
}

/** 화면에 보여 줄 공개 부분 (ID · 아이디 · 비밀번호 해시 · 시각은 빼고) → { nickname, wins, losses, games, streak, maxStreak, mmr } | null */
export const publicRecord = (rec) => (rec
  ? { nickname: rec.nickname, wins: rec.wins, losses: rec.losses, games: rec.wins + rec.losses, streak: rec.streak, maxStreak: rec.maxStreak, mmr: rec.mmr }
  : null);

/** 판 결과 한 번을 기록에 반영 (MMR_RULE) */
function applyResult(rec, won) {
  if (won) {
    rec.wins = Math.min(MAX_COUNT, rec.wins + 1);
    rec.streak = Math.min(MAX_COUNT, rec.streak + 1);
    rec.maxStreak = Math.max(rec.maxStreak, rec.streak);
    rec.mmr = Math.min(MAX_COUNT, rec.mmr + MMR_RULE.win);
  } else {
    rec.losses = Math.min(MAX_COUNT, rec.losses + 1);
    rec.streak = 0;
    rec.mmr = Math.max(0, rec.mmr - MMR_RULE.loss);
  }
}

const fromRow = (row) => ({
  wins: count(row.wins), losses: count(row.losses), streak: count(row.streak), maxStreak: count(row.max_streak),
  mmr: Number.isFinite(row.mmr) ? count(row.mmr) : MMR_RULE.start,
});
// 전적 upsert 는 username · password_hash 를 싣지 않는다 (PostgREST upsert 는 보낸 컬럼만 고친다 → 계정 정보가 지워지지 않는다)
const toRow = (rec) => ({ user_id: rec.id, nickname: rec.nickname, wins: rec.wins, losses: rec.losses, streak: rec.streak, max_streak: rec.maxStreak, mmr: rec.mmr });
const fromDbRow = (row) => ({
  id: row.user_id, nickname: row.nickname, username: cleanUsername(row.username), passwordHash: isPasswordHash(row.password_hash) ? row.password_hash : null, ...fromRow(row),
});
const byRank = (a, b) => b.mmr - a.mmr || b.wins - a.wins;
const hasPlayed = (r) => r.wins + r.losses > 0; // 랭킹전을 1판 이상 — TOP 10 에 오를 자격
/** unique 인덱스 위반(23505) → 어떤 값이 겹쳤는지 */
const duplicateOf = (err) => {
  if (err?.cause?.code !== '23505') return null;
  return /nickname/i.test(`${err.cause.message ?? ''} ${err.cause.details ?? ''}`) ? 'NICKNAME_TAKEN' : 'USERNAME_TAKEN';
};

/**
 * 유저 저장소를 만든다.
 *   file        JSON 파일 경로 (null · '' 이면 메모리에만)
 *   db          Supabase 클라이언트 또는 그 Promise (주면 players 테이블에 저장 · file 은 무시. 연결에 실패하면 메모리로)
 *   maxUsers    최대 계정 수 — 가득 차면 새로 가입할 수 없다
 *   saveDelayMs 바뀐 뒤 파일에 쓰기까지 모으는 시간
 *   authSecret  로그인 토큰 서명에 섞는 서버 비밀 (환경 변수 AUTH_SECRET)
 *   now         시계 (테스트용)        onError(err)  읽기 · 쓰기 실패를 알린다 (서버는 계속 돈다)        log(...)  상태 로그
 * → { signup, login, authenticate, rename, ready, get, recordResult, recordMatch, leaderboard, health, publicView, size, flush, close }
 */
export function createUserStore({
  file = null, db = null, maxUsers = USER_DEFAULTS.maxUsers, saveDelayMs = USER_DEFAULTS.saveDelayMs, authSecret = '',
  now = Date.now, onError = () => {}, log = () => {}, accountRecheckMs = ACCOUNT_RECHECK_MS,
} = {}) {
  const users = new Map(); // id → record (계정 · 캐시)
  const byUsername = new Map(); // 아이디 → id
  const nickOwner = new Map(); // 계정 닉네임 → id
  let dirty = false;
  let timer = null;
  let chain = Promise.resolve(); // 파일 쓰기는 한 번에 하나씩 차례로
  let closed = false;
  let serialChain = Promise.resolve(); // 가입 · 닉네임 변경은 한 번에 하나씩 (같은 아이디 · 닉네임이 동시에 둘 생기지 않게)

  const index = (rec) => {
    if (!rec.username) return;
    byUsername.set(rec.username, rec.id);
    nickOwner.set(rec.nickname, rec.id);
  };
  function serial(task) {
    const run = serialChain.then(task);
    serialChain = run.catch(() => {});
    return run;
  }

  // ── Supabase (db 가 있을 때만) ──
  if (!db && startedAsServer()) { // 서버 실행인데 index.js 가 클라이언트를 못 넘겼다(환경 변수 없음) → 기본 접속 정보로
    log('[DB] SUPABASE_URL · SUPABASE_KEY:', process.env.SUPABASE_URL && process.env.SUPABASE_KEY ? '환경 변수' : '기본값 사용', `(${SUPABASE_URL})`);
    db = connectSupabase(SUPABASE_URL, SUPABASE_KEY);
  }
  if (db) file = null; // DB 가 원본 — 파일과 둘로 갈라지지 않게
  let client = null;
  let dbOk = null; // 마지막 DB 작업 성공 여부 (/healthz) — null = 아직 없음
  let dbError = null; // 마지막 DB 오류 메시지 (/healthz — Render 로그를 못 볼 때 원인 확인용, 키는 들어가지 않는다)
  const markDb = (err) => {
    dbOk = !err;
    dbError = err ? String(err.message ?? err).slice(0, 400) : null;
  };
  const dbReady = db
    ? Promise.resolve(db).then((c) => { client = c; }, (err) => {
      const e = new Error(`Supabase 클라이언트를 만들지 못해 메모리로 동작합니다: ${err?.message ?? err}`, { cause: err });
      markDb(e);
      onError(e);
    })
    : Promise.resolve();
  const meta = new Map(); // id → { chain, loaded, pending: [won…] } — 유저별 DB 쓰기 순서
  const inflight = new Set();
  let board = { at: -Infinity, rows: null };
  // 흔한 원인을 로그에 함께 적는다
  const HINTS = [
    [/row-level security|permission denied/i, 'SUPABASE_KEY 에 service_role(secret) 키를 넣으세요 (anon 키는 RLS 에 막힌다)'],
    [/ON CONFLICT|exclusion constraint/i, 'players.user_id 에 primary key(또는 unique)가 필요합니다'],
    [/column|relation|does not exist|schema cache/i, 'players 테이블 · 컬럼을 확인하세요 (계정 컬럼은 ACCOUNT_SQL)'],
    [/fetch failed|ENOTFOUND|Invalid API key|JWT/i, 'SUPABASE_URL · SUPABASE_KEY 값을 확인하세요'],
  ];
  /** Supabase 응답 { data, error } → 오류면 code · details · hint 까지 담아 던진다 (원본은 err.cause) */
  const check = (res, op) => {
    if (!res?.error) return res;
    const e = res.error;
    const hint = HINTS.find(([re]) => re.test(`${e.message} ${e.details ?? ''}`))?.[1];
    throw new Error([`${op} 실패: ${e.message}`, e.code && `code=${e.code}`, e.details && `details=${e.details}`, e.hint && `hint=${e.hint}`, hint && `→ ${hint}`].filter(Boolean).join(' · '), { cause: e });
  };

  // 시작: players 테이블 확인 + 계정 컬럼 확인 · 계정 목록(아이디 · 닉네임) 읽기
  let accountReady = !db; // 메모리 · 파일 저장은 그대로 된다. DB 는 계정 컬럼(ACCOUNT_SQL)이 있어야 한다
  let accountsProbedAt = -Infinity;
  const schemaReady = db
    ? dbReady.then(async () => {
      log('[DB] Supabase initialized:', Boolean(client));
      if (!client) { accountReady = true; return; } // DB 연결 실패 → 메모리로 동작
      try {
        check(await client.from(TABLE).select(COLUMNS).limit(1), 'players 테이블 확인');
        markDb(null);
        log('[DB] players 테이블 확인 완료');
      } catch (err) {
        markDb(err);
        onError(err);
        return;
      }
      await probeAccounts();
    })
    : Promise.resolve();
  if (!db) log('[DB] Supabase initialized:', false, `— SUPABASE_URL · SUPABASE_KEY 가 없어 ${file ? '파일' : '메모리'}에 저장합니다`);

  /** 계정 컬럼 확인 + 계정 목록 → accountReady. 서버가 뜬 뒤 ACCOUNT_SQL 을 실행해도 다음 가입 · 로그인 시도 때 다시 확인한다 */
  async function probeAccounts() {
    accountsProbedAt = now();
    try {
      check(await client.from(TABLE).select('user_id, username, password_hash').limit(1), 'players 계정 컬럼 확인');
      const res = check(await client.from(TABLE).select('user_id, username, nickname').not('username', 'is', null).limit(maxUsers), '계정 목록');
      for (const row of res.data ?? []) {
        const username = cleanUsername(row.username);
        if (!username) continue;
        byUsername.set(username, row.user_id);
        nickOwner.set(row.nickname, row.user_id);
      }
      accountReady = true;
      log(`[DB] 계정 ${byUsername.size}개 확인 — 회원가입 · 로그인 사용 가능`);
    } catch (err) {
      onError(new Error(`players 에 계정 컬럼(username · password_hash)이 없어 회원가입 · 로그인을 쓸 수 없습니다. Supabase SQL Editor 에서 실행하세요:\n${ACCOUNT_SQL}`, { cause: err }));
    }
  }
  async function ensureAccounts() {
    await schemaReady;
    if (!accountReady && client && now() - accountsProbedAt >= accountRecheckMs) await probeAccounts();
    return accountReady;
  }

  const upsert = async (rec) => {
    await dbReady;
    if (!client) return;
    check(await client.from(TABLE).upsert(toRow(rec), { onConflict: 'user_id' }), `players upsert(${rec.nickname})`);
    markDb(null);
    board.at = -Infinity; // 바뀐 전적 · 닉네임이 랭킹에 바로 보이게
  };

  /** 유저별 DB 쓰기를 차례로. 실패해도 게임은 계속 — 오류는 [DB ERROR] 로 알린다 */
  function queue(m, task) {
    const run = m.chain.then(task).catch((err) => { markDb(err); onError(err); });
    m.chain = run;
    inflight.add(run);
    run.finally(() => inflight.delete(run));
    return run;
  }
  const loadedMeta = () => ({ chain: Promise.resolve(), loaded: true, pending: [] });

  /** DB 에서 읽은 계정을 캐시에 올린다 (이미 있으면 캐시가 최신 — 계정 정보만 채운다) → 기록 | null(가득 참) */
  function adopt(row) {
    let rec = users.get(row.id);
    if (!rec) {
      if (users.size >= maxUsers) return null;
      const t = now();
      rec = { ...row, createdAt: t, updatedAt: t, lastSeenAt: t };
      users.set(rec.id, rec);
      if (client) meta.set(rec.id, loadedMeta()); // 방금 DB 에서 읽었다
    } else {
      rec.username ??= row.username;
      rec.passwordHash ??= row.passwordHash;
    }
    index(rec);
    return rec;
  }

  async function usernameTaken(username) {
    if (!client) return byUsername.has(username);
    const res = check(await client.from(TABLE).select('user_id').eq('username', username).limit(1), `아이디 확인(${username})`);
    markDb(null);
    return (res.data ?? []).length > 0;
  }

  async function nicknameTaken(nickname, exceptId) {
    if (!client) {
      const owner = nickOwner.get(nickname);
      return Boolean(owner && owner !== exceptId);
    }
    const res = check(await client.from(TABLE).select('user_id').eq('nickname', nickname).not('username', 'is', null).limit(5), `닉네임 확인(${nickname})`);
    markDb(null);
    return (res.data ?? []).some((row) => row.user_id !== exceptId);
  }

  if (file) load();

  function load() {
    let text;
    try {
      text = readFileSync(file, 'utf8');
    } catch (err) {
      if (err?.code !== 'ENOENT') onError(err); // 파일이 아직 없으면 빈 저장소로 시작
      return;
    }
    try {
      const data = JSON.parse(text);
      const t = now();
      for (const raw of Array.isArray(data?.users) ? data.users : []) {
        const rec = readRecord(raw, t);
        if (!rec || users.size >= maxUsers) continue;
        users.set(rec.id, rec);
        index(rec);
      }
    } catch (err) {
      onError(new Error(`유저 파일을 읽지 못해 빈 저장소로 시작합니다 (${file}): ${err.message}`));
    }
  }

  function markDirty() {
    if (!file || closed) return;
    dirty = true;
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      save();
    }, saveDelayMs);
    timer.unref?.(); // 저장 대기 때문에 프로세스가 안 끝나는 일이 없게 (종료할 때는 close 가 마저 쓴다)
  }

  function save() {
    if (!file || !dirty) return chain;
    dirty = false;
    const json = JSON.stringify({ v: 2, savedAt: now(), users: [...users.values()] });
    chain = chain.then(async () => {
      await mkdir(path.dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      await writeFile(tmp, json, 'utf8');
      await rename(tmp, file); // 바꿔치기 — 쓰는 도중에 꺼져도 기존 파일은 멀쩡하다
    }).catch((err) => {
      dirty = true; // 다음 변경 때 다시 시도
      onError(err);
    });
    return chain;
  }

  // ── 계정 ──

  /**
   * 회원가입 (아이디 · 비밀번호 · 닉네임은 이미 검사한 값) → { ok: true, user } | { ok: false, error }
   *   USERNAME_TAKEN · NICKNAME_TAKEN · ACCOUNT_SETUP_REQUIRED(DB 계정 컬럼 없음) · SERVER_BUSY(가득 참)
   */
  async function signup({ username, password, nickname = null }) {
    if (!(await ensureAccounts())) return { ok: false, error: 'ACCOUNT_SETUP_REQUIRED' };
    const auto = nickname === null; // 닉네임을 비웠다 → 서버가 느와르 닉네임을 붙인다 (로비 · 계정 창에서 언제든 바꿀 수 있다)
    return serial(async () => {
      if (await usernameTaken(username)) return { ok: false, error: 'USERNAME_TAKEN' };
      if (!auto && (await nicknameTaken(nickname, null))) return { ok: false, error: 'NICKNAME_TAKEN' };
      if (users.size >= maxUsers) return { ok: false, error: 'SERVER_BUSY' };
      const t = now();
      const passwordHash = await hashPassword(password);
      for (let attempt = 0; attempt < AUTO_NICK_TRIES; attempt += 1) { // 직접 정한 닉네임은 한 번, 자동 닉네임은 겹치면 다시 뽑아 최대 AUTO_NICK_TRIES 번
        const name = auto ? await freshNickname(attempt) : nickname;
        if (!name) return { ok: false, error: 'SERVER_BUSY' };
        const rec = {
          id: randomUUID(), username, nickname: name, passwordHash,
          wins: 0, losses: 0, streak: 0, maxStreak: 0, mmr: MMR_RULE.start, createdAt: t, updatedAt: t, lastSeenAt: t,
        };
        if (client) {
          try {
            check(await client.from(TABLE).insert({ ...toRow(rec), username, password_hash: rec.passwordHash }), `회원가입(${username})`);
            markDb(null);
          } catch (err) {
            const dup = duplicateOf(err); // 그새 같은 아이디 · 닉네임이 생겼다 (unique 인덱스)
            if (dup === 'NICKNAME_TAKEN' && auto) continue; // 자동 닉네임이 그 사이 다른 가입과 겹쳤다 → 다시 뽑는다
            if (dup) return { ok: false, error: dup };
            throw err;
          }
          meta.set(rec.id, loadedMeta());
        }
        users.set(rec.id, rec);
        index(rec);
        board.at = -Infinity;
        markDirty();
        return { ok: true, user: rec };
      }
      return { ok: false, error: 'NICKNAME_TAKEN' };
    });
  }

  /** 아직 아무도 안 쓰는 느와르 닉네임 하나 (처음에는 숫자 없이, 겹치면 숫자를 붙여) — 못 찾으면 null */
  async function freshNickname(round) {
    for (let i = 0; i < 12; i += 1) {
      const name = noirNickname(Math.random, { number: round > 0 || i >= 6 });
      if (!(await nicknameTaken(name, null))) return name;
    }
    return null;
  }

  let dummyHash = null; // 없는 아이디도 같은 시간을 쓰게 (아이디가 있는지 응답 시간으로 알아내지 못하게)
  /** 로그인 (아이디는 검사한 값) → { ok: true, user } | { ok: false, error: 'BAD_CREDENTIALS' | 'ACCOUNT_SETUP_REQUIRED' | 'SERVER_BUSY' } */
  async function login({ username, password }) {
    if (!(await ensureAccounts())) return { ok: false, error: 'ACCOUNT_SETUP_REQUIRED' };
    let row = null;
    if (client) {
      const res = check(await client.from(TABLE).select(ACCOUNT_COLUMNS).eq('username', username).maybeSingle(), `로그인(${username})`);
      markDb(null);
      row = res.data ? fromDbRow(res.data) : null;
    } else {
      const id = byUsername.get(username);
      row = id ? users.get(id) : null;
    }
    if (!row?.passwordHash) {
      dummyHash ??= hashPassword('not-a-real-password');
      await verifyPassword(String(password), await dummyHash);
      return { ok: false, error: 'BAD_CREDENTIALS' };
    }
    if (!(await verifyPassword(password, row.passwordHash))) return { ok: false, error: 'BAD_CREDENTIALS' };
    const rec = adopt(row);
    if (!rec) return { ok: false, error: 'SERVER_BUSY' };
    rec.lastSeenAt = now();
    return { ok: true, user: rec };
  }

  /** 로그인 토큰 → 계정 | null (모양이 틀림 · 서명이 안 맞음 · 만료 · 비밀번호가 바뀜 · 없는 계정) */
  async function authenticate(token) {
    const parsed = readToken(token);
    if (!parsed) return null;
    await schemaReady;
    let rec = users.get(parsed.id);
    if (!rec?.passwordHash && client) {
      try {
        const res = check(await client.from(TABLE).select(ACCOUNT_COLUMNS).eq('user_id', parsed.id).maybeSingle(), '토큰 계정 조회');
        markDb(null);
        const row = res.data ? fromDbRow(res.data) : null;
        if (row?.passwordHash && row.username) rec = adopt(row);
      } catch (err) {
        markDb(err);
        onError(err);
        return null;
      }
    }
    if (!rec?.passwordHash || !rec.username) return null;
    if (!verifyToken(parsed, rec.passwordHash, authSecret, Math.floor(now() / 1000))) return null;
    rec.lastSeenAt = now();
    return rec;
  }

  /** 닉네임 변경 → { ok: true, user, unchanged? } | { ok: false, error: 'NICKNAME_TAKEN' | 'AUTH_REQUIRED' } — DB 는 바로 UPDATE */
  async function renameAccount(id, nickname) {
    const rec = users.get(id);
    if (!rec?.username) return { ok: false, error: 'AUTH_REQUIRED' };
    if (rec.nickname === nickname) return { ok: true, user: rec, unchanged: true };
    return serial(async () => {
      if (await nicknameTaken(nickname, id)) return { ok: false, error: 'NICKNAME_TAKEN' };
      if (client) {
        try {
          const m = meta.get(id);
          if (m) await m.chain; // 이 계정의 앞선 전적 쓰기 뒤에
          check(await client.from(TABLE).update({ nickname }).eq('user_id', id), `닉네임 변경(${nickname})`);
          markDb(null);
        } catch (err) {
          if (duplicateOf(err)) return { ok: false, error: 'NICKNAME_TAKEN' };
          throw err;
        }
      }
      if (nickOwner.get(rec.nickname) === id) nickOwner.delete(rec.nickname);
      rec.nickname = nickname;
      rec.updatedAt = now();
      nickOwner.set(nickname, id);
      board.at = -Infinity;
      markDirty();
      return { ok: true, user: rec };
    });
  }

  /** 판 결과 한 번 기록 (MMR_RULE) → 갱신된 기록 | null(모르는 유저). 캐시는 바로 고치고 DB 에는 차례로 쓴다 */
  function recordResult(id, won) {
    const rec = users.get(id);
    if (!rec) return null;
    applyResult(rec, won);
    rec.updatedAt = now();
    board.at = -Infinity; // 순위가 바뀌었을 수 있다
    const m = meta.get(id);
    if (m) queue(m, () => upsert(rec));
    markDirty();
    return rec;
  }

  /**
   * 한 판의 결과를 승자 · 패자 두 계정에 한꺼번에 기록한다 (랭킹전 정산 — 정상 종료 · 항복 · 부전승 모두) → { winner, loser } | null(모르는 유저 · 같은 계정)
   * 메모리는 둘 다 한 번에(동기) 고치고, DB 는 두 행을 요청 하나(upsert 배열 = SQL 문 하나)로 써서 '승자만 올라가고 패자는 그대로인' 중간 상태가 남지 않게 한다.
   * 두 계정의 앞선 쓰기가 모두 끝난 뒤에 쓰고, 그 쓰기가 끝나기 전에는 두 계정 모두 다음 쓰기를 기다린다 (계정별 쓰기 순서 유지).
   */
  function recordMatch(winnerId, loserId) {
    const win = users.get(winnerId);
    const lose = users.get(loserId);
    if (!win || !lose || win === lose) return null;
    applyResult(win, true);
    applyResult(lose, false);
    win.updatedAt = lose.updatedAt = now();
    board.at = -Infinity; // 순위가 바뀌었을 수 있다
    const mw = meta.get(winnerId);
    const ml = meta.get(loserId);
    if (client && mw && ml) {
      const run = Promise.all([mw.chain, ml.chain]).then(async () => {
        await dbReady;
        check(await client.from(TABLE).upsert([toRow(win), toRow(lose)], { onConflict: 'user_id' }), `players upsert(${win.nickname} · ${lose.nickname})`);
        markDb(null);
        board.at = -Infinity; // 바뀐 전적이 랭킹에 바로 보이게
      }).catch((err) => { markDb(err); onError(err); });
      mw.chain = ml.chain = run;
      inflight.add(run);
      run.finally(() => inflight.delete(run));
    } else {
      for (const [m, rec] of [[mw, win], [ml, lose]]) if (m) queue(m, () => upsert(rec));
    }
    markDirty();
    return { winner: win, loser: lose };
  }

  /**
   * mmr 내림차순 상위 limit 명 (기록 객체 — id 포함, 밖으로 보낼 때는 publicView). DB 가 안 되면 메모리 캐시로.
   * 계정이고 랭킹전을 1판 이상 둔 유저(wins + losses > 0)만 — 로비에만 들렀다 간 계정(1000점) · 예전 행이 순위를 채우지 않게.
   */
  async function leaderboard(limit = 10) {
    await schemaReady;
    if (client) {
      if (board.rows && now() - board.at < BOARD_CACHE_MS) return board.rows;
      try {
        let query = client.from(TABLE).select(COLUMNS).or('wins.gt.0,losses.gt.0'); // wins + losses > 0 (둘 다 0 이상이라 같은 뜻)
        if (accountReady) query = query.not('username', 'is', null); // 계정만
        const res = check(await query.order('mmr', { ascending: false }).order('wins', { ascending: false }).limit(limit), 'players leaderboard');
        markDb(null);
        const rows = (res.data ?? []).map((row) => (meta.get(row.user_id) && users.get(row.user_id)) || { id: row.user_id, nickname: row.nickname, ...fromRow(row) }); // 캐시가 더 최신
        board = { at: now(), rows: rows.filter(hasPlayed).sort(byRank) };
        return board.rows;
      } catch (err) {
        markDb(err);
        onError(err);
      }
    }
    return [...users.values()].filter((r) => r.username && hasPlayed(r)).sort(byRank).slice(0, limit);
  }

  /** 지금까지 바뀐 내용을 바로 쓴다 (파일 · DB 진행 중인 쓰기까지 기다린다) */
  async function flush() {
    clearTimeout(timer);
    timer = null;
    await save();
    await Promise.allSettled([...inflight]);
  }

  /** 서버를 닫을 때: 남은 변경을 쓰고 더는 저장하지 않는다 */
  async function close() {
    await flush();
    closed = true;
  }

  return {
    signup,
    login,
    authenticate,
    rename: renameAccount,
    ready: (id) => meta.get(id)?.chain ?? Promise.resolve(), // 그 유저의 DB 쓰기가 지금까지 줄 선 것까지 다 끝날 때 (메모리 모드면 바로)
    get: (id) => users.get(id) ?? null,
    recordResult,
    recordMatch,
    leaderboard,
    // /healthz — 어디에 저장 중인지 · 마지막 DB 작업 성공 여부 · 마지막 DB 오류 · 접속 중인 Supabase 주소(키 제외) · 계정 사용 가능 여부
    health: () => ({
      storage: db ? (client ? 'supabase' : 'memory') : (file ? 'file' : 'memory'),
      dbOk,
      dbError,
      dbHost: db ? (() => { try { return new URL(SUPABASE_URL).host; } catch { return `잘못된 URL: ${String(SUPABASE_URL).slice(0, 60)}`; } })() : null,
      accountReady, // 회원가입 · 로그인 가능 (DB 면 계정 컬럼 · 인덱스가 있어야 true)
      authSecret: Boolean(authSecret), // AUTH_SECRET 설정 여부 (값은 내보내지 않는다)
    }),
    publicView: publicRecord,
    size: () => users.size,
    flush,
    close,
  };
}
