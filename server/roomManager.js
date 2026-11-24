/**
 * LAST CHAMBER - 방 · 판 관리 (server/index.js 에서 분리)
 *
 *   방(친구 초대 사설 방 · 매칭으로 맺어진 방)의 한살이를 맡는다:
 *   · 생성 / 입장 / 재접속 토큰(rejoin_room) / 나가기 / 연결 끊김
 *   · 방마다 GameEngine 하나 — 서버 권위. 좌석(P1 · P2)은 서버가 소켓에 붙이고, 각자에게는 자기 시점의 상태와 로그만 보낸다
 *   · 20초 턴 타이머(0초가 되면 서버가 대신 격발) · 15초 연결 끊김 부전승 · 친구를 기다리는 방의 10분 만료 · 끝난 판 결과 60초 보관
 *   · 이모트(send_emote) 중계 · 클라이언트가 보낸 프로필의 모양 검사(cleanProfile) · 로그인한 소켓은 서버가 확인한 닉네임으로(profileOf)
 *   · 판이 끝나면 로그인한 좌석의 서버 전적(승/패)을 기록한다 (server/userStore.js) — game_over 에 그 좌석의 record 로 알려 준다
 *   소켓 이벤트 이름 · 페이로드 규약은 server/index.js 맨 위 주석, 등급별 대기열은 server/matchmaker.js.
 *
 *   socket.data 약속:  where = null | { kind: 'queue', tier }(matchmaker 가 씀) | { kind: 'room', code }(여기서 씀) · lastEmote = 마지막 이모트 시각(ms)
 *                      user = null | { id, nickname } (server/index.js identifyUser 가 씀 — 로그인한 소켓)
 */

import { randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { GameEngine } from '../src/engine/gameEngine.js';

// ───────── 규칙 · 설정 ─────────

export const TURN_MS = 20_000; // 턴 제한
export const GRACE_MS = 15_000; // 연결이 끊긴 뒤 돌아올 수 있는 시간
export const ROOM_TTL_MS = 10 * 60_000; // 친구를 기다리는 사설 방이 살아 있는 시간
export const RESULT_TTL_MS = 60_000; // 끝난 판의 결과를 늦게 돌아온 사람에게 다시 알려 줄 수 있는 시간
/** createGameServer 의 설정(cfg) 중 이 파일이 읽는 값의 기본값 — options 로 덮어쓸 수 있다 (예: 테스트에서 turnMs: 250) */
export const ROOM_DEFAULTS = Object.freeze({
  turnMs: TURN_MS,
  graceMs: GRACE_MS,
  roomTtlMs: ROOM_TTL_MS,
  resultTtlMs: RESULT_TTL_MS,
  maxRooms: 5000,
  emoteGapMs: 500, // 이모트 최소 간격
});

// 4자리 방 코드: 헷갈리는 글자(0 O 1 I)를 뺀 영문 대문자 + 숫자 32종 → 약 100만 가지
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_PATTERN = new RegExp(`^[${CODE_ALPHABET}]{4}$`);

const rand = () => randomInt(2 ** 32) / 2 ** 32; // [0, 1)
const makeCode = () => Array.from({ length: 4 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join('');
const makeToken = () => randomBytes(16).toString('hex');
const cleanCode = (raw) => {
  const code = typeof raw === 'string' ? raw.trim().toUpperCase() : '';
  return CODE_PATTERN.test(code) ? code : null;
};
const sameToken = (a, b) => {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};
/** ack 로 돌려주는 실패 응답 */
export const fail = (error) => ({ ok: false, error });

// ───────── 클라이언트가 보낸 값 거르기 ─────────

const isRecord = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const NICK_PATTERN = /^[\p{L}\p{N}_.\-·]+(?: [\p{L}\p{N}_.\-·]+)*$/u; // 클라이언트의 닉네임 규칙(storeData.js)과 같다
const TITLE_PATTERN = /^[\p{L}\p{N}_.\-·'!?]+(?: [\p{L}\p{N}_.\-·'!?]+)*$/u;
const ID_PATTERN = /^[A-Za-z0-9_]{1,24}$/;
const DEFAULT_NICKNAME = '방랑자';

function cleanLabel(raw, pattern, max) {
  if (typeof raw !== 'string' || raw.length > 200) return null;
  const text = raw.normalize('NFC').trim().replace(/\s+/g, ' ');
  return text && [...text].length <= max && pattern.test(text) ? text : null;
}
const cleanId = (raw) => (typeof raw === 'string' && ID_PATTERN.test(raw) ? raw : null);
const clampInt = (raw, min, max, fallback) => (Number.isFinite(raw) ? Math.min(max, Math.max(min, Math.floor(raw))) : fallback);

/**
 * 상대 화면에 그려질 프로필: 알려진 필드만, 모양이 맞는 것만 통과 (나머지는 기본값/null).
 * { nickname, mmr, tier, title, cosmetics: { gun, table, flame, taunt } } — cosmetics 는 loadout 이라는 이름으로 보내도 받는다.
 */
export function cleanProfile(raw) {
  const p = isRecord(raw) ? raw : {};
  const c = isRecord(p.cosmetics) ? p.cosmetics : isRecord(p.loadout) ? p.loadout : {};
  return {
    nickname: cleanLabel(p.nickname, NICK_PATTERN, 12) ?? DEFAULT_NICKNAME,
    mmr: clampInt(p.mmr, 0, 99_999, 1000),
    tier: cleanId(isRecord(p.tier) ? p.tier.id : p.tier),
    title: cleanLabel(p.title, TITLE_PATTERN, 20),
    cosmetics: { gun: cleanId(c.gun), table: cleanId(c.table), flame: cleanId(c.flame), taunt: cleanId(c.taunt) },
  };
}

/**
 * 좌석에 앉힐 프로필: cleanProfile 로 거른 뒤, 로그인한 소켓(socket.data.user)이면 서버가 확인한 닉네임으로 덮어쓴다
 * → 상대 화면의 이름표 · 서버 전적 기록이 같은 이름이 된다. 로그인하지 않은 예전 클라이언트는 예전처럼 보낸 닉네임(cleanProfile 규칙)을 쓴다.
 */
export function profileOf(socket, raw) {
  const profile = cleanProfile(raw);
  const nickname = socket?.data?.user?.nickname;
  return nickname ? { ...profile, nickname } : profile;
}

const EMOTE_KEY = /^[A-Za-z][A-Za-z0-9_]{0,15}$/;
/** 이모트(도발) 페이로드: 키 4개 이하의 평면 객체, 값은 짧은 문자열 · 유한한 숫자 · 불리언 · null 만 */
function validEmote(p) {
  if (!isRecord(p)) return false;
  const keys = Object.keys(p);
  return keys.length > 0 && keys.length <= 4 && keys.every((k) => EMOTE_KEY.test(k) && (
    typeof p[k] === 'boolean'
    || p[k] === null
    || (typeof p[k] === 'number' && Number.isFinite(p[k]))
    || (typeof p[k] === 'string' && p[k].length <= 32)));
}

// ───────── 방 관리자 ─────────

/**
 * 방 관리자를 만든다.
 *   io     Socket.io 서버 (좌석에 적어 둔 소켓 id 로 소켓을 찾는다)
 *   cfg    createGameServer 가 만든 설정: turnMs · graceMs · roomTtlMs · resultTtlMs · maxRooms · emoteGapMs · onError
 *   log    quiet 을 지키는 로그 함수          guard  타이머 · 콜백의 예외가 프로세스를 죽이지 않게 감싸는 함수
 *   tiers  등급표 { free: { fee, prize }, ... } (matchmaker 의 QUEUE_TIERS) — 사설 방은 'free' 등급이다
 *   users  유저 저장소 (server/userStore.js createUserStore) — 없으면 서버 전적을 기록하지 않는다
 * 이벤트 처리 함수는 (socket, payload) → ack 로 돌려줄 { ok, ... } 를 반환한다 (소켓 이벤트와의 연결은 server/index.js).
 */
export function createRoomManager({ io, cfg, log, guard, tiers, users = null }) {
  const rooms = new Map(); // code → room { code, mode, tier, status: 'waiting'|'playing'|'over', seats, engine, sent, turnTimer, turnSeq, deadline, ttlTimer, result }

  // ── 좌석 · 소켓 ──
  const socketOf = (seat) => (seat.socketId ? io.sockets.sockets.get(seat.socketId) : undefined);
  const emitTo = (seat, event, payload) => { socketOf(seat)?.emit(event, payload); };
  const otherSeat = (room, seat) => room.seats.find((s) => s !== seat);
  // userId: 앉을 때 로그인한 유저 (재접속으로 소켓이 바뀌어도 좌석의 주인은 그대로 — 판 결과는 이 유저에게 기록된다)
  const makeSeat = (id, socket, profile) => ({ id, token: makeToken(), socketId: socket.id, userId: socket.data.user?.id ?? null, profile, connected: true, graceTimer: null, graceUntil: 0 });
  const attach = (socket, room) => { socket.data.where = { kind: 'room', code: room.code }; };
  const release = (socket, code) => { // 이 방에 묶여 있을 때만 풀어 준다
    const where = socket?.data.where;
    if (where?.kind === 'room' && (code === undefined || where.code === code)) socket.data.where = null;
  };
  const seatOfSocket = (socket) => {
    const where = socket.data.where;
    const room = where?.kind === 'room' ? rooms.get(where.code) : undefined;
    const seat = room?.seats.find((s) => s.socketId === socket.id);
    return room && seat ? { room, seat } : null;
  };

  function newRoom(mode, tier) {
    for (let i = 0; i < 50; i += 1) {
      const code = makeCode();
      if (!rooms.has(code)) {
        const room = { code, mode, tier, status: 'waiting', seats: [], engine: null, sent: 0, turnTimer: null, turnSeq: 0, deadline: 0, ttlTimer: null, result: null };
        rooms.set(code, room);
        return room;
      }
    }
    return null;
  }

  function clearRoomTimers(room) {
    clearTimeout(room.turnTimer);
    clearTimeout(room.ttlTimer);
    for (const seat of room.seats) clearTimeout(seat.graceTimer);
  }

  function closeRoom(room) { // 시작 전에 닫는 방 (또는 통째로 정리)
    clearRoomTimers(room);
    rooms.delete(room.code);
    for (const seat of room.seats) release(socketOf(seat), room.code);
  }

  // ── 판 진행 ──
  const matchPayload = (room, seat, resume) => {
    const opp = otherSeat(room, seat);
    const { fee, prize } = tiers[room.tier];
    return { code: room.code, mode: room.mode, tier: room.tier, fee, prize, you: seat.id, token: seat.token, opponent: { id: opp.id, profile: opp.profile }, turnMs: cfg.turnMs, graceMs: cfg.graceMs, resume };
  };

  const snapshot = (room, seat, reason, since, events, extra = {}) => ({
    code: room.code,
    reason,
    ...extra,
    state: room.engine.getPublicState(seat.id), // 이 좌석의 시점 — 탄 순서는 들어 있지 않다
    logFrom: since,
    events, // 이 좌석이 볼 수 있는 로그만 (투시경 결과는 쓴 사람에게만)
    deadline: room.status === 'playing' ? room.deadline : null,
    now: Date.now(),
    opponentConnected: otherSeat(room, seat).connected,
  });

  function broadcast(room, reason, extra) { // 좌석마다 따로 만들어 따로 보낸다
    const since = room.sent;
    let end = since;
    for (const seat of room.seats) {
      const events = room.engine.getLog(seat.id, since);
      end = since + events.length;
      emitTo(seat, 'state_update', snapshot(room, seat, reason, since, events, extra));
    }
    room.sent = end;
  }

  function armTurn(room) { // 턴 타이머를 20초로 다시 센다
    clearTimeout(room.turnTimer);
    room.turnSeq += 1;
    const seq = room.turnSeq;
    room.deadline = Date.now() + cfg.turnMs;
    room.turnTimer = setTimeout(() => guard(() => onTurnTimeout(room, seq)), cfg.turnMs);
  }

  function onTurnTimeout(room, seq) { // 0초 → 서버가 대신 방아쇠를 당긴다 (자신 또는 상대, 무작위)
    if (room.status !== 'playing' || seq !== room.turnSeq) return;
    const actor = room.engine.getPublicState(room.seats[0].id).turn?.player;
    if (!actor) return;
    const target = rand() < 0.5 ? 'self' : 'opponent';
    const result = room.engine.shoot(actor, target);
    if (!result.ok) { // 일어날 수 없는 경우지만 판이 멈추지 않게 다시 센다
      cfg.onError(new Error(`타임아웃 격발 실패: ${result.error}`));
      armTurn(room);
      return;
    }
    settle(room, 'timeout', { by: actor, auto: { target } });
  }

  function settle(room, reason, extra) { // 엔진에 반영된 뒤: 타이머 → 양쪽 알림 → 승부가 났으면 종료
    const winnerId = room.engine.getPublicState(room.seats[0].id).winner;
    if (reason !== 'item' && !winnerId) armTurn(room); // 아이템은 턴을 끝내지 않으므로 시간도 그대로
    broadcast(room, reason, extra);
    if (winnerId) finishGame(room, room.seats.find((seat) => seat.id === winnerId), 'normal');
  }

  function overPayload(room, seat) {
    const { fee, prize } = tiers[room.tier];
    const won = room.result.winner === seat.id;
    const view = room.engine.getPublicState(seat.id);
    const players = Object.fromEntries(room.seats.map((s) => [s.id, { mmr: s.profile.mmr }])); // 입장 때 신고한 양쪽의 초기 MMR — 클라이언트가 Elo 정산에 쓴다
    const record = seat.userId && users ? users.publicView(users.get(seat.userId)) : null; // 이 좌석 유저의 서버 전적 (로그인한 좌석만 — 상대 것은 보내지 않는다)
    return {
      code: room.code, tier: room.tier, fee, prize, winner: room.result.winner, youWon: won, reason: room.result.reason, payout: won ? prize : 0,
      score: { you: view.me.wins, opponent: view.opponent.wins }, players, ...(record ? { record } : {}),
    };
  }

  /** 서버 전적 기록: 로그인한 좌석만. 같은 유저가 두 자리에 앉은 판(창 두 개로 혼자 둔 판)은 세지 않는다 — 전적 부풀리기 방지 */
  function recordResults(room) {
    if (!users) return;
    const [a, b] = room.seats;
    if (a.userId && a.userId === b.userId) return;
    for (const seat of room.seats) {
      if (seat.userId) users.recordResult(seat.userId, seat.id === room.result.winner);
    }
  }

  function finishGame(room, winner, reason) {
    if (room.status !== 'playing' || !winner) return;
    room.status = 'over';
    clearRoomTimers(room);
    room.result = { winner: winner.id, reason };
    recordResults(room); // game_over 보다 먼저 — 알림에 갱신된 전적이 실린다
    for (const seat of room.seats) {
      emitTo(seat, 'game_over', overPayload(room, seat));
      release(socketOf(seat), room.code); // 다시 대기열 · 방에 들어갈 수 있다
    }
    log('판 종료', room.code, room.tier, reason);
    room.ttlTimer = setTimeout(() => rooms.delete(room.code), cfg.resultTtlMs); // 늦게 돌아온 사람에게 결과를 다시 알려 줄 시간
    room.ttlTimer.unref?.();
  }

  function startGame(room) {
    const [first, second] = rand() < 0.5 ? [room.seats[0], room.seats[1]] : [room.seats[1], room.seats[0]]; // 첫 라운드 선공은 players[0] → 추첨
    room.engine = new GameEngine({ players: [first.id, second.id], rng: rand });
    room.status = 'playing';
    clearTimeout(room.ttlTimer);
    for (const seat of room.seats) emitTo(seat, 'match_found', matchPayload(room, seat, false));
    armTurn(room);
    broadcast(room, 'start');
    log('판 시작', room.code, room.mode, room.tier);
  }

  function forfeit(room, loser) { // 연결 끊김 · 나가기 → 상대 부전승
    finishGame(room, otherSeat(room, loser), 'forfeit');
  }

  // ── 이벤트 처리 ──
  function createPrivateRoom(socket, payload) {
    if (socket.data.where) return fail('ALREADY_IN_ROOM');
    if (rooms.size >= cfg.maxRooms) return fail('SERVER_BUSY');
    const room = newRoom('private', 'free');
    if (!room) return fail('SERVER_BUSY');
    room.seats.push(makeSeat('P1', socket, profileOf(socket, payload?.profile ?? payload)));
    room.ttlTimer = setTimeout(() => guard(() => expireRoom(room)), cfg.roomTtlMs);
    room.ttlTimer.unref?.();
    attach(socket, room);
    socket.emit('room_created', { code: room.code });
    return { ok: true, code: room.code };
  }

  function expireRoom(room) {
    if (room.status !== 'waiting') return;
    emitTo(room.seats[0], 'room_closed', { reason: 'EXPIRED' });
    closeRoom(room);
  }

  function joinPrivateRoom(socket, payload) {
    const raw = typeof payload === 'string' ? { code: payload } : payload;
    const code = cleanCode(raw?.code);
    if (!code) return fail('ROOM_NOT_FOUND');
    if (socket.data.where) return fail('ALREADY_IN_ROOM');
    const room = rooms.get(code);
    if (!room || room.mode !== 'private') return fail('ROOM_NOT_FOUND'); // 매칭으로 만든 방은 코드로 들어올 수 없다
    if (room.status !== 'waiting') return fail('ROOM_FULL');
    room.seats.push(makeSeat('P2', socket, profileOf(socket, raw.profile)));
    attach(socket, room);
    startGame(room);
    return { ok: true, code };
  }

  /**
   * matchmaker 가 맺어 준 두 사람으로 방을 만들고 바로 시작한다. a · b = { socket, profile(검사를 마친 프로필) }.
   * 방이 가득 찼거나 코드를 못 얻어 만들지 못하면 false — matchmaker 가 두 사람을 대기열에 그대로 둔다.
   */
  function startMatchedRoom(tier, [a, b]) {
    const room = rooms.size < cfg.maxRooms ? newRoom('queue', tier) : null;
    if (!room) return false;
    room.seats.push(makeSeat('P1', a.socket, a.profile), makeSeat('P2', b.socket, b.profile));
    attach(a.socket, room);
    attach(b.socket, room);
    startGame(room);
    return true;
  }

  function leaveRoom(socket) { // 방 나가기 (대기열에서 나가기는 matchmaker.leaveQueue — server/index.js 가 소켓의 위치를 보고 고른다)
    const seated = seatOfSocket(socket);
    release(socket);
    if (seated?.room.status === 'waiting') closeRoom(seated.room);
    else if (seated?.room.status === 'playing') forfeit(seated.room, seated.seat);
    return { ok: true };
  }

  function gameAction(socket, action) {
    const seated = seatOfSocket(socket);
    if (!seated || seated.room.status !== 'playing') return fail('NOT_IN_GAME');
    if (!isRecord(action)) return fail('BAD_REQUEST');
    const { room, seat } = seated;
    let result;
    if (action.type === 'shoot') result = room.engine.shoot(seat.id, action.target); // 좌석은 서버가 정한다 — 보낸 id 는 읽지 않는다
    else if (action.type === 'use_item') result = room.engine.useItem(seat.id, action.index);
    else return fail('INVALID_ACTION');
    if (!result.ok) return fail(result.error); // 거절된 입력은 상태를 바꾸지 않고 알리지도 않는다
    settle(room, action.type === 'shoot' ? 'shoot' : 'item', { by: seat.id });
    return { ok: true }; // 결과는 state_update 로만 — 투시경 같은 비공개 정보가 ack 에 섞이지 않게
  }

  function sendEmote(socket, payload) {
    const seated = seatOfSocket(socket);
    if (!seated || seated.room.status !== 'playing') return fail('NOT_IN_GAME');
    if (!validEmote(payload)) return fail('BAD_REQUEST');
    const now = Date.now();
    if (now - socket.data.lastEmote < cfg.emoteGapMs) return fail('RATE_LIMITED');
    socket.data.lastEmote = now;
    emitTo(otherSeat(seated.room, seated.seat), 'receive_emote', payload);
    return { ok: true };
  }

  function rejoinRoom(socket, payload) {
    const room = rooms.get(cleanCode(payload?.code));
    const seat = room?.seats.find((s) => sameToken(s.token, payload?.token));
    if (!room || !seat) return fail('ROOM_NOT_FOUND'); // 코드와 토큰 중 어느 쪽이 틀렸는지는 알려 주지 않는다
    const where = socket.data.where;
    if (where && !(where.kind === 'room' && where.code === room.code)) return fail('ALREADY_IN_ROOM');
    if (room.status === 'over') {
      socket.emit('game_over', overPayload(room, seat)); // 끝난 판 — 결과만 다시 알려 준다
      return { ok: true, over: true };
    }
    if (room.status !== 'playing') return fail('ROOM_NOT_FOUND');
    const old = socketOf(seat); // 끊긴 줄 모르는 옛 연결이 아직 살아 있다면 새 연결이 자리를 넘겨받는다
    seat.socketId = socket.id;
    seat.connected = true;
    clearTimeout(seat.graceTimer);
    seat.graceTimer = null;
    if (old && old !== socket) {
      release(old);
      old.emit('session_replaced');
      old.disconnect(true);
    }
    attach(socket, room);
    emitTo(seat, 'match_found', matchPayload(room, seat, true));
    emitTo(seat, 'state_update', snapshot(room, seat, 'rejoin', 0, room.engine.getLog(seat.id, 0))); // 전체 로그부터 — logFrom 0
    const opp = otherSeat(room, seat);
    emitTo(opp, 'opponent_status', { connected: true });
    return { ok: true };
  }

  function onDisconnect(socket) { // 방에 앉아 있던 소켓이 끊겼을 때 (대기열에 있던 소켓은 matchmaker.onDisconnect)
    const seated = seatOfSocket(socket); // 방에 없거나, 이미 새 연결로 자리를 넘겨 준 옛 소켓이면 null
    if (!seated) return;
    const { room, seat } = seated;
    if (room.status === 'waiting') {
      closeRoom(room); // 친구를 기다리던 방은 만든 사람이 끊기면 바로 닫는다
      return;
    }
    if (room.status !== 'playing') return;
    seat.connected = false;
    seat.socketId = null;
    seat.graceUntil = Date.now() + cfg.graceMs;
    seat.graceTimer = setTimeout(() => guard(() => forfeit(room, seat)), cfg.graceMs);
    emitTo(otherSeat(room, seat), 'opponent_status', { connected: false, graceMs: cfg.graceMs, until: seat.graceUntil });
  }

  // ── 현황 · 종료 ──
  function stats() {
    const all = [...rooms.values()];
    return {
      rooms: all.length,
      waiting: all.filter((r) => r.status === 'waiting').length,
      playing: all.filter((r) => r.status === 'playing').length,
    };
  }

  function shutdown() { // 서버를 닫을 때: 모든 타이머를 멈추고 방을 비운다
    for (const room of rooms.values()) clearRoomTimers(room);
    rooms.clear();
  }

  return { createPrivateRoom, joinPrivateRoom, startMatchedRoom, leaveRoom, rejoinRoom, gameAction, sendEmote, onDisconnect, stats, shutdown };
}
