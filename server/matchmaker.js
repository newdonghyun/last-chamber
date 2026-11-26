/**
 * ODD ROULETTE - 매칭 큐 (server/index.js 에서 분리)
 *
 *   free · pro · vip 등급별 대기열을 관리하고, 같은 등급 2명이 모이면 roomManager 에게 방을 만들어 바로 시작하라고 넘긴다.
 *   등급표(QUEUE_TIERS: 참가비 fee · 승자 상금 prize)도 여기서 정한다 — 방 관리자에게는 createRoomManager({ tiers }) 로 건네 준다.
 *   대기열에 있는 소켓은 socket.data.where = { kind: 'queue', tier } — 방에 들어가면 roomManager 가 { kind: 'room', code } 로 바꾼다.
 *   참가비(fee > 0): 서버 지갑이 있는 계정은 대기열에 들어갈 때 서버가 탄피를 먼저 받아 둔다(wallets.spend — 모자라면 INSUFFICIENT_BRASS).
 *   매칭 전에 취소 · 끊김이면 그대로 돌려주고, 매칭되면 방이 승자 상금 · 조기 종료 환불로 정산한다 (server/roomManager.js).
 *   소켓 이벤트 이름 · 페이로드 규약은 server/index.js 맨 위 주석.
 */

import { profileOf, fail } from './roomManager.js';

/** 매칭 등급: fee = 참가비(탄피), prize = 승자가 받는 탄피 (2명이 낸 판돈의 90%) */
export const QUEUE_TIERS = Object.freeze({
  free: Object.freeze({ fee: 0, prize: 0 }),
  pro: Object.freeze({ fee: 200, prize: 360 }),
  vip: Object.freeze({ fee: 1000, prize: 1800 }),
});

/**
 * 매칭 큐를 만든다.
 *   io     Socket.io 서버 (대기열에 적어 둔 소켓 id 로 소켓을 찾는다)
 *   rooms  방 관리자 (createRoomManager 의 반환값) — 매칭이 성사되면 rooms.startMatchedRoom 을 부른다
 *   tiers  등급표 (기본 QUEUE_TIERS)
 *   wallets  서버 지갑 창구 { managed(userId), spend(userId, n), grant(userId, n) } — 없으면 참가비를 받지 않는다 (클라이언트가 예전처럼 처리)
 * 이벤트 처리 함수는 (socket, payload) → ack 로 돌려줄 { ok, ... } 를 반환한다 (소켓 이벤트와의 연결은 server/index.js).
 */
export function createMatchmaker({ io, rooms, tiers = QUEUE_TIERS, wallets = null }) {
  const queues = Object.fromEntries(Object.keys(tiers).map((tier) => [tier, []])); // tier → [{ socketId, profile, userId, paid }]

  function joinQueue(socket, payload) {
    const tier = payload?.tier;
    if (typeof tier !== 'string' || !Object.hasOwn(tiers, tier)) return fail('INVALID_TIER');
    if (socket.data.where) return fail('ALREADY_IN_ROOM');
    const { fee, prize } = tiers[tier];
    const userId = socket.data.user?.id ?? null;
    if (userId && (rooms.seatedElsewhere(userId, socket) || queuedElsewhere(userId, socket.id))) return fail('ACCOUNT_BUSY'); // 계정당 활성 방 · 대기 1개
    let paid = 0;
    if (fee > 0 && wallets?.managed(userId)) { // 참가비는 서버가 먼저 받아 둔다 (클라이언트가 속여 공짜로 들어오지 못한다)
      if (!wallets.spend(userId, fee)) return fail('INSUFFICIENT_BRASS');
      paid = fee;
    }
    queues[tier].push({ socketId: socket.id, profile: profileOf(socket, payload.profile), userId, paid }); // 로그인한 소켓이면 서버가 확인한 닉네임
    socket.data.where = { kind: 'queue', tier };
    socket.emit('queue_joined', { tier, fee, prize });
    tryMatch(tier);
    return { ok: true, tier, fee, prize };
  }

  /** 대기열에서 빼고, 미리 받아 둔 참가비는 돌려준다 */
  function removeFromQueue(tier, socketId) {
    const queue = queues[tier];
    const i = queue.findIndex((entry) => entry.socketId === socketId);
    if (i < 0) return;
    const [entry] = queue.splice(i, 1);
    if (entry.paid > 0) wallets?.grant(entry.userId, entry.paid);
  }

  function tryMatch(tier) { // 같은 등급 2명이 모이면 방을 만들고 바로 시작
    const queue = queues[tier];
    while (queue.length >= 2) {
      const j = queue.findIndex((e, i) => i > 0 && (!e.userId || e.userId !== queue[0].userId)); // 같은 계정끼리는 맺지 않는다
      if (j < 0) break;
      const [b] = queue.splice(j, 1);
      const a = queue.shift();
      const sa = io.sockets.sockets.get(a.socketId);
      const sb = io.sockets.sockets.get(b.socketId);
      if (!sa?.connected || !sb?.connected) { // 끊긴 소켓은 disconnect 에서 이미 빠지지만 혹시 남았다면 살아 있는 쪽만 맨 앞으로 돌려 놓는다
        if (sa?.connected) queue.unshift(a); else if (a.paid > 0) wallets?.grant(a.userId, a.paid); // 버리는 대기자의 참가비는 돌려준다
        if (sb?.connected) queue.unshift(b); else if (b.paid > 0) wallets?.grant(b.userId, b.paid);
        continue;
      }
      if (!rooms.startMatchedRoom(tier, [{ socket: sa, profile: a.profile, paid: a.paid }, { socket: sb, profile: b.profile, paid: b.paid }])) { // 서버가 가득 참 — 두 사람은 대기열에 그대로 둔다
        queue.unshift(a, b);
        break;
      }
    }
  }

  function leaveQueue(socket) {
    const where = socket.data.where;
    if (where?.kind === 'queue') {
      removeFromQueue(where.tier, socket.id);
      socket.data.where = null;
    }
    return { ok: true };
  }

  function onDisconnect(socket) { // 대기 중에 끊긴 소켓은 즉시 대기열에서 뺀다 (방에 있던 소켓은 rooms.onDisconnect)
    const where = socket.data.where;
    if (where?.kind === 'queue') removeFromQueue(where.tier, socket.id);
  }

  /** 이 계정이 다른 접속으로 대기 중인가 */
  function queuedElsewhere(userId, socketId) {
    return Boolean(userId) && Object.values(queues).some((queue) => queue.some((e) => e.userId === userId && e.socketId !== socketId && io.sockets.sockets.get(e.socketId)?.connected));
  }

  // ── 현황 · 종료 ──
  const queued = () => Object.values(queues).reduce((n, queue) => n + queue.length, 0); // 모든 등급의 대기 인원

  function clear() { // 서버를 닫을 때
    for (const queue of Object.values(queues)) queue.length = 0;
  }

  return { joinQueue, leaveQueue, onDisconnect, queuedElsewhere, queued, clear };
}
