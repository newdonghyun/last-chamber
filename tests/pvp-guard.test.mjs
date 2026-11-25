// PvP 수신 가드 검증 (브라우저 없음 · 가짜 소켓): node tests/pvp-guard.test.mjs
//   pvpSession.js 는 인게임 이벤트(state_update · game_over · opponent_status · receive_emote · match_found · room_closed · session_replaced)를
//   ① 지금 세션이고 ② 닫히지 않았고 ③ 이벤트의 방 코드가 내 방과 같을 때만 처리한다 — 다른 방 · 코드 없는 · 끝난 판의 이벤트는 화면 갱신 · 도발 · 알림 없이 버린다.
//   pvpPause() / pvpResume(): blur · freeze 때 소켓만 끊고(알림 · 재연결 시도 없음) 판은 유지 → 돌아오면 같은 소켓이 다시 붙어 rejoin_room 으로 자리를 되찾는다.
//   pvpSettle(): 서버 지갑이 정산한 판은 이 기기에서 다시 계산하지 않는다 (참가비 feePaid · 서버 보상 reward · 거울 wallet) · 무효 판(voided)은 MMR · 보상 없이 안내만.
//   pvpSurrender(): 항복 요청은 서버에 surrender 로만 보낸다 — 승패는 서버의 game_over(reason 'surrender')로만 정해지고, 끝난 판 · 연결 없음 · 시간 초과는 판을 건드리지 않는다.
const T0 = performance.now();
let pass = 0;
const fails = [];
const ok = (cond, name) => { if (cond) pass += 1; else { fails.push(name); console.log(`  ✗ ${name}`); } };
const eq = (got, want, name) => ok(JSON.stringify(got) === JSON.stringify(want), `${name} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`);

// pvpSession 이 쓰는 브라우저 전역만 흉내 (window · document 이벤트)
globalThis.window = new EventTarget();
globalThis.document = new EventTarget();
const { initPvp, pvpEnd, pvpOver, pvpMode, pvpEngine, pvpSurrender, pvpPause, pvpResume, pvpSettle } = await import('../src/ui/pvpSession.js');

class FakeSocket {
  handlers = new Map();
  connected = true;
  sent = [];
  payloads = [];
  disconnects = 0;
  connects = 0;
  acks = []; // emit 에 넘긴 ack 콜백 (테스트가 서버 답을 흉내 낸다)
  on(event, fn) { if (!this.handlers.has(event)) this.handlers.set(event, new Set()); this.handlers.get(event).add(fn); return this; }
  off(event, fn) { this.handlers.get(event)?.delete(fn); return this; }
  emit(event, ...args) { this.sent.push(event); this.payloads.push([event, args[0]]); if (typeof args.at(-1) === 'function') this.acks.push(args.at(-1)); return this; }
  timeout() { return this; }
  connect() { this.connected = true; this.connects += 1; }
  disconnect() { this.connected = false; this.disconnects += 1; this.fire('disconnect', 'io client disconnect'); }
  fire(event, payload) { for (const fn of [...(this.handlers.get(event) ?? [])]) fn(payload); }
  count() { return [...this.handlers.values()].reduce((n, set) => n + set.size, 0); }
}

const calls = { start: 0, update: 0, notice: [], spent: [], ranked: [], friendly: [], voided: [], adopted: [] };
initPvp({
  profile: {
    activeLoadout: () => ({ gun: 'steel', table: 'obsidian', flame: 'native' }),
    spendBrass: (n) => { calls.spent.push(n); return { ok: true }; },
    recordRanked: (won, opts) => { calls.ranked.push([won, opts]); return { mode: 'ranked', ranked: true, won, total: opts.brass ?? opts.reward ?? 0, brass: 100 }; },
    recordFriendly: (won, opts) => { calls.friendly.push([won, opts]); return { mode: 'friendly', ranked: false, won, total: opts.brass ?? opts.reward ?? 0, brass: 100 }; },
    recordVoided: (won, opts) => { calls.voided.push([won, opts]); return { mode: opts.ranked ? 'ranked' : 'friendly', won, total: 0, voided: opts.reason, brass: 100 }; },
    adoptWallet: (w) => { calls.adopted.push(w); return true; },
    get brass() { return 777; },
  },
  onStart: () => { calls.start += 1; },
  onUpdate: () => { calls.update += 1; },
  onNotice: (text) => calls.notice.push(text),
  onAbort: () => {},
});
const taunts = [];
document.addEventListener('lastchamber:taunt-in', (e) => taunts.push(e.detail));

const MY = 'MINE';
const OTHER = 'ZZZZ';
const state = (code, extra = {}) => ({
  code, logFrom: 0, events: [], deadline: 1000, now: 0,
  state: { round: 1, total: 3, live: 1, blank: 2, obscured: false, me: { id: 'P1', hp: 3, items: [] }, opponent: { id: 'P2', hp: 3, items: [] }, turn: { player: 'P1', isMine: true }, winner: null },
  ...extra,
});
const sock = new FakeSocket();
window.dispatchEvent(new CustomEvent('pvp:start', { detail: { match: { code: MY, mode: 'queue', ranked: true, tier: 'free', fee: 0, prize: 0, you: 'P1', token: 't', opponent: { id: 'P2', profile: {} } }, socket: sock } }));
eq(pvpMode(), 'ranked', '1 세션 시작 (랭킹전)');

// 다른 방 · 코드 없는 이벤트는 첫 상태조차 아니다
sock.fire('state_update', state(OTHER));
sock.fire('state_update', state(undefined));
eq(calls.start, 0, '1 다른 방(또는 방 코드 없는) state_update 로는 판을 열지 않는다');
sock.fire('state_update', state(MY));
eq(calls.start, 1, '1 내 방 state_update → 판 시작');

sock.fire('state_update', state(OTHER, { events: [{ type: 'SHOT', actor: 'P2', target: 'P1', shell: 'LIVE', damage: 1 }] }));
eq([calls.update, pvpEngine().getLog('player', 0).length], [0, 0], '2 다른 방의 격발 로그 → 화면 갱신 · 연출 없음');
sock.fire('state_update', state(MY, { events: [{ type: 'SHOT', actor: 'P2', target: 'P1', shell: 'BLANK', damage: 0 }] }));
eq([calls.update, pvpEngine().getLog('player', 0).length], [1, 1], '2 내 방 격발 로그 → 갱신 1번');

sock.fire('receive_emote', { type: 'TAUNT', id: 'knock', code: OTHER });
sock.fire('receive_emote', { type: 'TAUNT', id: 'knock' });
eq(taunts.length, 0, '3 다른 방 · 코드 없는 도발 → 연출 · 소리 없음');
sock.fire('receive_emote', { type: 'TAUNT', id: 'knock', code: MY });
eq(taunts, [{ type: 'TAUNT', id: 'knock' }], '3 내 방 도발 → 방 코드를 뗀 도발만 전달');

sock.fire('opponent_status', { code: OTHER, connected: false, graceMs: 15000 });
sock.fire('room_closed', { code: OTHER });
eq(calls.notice.length, 0, '4 다른 방의 상대 상태 · 방 닫힘 알림은 무시');
sock.fire('opponent_status', { code: MY, connected: false, graceMs: 15000 });
eq(calls.notice.length, 1, '4 내 방 상대 상태 → 알림');

sock.fire('game_over', { code: OTHER, youWon: false, payout: 0 });
sock.fire('session_replaced', { code: OTHER });
eq(pvpOver(), null, '5 다른 방의 game_over · session_replaced 로는 내 판이 끝나지 않는다');
sock.fire('game_over', { code: MY, youWon: true, payout: 0 });
eq(pvpOver()?.youWon, true, '5 내 방 game_over → 판 종료');

// 세션을 닫은 뒤(결과 화면 · 로비): 내 방 코드여도 아무것도 하지 않고 리스너도 남지 않는다
const before = { ...calls, notice: calls.notice.length, taunts: taunts.length };
pvpEnd();
eq(sock.count(), 0, '6 세션을 닫으면 소켓 리스너가 하나도 남지 않는다');
sock.fire('state_update', state(MY));
sock.fire('receive_emote', { type: 'TAUNT', id: 'knock', code: MY });
sock.fire('opponent_status', { code: MY, connected: true });
eq([calls.start, calls.update, calls.notice.length, taunts.length], [before.start, before.update, before.notice, before.taunts], '6 끝난 판의 늦은 이벤트 → 갱신 · 도발 · 알림 없음');

// 새 판이 시작되면 지난 판 소켓의 이벤트는 새 판에 섞이지 않는다
const sock2 = new FakeSocket();
window.dispatchEvent(new CustomEvent('pvp:start', { detail: { match: { code: 'NEW1', mode: 'private', ranked: false, tier: 'free', fee: 0, prize: 0, you: 'P2', token: 'u', opponent: { id: 'P1', profile: {} } }, socket: sock2 } }));
sock.fire('state_update', state(MY));
sock2.fire('state_update', state(MY));
eq([calls.start, pvpMode()], [before.start, 'friendly'], '7 새 판(친선전)에는 지난 판 · 다른 방 이벤트가 섞이지 않는다');
sock2.fire('state_update', state('NEW1'));
eq(calls.start, before.start + 1, '7 새 판의 내 방 이벤트만 판을 연다');
pvpEnd();

// 항복: 서버에 surrender 만 보낸다 — ack 는 접수 여부일 뿐, 승패는 game_over 로만
const sock3 = new FakeSocket();
window.dispatchEvent(new CustomEvent('pvp:start', { detail: { match: { code: 'SUR1', mode: 'public', ranked: true, tier: 'free', fee: 0, prize: 0, you: 'P1', token: 'v', opponent: { id: 'P2', profile: {} } }, socket: sock3 } }));
sock3.fire('state_update', state('SUR1'));
const pending = pvpSurrender();
eq(sock3.sent.filter((e) => e === 'surrender').length, 1, '8 항복 → 서버에 surrender 한 번');
sock3.acks.at(-1)(null, { ok: true });
eq(await pending, { ok: true }, '8 서버가 받아들이면 { ok: true }');
eq(pvpOver(), null, '8 ack 만으로는 판이 끝나지 않는다 (승패는 서버의 game_over 로만)');
sock3.fire('game_over', { code: 'OTHR', youWon: true, reason: 'surrender' });
eq(pvpOver(), null, '8 다른 방의 항복 결과는 내 판을 끝내지 않는다');
sock3.fire('game_over', { code: 'SUR1', youWon: false, payout: 0, reason: 'surrender', mmrDelta: -20, record: { wins: 0, losses: 1, games: 1, streak: 0, maxStreak: 0, mmr: 980 } });
eq([pvpOver()?.reason, pvpOver()?.youWon, pvpOver()?.mmrDelta, pvpOver()?.record?.mmr], ['surrender', false, -20, 980], '8 내 방 game_over(surrender) → 항복 패배 · 서버가 정산한 MMR 을 그대로 받는다');
const sentBefore = sock3.sent.length;
eq(await pvpSurrender(), { ok: false, error: 'NOT_IN_GAME' }, '8 이미 끝난 판에는 다시 항복하지 않는다');
sock3.fire('game_over', { code: 'SUR1', youWon: true, reason: 'normal' });
eq([pvpOver()?.reason, pvpOver()?.youWon, sock3.sent.length], ['surrender', false, sentBefore], '8 결과 화면은 한 번 — 늦게 온 두 번째 game_over 는 무시, 요청도 더 보내지 않는다');
pvpEnd();
eq(await pvpSurrender(), { ok: false, error: 'NOT_IN_GAME' }, '8 닫힌 세션에서는 NOT_IN_GAME');

const sock4 = new FakeSocket();
window.dispatchEvent(new CustomEvent('pvp:start', { detail: { match: { code: 'SUR2', mode: 'private', ranked: false, tier: 'free', fee: 0, prize: 0, you: 'P2', token: 'w', opponent: { id: 'P1', profile: {} } }, socket: sock4 } }));
sock4.fire('state_update', state('SUR2'));
sock4.connected = false;
eq([await pvpSurrender(), sock4.sent.includes('surrender')], [{ ok: false, error: 'OFFLINE' }, false], '8 연결이 없으면 OFFLINE — 요청도 보내지 않는다');
sock4.connected = true;
const late = pvpSurrender();
sock4.acks.at(-1)(new Error('operation has timed out'));
eq(await late, { ok: false, error: 'TIMEOUT' }, '8 서버가 답하지 않으면 TIMEOUT');
eq(pvpOver(), null, '8 TIMEOUT 이어도 판은 그대로 (결과는 서버만 정한다)');
const again = pvpSurrender();
sock4.acks.at(-1)(null, { ok: false, error: 'NOT_IN_GAME' });
eq(await again, { ok: false, error: 'NOT_IN_GAME' }, '8 서버가 이미 끝난 판이라고 하면 그대로 전달 (동시 항복 · 상대가 먼저 끝냄)');
pvpEnd();

// 화면을 떠남(blur · freeze): 소켓만 끊고 판은 유지 → 돌아오면 같은 소켓으로 다시 붙어 자리를 되찾는다
const sock5 = new FakeSocket();
window.dispatchEvent(new CustomEvent('pvp:start', { detail: { match: { code: 'PAU1', mode: 'queue', ranked: true, tier: 'free', fee: 0, prize: 0, you: 'P1', token: 'tok5', opponent: { id: 'P2', profile: {} } }, socket: sock5 } }));
sock5.fire('state_update', state('PAU1'));
const noticed = calls.notice.length;
pvpPause();
eq([sock5.connected, sock5.disconnects, calls.notice.length - noticed], [false, 1, 0], '9 pvpPause → 소켓 disconnect · 일부러 끊은 것이라 "끊어졌습니다" 알림 없음');
eq([pvpOver(), pvpMode()], [null, 'ranked'], '9 끊어도 판(세션)은 그대로');
pvpPause();
eq(sock5.disconnects, 1, '9 이미 끊었으면 다시 끊지 않는다');
eq(await pvpSurrender(), { ok: false, error: 'OFFLINE' }, '9 끊긴 동안 항복 · 행동은 OFFLINE (서버에 보내지 않는다)');
pvpResume();
eq([sock5.connected, sock5.connects], [true, 1], '9 pvpResume → 같은 소켓을 다시 연결');
pvpResume();
eq(sock5.connects, 1, '9 이미 이었으면 다시 잇지 않는다');
sock5.fire('connect');
eq(sock5.payloads.filter(([e]) => e === 'rejoin_room').at(-1)?.[1], { code: 'PAU1', token: 'tok5' }, '9 연결되면 rejoin_room(방 코드 · 좌석 토큰)으로 자리를 되찾는다');
sock5.acks.at(-1)({ ok: true }); // rejoin_room 은 timeout() 없이 보내므로 ack 는 (res) 하나
eq([calls.notice.at(-1), pvpOver()], ['다시 연결되었습니다.', null], '9 자리를 되찾으면 알림 · 판 계속');

pvpPause();
pvpResume();
sock5.fire('connect');
sock5.acks.at(-1)({ ok: false, error: 'ROOM_NOT_FOUND' });
eq([pvpOver()?.reason, pvpOver()?.youWon], ['disconnect', false], '9 유예가 지나 자리를 잃었으면 부전패로 끝 (기존 재접속 규칙 그대로)');
pvpPause();
eq(sock5.disconnects, 2, '9 끝난 판은 더 끊지 않는다');
pvpEnd();
pvpResume();
eq(sock5.connects, 2, '9 닫힌 세션은 다시 잇지 않는다');

// 서버 지갑이 정산한 판: 참가비는 서버가 이미 받았고(feePaid) 보상 · 지갑도 서버 값
const startMatch = (code, extra = {}) => {
  const socket = new FakeSocket();
  window.dispatchEvent(new CustomEvent('pvp:start', { detail: { match: { code, mode: 'queue', ranked: true, tier: 'pro', fee: 200, prize: 360, feePaid: true, you: 'P1', token: 'tk', opponent: { id: 'P2', profile: {} }, ...extra }, socket } }));
  socket.fire('state_update', state(code));
  return socket;
};
{
  const spentBefore = calls.spent.length;
  const sockA = startMatch('PAY1');
  eq(calls.spent.length, spentBefore, '10 feePaid 이면 이 기기에서 참가비를 또 내지 않는다');
  sockA.fire('game_over', { code: 'PAY1', youWon: true, payout: 360, reason: 'surrender', mmrDelta: 25, record: { nickname: 'a', wins: 1, losses: 0, games: 1, streak: 1, maxStreak: 1, mmr: 1025 }, voided: null, reward: { brass: 0, refunded: 0 }, wallet: { brass: 460 } });
  const outA = await pvpSettle(true);
  eq([calls.ranked.at(-1)[1].brass, calls.ranked.at(-1)[1].reward, calls.adopted.at(-1), outA.brass], [360, null, { brass: 460 }, 777], '10 판돈 테이블: 서버 상금(360)을 쓰고, 정산 뒤 서버 지갑으로 거울을 맞춘다 (표시 탄피는 거울 값)');

  startMatch('PAY2', { fee: 0, prize: 0, tier: 'free' }).fire('game_over', { code: 'PAY2', youWon: true, payout: 0, reason: 'normal', mmrDelta: 25, record: null, voided: null, reward: { brass: 180, refunded: 0 }, wallet: { brass: 480 } });
  await pvpSettle(true);
  eq([calls.ranked.at(-1)[1].brass, calls.ranked.at(-1)[1].reward, calls.adopted.at(-1)], [null, 180, { brass: 480 }], '10 무료 랭킹전: 서버가 지급한 보상(180)을 그대로 보여 준다 (연승 보너스 포함 — 기기가 다시 계산하지 않음)');

  startMatch('PAY3', { fee: 0, prize: 0, tier: 'free', mode: 'private', ranked: false }).fire('game_over', { code: 'PAY3', youWon: false, payout: 0, reason: 'normal', voided: null, reward: { brass: 40, refunded: 0 }, wallet: { brass: 340 } });
  await pvpSettle(false);
  eq([calls.friendly.at(-1)[1].reward, calls.adopted.at(-1)], [40, { brass: 340 }], '10 친선전도 서버 보상');

  const rankedBefore = calls.ranked.length;
  startMatch('VOID1').fire('game_over', { code: 'VOID1', youWon: true, payout: 0, reason: 'surrender', voided: 'EARLY_END', reward: { brass: 0, refunded: 200 }, wallet: { brass: 300 } });
  const outV = await pvpSettle(true);
  eq([outV.voided, outV.refunded, calls.ranked.length, calls.voided.at(-1), calls.adopted.at(-1)], ['EARLY_END', 200, rankedBefore, [true, { ranked: true, reason: 'EARLY_END' }], { brass: 300 }], '10 조기 종료(무효): recordRanked 를 부르지 않고(MMR · 보상 없음) 환불된 지갑으로 맞춘다');

  startMatch('VOID2', { fee: 0, prize: 0, tier: 'free' }).fire('game_over', { code: 'VOID2', youWon: false, payout: 0, reason: 'normal', voided: 'PAIR_LIMIT', reward: { brass: 0, refunded: 0 }, wallet: { brass: 300 } });
  eq((await pvpSettle(false)).voided, 'PAIR_LIMIT', '10 같은 상대 하루 3판 초과(무효)도 같은 방식');

  // 서버 지갑을 안 쓰는 접속(예전 방식): 참가비는 이 기기가 내고 보상도 이 기기가 계산한다
  const spent0 = calls.spent.length;
  const old = startMatch('OLD1', { feePaid: false });
  eq(calls.spent.length, spent0 + 1, '10 feePaid 가 아니면 예전처럼 기기에서 참가비를 낸다');
  old.fire('game_over', { code: 'OLD1', youWon: true, payout: 360, reason: 'normal', mmrDelta: 25, record: null });
  const adoptedBefore = calls.adopted.length;
  await pvpSettle(true);
  eq([calls.ranked.at(-1)[1].brass, calls.ranked.at(-1)[1].reward, calls.adopted.length], [360, null, adoptedBefore], '10 서버 지갑이 정산하지 않은 판은 예전 방식 (거울 맞춤 없음)');
}

const ms = Math.round(performance.now() - T0);
console.log(fails.length === 0 ? `PASS  ${pass} checks, 0 failed — ${ms} ms` : `FAIL  ${pass} passed, ${fails.length} failed — ${ms} ms`);
process.exitCode = fails.length === 0 ? 0 : 1;
