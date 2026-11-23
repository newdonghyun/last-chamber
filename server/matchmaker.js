/**
 * LAST CHAMBER - 매칭 큐 (server/index.js 에서 분리)
 *
 *   free · pro · vip 등급별 대기열을 관리하고, 같은 등급 2명이 모이면 roomManager 에게 방을 만들어 바로 시작하라고 넘긴다.
 *   등급표(QUEUE_TIERS: 참가비 fee · 승자 상금 prize)도 여기서 정한다 — 방 관리자에게는 createRoomManager({ tiers }) 로 건네 준다.
 *   대기열에 있는 소켓은 socket.data.where = { kind: 'queue', tier } — 방에 들어가면 roomManager 가 { kind: 'room', code } 로 바꾼다.
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
 * 이벤트 처리 함수는 (socket, payload) → ack 로 돌려줄 { ok, ... } 를 반환한다 (소켓 이벤트와의 연결은 server/index.js).
 */
export function createMatchmaker({ io, rooms, tiers = QUEUE_TIERS }) {
  const queues = Object.fromEntries(Object.keys(tiers).map((tier) => [tier, []])); // tier → [{ socketId, profile }]

  function joinQueue(socket, payload) {
    const tier = payload?.tier;
    if (typeof tier !== 'string' || !Object.hasOwn(tiers, tier)) return fail('INVALID_TIER');
    if (socket.data.where) return fail('ALREADY_IN_ROOM');
    queues[tier].push({ socketId: socket.id, profile: profileOf(socket, payload.profile) }); // 로그인한 소켓이면 서버가 확인한 닉네임
    socket.data.where = { kind: 'queue', tier };
    const { fee, prize } = tiers[tier];
    socket.emit('queue_joined', { tier, fee, prize });
    tryMatch(tier);
    return { ok: true, tier, fee, prize };
  }

  function removeFromQueue(tier, socketId) {
    const queue = queues[tier];
    const i = queue.findIndex((entry) => entry.socketId === socketId);
    if (i >= 0) queue.splice(i, 1);
  }

  function tryMatch(tier) { // 같은 등급 2명이 모이면 방을 만들고 바로 시작
    const queue = queues[tier];
    while (queue.length >= 2) {
      const [a, b] = queue.splice(0, 2);
      const sa = io.sockets.sockets.get(a.socketId);
      const sb = io.sockets.sockets.get(b.socketId);
      if (!sa?.connected || !sb?.connected) { // 끊긴 소켓은 disconnect 에서 이미 빠지지만 혹시 남았다면 살아 있는 쪽만 맨 앞으로 돌려 놓는다
        if (sa?.connected) queue.unshift(a);
        if (sb?.connected) queue.unshift(b);
        continue;
      }
      if (!rooms.startMatchedRoom(tier, [{ socket: sa, profile: a.profile }, { socket: sb, profile: b.profile }])) { // 서버가 가득 참 — 두 사람은 대기열에 그대로 둔다
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

  // ── 현황 · 종료 ──
  const queued = () => Object.values(queues).reduce((n, queue) => n + queue.length, 0); // 모든 등급의 대기 인원

  function clear() { // 서버를 닫을 때
    for (const queue of Object.values(queues)) queue.length = 0;
  }

  return { joinQueue, leaveQueue, onDisconnect, queued, clear };
}
