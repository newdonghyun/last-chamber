/**
 * LAST CHAMBER - 서버 유저 저장소: 닉네임 · 대전 전적(승/패)
 *
 *   클라이언트가 처음 로그인할 때 만든 유저 ID(UUID)를 열쇠로 유저 한 명의 기록을 들고 있는다:
 *     { id, nickname, wins, losses, createdAt, updatedAt, lastSeenAt }   (시각은 ms)
 *   · 식별: Socket.io 연결 때 handshake.auth = { userId, nickname } 또는 hello 이벤트 (server/index.js identifyUser)
 *   · 전적: 실시간 PvP 판이 끝나면 roomManager 가 recordResult(userId, won) — AI 딜러 판은 기기 안의 기록(storeData.js)이라 여기 오지 않는다
 *   · 저장: file 을 주면 JSON 파일로 남긴다 (바뀐 뒤 saveDelayMs 동안 모아서 한 번 · 임시 파일에 쓴 뒤 바꿔치기 → 쓰다가 꺼져도 파일이 깨지지 않는다).
 *           주지 않으면 메모리에만 (테스트 · 임시 서버). 서버를 시작할 때 파일이 있으면 읽어 온다.
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
    createdAt,
    updatedAt: time(raw.updatedAt, createdAt),
    lastSeenAt: time(raw.lastSeenAt, createdAt),
  };
}

/** 화면에 보여 줄 공개 부분 (ID · 시각은 빼고) → { nickname, wins, losses, games } | null */
export const publicRecord = (rec) => (rec ? { nickname: rec.nickname, wins: rec.wins, losses: rec.losses, games: rec.wins + rec.losses } : null);

/**
 * 유저 저장소를 만든다.
 *   file        JSON 파일 경로 (null · '' 이면 메모리에만)
 *   maxUsers    최대 기록 수 — 가득 차면 새 유저는 기록하지 않는다 (대전은 그대로 할 수 있다)
 *   saveDelayMs 바뀐 뒤 파일에 쓰기까지 모으는 시간
 *   now         시계 (테스트용)        onError(err)  읽기 · 쓰기 실패를 알린다 (서버는 계속 돈다)
 * → { identify, get, recordResult, publicView, size, flush, close }
 */
export function createUserStore({ file = null, maxUsers = USER_DEFAULTS.maxUsers, saveDelayMs = USER_DEFAULTS.saveDelayMs, now = Date.now, onError = () => {} } = {}) {
  const users = new Map(); // id → record
  let dirty = false;
  let timer = null;
  let chain = Promise.resolve(); // 파일 쓰기는 한 번에 하나씩 차례로
  let closed = false;

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
      rec = { id, nickname, wins: 0, losses: 0, createdAt: t, updatedAt: t, lastSeenAt: t };
      users.set(id, rec);
    } else {
      if (rec.nickname !== nickname) {
        rec.nickname = nickname;
        rec.updatedAt = t;
      }
      rec.lastSeenAt = t;
    }
    markDirty();
    return rec;
  }

  /** 판 결과 한 번 기록 → 갱신된 기록 | null(모르는 유저) */
  function recordResult(id, won) {
    const rec = users.get(id);
    if (!rec) return null;
    if (won) rec.wins = Math.min(MAX_COUNT, rec.wins + 1);
    else rec.losses = Math.min(MAX_COUNT, rec.losses + 1);
    rec.updatedAt = now();
    markDirty();
    return rec;
  }

  /** 지금까지 바뀐 내용을 바로 파일에 쓴다 */
  function flush() {
    clearTimeout(timer);
    timer = null;
    return save();
  }

  /** 서버를 닫을 때: 남은 변경을 쓰고 더는 저장하지 않는다 */
  async function close() {
    await flush();
    closed = true;
  }

  return {
    identify,
    get: (id) => users.get(id) ?? null,
    recordResult,
    publicView: publicRecord,
    size: () => users.size,
    flush,
    close,
  };
}
