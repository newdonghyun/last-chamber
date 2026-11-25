// PvP 수신 가드 검증 (브라우저 없음 · 가짜 소켓): node tests/pvp-guard.test.mjs
//   pvpSession.js 는 인게임 이벤트(state_update · game_over · opponent_status · receive_emote · match_found · room_closed · session_replaced)를
//   ① 지금 세션이고 ② 닫히지 않았고 ③ 이벤트의 방 코드가 내 방과 같을 때만 처리한다 — 다른 방 · 코드 없는 · 끝난 판의 이벤트는 화면 갱신 · 도발 · 알림 없이 버린다.
const T0 = performance.now();
let pass = 0;
const fails = [];
const ok = (cond, name) => { if (cond) pass += 1; else { fails.push(name); console.log(`  ✗ ${name}`); } };
const eq = (got, want, name) => ok(JSON.stringify(got) === JSON.stringify(want), `${name} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`);

// pvpSession 이 쓰는 브라우저 전역만 흉내 (window · document 이벤트)
globalThis.window = new EventTarget();
globalThis.document = new EventTarget();
const { initPvp, pvpEnd, pvpOver, pvpMode, pvpEngine } = await import('../src/ui/pvpSession.js');

class FakeSocket {
  handlers = new Map();
  connected = true;
  sent = [];
  on(event, fn) { if (!this.handlers.has(event)) this.handlers.set(event, new Set()); this.handlers.get(event).add(fn); return this; }
  off(event, fn) { this.handlers.get(event)?.delete(fn); return this; }
  emit(event, ...args) { this.sent.push(event); return this; }
  timeout() { return this; }
  connect() {}
  disconnect() { this.connected = false; this.fire('disconnect', 'io client disconnect'); }
  fire(event, payload) { for (const fn of [...(this.handlers.get(event) ?? [])]) fn(payload); }
  count() { return [...this.handlers.values()].reduce((n, set) => n + set.size, 0); }
}

const calls = { start: 0, update: 0, notice: [] };
initPvp({
  profile: { activeLoadout: () => ({ gun: 'steel', table: 'obsidian', flame: 'native' }), spendBrass: () => ({ ok: true }) },
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

const ms = Math.round(performance.now() - T0);
console.log(fails.length === 0 ? `PASS  ${pass} checks, 0 failed — ${ms} ms` : `FAIL  ${pass} passed, ${fails.length} failed — ${ms} ms`);
process.exitCode = fails.length === 0 ? 0 : 1;
