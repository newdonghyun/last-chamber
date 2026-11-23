/**
 * LAST CHAMBER - 서버 유저 저장소: 닉네임 · 대전 전적(승/패)
 *
 *   클라이언트가 처음 로그인할 때 만든 유저 ID(UUID)를 열쇠로 유저 한 명의 기록을 들고 있는다:
 *     { id, nickname, wins, losses, createdAt, updatedAt, lastSeenAt }   (시각은 ms)
 *   · 식별: Socket.io 연결 때 handshake.auth = { userId, nickname } 또는 hello 이벤트 (server/index.js identifyUser)
 *   · 전적: 실시간 PvP 판이 끝나면 roomManager 가 recordResult(userId, won) — AI 딜러 판은 기기 안의 기록(storeData.js)이라 여기 오지 않는다
 *   · 저장: file 을 주면 JSON 파일로 남긴다 (바뀐 뒤 saveDelayMs 동안 모아서 한 번 · 임시 파일에 쓴 뒤 바꿔치기 → 쓰다가 꺼져도 파일이 깨지지 않는다).
 *           주지 않으면 메모리에만 (테스트 · 임시 서버). 서버를 시작할 때 파일이 있으면 읽어 온다.
 *   · Supabase: db(Supabase 클라이언트 또는 그 Promise)를 주면 players 테이블이 원본이다 (파일 저장은 끈다). 메모리는 캐시 — 서버 인스턴스 1개 전제.
 *       접속/로그인 → user_id 조회 → DB 값을 캐시에, 없으면 기본값으로 upsert / 판 결과 → 유저별로 차례로 upsert
 *       create table players (user_id text primary key, nickname text not null, wins int not null default 0, losses int not null default 0,
 *                             streak int not null default 0, max_streak int not null default 0, mmr int not null default 1000);
 *     키는 서버 전용 service_role 키 (클라이언트에 넣지 않는다).
 *   · 판정(MMR_RULE): 승 = wins+1 · streak+1 · max_streak 갱신 · mmr+25 / 패 = losses+1 · streak 0 · mmr−20 (0 아래로는 안 내려감)
 *   ⚠ 아직 비밀번호 · 토큰 같은 인증이 없다 — 유저 ID 를 아는 사람은 그 기록을 이어 쓸 수 있다. 그래서 ID 는 본인 소켓에만 오가고
 *     상대에게 가는 프로필(cleanProfile)에는 절대 넣지 않는다. 실제 계정(소셜 로그인 등)이 붙으면 이 ID 를 계정에 연결하면 된다.
 *   ⚠ 무료 클라우드 호스팅(Render 무료 플랜 등)의 디스크는 재배포 · 재시작 때 비워진다 — 오래 남기려면 영구 디스크 경로를 USER_DATA_FILE 로 주거나 DB 로 바꿀 것.
 */

import { readFileSync } from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** 유저 ID = UUID (소문자 16진수, RFC 4122 변형) — 클라이언트 src/ui/session.js 의 USER_ID_PATTERN 과 같다 */
export const USER_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
/** 로그인 닉네임 규칙: 2~10자 · 공백 없음 · 글자/숫자와 ( _ . - · ) — 클라이언트 src/ui/session.js validateNickname 과 같다 */
export const NICK_RULE = Object.freeze({ min: 2, max: 10 });
const NICK_CHARS = /^[\p{L}\p{N}_.\-·]+$/u;
const HAS_WORD = /[\p{L}\p{N}]/u;
const INVISIBLE_LETTERS = /[ᅟᅠㅤﾠ]/u; // 글자로 분류되지만 보이지 않는 한글 채움 문자
const MAX_COUNT = 9_999_999;
/** 서버 랭킹 점수 (players.mmr) */
export const MMR_RULE = Object.freeze({ start: 1000, win: 25, loss: 20 });
const TABLE = 'players';
const COLUMNS = 'user_id, nickname, wins, losses, streak, max_streak, mmr';
const BOARD_CACHE_MS = 3000; // get_leaderboard 연타가 그대로 DB 로 가지 않게

export const USER_DEFAULTS = Object.freeze({ maxUsers: 50_000, saveDelayMs: 1000 });

/** 유저 ID 검사 → 소문자 UUID | null */
export function cleanUserId(raw) {
  const id = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  return USER_ID_PATTERN.test(id) ? id : null;
}

/** 로그인 닉네임 검사 (NFC 정규화 · 앞뒤 공백 제거) → 닉네임 | null */
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

/** 파일에서 읽은 기록 한 줄 검사 (규칙이 바뀌어도 예전 닉네임은 지우지 않는다 — 다음 로그인 때 새 닉네임으로 바뀐다) */
function readRecord(raw, now) {
  const id = cleanUserId(raw?.id);
  const nickname = typeof raw?.nickname === 'string' && raw.nickname.trim() ? raw.nickname.trim().slice(0, 40) : null;
  if (!id || !nickname) return null;
  const createdAt = time(raw.createdAt, now);
  return {
    id,
    nickname,
    wins: count(raw.wins),
    losses: count(raw.losses),
    streak: count(raw.streak),
    maxStreak: count(raw.maxStreak),
    mmr: Number.isFinite(raw.mmr) ? count(raw.mmr) : MMR_RULE.start, // 이 필드가 없던 예전 파일도 기본값으로 이어받는다
    createdAt,
    updatedAt: time(raw.updatedAt, createdAt),
    lastSeenAt: time(raw.lastSeenAt, createdAt),
  };
}

/** 화면에 보여 줄 공개 부분 (ID · 시각은 빼고) → { nickname, wins, losses, games, streak, maxStreak, mmr } | null */
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
const toRow = (rec) => ({ user_id: rec.id, nickname: rec.nickname, wins: rec.wins, losses: rec.losses, streak: rec.streak, max_streak: rec.maxStreak, mmr: rec.mmr });
const byRank = (a, b) => b.mmr - a.mmr || b.wins - a.wins;

/**
 * 유저 저장소를 만든다.
 *   file        JSON 파일 경로 (null · '' 이면 메모리에만)
 *   db          Supabase 클라이언트 또는 그 Promise (주면 players 테이블에 저장 · file 은 무시. 연결에 실패하면 메모리로)
 *   maxUsers    최대 기록 수 — 가득 차면 새 유저는 기록하지 않는다 (대전은 그대로 할 수 있다)
 *   saveDelayMs 바뀐 뒤 파일에 쓰기까지 모으는 시간
 *   now         시계 (테스트용)        onError(err)  읽기 · 쓰기 실패를 알린다 (서버는 계속 돈다)
 * → { identify, ready, get, recordResult, leaderboard, publicView, size, flush, close }
 */
export function createUserStore({ file = null, db = null, maxUsers = USER_DEFAULTS.maxUsers, saveDelayMs = USER_DEFAULTS.saveDelayMs, now = Date.now, onError = () => {} } = {}) {
  const users = new Map(); // id → record
  let dirty = false;
  let timer = null;
  let chain = Promise.resolve(); // 파일 쓰기는 한 번에 하나씩 차례로
  let closed = false;

  // ── Supabase (db 가 있을 때만) ──
  if (db) file = null; // DB 가 원본 — 파일과 둘로 갈라지지 않게
  let client = null;
  const dbReady = db
    ? Promise.resolve(db).then((c) => { client = c; }, (err) => onError(new Error(`Supabase 에 연결하지 못해 메모리로 동작합니다: ${err?.message ?? err}`)))
    : Promise.resolve();
  const meta = new Map(); // id → { chain, loaded, loading, pending: [won…], ready } — 유저별 DB 작업 순서 · 불러오기 상태
  const inflight = new Set();
  let board = { at: -Infinity, rows: null };
  const check = (res) => { if (res?.error) throw new Error(`Supabase: ${res.error.message}`); return res; };
  const upsert = async (rec) => {
    await dbReady;
    if (client) check(await client.from(TABLE).upsert(toRow(rec), { onConflict: 'user_id' }));
  };

  /** 유저별 DB 작업을 차례로 (불러오기 → 결과 저장 → …). 실패해도 게임은 계속 — 오류만 알린다 */
  function queue(m, task) {
    const run = m.chain.then(task).catch(onError);
    m.chain = run;
    inflight.add(run);
    run.finally(() => inflight.delete(run));
    return run;
  }

  /** 접속/로그인: user_id 로 조회 → DB 값을 캐시에 싣고, 없으면 기본값으로 upsert. 불러오기 전에 끝난 판(pending)은 DB 값 위에 다시 적용 */
  function loadRow(rec) {
    let m = meta.get(rec.id);
    if (!m) meta.set(rec.id, (m = { chain: Promise.resolve(), loaded: false, loading: false, pending: [], ready: null }));
    m.loading = true;
    m.ready = queue(m, async () => {
      await dbReady;
      if (!client) { m.loaded = true; m.pending = []; return; } // DB 없이 시작됨 → 메모리 기록만
      const res = check(await client.from(TABLE).select(COLUMNS).eq('user_id', rec.id).maybeSingle());
      if (res.data) {
        Object.assign(rec, fromRow(res.data));
        for (const won of m.pending) applyResult(rec, won);
      }
      const write = !res.data || res.data.nickname !== rec.nickname || m.pending.length > 0;
      m.pending = [];
      m.loaded = true;
      if (write) await upsert(rec);
    }).finally(() => { m.loading = false; }); // 실패하면 loaded 는 false 그대로 → 다음 로그인 때 다시 불러온다 (그사이 결과는 pending 에 남는다)
    return m.ready;
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
        if (rec && users.size < maxUsers) users.set(rec.id, rec);
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
    const json = JSON.stringify({ v: 1, savedAt: now(), users: [...users.values()] });
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

  /** 로그인한 유저를 등록하거나 닉네임 · 마지막 접속 시각을 갱신한다 (id · nickname 은 이미 검사한 값). 가득 차서 새로 못 넣으면 null */
  function identify(id, nickname) {
    const t = now();
    let rec = users.get(id);
    if (!rec) {
      if (users.size >= maxUsers) return null;
      rec = { id, nickname, wins: 0, losses: 0, streak: 0, maxStreak: 0, mmr: MMR_RULE.start, createdAt: t, updatedAt: t, lastSeenAt: t };
      users.set(id, rec);
    } else {
      if (rec.nickname !== nickname) {
        rec.nickname = nickname;
        rec.updatedAt = t;
        const m = meta.get(id);
        if (m?.loaded) queue(m, () => upsert(rec)); // 닉네임 변경도 DB 에
      }
      rec.lastSeenAt = t;
    }
    if (db) {
      const m = meta.get(id);
      if (!m || (!m.loaded && !m.loading)) loadRow(rec);
    }
    markDirty();
    return rec;
  }

  /** 판 결과 한 번 기록 (MMR_RULE) → 갱신된 기록 | null(모르는 유저). 캐시는 바로 고치고 DB 에는 차례로 쓴다 */
  function recordResult(id, won) {
    const rec = users.get(id);
    if (!rec) return null;
    applyResult(rec, won);
    rec.updatedAt = now();
    board.at = -Infinity; // 순위가 바뀌었을 수 있다
    const m = meta.get(id);
    if (m) {
      if (m.loaded) queue(m, () => upsert(rec));
      else m.pending.push(won); // 아직 DB 값을 못 불러왔다 — 불러온 뒤 그 위에 다시 적용해서 쓴다
    }
    markDirty();
    return rec;
  }

  /** mmr 내림차순 상위 limit 명 (기록 객체 — id 포함, 밖으로 보낼 때는 publicView). DB 가 안 되면 메모리 캐시로 */
  async function leaderboard(limit = 10) {
    await dbReady;
    if (client) {
      if (board.rows && now() - board.at < BOARD_CACHE_MS) return board.rows;
      try {
        const res = check(await client.from(TABLE).select(COLUMNS).order('mmr', { ascending: false }).order('wins', { ascending: false }).limit(limit));
        const rows = (res.data ?? []).map((row) => (meta.get(row.user_id)?.loaded && users.get(row.user_id)) || { id: row.user_id, nickname: row.nickname, ...fromRow(row) }); // 캐시가 더 최신
        board = { at: now(), rows: rows.sort(byRank) };
        return board.rows;
      } catch (err) {
        onError(err);
      }
    }
    return [...users.values()].sort(byRank).slice(0, limit);
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
    identify,
    ready: (id) => meta.get(id)?.ready ?? Promise.resolve(), // DB 에서 그 유저를 다 불러올 때까지 (메모리 모드면 바로)
    get: (id) => users.get(id) ?? null,
    recordResult,
    leaderboard,
    publicView: publicRecord,
    size: () => users.size,
    flush,
    close,
  };
}
