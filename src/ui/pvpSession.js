/**
 * LAST CHAMBER - 인게임 실시간 PvP 세션 (4-3단계)
 *
 * 4-2 로비가 넘겨 준 소켓('pvp:start' 의 detail = { match, socket, serverUrl })을 받아, 한 판 동안 서버와의 통신을 맡는다. 화면은 app.js 가 그린다.
 *   · 서버의 state_update 를 '원격 엔진'(pvpEngine)에 쌓아 두면, app.js 의 렌더러 · 로그 연출이 로컬 GameEngine 을 읽던 그대로 읽는다 (getPublicState / getLog).
 *     서버 좌석 id(P1/P2)는 화면용 id(player/ai)로 바꿔서 건넨다. 로컬 엔진 · 딜러 AI 는 PvP 중에 돌지 않는다.
 *   · 내 입력은 pvpEngine().shoot / useItem 이 game_action 으로 보내고, 서버가 확정한 결과(그 행동이 만든 state_update)를 돌려준다.
 *   · 항복: pvpSurrender() 가 surrender 를 보내면 서버가 판을 끝내고(랭킹전이면 항복자 −20 · 상대 +25 정산) 양쪽에 game_over(reason 'surrender')를 보낸다 — 결과 화면은 그 game_over 로만 연다.
 *   · 도발: app.js 가 쏘는 document 'lastchamber:taunt-out' → send_emote / 서버의 receive_emote → document 'lastchamber:taunt-in'.
 *   · 참가비 차감 · 전적/MMR/상금 정산은 app.js 가 initPvp 로 넘겨 준 PlayerProfile 로 한다 (같은 인스턴스 → 탄피 배지가 어긋나지 않는다).
 *     모드별: 랭킹전(무작위 매칭 · match.ranked) → recordRanked(서버 기록으로 랭킹 MMR · 전적 · 연승을 맞춤) / 친선전(방 코드) → recordFriendly(탄피만).
 *   · 이벤트 이름은 server/index.js 규약 그대로: state_update · game_over · opponent_status · receive_emote · room_closed · session_replaced · match_found(재접속 때 다시 옴).
 *
 * 수신 가드: 모든 인게임 이벤트(state_update · game_over · opponent_status · receive_emote · match_found · room_closed · session_replaced)는
 *   ① 지금 세션(S)이고 ② 닫히지 않았고 ③ 이벤트의 방 코드(code)가 내가 앉은 방과 같을 때만 처리한다 — 아니면 연출 · 소리 없이 버린다.
 *
 * 'pvp:start' 핸들러는 소켓 리스너를 '동기로' 먼저 붙인다 (서버가 match_found 직후 첫 state_update 를 보내므로). 첫 state_update 가 도착하면 hooks.onStart() 로 판을 연다.
 */

import { KIND, DEFAULT_ID, DEFAULT_FLAME_ID, getItem, getFlame, tierOf, readServerRecord } from './storeData.js';

const ME = 'player'; // app.js 의 PLAYER / AI 와 같은 값
const FOE = 'ai';
const TAUNT_OUT = 'lastchamber:taunt-out'; // app.js 와 같은 이름 — 내 도발(detail = { type: 'TAUNT', id })
const TAUNT_IN = 'lastchamber:taunt-in'; // 상대의 도발 도착
const ACK_MS = 8000;
const UPDATE_WAIT_MS = 2500; // ack 는 왔는데 그 행동의 state_update 가 아직이면 기다리는 시간
const OVER_WAIT_MS = 2500; // 승패는 갈렸는데 game_over(상금)가 아직이면 기다리는 시간

let hooks = null; // { profile, onStart, onUpdate, onNotice, onAbort }
let S = null; // 지금(또는 방금 끝난) 세션
let lastState = null; // 가장 최근에 받은 상태 (세션이 바뀌어도 유지)

/** app.js 가 한 번 부른다. profile = PlayerProfile · onStart() = 첫 상태가 왔으니 판을 열어라 · onUpdate() = 새 상태/결과 · onNotice(text, tone) · onAbort(text) = 시작하지 못함 */
export function initPvp(h) {
  if (hooks) return;
  hooks = h;
  window.addEventListener('pvp:start', onPvpStart);
  document.addEventListener(TAUNT_OUT, onTauntOut);
}

// ───────── 세션 시작 ─────────

function onPvpStart(e) {
  const { match, socket } = e.detail ?? {};
  if (!hooks || !match || !socket) return;
  pvpEnd(); // 남은 이전 세션 정리
  const seat = match.you;
  const s = {
    socket,
    match,
    code: match.code,
    token: match.token,
    ids: new Map([[seat, ME], [seat === 'P1' ? 'P2' : 'P1', FOE]]), // 서버 좌석 → 화면 id
    foe: readOpponent(match.opponent?.profile),
    mine: hooks.profile.activeLoadout(), // 이번 판에 쓰는 내 총기 · 테이블 · 화염 (4-2 가 상대에게 보낸 값과 같다)
    log: [], // 내 시점 로그 (화면 id 로 변환됨, 각 항목에 idx = 위치)
    state: null,
    over: null,
    started: false,
    closed: false,
    updates: 0,
    waiters: new Set(),
    off: [],
    turnMs: null, // 마지막 state_update 시점의 남은 턴 시간 (deadline − now)
    turnAt: 0,
  };
  S = s;
  bind(s); // ★ 가장 먼저, 동기로 — 첫 state_update 를 놓치지 않는다
  if (match.fee > 0) { // 참가비 (프로 200 · VIP 1,000)
    const paid = hooks.profile.spendBrass(match.fee);
    if (!paid.ok) {
      s.socket.emit('leave_room');
      pvpEnd();
      hooks.onAbort?.('탄피가 부족해 대전에 입장하지 못했습니다.');
    }
  }
}

/** 이 이벤트를 처리해도 되는가: 지금 세션 · 닫히지 않음 · 내 방 코드와 같음 (다른 방 · 지난 판 이벤트는 버린다) */
const mine = (s, m) => S === s && !s.closed && typeof m?.code === 'string' && m.code === s.code;

function bind(s) {
  const on = (event, fn) => {
    const guarded = (m) => { if (mine(s, m)) fn(m); }; // 가드는 맨 앞에서 — 통과하지 못하면 아무 연출 · 소리도 없다
    s.socket.on(event, guarded);
    s.off.push(() => s.socket.off(event, guarded));
  };
  on('state_update', (m) => onState(s, m));
  on('game_over', (m) => finish(s, {
    youWon: Boolean(m?.youWon),
    payout: Math.max(0, Math.floor(m?.payout) || 0),
    reason: m?.reason ?? 'normal',
    record: readServerRecord(m?.record), // 서버(Supabase players)의 내 랭킹 기록 { wins, losses, mmr, streak, maxStreak } (로그인한 경우만 — 아니면 null)
    mmrDelta: Number.isFinite(m?.mmrDelta) ? m.mmrDelta : null, // 랭킹전에서 서버가 실제로 기록한 이번 판 MMR 변동 (친선전 · 기록 실패면 없음)
  }));
  on('opponent_status', (m) => onOpponent(s, m));
  on('receive_emote', ({ code: _room, ...emote }) => document.dispatchEvent(new CustomEvent(TAUNT_IN, { detail: emote }))); // 방 코드는 떼고 도발 모양만
  on('match_found', (m) => { if (m?.token) s.token = m.token; }); // 재접속 때 다시 오는 match_found
  on('room_closed', () => { if (!s.over) hooks.onNotice?.('방이 닫혔습니다.', 'danger'); });
  on('session_replaced', () => finish(s, { youWon: false, payout: 0, reason: 'replaced' })); // 다른 화면이 이 좌석을 넘겨받았다
  const onSocket = (event, fn) => { // 소켓 연결 상태 이벤트 (방 코드 없음) — 세션 · 닫힘만 본다
    const guarded = (arg) => { if (S === s && !s.closed) fn(arg); };
    s.socket.on(event, guarded);
    s.off.push(() => s.socket.off(event, guarded));
  };
  onSocket('disconnect', (reason) => {
    if (s.over || s.closed) return;
    hooks.onNotice?.('서버와 연결이 끊어졌습니다 — 다시 연결하는 중…', 'danger');
    if (reason === 'io server disconnect') s.socket.connect(); // 서버가 끊은 경우는 자동 재연결이 없다
  });
  onSocket('connect', () => { // 자동 재연결 성공 → 15초 유예 안에 자리를 되찾는다 (새 소켓이라 토큰으로 증명)
    if (s.over || s.closed) return;
    s.socket.emit('rejoin_room', { code: s.code, token: s.token }, (res) => {
      if (res?.ok) hooks.onNotice?.('다시 연결되었습니다.', 'info');
      else finish(s, { youWon: false, payout: 0, reason: 'disconnect' }); // 자리를 잃었다 → 부전패
    });
  });
}

/**
 * 항복 요청 → { ok: true } | { ok: false, error }.  결과(승패 · MMR)는 ack 가 아니라 서버가 보내는 game_over 로 온다 (app.js 가 거기서 결과 화면을 연다).
 * NOT_IN_GAME = 이미 끝난 판(상대가 먼저 끝냈거나 동시에 항복) · OFFLINE · TIMEOUT = 서버에 닿지 않았다 (판은 그대로 — 다시 시도할 수 있다)
 */
export function pvpSurrender() {
  const s = S;
  if (!s || s.closed || s.over) return Promise.resolve({ ok: false, error: 'NOT_IN_GAME' });
  if (!s.socket.connected) return Promise.resolve({ ok: false, error: 'OFFLINE' });
  return new Promise((resolve) => {
    s.socket.timeout(ACK_MS).emit('surrender', (err, res) => resolve(err ? { ok: false, error: 'TIMEOUT' } : (res ?? { ok: false, error: 'SERVER_ERROR' })));
  });
}

/** 상대 프로필(서버가 걸러 준 값) → 화면용. 모르는 스킨 id 는 기본값으로 */
function readOpponent(raw) {
  const p = raw && typeof raw === 'object' ? raw : {};
  const c = p.cosmetics && typeof p.cosmetics === 'object' ? p.cosmetics : {};
  const mmr = Number.isFinite(p.mmr) ? p.mmr : 1000;
  return {
    name: typeof p.nickname === 'string' && p.nickname ? p.nickname : '상대',
    mmr,
    tier: tierOf(mmr),
    title: typeof p.title === 'string' ? p.title : '',
    cosmetics: {
      gun: getItem(KIND.GUN, c.gun) ? c.gun : DEFAULT_ID[KIND.GUN],
      flame: getFlame(c.flame) ? c.flame : DEFAULT_FLAME_ID,
    },
  };
}

// ───────── 서버 이벤트 ─────────

function mapIds(ids, v) {
  if (typeof v === 'string') return ids.get(v) ?? v;
  if (Array.isArray(v)) return v.map((x) => mapIds(ids, x));
  if (v && typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v)) out[k] = mapIds(ids, v[k]);
    return out;
  }
  return v;
}

function onState(s, m) {
  if (S !== s || s.closed || !m || m.code !== s.code) return;
  const from = Number.isInteger(m.logFrom) ? Math.max(0, m.logFrom) : s.log.length;
  s.log.length = Math.min(s.log.length, from); // 재접속은 logFrom 0 부터 전체를 다시 준다
  for (const ev of m.events ?? []) s.log.push({ ...mapIds(s.ids, ev), idx: s.log.length });
  s.state = mapIds(s.ids, m.state);
  lastState = s.state;
  if (Number.isFinite(m.deadline) && Number.isFinite(m.now)) {
    s.turnMs = Math.max(0, m.deadline - m.now); // 서버 시계끼리의 차 → 기기 시계와 무관
    s.turnAt = performance.now();
  }
  s.updates += 1;
  wake(s);
  if (!s.started) {
    s.started = true;
    hooks.onStart();
  } else {
    hooks.onUpdate();
  }
}

/** 판이 끝났다 (정상 종료 game_over · 부전패 · 자리 상실). 한 번만 */
function finish(s, over) {
  if (S !== s || s.over) return;
  s.over = over;
  wake(s);
  if (s.started) hooks.onUpdate();
}

function onOpponent(s, m) {
  if (S !== s || s.over) return;
  if (m?.connected === false) hooks.onNotice?.(`상대의 연결이 끊어졌습니다 — ${Math.round((m.graceMs ?? 15000) / 1000)}초 안에 돌아오지 않으면 당신의 승리`, 'danger');
  else if (m?.connected === true) hooks.onNotice?.('상대가 다시 연결되었습니다.', 'info');
}

function onTauntOut(e) {
  const s = S;
  if (!s || s.closed || s.over || !s.started || !s.socket.connected || !e.detail) return;
  s.socket.emit('send_emote', e.detail); // 서버가 모양을 다시 검사해서 상대에게 그대로 중계한다
}

function wake(s) {
  for (const fn of [...s.waiters]) fn();
}

/** 다음 state_update / 종료까지 기다린다 (최대 ms) */
function nextUpdate(s, ms) {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      s.waiters.delete(done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    s.waiters.add(done);
  });
}

// ───────── 원격 엔진 (app.js 가 engine 자리에 꽂는다) ─────────

/** 내 행동을 서버로 보내고, 그 결과(내 SHOT / ITEM 로그)를 돌려준다. 결과는 ack 가 아니라 state_update 로만 온다 */
function act(payload, type) {
  const s = S;
  if (!s || s.closed || s.over) return Promise.resolve({ ok: false, error: 'NOT_IN_GAME' });
  if (!s.socket.connected) return Promise.resolve({ ok: false, error: 'OFFLINE' });
  const before = s.updates;
  const from = s.log.length;
  return new Promise((resolve) => {
    s.socket.timeout(ACK_MS).emit('game_action', payload, async (err, res) => {
      if (err || !res?.ok) {
        resolve({ ok: false, error: err ? 'TIMEOUT' : (res?.error ?? 'SERVER_ERROR') });
        return;
      }
      if (s.updates === before) await nextUpdate(s, UPDATE_WAIT_MS); // 보통은 ack 보다 먼저 도착해 있다
      const e = s.log.slice(from).find((x) => x.type === type && x.actor === ME);
      resolve(e ? { ok: true, shell: e.shell, damage: e.damage, idx: e.idx } : { ok: false, error: 'NO_RESULT' });
    });
  });
}

const remote = {
  getPublicState() {
    const s = S;
    const base = s?.state ?? lastState; // 새 세션의 첫 상태가 오기 전 잠깐은 지난 판의 마지막 상태 (null 로 렌더러가 터지지 않게)
    if (!base) return null;
    if (base.winner || !s?.over) return base;
    return { ...base, winner: s.over.youWon ? ME : FOE }; // 부전승 · 자리 상실: 엔진은 안 끝났지만 승패는 정해졌다
  },
  getLog: (_id, since = 0) => (S ? S.log.slice(since) : []),
  shoot: (_id, target) => act({ type: 'shoot', target }, 'SHOT'),
  useItem: (_id, index) => act({ type: 'use_item', index }, 'ITEM'),
};

export const pvpEngine = () => remote;
export const pvpOpponent = () => S?.foe ?? null; // { name, mmr, tier, title, cosmetics }
export const pvpOver = () => S?.over ?? null;

/** 지금 차례인 사람(id = 'player' | 'ai')의 총기 스킨 · 총구 화염. 테이블 테마는 언제나 내 것 */
export function pvpLoadoutFor(id) {
  const s = S;
  if (!s) return null;
  return id === FOE ? { gun: s.foe.cosmetics.gun, table: s.mine.table, flame: s.foe.cosmetics.flame } : s.mine;
}

/** 이번 턴의 남은 시간(ms) — 마지막 state_update 의 deadline 기준 (연출 시간은 서버가 기다려 주지 않는다) */
export function pvpRemainingMs(fallback) {
  const s = S;
  if (!s || s.turnMs === null) return fallback;
  return Math.max(0, s.turnMs - (performance.now() - s.turnAt));
}

// ───────── 정산 · 정리 ─────────

/** 지금 판이 랭킹전(무작위 매칭)인가 — 친구 방 코드 대전은 친선전 (예전 서버는 ranked 를 안 보내므로 mode 로도 판단) */
const isRankedMatch = (match) => (typeof match?.ranked === 'boolean' ? match.ranked : match?.mode === 'queue');

/** 지금(또는 방금 끝난) PvP 판의 모드: 'ranked' | 'friendly' | null(PvP 아님) */
export function pvpMode() {
  if (!S) return null;
  return isRankedMatch(S.match) ? 'ranked' : 'friendly';
}

/**
 * 판 결과를 저장하고 소켓을 정리한다. 모드별로 나눠 정산한다:
 *   랭킹전 → profile.recordRanked: 서버(Supabase)가 기록한 내 랭킹 기록(game_over.record)으로 MMR · 전적 · 연승을 맞춘다 + 탄피
 *   친선전 → profile.recordFriendly: 랭킹 기록은 그대로, 탄피만
 * 참가비가 있는 테이블은 서버가 내려준 상금(payout)이 탄피 보상이고, 일반 테이블 · 친구 방은 기본 승리/패배 보상이다.
 * → 정산 결과 + { pvp: { tier, mode, ranked, fee, payout, record } }   record = 서버의 내 랭킹 기록 | null
 */
export async function pvpSettle(won) {
  const s = S;
  if (!s) return hooks.profile.recordFriendly(won); // 세션을 잃었다 — 랭킹 기록은 서버가 원본이니 건드리지 않는다 (다음 로비 접속 때 맞춰진다)
  const until = performance.now() + OVER_WAIT_MS;
  while (!s.over && !s.closed && performance.now() < until) await nextUpdate(s, until - performance.now());
  const fee = s.match.fee > 0 ? s.match.fee : 0;
  const payout = s.over ? s.over.payout : (won ? Number(s.match.prize) || 0 : 0);
  const brass = fee > 0 ? payout : null;
  const ranked = isRankedMatch(s.match);
  const record = s.over?.record ?? null;
  const outcome = ranked
    ? hooks.profile.recordRanked(won, { record, mmrDelta: s.over?.mmrDelta ?? null, brass })
    : hooks.profile.recordFriendly(won, { brass });
  pvpEnd();
  return { ...outcome, pvp: { tier: s.match.tier, mode: s.match.mode, ranked, fee, payout, record } };
}

/** 리스너를 떼고 소켓을 끊는다 (여러 번 불러도 안전). 서버는 끊김을 보고 방을 정리한다 */
export function pvpEnd() {
  const s = S;
  if (!s || s.closed) return;
  s.closed = true;
  for (const off of s.off) off();
  s.off = [];
  wake(s);
  try {
    s.socket.disconnect();
  } catch {
    /* 이미 끊김 */
  }
}
