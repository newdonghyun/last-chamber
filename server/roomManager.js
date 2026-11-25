/**
 * LAST CHAMBER - 방 · 판 관리 (server/index.js 에서 분리)
 *
 *   방 3종의 한살이를 맡는다:
 *     'public'  공개 방 — 방장이 만들면 로비 방 목록(publicRooms)에 보이고, 목록에서 누르면 바로 1:1 시작 (랭킹전)
 *     'queue'   빠른 매칭 — matchmaker 가 같은 등급 2명을 맺어 준 방 (랭킹전)
 *     'private' 친선 비밀방 — 목록에 보이지 않고 4자리 코드로만 들어온다 (친선전: MMR · 전적 미반영)
 *   · 생성 / 입장 / 재접속 토큰(rejoin_room) / 나가기 / 연결 끊김
 *   · 항복(surrender): 진행 중인 판에서 내가 패배로 끝낸다 — 랭킹전이면 항복자 −20 · 상대 +25 를 서버가 정산하고 둘 다 game_over(reason 'surrender'), 친선 비밀방이면 기록 없이 상대 승리
 *   · 방마다 GameEngine 하나 — 서버 권위. 좌석(P1 · P2)은 서버가 소켓에 붙이고, 각자에게는 자기 시점의 상태와 로그만 보낸다
 *   · 20초 턴 타이머(0초가 되면 서버가 대신 격발) · 15초 연결 끊김 부전승 · 친구를 기다리는 방의 10분 만료 · 끝난 판 결과 60초 보관
 *   · 이모트(send_emote) 중계 · 클라이언트가 보낸 프로필의 모양 검사(cleanProfile) · 로그인한 소켓은 서버가 확인한 닉네임으로(profileOf)
 *   · 랭킹 어뷰징 방지: 1라운드가 끝나기 전에 항복 · 연결 끊김으로 끝난 판(EARLY_END)과, 같은 두 계정이 하루(한국 시간)에 PAIR_LIMIT 판을 넘겨 만난 판(PAIR_LIMIT)은
 *     MMR · 전적 · 탄피 보상을 모두 무효로 한다 (참가비는 돌려준다) — game_over 의 voided 로 알린다.
 *   · 서버 지갑(wallets): 참가비는 대기열에서 이미 냈고(matchmaker), 판이 끝나면 서버가 상금 · 기본 보상을 지급한다 — game_over 의 reward · wallet 으로 알린다.
 *   · 판이 끝나면 로그인한 좌석의 서버 전적(승/패 · 연승 · MMR)을 기록한다 (server/userStore.js) — 랭킹전(공개 방 · 빠른 매칭)만. 친선 비밀방은 기록하지 않는다
 *     game_over 에 그 좌석의 record(현재 서버 전적) · ranked · mmrDelta(랭킹전에서 바뀐 MMR)로 알려 준다
 *   소켓 이벤트 이름 · 페이로드 규약은 server/index.js 맨 위 주석, 등급별 대기열은 server/matchmaker.js.
 *
 *   전송 격리: 전체 방송(io.emit · socket.broadcast)은 쓰지 않는다. 인게임 이벤트는 좌석마다 따로(자기 시점 상태 — 투시경 같은 비공개 정보가 섞이지 않게),
 *             그 좌석의 소켓이 지금 이 방에 앉아 있을 때만 보내고(emitTo), 모든 이벤트에 방 코드(code)를 싣는다 → 클라이언트는 자기 방 코드가 아니면 버린다.
 *             방에 앉으면 Socket.io 방 채널(room:<code>)에 join, 판이 끝나거나 나가거나 방이 닫히면 leave.
 *   로비 방 목록: 목록을 보는 소켓은 LOBBY_CHANNEL 에 들어 있다(server/index.js watch_rooms). 공개 방이 생기거나 · 시작되거나 · 닫히면 onRoomsChanged() →
 *             index.js 가 그 채널에만 room_list 를 보낸다 (인게임 이벤트가 아니다). 방에 앉는 순간 그 소켓은 로비 채널에서 나간다.
 *   socket.data 약속:  where = null | { kind: 'queue', tier }(matchmaker 가 씀) | { kind: 'room', code }(여기서 씀) · lastEmote = 마지막 이모트 시각(ms)
 *                      user = null | { id, nickname } (server/index.js 가 로그인 토큰을 확인한 뒤 씀 — 방 · 매칭은 로그인한 소켓만)
 */

import { randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { GameEngine } from '../src/engine/gameEngine.js';
import { rewardFor, getTitle, TITLES } from '../src/ui/storeData.js';
import { kstDate } from './wallet.js';

// ───────── 규칙 · 설정 ─────────

export const TURN_MS = 20_000; // 턴 제한
export const GRACE_MS = 15_000; // 연결이 끊긴 뒤 돌아올 수 있는 시간
export const ROOM_TTL_MS = 10 * 60_000; // 상대를 기다리는 방(공개 · 비밀)이 살아 있는 시간
export const RESULT_TTL_MS = 60_000; // 끝난 판의 결과를 늦게 돌아온 사람에게 다시 알려 줄 수 있는 시간
/** createGameServer 의 설정(cfg) 중 이 파일이 읽는 값의 기본값 — options 로 덮어쓸 수 있다 (예: 테스트에서 turnMs: 250) */
export const ROOM_DEFAULTS = Object.freeze({
  turnMs: TURN_MS,
  graceMs: GRACE_MS,
  roomTtlMs: ROOM_TTL_MS,
  resultTtlMs: RESULT_TTL_MS,
  maxRooms: 5000,
  emoteGapMs: 500, // 이모트 최소 간격
  pairDailyLimit: 3, // 같은 두 계정의 랭킹 정산(MMR · 보상)이 하루(한국 시간)에 반영되는 최대 판 수
  clock: () => Date.now(), // 한국 시간 날짜 계산용 시계 (테스트에서 바꾼다)
});

// 4자리 방 코드: 헷갈리는 글자(0 O 1 I)를 뺀 영문 대문자 + 숫자 32종 → 약 100만 가지
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_PATTERN = new RegExp(`^[${CODE_ALPHABET}]{4}$`);

const rand = () => randomInt(2 ** 32) / 2 ** 32; // [0, 1)
export const roomChannel = (code) => `room:${code}`; // Socket.io 방 채널 이름 (방에 앉은 소켓만 들어 있다)
export const LOBBY_CHANNEL = 'lobby'; // 로비 방 목록을 보는 소켓들 (room_list 받는 곳)
export const RANKED_MODES = Object.freeze(['queue', 'public']); // 랭킹전 = 빠른 매칭 · 공개 방 ('private' 친선 비밀방은 친선전)
const isRanked = (room) => RANKED_MODES.includes(room.mode);
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
  const user = socket?.data?.user;
  if (!user) return profile;
  const rec = user.rec; // 로그인한 계정의 서버 기록 (닉네임 변경 · 판 결과가 바로 반영된 같은 객체)
  const w = rec?.wallet; // 서버 지갑이 있으면 상대에게 보이는 스킨 · 화염 · 도발 · 칭호도 클라이언트가 보낸 값이 아니라 서버가 아는 장착값
  const owned = w ? {
    title: TITLES.find((t) => t.name === profile.title)?.name ?? getTitle(w.extra.equippedTitle)?.name, // 칭호는 꾸밈 — 카탈로그에 있는 이름만 인정 (없으면 서버가 아는 장착 칭호)
    cosmetics: { gun: w.equipped.gun, table: w.equipped.table, flame: w.extra.equippedFlame, taunt: w.extra.equippedTaunt },
  } : {};
  return { ...profile, ...owned, nickname: rec?.nickname ?? user.nickname, ...(Number.isFinite(rec?.mmr) ? { mmr: rec.mmr } : {}) }; // 이름 · MMR 은 서버 값
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
 *   wallets  서버 지갑 창구 { managed(userId), grant(userId, n), view(userId) } — 없으면 탄피 정산은 클라이언트 몫 (예전 방식)
 *   onRoomsChanged()  공개 방 목록이 바뀌었을 때 (index.js 가 로비 채널에 room_list 를 보낸다)
 * 이벤트 처리 함수는 (socket, payload) → ack 로 돌려줄 { ok, ... } 를 반환한다 (소켓 이벤트와의 연결은 server/index.js).
 */
export function createRoomManager({ io, cfg, log, guard, tiers, users = null, wallets = null, onRoomsChanged = () => {} }) {
  const pairs = new Map(); // '계정A|계정B' → { day, ranked, friendly } — 오늘 이 두 계정의 정산이 반영된 판 수 (서버를 다시 켜면 비워진다)
  const rooms = new Map(); // code → room { code, mode, tier, status: 'waiting'|'playing'|'over', seats, engine, sent, turnTimer, turnSeq, deadline, ttlTimer, result }

  // ── 좌석 · 소켓 ──
  const socketOf = (seat) => (seat.socketId ? io.sockets.sockets.get(seat.socketId) : undefined);
  const seatedIn = (socket, room) => socket?.data.where?.kind === 'room' && socket.data.where.code === room.code;
  // 이 방 좌석의 소켓에게만 — 그 소켓이 이미 이 방을 떠났으면(판 종료 · 나가기 · 다른 방) 아무것도 보내지 않는다
  const emitTo = (room, seat, event, payload) => {
    const socket = socketOf(seat);
    if (seatedIn(socket, room)) socket.emit(event, payload);
  };
  const otherSeat = (room, seat) => room.seats.find((s) => s !== seat);
  // userId: 앉을 때 로그인한 유저 (재접속으로 소켓이 바뀌어도 좌석의 주인은 그대로 — 판 결과는 이 유저에게 기록된다)
  const makeSeat = (id, socket, profile, paid = 0) => ({ id, token: makeToken(), socketId: socket.id, userId: socket.data.user?.id ?? null, profile, paid, connected: true, graceTimer: null, graceUntil: 0 }); // paid = 대기열에서 서버가 미리 받은 참가비
  const attach = (socket, room) => {
    socket.data.where = { kind: 'room', code: room.code };
    socket.join(roomChannel(room.code));
    socket.leave(LOBBY_CHANNEL); // 방에 앉으면 로비 목록은 더 받지 않는다
  };
  const listChanged = (room) => { if (room.mode === 'public') guard(() => onRoomsChanged()); };
  const release = (socket, code) => { // 이 방에 묶여 있을 때만 풀어 준다 (방 채널에서도 나간다 → 이전 방 이벤트를 더는 받지 않는다)
    const where = socket?.data.where;
    if (where?.kind !== 'room' || (code !== undefined && where.code !== code)) return;
    socket.data.where = null;
    socket.leave(roomChannel(where.code));
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
    listChanged(room); // 공개 방이면 로비 목록에서 빠진다
  }

  // ── 판 진행 ──
  const matchPayload = (room, seat, resume) => {
    const opp = otherSeat(room, seat);
    const { fee, prize } = tiers[room.tier];
    return { code: room.code, mode: room.mode, ranked: isRanked(room), tier: room.tier, fee, prize, feePaid: Boolean(wallets?.managed(seat.userId)), you: seat.id, token: seat.token, opponent: { id: opp.id, profile: opp.profile }, turnMs: cfg.turnMs, graceMs: cfg.graceMs, resume };
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
      emitTo(room, seat, 'state_update', snapshot(room, seat, reason, since, events, extra));
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
    const mmrDelta = room.deltas?.[seat.id]; // 랭킹전에서 실제로 기록된 이번 판 MMR 변동 (친선전 · 기록 안 된 좌석은 없음)
    const reward = room.rewards?.[seat.id]; // 서버 지갑이 이 좌석에 지급한 탄피 (지갑을 쓰지 않는 좌석은 없음)
    return {
      code: room.code, mode: room.mode, ranked: isRanked(room), tier: room.tier, fee, prize, winner: room.result.winner, youWon: won, reason: room.result.reason, payout: won && !room.voided ? prize : 0,
      score: { you: view.me.wins, opponent: view.opponent.wins }, players, ...(record ? { record } : {}), ...(Number.isFinite(mmrDelta) ? { mmrDelta } : {}),
      voided: room.voided ?? null, // 'EARLY_END' | 'PAIR_LIMIT' | null — 무효면 MMR · 전적 · 탄피 보상이 없다 (참가비는 환불)
      ...(reward ? { reward, wallet: wallets?.view(seat.userId) ?? null } : {}),
    };
  }

  /**
   * 서버 전적 기록 — 랭킹전(무작위 매칭 'queue')만. 친구 초대 방('private')은 친선전이라 MMR · 전적 · 연승을 건드리지 않는다
   * (지인끼리 점수를 몰아주는 어뷰징 방지). 로그인한 좌석만 · 같은 유저가 두 자리에 앉은 판(창 두 개로 혼자 둔 판)은 세지 않는다.
   * 좌석별 MMR 변동은 room.deltas 에 남겨 game_over 로 알려 준다.
   * 두 좌석이 모두 로그인한 계정이면 승자 · 패자를 한 번에 기록한다 (users.recordMatch — DB 에도 요청 하나로 써서 한쪽만 반영되지 않는다).
   * finishGame 이 판마다 한 번만 부르므로(상태가 'playing' 일 때만) 정상 종료 · 항복 · 부전승 어느 경로로 끝나도 정산은 한 번이다.
   */
  function recordResults(room) {
    room.deltas = {};
    if (!users || !isRanked(room) || room.voided) return; // 무효 판(조기 종료 · 같은 상대 반복)은 MMR · 전적을 건드리지 않는다
    const [a, b] = room.seats;
    if (a.userId && a.userId === b.userId) return;
    const before = Object.fromEntries(room.seats.map((s) => [s.id, s.userId ? users.get(s.userId)?.mmr : undefined]));
    const winner = room.seats.find((s) => s.id === room.result.winner);
    const loser = otherSeat(room, winner);
    if (!(winner.userId && loser.userId && users.recordMatch(winner.userId, loser.userId))) { // 한쪽이 손님이었던 옛 판 등: 좌석별로
      for (const seat of room.seats) if (seat.userId) users.recordResult(seat.userId, seat.id === winner.id);
    }
    for (const seat of room.seats) {
      const after = seat.userId ? users.get(seat.userId)?.mmr : undefined;
      if (Number.isFinite(before[seat.id]) && Number.isFinite(after)) room.deltas[seat.id] = after - before[seat.id];
    }
  }

  /** 1라운드가 끝나기 전에 항복 · 연결 끊김으로 끝난 판인가 (정상 종료는 항상 2라운드 승리라 해당 없음) */
  function endedEarly(room, reason) {
    if (reason === 'normal' || !room.engine) return false;
    const view = room.engine.getPublicState(room.seats[0].id);
    return view.round === 1 && view.me.wins === 0 && view.opponent.wins === 0;
  }

  const pairKeyOf = (room) => room.seats.map((s) => s.userId).sort().join('|');
  /** 이 판의 정산(MMR · 보상)을 무효로 할 이유 → 'EARLY_END' | 'PAIR_LIMIT' | null (반영되는 판이면 오늘 이 두 계정의 횟수를 올린다) */
  function judge(room, reason) {
    if (endedEarly(room, reason)) return 'EARLY_END';
    const [a, b] = room.seats;
    if (!a.userId || !b.userId || a.userId === b.userId) return null;
    const day = kstDate(cfg.clock());
    const key = pairKeyOf(room);
    let entry = pairs.get(key);
    if (entry?.day !== day) { // 날이 바뀌면 처음부터 (오래된 항목은 이때 같이 정리)
      entry = { day, ranked: 0, friendly: 0 };
      pairs.set(key, entry);
      for (const [k, v] of pairs) if (v.day !== day) pairs.delete(k);
    }
    const kind = isRanked(room) ? 'ranked' : 'friendly';
    if (entry[kind] >= cfg.pairDailyLimit) return 'PAIR_LIMIT';
    entry[kind] += 1;
    return null;
  }

  /**
   * 서버 지갑 정산: 무효면 미리 받은 참가비 환불 · 보상 없음. 아니면 참가비 테이블은 승자 상금(참가비는 이미 냈다), 그 밖에는 기본 보상(승 150 · 패 40 — 랭킹전은 연승 보너스).
   * 계정마다 room.rewards[좌석] = { brass(지급한 탄피), refunded(돌려준 참가비) }.
   */
  function payoutBrass(room) {
    if (!wallets) return;
    const { fee, prize } = tiers[room.tier];
    room.rewards = {};
    for (const seat of room.seats) {
      if (!seat.userId || !wallets.managed(seat.userId)) continue;
      const won = room.result.winner === seat.id;
      let brass = 0;
      let refunded = 0;
      if (room.voided) {
        refunded = seat.paid;
        if (refunded > 0) wallets.grant(seat.userId, refunded);
      } else if (fee > 0) {
        brass = won ? prize : 0;
      } else {
        const streak = isRanked(room) && won ? users?.get(seat.userId)?.streak ?? 0 : 0; // 랭킹 연승(이번 승리 포함) 보너스
        brass = rewardFor(won, streak).total;
      }
      if (brass > 0) wallets.grant(seat.userId, brass);
      room.rewards[seat.id] = { brass, refunded };
    }
  }

  function finishGame(room, winner, reason) {
    if (room.status !== 'playing' || !winner) return;
    room.status = 'over';
    clearRoomTimers(room);
    room.result = { winner: winner.id, reason };
    room.voided = judge(room, reason);
    recordResults(room); // game_over 보다 먼저 — 알림에 갱신된 전적이 실린다
    payoutBrass(room);
    for (const seat of room.seats) {
      emitTo(room, seat, 'game_over', overPayload(room, seat));
      release(socketOf(seat), room.code); // 방 채널에서 나가고 다시 대기열 · 방에 들어갈 수 있다
      seat.socketId = null; // 끝난 판은 어떤 소켓과도 이어 두지 않는다 (늦게 돌아온 사람은 rejoin_room 으로 결과만 다시 받는다)
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
    for (const seat of room.seats) emitTo(room, seat, 'match_found', matchPayload(room, seat, false));
    armTurn(room);
    broadcast(room, 'start');
    listChanged(room); // 시작된 공개 방은 로비 목록에서 빠진다
    log('판 시작', room.code, room.mode, room.tier);
  }

  function forfeit(room, loser) { // 연결 끊김 · 나가기 → 상대 부전승
    finishGame(room, otherSeat(room, loser), 'forfeit');
  }

  /**
   * 항복: 진행 중인 판에서 이 소켓의 좌석이 지고 상대가 이긴 것으로 끝낸다 (reason 'surrender').
   * 정산은 finishGame → recordResults 한 곳 — 랭킹전(공개 방 · 빠른 매칭)이면 항복자 −20 · 패배 +1 · 연승 초기화, 상대 +25 · 승리 +1 · 연승 +1 을 서버가 기록하고,
   * 친선 비밀방이면 기록 없이 상대 승리로만 끝난다. 두 사람 모두에게 game_over 를 보낸 뒤 방 채널에서 내보낸다.
   * 이미 끝난 판 · 동시에 서로 항복한 두 번째 요청은 NOT_IN_GAME (좌석이 이미 풀려 있다) — 두 번 정산되지 않는다.
   */
  function surrender(socket) {
    const seated = seatOfSocket(socket);
    if (!seated || seated.room.status !== 'playing') return fail('NOT_IN_GAME');
    finishGame(seated.room, otherSeat(seated.room, seated.seat), 'surrender');
    return { ok: true };
  }

  // ── 이벤트 처리 ──
  /** 상대를 기다리는 방을 만든다 (mode: 'private' 친선 비밀방 | 'public' 공개 방) */
  function openRoom(socket, payload, mode) {
    if (socket.data.where) return fail('ALREADY_IN_ROOM');
    if (rooms.size >= cfg.maxRooms) return fail('SERVER_BUSY');
    const room = newRoom(mode, 'free');
    if (!room) return fail('SERVER_BUSY');
    room.seats.push(makeSeat('P1', socket, profileOf(socket, payload?.profile ?? payload)));
    room.createdAt = Date.now();
    room.ttlTimer = setTimeout(() => guard(() => expireRoom(room)), cfg.roomTtlMs);
    room.ttlTimer.unref?.();
    attach(socket, room);
    socket.emit('room_created', { code: room.code, mode });
    listChanged(room); // 공개 방이면 로비 목록에 바로 보인다
    return { ok: true, code: room.code, mode };
  }

  /** 친선 비밀방 만들기 — 로비 목록에 보이지 않고 코드로만 들어온다 */
  const createPrivateRoom = (socket, payload) => openRoom(socket, payload, 'private');
  /** 공개 방 만들기 — 로비 방 목록에 보이고, 누르면 바로 시작 (랭킹전) */
  const createPublicRoom = (socket, payload) => openRoom(socket, payload, 'public');

  function expireRoom(room) {
    if (room.status !== 'waiting') return;
    emitTo(room, room.seats[0], 'room_closed', { code: room.code, reason: 'EXPIRED' });
    closeRoom(room);
  }

  function joinPrivateRoom(socket, payload) {
    const raw = typeof payload === 'string' ? { code: payload } : payload;
    const code = cleanCode(raw?.code);
    if (!code) return fail('ROOM_NOT_FOUND');
    if (socket.data.where) return fail('ALREADY_IN_ROOM');
    const room = rooms.get(code);
    if (!room || room.mode !== 'private') return fail('ROOM_NOT_FOUND'); // 공개 방 · 매칭 방은 코드 입력으로 들어올 수 없다
    return takeSeat(socket, room, raw.profile);
  }

  /** 로비 목록에서 공개 방을 눌렀다 → 바로 1:1 시작 */
  function joinPublicRoom(socket, payload) {
    const raw = typeof payload === 'string' ? { code: payload } : payload;
    const code = cleanCode(raw?.code);
    if (socket.data.where) return fail('ALREADY_IN_ROOM');
    const room = code ? rooms.get(code) : undefined;
    if (!room || room.mode !== 'public') return fail('ROOM_NOT_FOUND');
    return takeSeat(socket, room, raw.profile);
  }

  /** 기다리는 방의 두 번째 자리에 앉혀 판을 시작한다 */
  function takeSeat(socket, room, profile) {
    if (room.status !== 'waiting' || room.seats.length >= 2) return fail('ROOM_FULL');
    const host = room.seats[0];
    if (host.userId && host.userId === socket.data.user?.id) return fail('OWN_ROOM'); // 같은 계정끼리(창 두 개)는 못 붙는다
    room.seats.push(makeSeat('P2', socket, profileOf(socket, profile)));
    attach(socket, room);
    startGame(room);
    return { ok: true, code: room.code, mode: room.mode };
  }

  /** 로비 방 목록: 상대를 기다리는 공개 방 (오래된 순) → [{ code, host, mmr, players, capacity, createdAt }] — 유저 ID 는 싣지 않는다 */
  function publicRooms() {
    return [...rooms.values()]
      .filter((r) => r.mode === 'public' && r.status === 'waiting' && r.seats.length === 1)
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((r) => {
        const host = r.seats[0];
        const mmr = (host.userId && users?.get(host.userId)?.mmr) ?? host.profile.mmr ?? 1000; // 서버 전적의 MMR (계정) — 없으면 프로필 값
        return { code: r.code, host: host.profile.nickname, mmr, players: r.seats.length, capacity: 2, createdAt: r.createdAt };
      });
  }

  /**
   * matchmaker 가 맺어 준 두 사람으로 방을 만들고 바로 시작한다. a · b = { socket, profile(검사를 마친 프로필) }.
   * 방이 가득 찼거나 코드를 못 얻어 만들지 못하면 false — matchmaker 가 두 사람을 대기열에 그대로 둔다.
   */
  function startMatchedRoom(tier, [a, b]) {
    const room = rooms.size < cfg.maxRooms ? newRoom('queue', tier) : null;
    if (!room) return false;
    room.seats.push(makeSeat('P1', a.socket, a.profile, a.paid ?? 0), makeSeat('P2', b.socket, b.profile, b.paid ?? 0));
    attach(a.socket, room);
    attach(b.socket, room);
    startGame(room);
    return true;
  }

  function leaveRoom(socket) { // 방 나가기 (대기열에서 나가기는 matchmaker.leaveQueue — server/index.js 가 소켓의 위치를 보고 고른다)
    const seated = seatOfSocket(socket);
    if (seated?.room.status === 'waiting') closeRoom(seated.room);
    else if (seated?.room.status === 'playing') forfeit(seated.room, seated.seat); // 나간 사람에게도 결과(game_over)를 준 뒤 finishGame 이 방 채널에서 내보낸다
    release(socket); // 어떤 경우든 방 채널에서 나간다
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
    emitTo(seated.room, otherSeat(seated.room, seated.seat), 'receive_emote', { ...payload, code: seated.room.code });
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
      old.emit('session_replaced', { code: room.code });
      old.disconnect(true);
    }
    attach(socket, room);
    emitTo(room, seat, 'match_found', matchPayload(room, seat, true));
    emitTo(room, seat, 'state_update', snapshot(room, seat, 'rejoin', 0, room.engine.getLog(seat.id, 0))); // 전체 로그부터 — logFrom 0
    const opp = otherSeat(room, seat);
    emitTo(room, opp, 'opponent_status', { code: room.code, connected: true });
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
    emitTo(room, otherSeat(room, seat), 'opponent_status', { code: room.code, connected: false, graceMs: cfg.graceMs, until: seat.graceUntil });
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

  return { createPrivateRoom, joinPrivateRoom, createPublicRoom, joinPublicRoom, publicRooms, startMatchedRoom, leaveRoom, surrender, rejoinRoom, gameAction, sendEmote, onDisconnect, stats, shutdown };
}
