// 멀티플레이 서버 검증 (브라우저 없음): node tests/server.test.mjs   — socket.io-client 로 서버를 실제로 때려 본다. 5초 안에 끝난다.
//   Phase 1 (기본 서버, 클라이언트 2개): 방 생성 → 입장 → 격발 1회 · 치트 시도 거절 · 이모트 중계 · 항복 · 무작위 매칭(pro) · 정적 파일
//   Phase 2 (타이머를 줄인 서버): 20초 턴 타임아웃 강제 격발 · 연결 끊김 부전승 · 재접속 · 새 연결의 자리 인수
//   Phase 3 (유저 기록 파일을 쓰는 서버): 로그인(handshake auth · hello) · 닉네임 규칙 · 서버가 확인한 닉네임으로 상대에게 표시 · 서버 전적 기록 · 파일 저장/복원
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { io as connect } from 'socket.io-client';
import { createGameServer, QUEUE_TIERS } from '../server/index.js';

const T0 = performance.now();
let pass = 0;
const fails = [];
const serverErrors = [];
const clientErrors = [];
const ok = (cond, name) => { if (cond) pass += 1; else { fails.push(name); console.log(`  ✗ ${name}`); } };
const eq = (got, want, name) => ok(JSON.stringify(got) === JSON.stringify(want), `${name} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const onError = (err) => serverErrors.push(err);

const allSockets = [];
async function client(port, auth) { // auth = { userId, nickname } 이면 로그인한 클라이언트 (handshake auth)
  const socket = connect(`http://127.0.0.1:${port}`, { transports: ['websocket'], reconnection: false, forceNew: true, ...(auth ? { auth } : {}) });
  const inbox = []; // 받은 이벤트를 전부 쌓아 둔다 → 이벤트가 리스너보다 먼저 도착해도 놓치지 않는다
  socket.onAny((event, payload) => inbox.push({ event, payload }));
  socket.on('connect_error', (err) => clientErrors.push(`connect_error: ${err.message}`));
  allSockets.push(socket);
  await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('connect_error', reject); });
  return {
    socket,
    inbox,
    call: (event, payload) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`ack 시간 초과: ${event}`)), 2000);
      const done = (res) => { clearTimeout(timer); resolve(res); };
      if (payload === undefined) socket.emit(event, done);
      else socket.emit(event, payload, done);
    }),
    waitFor: (event, pred = () => true, ms = 2000) => new Promise((resolve, reject) => {
      const find = () => inbox.find((m) => m.event === event && pred(m.payload));
      const hit = find();
      if (hit) { resolve(hit.payload); return; }
      const timer = setTimeout(() => { socket.offAny(listener); reject(new Error(`이벤트 시간 초과: ${event}`)); }, ms);
      const listener = () => {
        const found = find();
        if (!found) return;
        clearTimeout(timer);
        socket.offAny(listener);
        resolve(found.payload);
      };
      socket.onAny(listener);
    }),
  };
}

const head = (port, urlPath) => new Promise((resolve, reject) => {
  const req = http.request({ host: '127.0.0.1', port, path: urlPath, method: 'HEAD', agent: false }, (res) => { res.resume(); resolve(res.statusCode); });
  req.on('error', reject);
  req.end();
});

async function phase1() {
  const server = createGameServer({ quiet: true, onError });
  const port = await server.start(0, '127.0.0.1');
  eq([QUEUE_TIERS.free, QUEUE_TIERS.pro, QUEUE_TIERS.vip], [{ fee: 0, prize: 0 }, { fee: 200, prize: 360 }, { fee: 1000, prize: 1800 }], '등급표: free 0 · pro 200→360 · vip 1000→1800');
  const A = await client(port);
  const B = await client(port);
  const profA = { nickname: '알파', mmr: 1100, tier: 'silver', title: '신입', cosmetics: { gun: 'gold', table: 'obsidian', flame: 'native' } };
  const profB = { nickname: 'Bravo_7', mmr: 900, cosmetics: { gun: '<img src=x onerror=alert(1)>', table: 'obsidian' } }; // 나쁜 id 는 걸러져야 한다

  // 1. 방 생성
  const created = await A.call('create_private_room', { profile: profA });
  ok(created.ok && /^[A-HJ-NP-Z2-9]{4}$/.test(created.code), `1 사설 방 코드는 4자리 영문/숫자 (${created.code})`);
  eq((await A.waitFor('room_created')).code, created.code, '1 room_created 이벤트도 같은 코드');
  eq((await A.call('create_private_room', { profile: profA })).error, 'ALREADY_IN_ROOM', '1 이미 방에 있으면 또 만들 수 없다');
  eq((await B.call('join_private_room', 'ZZZZ')).error, 'ROOM_NOT_FOUND', '1 없는 코드는 거절');

  // 2. 입장 (소문자 코드도 통과) → 두 사람 모두 match_found
  const joined = await B.call('join_private_room', { code: created.code.toLowerCase(), profile: profB });
  eq([joined.ok, joined.code], [true, created.code], '2 입장 성공');
  const [mA, mB] = await Promise.all([A.waitFor('match_found'), B.waitFor('match_found')]);
  eq([mA.mode, mA.tier, mA.fee, mA.prize, mA.code], ['private', 'free', 0, 0, created.code], '2 사설 방은 무료 판');
  eq([mA.you, mB.you].sort(), ['P1', 'P2'], '2 서로 다른 좌석');
  eq([mA.opponent.id, mB.opponent.id], [mB.you, mA.you], '2 상대 좌석 id');
  eq([mA.opponent.profile.nickname, mA.opponent.profile.mmr], ['Bravo_7', 900], '2 A 가 보는 상대 프로필(B)');
  eq(mA.opponent.profile.cosmetics, { gun: null, table: 'obsidian', flame: null, taunt: null }, '2 위험한 코스메틱 id 는 걸러진다');
  eq(mB.opponent.profile, { nickname: '알파', mmr: 1100, tier: 'silver', title: '신입', cosmetics: { gun: 'gold', table: 'obsidian', flame: 'native', taunt: null } }, '2 B 가 보는 상대 프로필(A)');
  ok(mA.token.length === 32 && mB.token.length === 32 && mA.token !== mB.token, '2 재접속 토큰은 각자 따로');
  eq(await B.call('join_private_room', created.code), { ok: false, error: 'ALREADY_IN_ROOM' }, '2 이미 시작된 방에 또 들어갈 수 없다');

  // 3. 첫 상태: 각자 자기 시점만, 탄 순서는 없다
  const [sA, sB] = await Promise.all([A.waitFor('state_update', (p) => p.reason === 'start'), B.waitFor('state_update', (p) => p.reason === 'start')]);
  eq([sA.state.me.id, sA.state.opponent.id], [mA.you, mB.you], '3 A 시점 상태');
  eq([sB.state.me.id, sB.state.opponent.id], [mB.you, mA.you], '3 B 시점 상태');
  eq([sA.state.turn.isMine, sB.state.turn.isMine].filter(Boolean).length, 1, '3 선공은 정확히 한 명');
  ok(sA.state.total >= 3 && sA.state.live + sA.state.blank === sA.state.total, `3 실탄 + 공포탄 = 총 발수 (${sA.state.live}+${sA.state.blank}=${sA.state.total}) — 개수만 공개`);
  ok(!('chamber' in sA.state) && !('chamber' in sB.state), '3 상태에 탄창 필드가 없다');
  ok(![sA, sB].some((p) => /"(LIVE|BLANK)"/.test(JSON.stringify(p))), '3 시작 페이로드에 탄종이 없다');
  ok(sA.deadline > sA.now && sA.deadline - sA.now <= 20_000, '3 턴 마감 시각(서버 시계)이 함께 온다');
  eq(sA.logFrom, 0, '3 로그는 0 부터');

  // 4. 격발 1회
  const actor = sA.state.turn.isMine ? A : B;
  const waiter = actor === A ? B : A;
  const actorSeat = actor === A ? mA.you : mB.you;
  const waiterSeat = actor === A ? mB.you : mA.you;
  eq(await actor.call('game_action', { type: 'shoot', target: 'opponent' }), { ok: true }, '4 격발 ack');
  const [uA, uB] = await Promise.all([A.waitFor('state_update', (p) => p.reason === 'shoot'), B.waitFor('state_update', (p) => p.reason === 'shoot')]);
  ok([uA, uB].every((u) => u.events.some((e) => e.type === 'SHOT' && e.actor === actorSeat)), '4 양쪽 모두 SHOT 이벤트를 받는다');
  eq([uA.by, uB.by], [actorSeat, actorSeat], '4 누가 쐈는지 알려 준다');
  eq([uA.state.total, uB.state.total], [sA.state.total - 1, sA.state.total - 1], '4 남은 탄 −1');
  eq([uA.state.turn.player, uB.state.turn.player], [waiterSeat, waiterSeat], '4 상대에게 쏘면 턴이 넘어간다');
  eq([uA.state.me.hp, uA.state.opponent.hp], [uB.state.opponent.hp, uB.state.me.hp], '4 두 시점의 체력이 서로 맞물린다');
  eq([uA.logFrom, uB.logFrom], [sA.events.length, sB.events.length], '4 로그 커서가 이어진다');
  ok(uA.deadline >= sA.deadline, '4 격발 뒤 턴 마감이 새로 계산된다');

  // 5. 치트 시도는 상태를 바꾸지 않고 거절된다
  eq(await actor.call('game_action', { type: 'shoot', target: 'opponent' }), { ok: false, error: 'NOT_YOUR_TURN' }, '5 내 턴이 아닐 때 격발');
  eq(await actor.call('game_action', { type: 'shoot', target: 'self', playerId: waiterSeat }), { ok: false, error: 'NOT_YOUR_TURN' }, '5 남의 좌석 id 를 실어 보내도 소용없다');
  eq(await actor.call('game_action', { type: 'use_item', index: 0 }), { ok: false, error: 'NOT_YOUR_TURN' }, '5 내 턴이 아닐 때 아이템');
  eq(await waiter.call('game_action', { type: 'shoot', target: 'moon' }), { ok: false, error: 'INVALID_TARGET' }, '5 잘못된 대상');
  eq(await waiter.call('game_action', { type: 'use_item', index: 99 }), { ok: false, error: 'INVALID_ITEM' }, '5 잘못된 아이템 칸');
  eq(await waiter.call('game_action', { type: 'fly' }), { ok: false, error: 'INVALID_ACTION' }, '5 모르는 액션');
  eq(await waiter.call('game_action', 'shoot'), { ok: false, error: 'BAD_REQUEST' }, '5 객체가 아닌 액션');

  // 6. 이모트: 그대로 중계, 이상한 값·연타는 거절
  const emote = { type: 'TAUNT', id: 'knock' };
  const relayed = A.waitFor('receive_emote');
  eq(await B.call('send_emote', emote), { ok: true }, '6 이모트 ack');
  eq(await relayed, emote, '6 상대에게 그대로 중계');
  eq((await B.call('send_emote', emote)).error, 'RATE_LIMITED', '6 0.5초 안의 연타는 거절');
  eq((await B.call('send_emote', { type: 'TAUNT', id: { evil: true } })).error, 'BAD_REQUEST', '6 중첩 객체는 거절');
  eq((await B.call('send_emote', 'knock')).error, 'BAD_REQUEST', '6 객체가 아니면 거절');

  // 7. 나가면 항복 → 상대 부전승
  const overA = A.waitFor('game_over');
  const overB = B.waitFor('game_over');
  eq(await B.call('leave_room'), { ok: true }, '7 leave_room ack');
  const [goA, goB] = await Promise.all([overA, overB]);
  eq([goA.youWon, goA.reason, goA.winner, goA.payout], [true, 'forfeit', mA.you, 0], '7 남은 사람이 부전승 (무료 판 = 상금 0)');
  eq([goB.youWon, goB.payout], [false, 0], '7 나간 사람은 패배');
  eq(await B.call('game_action', { type: 'shoot', target: 'opponent' }), { ok: false, error: 'NOT_IN_GAME' }, '7 끝난 판에는 입력할 수 없다');

  // 8. 무작위 매칭: 같은 등급 2명 → 자동 방 생성, 승자 상금
  eq((await A.call('join_queue', { tier: 'gold' })).error, 'INVALID_TIER', '8 없는 등급');
  eq(await A.call('join_queue', { tier: 'pro', profile: profA }), { ok: true, tier: 'pro', fee: 200, prize: 360 }, '8 대기열 입장');
  eq((await A.call('join_queue', { tier: 'free' })).error, 'ALREADY_IN_ROOM', '8 대기 중에는 다른 대기열에 못 들어간다');
  eq(server.stats().queued, 1, '8 대기 인원 1');
  eq(await A.call('leave_queue'), { ok: true }, '8 leave_queue');
  eq(server.stats().queued, 0, '8 대기열에서 빠졌다');
  await A.call('join_queue', { tier: 'pro', profile: profA });
  await B.call('join_queue', { tier: 'pro', profile: profB });
  const [qA, qB] = await Promise.all([A.waitFor('match_found', (p) => p.mode === 'queue'), B.waitFor('match_found', (p) => p.mode === 'queue')]);
  eq([qA.tier, qA.fee, qA.prize, qB.fee, qB.prize], ['pro', 200, 360, 200, 360], '8 매칭된 pro 판: 참가비 200 · 승자 360');
  ok(qA.code !== created.code && qA.code === qB.code, '8 두 사람이 같은 새 방');
  const sniper = await client(port);
  eq((await sniper.call('join_private_room', qA.code)).error, 'ROOM_NOT_FOUND', '8 매칭 방은 코드로 들어올 수 없다');
  const overQ = B.waitFor('game_over', (p) => p.code === qA.code);
  await A.call('leave_room');
  const goQ = await overQ;
  eq([goQ.youWon, goQ.payout, goQ.prize, goQ.reason], [true, 360, 360, 'forfeit'], '8 승자는 pro 상금 360');
  eq(server.stats().playing, 0, '8 진행 중인 판 없음');

  // 9. 정적 파일: 프로젝트 루트는 서빙, 서버 내부 경로는 숨김
  eq(await head(port, '/healthz'), 200, '9 /healthz');
  eq(await head(port, '/index.html'), 200, '9 /index.html');
  eq(await head(port, '/src/engine/gameEngine.js'), 200, '9 /src/engine/gameEngine.js');
  for (const hidden of ['/server/index.js', '/package.json', '/package-lock.json', '/tests/server.test.mjs', '/node_modules/express/package.json', '/%73erver/index.js', '/./server/index.js', '/x/../server/index.js', '/Server./index.js']) {
    eq(await head(port, hidden), 404, `9 숨김 경로 ${hidden}`);
  }
  await server.stop();
}

async function phase2() {
  const server = createGameServer({ quiet: true, turnMs: 250, graceMs: 400, onError });
  const port = await server.start(0, '127.0.0.1');
  const mk = async (name) => {
    const [x, y] = [await client(port), await client(port)];
    const made = await x.call('create_private_room', { profile: { nickname: `${name}1` } });
    const joined = await y.call('join_private_room', made.code); // 스펙 형태: join_private_room(code)
    const [mx, my] = await Promise.all([x.waitFor('match_found'), y.waitFor('match_found')]);
    return { x, y, mx, my, joined, code: made.code };
  };

  // 10. 턴 타임아웃: 아무도 안 쏘면 서버가 대신 격발
  const g1 = await mk('타임');
  eq(g1.joined.ok, true, '10 join_private_room(code) 문자열 형태');
  eq(g1.mx.opponent.profile.nickname, '방랑자', '10 프로필 없이 들어오면 기본 닉네임');
  eq([g1.mx.turnMs, g1.mx.graceMs], [250, 400], '10 match_found 가 시간 규칙을 알려 준다');
  const first = await g1.x.waitFor('state_update', (p) => p.reason === 'start');
  const timeout = await g1.x.waitFor('state_update', (p) => p.reason === 'timeout', 1500);
  ok(timeout.events.some((e) => e.type === 'SHOT'), '10 타임아웃 → 서버가 대신 격발 (SHOT 이벤트)');
  eq(timeout.by, first.state.turn.player, '10 격발한 쪽은 그 턴의 주인');
  ok(['self', 'opponent'].includes(timeout.auto.target), `10 강제 격발 대상 = ${timeout.auto.target}`);
  ok(timeout.deadline > first.deadline, '10 타임아웃 뒤 턴 마감이 새로 계산된다');
  ok((await g1.y.waitFor('state_update', (p) => p.reason === 'timeout')).events.some((e) => e.type === 'SHOT'), '10 상대도 같은 타임아웃 갱신을 받는다');

  // 11. 연결 끊김 → 15초(여기서는 0.4초)가 지나면 부전승
  const gone = g1.x.waitFor('opponent_status', (p) => p.connected === false);
  const cut = Date.now();
  g1.y.socket.disconnect();
  eq((await gone).graceMs, 400, '11 상대에게 끊김과 유예 시간을 알린다');
  const over = await g1.x.waitFor('game_over', undefined, 1500);
  const waited = Date.now() - cut;
  eq([over.youWon, over.reason, over.winner], [true, 'forfeit', g1.mx.you], '11 유예가 지나면 남은 사람의 부전승');
  ok(waited >= 350 && waited < 1200, `11 유예 시간(0.4초)을 기다린 뒤에 처리 (${waited}ms)`);

  // 12. 재접속: 위조 토큰은 거절, 진짜 토큰이면 같은 자리로 복귀하고 부전승은 취소
  const g2 = await mk('복귀');
  g2.y.socket.disconnect();
  await g2.x.waitFor('opponent_status', (p) => p.connected === false);
  const intruder = await client(port);
  eq(await intruder.call('rejoin_room', { code: g2.code, token: 'f'.repeat(32) }), { ok: false, error: 'ROOM_NOT_FOUND' }, '12 위조 토큰은 거절');
  const back = await client(port);
  eq((await back.call('rejoin_room', { code: g2.code, token: g2.my.token })).ok, true, '12 진짜 토큰으로 재접속');
  const [rm, rs] = await Promise.all([back.waitFor('match_found'), back.waitFor('state_update', (p) => p.reason === 'rejoin')]);
  eq([rm.resume, rm.you, rm.token], [true, g2.my.you, g2.my.token], '12 같은 좌석 · 같은 토큰으로 복귀');
  ok(rs.logFrom === 0 && rs.events.length > 0 && rs.state.me.id === g2.my.you, '12 로그 전체와 내 시점 상태를 다시 받는다');
  await g2.x.waitFor('opponent_status', (p) => p.connected === true);
  const acted = await back.call('game_action', { type: 'shoot', target: 'self' });
  ok(acted.ok || acted.error === 'NOT_YOUR_TURN', `12 새 연결이 그 좌석으로 입력할 수 있다 (${acted.ok ? 'ok' : acted.error})`);
  await sleep(550); // 유예(0.4초)보다 길게
  ok(!g2.x.inbox.some((m) => m.event === 'game_over'), '12 재접속했다면 유예가 지나도 부전승은 없다');

  // 13. 옛 연결이 아직 살아 있어도 새 연결이 자리를 넘겨받는다 (모바일에서 망이 바뀐 경우)
  const takeover = await client(port);
  const replaced = back.waitFor('session_replaced');
  eq((await takeover.call('rejoin_room', { code: g2.code, token: g2.my.token })).ok, true, '13 새 연결로 재접속');
  await replaced;
  ok(true, '13 옛 연결은 session_replaced 를 받는다');
  await takeover.waitFor('state_update', (p) => p.reason === 'rejoin');
  await sleep(100);
  ok(!g2.x.inbox.some((m) => m.event === 'game_over'), '13 자리를 넘겨도 부전승이 아니다');
  const overTake = g2.x.waitFor('game_over');
  await takeover.call('leave_room');
  eq([(await overTake).youWon, (await overTake).reason], [true, 'forfeit'], '13 새 연결이 나가면 상대 부전승');
  const lateJoin = await client(port);
  const lateOver = lateJoin.waitFor('game_over', undefined, 1000);
  eq((await lateJoin.call('rejoin_room', { code: g2.code, token: g2.my.token })).over, true, '13 끝난 판에 늦게 돌아오면 결과만 다시 받는다');
  eq((await lateOver).youWon, false, '13 늦게 온 사람은 패자로 확인');
  await server.stop();
}

async function phase3() {
  const dir = mkdtempSync(join(tmpdir(), 'lastchamber-users-'));
  const file = join(dir, 'users.json');
  const server = createGameServer({ quiet: true, onError, userDataFile: file, userSaveDelayMs: 20 });
  const port = await server.start(0, '127.0.0.1');
  const idA = randomUUID();
  const idB = randomUUID();
  const meA = { userId: idA, nickname: '총잡이' };

  // 14. 로그인: handshake auth 로 등록 · hello 로 서버 전적 · 규칙에 안 맞으면 거절 (연결은 끊지 않는다)
  const A = await client(port, meA);
  const B = await client(port, { userId: idB, nickname: 'Ace_7' });
  eq(server.stats().users, 2, '14 handshake auth 로 유저 2명 등록');
  eq(server.stats().storage, 'file', '14 /healthz: Supabase 키가 없으면 파일 저장');
  eq(await A.call('hello', meA), { ok: true, user: { nickname: '총잡이', wins: 0, losses: 0, games: 0, streak: 0, maxStreak: 0, mmr: 1000 } }, '14 hello → 서버에 기록된 내 전적');
  eq((await A.call('hello', { userId: idA, nickname: '총 잡이' })).error, 'INVALID_NICKNAME', '14 공백이 든 닉네임은 거절');
  eq((await A.call('hello', { userId: idA, nickname: '총' })).error, 'INVALID_NICKNAME', '14 1자 닉네임은 거절');
  eq((await A.call('hello', { userId: idA, nickname: '열한글자짜리닉네임이요' })).error, 'INVALID_NICKNAME', '14 11자 닉네임은 거절');
  eq((await A.call('hello', { userId: idA, nickname: 'ㅤㅤ' })).error, 'INVALID_NICKNAME', '14 보이지 않는 채움 문자 닉네임은 거절');
  eq((await A.call('hello', { userId: 'not-a-uuid', nickname: '총잡이' })).error, 'BAD_REQUEST', '14 UUID 가 아닌 유저 ID 는 거절');
  const C = await client(port, { userId: 'x', nickname: '익명' }); // 틀린 auth → 익명으로 연결
  ok(C.socket.connected && server.stats().users === 2, '14 틀린 auth 는 익명 소켓으로 받고 기록하지 않는다');

  // 랭킹전(무작위 매칭 '무료 테이블') 한 판 잡기 — 이미 본 방 코드는 건너뛴다
  const seenCodes = new Set();
  const queueMatch = async (X, Y, profileX = {}, profileY = {}) => {
    await X.call('join_queue', { tier: 'free', profile: profileX });
    await Y.call('join_queue', { tier: 'free', profile: profileY });
    const mX = await X.waitFor('match_found', (p) => p.mode === 'queue' && !seenCodes.has(p.code));
    seenCodes.add(mX.code);
    return [mX, await Y.waitFor('match_found', (p) => p.code === mX.code)];
  };

  // 15. 랭킹전(무작위 매칭): 상대에게는 서버가 확인한 닉네임 (프로필로 다른 이름을 보내도) · 유저 ID 는 상대에게 가지 않는다 · 판이 끝나면 서버 전적 기록
  const [mA, mB] = await queueMatch(A, B, { nickname: '가짜이름', mmr: 1200 }, { nickname: 'Ace_7', mmr: 1000 });
  eq([mA.mode, mA.ranked, mB.ranked], ['queue', true, true], '15 무작위 매칭 = 랭킹전 (match_found.ranked)');
  eq([mB.opponent.profile.nickname, mA.opponent.profile.nickname], ['총잡이', 'Ace_7'], '15 상대 이름표에는 로그인한 닉네임');
  ok(![mA, mB].some((m) => JSON.stringify(m).includes(idA) || JSON.stringify(m).includes(idB)), '15 유저 ID 는 match_found 어디에도 실리지 않는다');
  const [overA, overB] = [A.waitFor('game_over', (p) => p.code === mA.code), B.waitFor('game_over', (p) => p.code === mA.code)];
  await B.call('leave_room');
  const [goA, goB] = await Promise.all([overA, overB]);
  eq(goA.record, { nickname: '총잡이', wins: 1, losses: 0, games: 1, streak: 1, maxStreak: 1, mmr: 1025 }, '15 승자: 1승 · 1연승 · MMR +25');
  eq(goB.record, { nickname: 'Ace_7', wins: 0, losses: 1, games: 1, streak: 0, maxStreak: 0, mmr: 980 }, '15 패자: 1패 · 연승 0 · MMR −20');
  eq([goA.ranked, goA.mmrDelta, goB.ranked, goB.mmrDelta], [true, 25, true, -20], '15 game_over: 랭킹전 · 서버가 기록한 이번 판 MMR 변동');

  // 15-b. 친선전(방 코드 대전): 끝까지 가도 서버 MMR · 전적 · 연승은 그대로 (지인끼리 점수 몰아주기 방지)
  const friendly = await A.call('create_private_room', { profile: {} });
  await B.call('join_private_room', friendly.code);
  const [fA] = await Promise.all([A.waitFor('match_found', (p) => p.code === friendly.code), B.waitFor('match_found', (p) => p.code === friendly.code)]);
  eq([fA.mode, fA.ranked], ['private', false], '15 방 코드 대전 = 친선전 (ranked: false)');
  const [fOverA, fOverB] = [A.waitFor('game_over', (p) => p.code === friendly.code), B.waitFor('game_over', (p) => p.code === friendly.code)];
  await A.call('leave_room'); // A 항복 → B 승
  const [fgA, fgB] = await Promise.all([fOverA, fOverB]);
  eq([fgA.ranked, 'mmrDelta' in fgA, fgA.record?.mmr, fgA.record?.losses, fgB.youWon, fgB.record?.mmr, fgB.record?.wins], [false, false, 1025, 0, true, 980, 0], '15 친선전 결과는 서버 MMR · 전적에 넣지 않는다');

  // 16. 익명 상대와의 랭킹전은 로그인한 쪽만 · 같은 유저끼리(창 두 개) 둔 판은 세지 않는다
  const [vsAnon] = await queueMatch(A, C);
  const [overA2, overC] = [A.waitFor('game_over', (p) => p.code === vsAnon.code), C.waitFor('game_over', (p) => p.code === vsAnon.code)];
  await C.call('leave_room');
  const [goA2, goC] = await Promise.all([overA2, overC]);
  eq([goA2.record?.wins, 'record' in goC], [2, false], '16 익명 상대 — 로그인한 쪽만 기록되고 익명에게는 record 가 없다');
  const A2 = await client(port, meA);
  const [self] = await queueMatch(A, A2);
  const overSelf = A.waitFor('game_over', (p) => p.code === self.code);
  await A2.call('leave_room');
  eq((await overSelf).record, { nickname: '총잡이', wins: 2, losses: 0, games: 2, streak: 2, maxStreak: 2, mmr: 1050 }, '16 같은 유저끼리 둔 판은 전적에 넣지 않는다');

  // 17. 닉네임 변경 (hello) · 대기열 · 판 도중에는 다른 유저 ID 로 못 바꾼다 · 랭킹
  eq((await B.call('hello', { userId: idB, nickname: '에이스' })).user, { nickname: '에이스', wins: 0, losses: 1, games: 1, streak: 0, maxStreak: 0, mmr: 980 }, '17 hello 로 닉네임 변경 — 전적은 그대로');
  const board = await A.call('get_leaderboard');
  eq(board.top.map((r) => [r.rank, r.nickname, r.mmr, r.isMe]), [[1, '총잡이', 1050, true], [2, '에이스', 980, false]], '17 get_leaderboard: mmr 내림차순 · 내 줄 표시');
  eq([board.me?.nickname, board.me?.mmr], ['총잡이', 1050], '17 get_leaderboard: 내 전적');
  ok(!JSON.stringify(board).includes(idA) && !JSON.stringify(board).includes(idB) && !JSON.stringify(board).includes('user_id'), '17 랭킹 응답에 유저 ID 가 없다');
  eq((await C.call('get_leaderboard')).me, null, '17 익명 소켓은 내 전적 없이 랭킹만');
  const idD = randomUUID();
  const D = await client(port, { userId: idD, nickname: '구경꾼' }); // 로비에만 들렀다 간 계정 (랭킹전 0판 · 1000점)
  const boardD = await D.call('get_leaderboard');
  eq([boardD.top.map((r) => r.nickname), boardD.me?.mmr], [['총잡이', '에이스'], 1000], '17 TOP 10 은 랭킹전 1판 이상만 — 0판(1000점) 계정은 빠지고 내 전적으로만');
  await B.call('join_queue', { tier: 'free', profile: {} });
  eq((await B.call('hello', { userId: randomUUID(), nickname: '다른사람' })).error, 'ALREADY_IN_ROOM', '17 대기 중에는 다른 유저 ID 로 바꿀 수 없다');
  await B.call('leave_queue');

  // 18. 저장 · 복원: 서버를 닫으면 파일에 쓰고, 다시 켜면 이어서 읽는다
  await server.stop();
  const saved = JSON.parse(readFileSync(file, 'utf8'));
  eq(saved.users.map((u) => [u.nickname, u.wins, u.losses]).sort(), [['구경꾼', 0, 0], ['에이스', 0, 1], ['총잡이', 2, 0]].sort(), '18 파일에 바뀐 닉네임 · 전적 저장');
  const again = createGameServer({ quiet: true, onError, userDataFile: file });
  const port2 = await again.start(0, '127.0.0.1');
  const back = await client(port2, meA);
  eq((await back.call('hello', meA)).user, { nickname: '총잡이', wins: 2, losses: 0, games: 2, streak: 2, maxStreak: 2, mmr: 1050 }, '18 재시작 뒤에도 서버 전적 유지');
  eq(again.stats().users, 3, '18 재시작 뒤 유저 수');
  await again.stop();
  rmSync(dir, { recursive: true, force: true });
}

// Supabase 흉내 (players 테이블 하나): from().select().eq().maybeSingle() · .order().limit() · upsert(row) 만
function fakeSupabase(rows = []) {
  const table = new Map(rows.map((r) => [r.user_id, { ...r }]));
  const calls = [];
  const orFilter = (expr) => { // PostgREST or 필터 'wins.gt.0,losses.gt.0' 중 gt · eq 만
    const conds = expr.split(',').map((part) => {
      const [col, op, val] = part.split('.');
      return (r) => (op === 'gt' ? r[col] > Number(val) : op === 'eq' ? String(r[col]) === val : false);
    });
    return (r) => conds.some((f) => f(r));
  };
  const query = (filters = [], sorts = [], lim = Infinity) => {
    const run = () => {
      const out = [...table.values()].filter((r) => filters.every((f) => f(r)));
      for (const [c, asc] of [...sorts].reverse()) out.sort((a, b) => (asc ? a[c] - b[c] : b[c] - a[c]));
      return out.slice(0, lim).map((r) => ({ ...r }));
    };
    return {
      eq: (c, v) => query([...filters, (r) => r[c] === v], sorts, lim),
      or: (expr) => { calls.push(`or:${expr}`); return query([...filters, orFilter(expr)], sorts, lim); },
      order: (c, o = {}) => query(filters, [...sorts, [c, o.ascending !== false]], lim),
      limit: (n) => query(filters, sorts, n),
      maybeSingle: async () => ({ data: run()[0] ?? null, error: null }),
      then: (res, rej) => Promise.resolve({ data: run(), error: null }).then(res, rej),
    };
  };
  return {
    table,
    calls,
    from: () => ({
      select: () => { calls.push('select'); return query(); },
      upsert: async (row) => { calls.push('upsert'); table.set(row.user_id, { ...table.get(row.user_id), ...row }); return { data: null, error: null }; },
    }),
  };
}

async function phase4() {
  const veteran = randomUUID();
  const rookie = randomUUID();
  const db = fakeSupabase([{ user_id: veteran, nickname: '고수', wins: 40, losses: 10, streak: 3, max_streak: 9, mmr: 1600 }]);
  const server = createGameServer({ quiet: true, onError, supabaseClient: db });
  const port = await server.start(0, '127.0.0.1');

  // 19. 접속/로그인: 있으면 DB 값을 그대로, 없으면 기본값으로 upsert
  const V = await client(port, { userId: veteran, nickname: '고수' });
  const R = await client(port, { userId: rookie, nickname: '신입' });
  eq((await V.call('hello', { userId: veteran, nickname: '고수' })).user, { nickname: '고수', wins: 40, losses: 10, games: 50, streak: 3, maxStreak: 9, mmr: 1600 }, '19 Supabase: 기존 유저는 DB 전적을 불러온다');
  await R.call('hello', { userId: rookie, nickname: '신입' });
  eq(db.table.get(rookie), { user_id: rookie, nickname: '신입', wins: 0, losses: 0, streak: 0, max_streak: 0, mmr: 1000 }, '19 Supabase: 없는 유저는 기본값으로 upsert');
  eq([(await R.call('get_leaderboard')).top.map((r) => r.nickname), db.calls.includes('or:wins.gt.0,losses.gt.0')], [['고수'], true], '19 TOP 10 쿼리: wins + losses > 0 — 로비만 들른 0판 유저는 빠진다');

  // 20-a. 친선전(방 코드)은 끝까지 가도 DB 를 건드리지 않는다
  const before = JSON.stringify([db.table.get(veteran), db.table.get(rookie)]);
  const friendly = await V.call('create_private_room', { profile: {} });
  await R.call('join_private_room', friendly.code);
  await Promise.all([V.waitFor('match_found', (p) => p.code === friendly.code), R.waitFor('match_found', (p) => p.code === friendly.code)]);
  const friendlyOver = R.waitFor('game_over', (p) => p.code === friendly.code);
  await V.call('leave_room');
  eq([(await friendlyOver).ranked, (await friendlyOver).youWon], [false, true], '20 친선전 game_over: ranked false');
  await server.users.flush();
  eq(JSON.stringify([db.table.get(veteran), db.table.get(rookie)]), before, '20 Supabase: 친선전 결과는 players 행을 바꾸지 않는다');

  // 20. 랭킹전(무작위 매칭) 승/패 확정 → DB 갱신 (승자 wins+1 · streak+1 · max_streak · mmr+25 / 패자 losses+1 · streak 0 · mmr−20)
  await V.call('join_queue', { tier: 'free', profile: {} });
  await R.call('join_queue', { tier: 'free', profile: {} });
  const ranked = await R.waitFor('match_found', (p) => p.mode === 'queue');
  await V.waitFor('match_found', (p) => p.code === ranked.code);
  const over = R.waitFor('game_over', (p) => p.code === ranked.code);
  await V.call('leave_room'); // 고수가 나감 → 신입 부전승
  eq([(await over).record?.mmr, (await over).mmrDelta], [1025, 25], '20 game_over 에 갱신된 MMR · 변동');
  await server.users.flush();
  eq([db.table.get(rookie).wins, db.table.get(rookie).streak, db.table.get(rookie).max_streak, db.table.get(rookie).mmr], [1, 1, 1, 1025], '20 Supabase: 승자 행 갱신');
  eq([db.table.get(veteran).losses, db.table.get(veteran).streak, db.table.get(veteran).max_streak, db.table.get(veteran).mmr], [11, 0, 9, 1580], '20 Supabase: 패자 행 갱신 (최대 연승은 유지)');

  // 21. get_leaderboard 는 DB 에서 mmr 내림차순
  const board = await R.call('get_leaderboard');
  eq(board.top.map((r) => [r.rank, r.nickname, r.mmr, r.isMe]), [[1, '고수', 1580, false], [2, '신입', 1025, true]], '21 Supabase: TOP 10 mmr 내림차순 · 내 줄');
  eq(board.me?.wins, 1, '21 Supabase: 내 전적');

  // 23. 로비에 들어올 때마다 동기화 — hello 응답이 오는 시점에는 이미 DB 에 써져 있다
  await V.call('hello', { userId: veteran, nickname: '고수왕' });
  eq([db.table.get(veteran).nickname, db.table.get(veteran).mmr], ['고수왕', 1580], '23 기존 유저: hello 응답 전에 닉네임 갱신 (전적은 그대로)');
  db.table.delete(rookie); // 대시보드에서 행을 지운 경우
  const again = await client(port, { userId: rookie, nickname: '신입' });
  eq((await again.call('hello', { userId: rookie, nickname: '신입' })).user?.mmr, 1025, '23 재접속 hello → 최신 전적');
  eq([db.table.get(rookie)?.nickname, db.table.get(rookie)?.mmr], ['신입', 1025], '23 없어진 행은 접속하자마자 다시 만든다');

  // 24. register_player { user_id, nickname } — upsert 가 끝난 뒤 내 전적 + TOP 10 으로 답한다
  const newbie = randomUUID();
  const N = await client(port); // handshake auth 없이 이벤트로만 등록
  const reg = await N.call('register_player', { user_id: newbie, nickname: '등록왕' });
  eq([reg.ok, reg.me?.nickname, reg.me?.mmr, reg.top?.length, reg.top?.some((r) => r.nickname === '등록왕')], [true, '등록왕', 1000, 2, false], '24 register_player → 내 전적 + TOP 10 (랭킹전 0판이라 순위에는 아직 없음)');
  eq(db.table.get(newbie)?.nickname, '등록왕', '24 응답이 올 때 이미 players 에 upsert 되어 있다');
  const upserts = db.calls.filter((c) => c === 'upsert').length;
  await N.call('register_player', { user_id: newbie, nickname: '등록왕' });
  eq(db.calls.filter((c) => c === 'upsert').length, upserts + 1, '24 다시 등록해도 upsert 한다');
  eq((await N.call('register_player', { nickname: '아이디없음' })).error, 'BAD_REQUEST', '24 user_id 가 없으면 거절');
  eq([server.stats().storage, server.stats().dbOk], ['supabase', true], '24 /healthz: 저장 방식 · DB 상태');
  await server.stop();

  // 22. DB 연결이 실패하면 메모리로 계속 돈다
  const errors = [];
  const broken = createGameServer({ quiet: true, onError: (err) => errors.push(err), supabaseClient: Promise.reject(new Error('no network')) });
  const port2 = await broken.start(0, '127.0.0.1');
  const solo = await client(port2, { userId: rookie, nickname: '신입' });
  eq((await solo.call('hello', { userId: rookie, nickname: '신입' })).user?.mmr, 1000, '22 Supabase 연결 실패 → 메모리 폴백');
  ok((await solo.call('get_leaderboard')).ok && errors.length === 1, `22 오류는 한 번만 알리고 랭킹은 메모리에서 (${errors.map((e) => e.message).join(' | ')})`);
  eq(broken.stats().storage, 'memory', '22 /healthz: 메모리로 동작 중');
  await broken.stop();
}

// 실제 supabase-js + 가짜 PostgREST, 전역 WebSocket 이 없는 Node 18/20 을 흉내낸다
// (예전에는 createClient 가 'native WebSocket not found' 예외를 던져 서버가 메모리로 떨어지고 players 에 아무것도 안 들어갔다)
async function phase5() {
  const rows = new Map();
  const requests = [];
  const boardQueries = []; // TOP 10 조회(GET, user_id 조건 없음)의 or 파라미터
  const rest = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const url = new URL(req.url, 'http://x');
      requests.push(`${req.method} ${url.pathname}`);
      if (req.method === 'GET' && !url.searchParams.has('user_id')) boardQueries.push(url.searchParams.get('or'));
      res.setHeader('Content-Type', 'application/json');
      if (req.method === 'POST') {
        for (const row of [].concat(JSON.parse(body))) rows.set(row.user_id, { ...rows.get(row.user_id), ...row });
        res.statusCode = 201;
        res.end();
        return;
      }
      const id = url.searchParams.get('user_id')?.replace(/^eq\./, '');
      res.end(JSON.stringify(id ? [rows.get(id)].filter(Boolean) : [...rows.values()].sort((a, b) => b.mmr - a.mmr)));
    });
  });
  await new Promise((resolve) => rest.listen(0, '127.0.0.1', resolve));
  const nativeWebSocket = globalThis.WebSocket;
  delete globalThis.WebSocket;
  const errors = [];
  const server = createGameServer({ quiet: true, onError: (err) => errors.push(err), supabaseUrl: `http://127.0.0.1:${rest.address().port}`, supabaseKey: 'test-service-role' });
  const port = await server.start(0, '127.0.0.1');
  try {
    const id = randomUUID();
    const C = await client(port);
    const reg = await C.call('register_player', { user_id: id, nickname: '노드20' });
    eq([reg.ok, server.stats().storage], [true, 'supabase'], `25 전역 WebSocket 이 없어도(Node 18/20) Supabase 클라이언트를 만든다 (${errors.map((e) => e.message.split('\n')[0]).join(' | ')})`);
    eq([rows.get(id)?.nickname, rows.get(id)?.mmr], ['노드20', 1000], '25 실제 supabase-js 로 players 에 upsert');
    ok(requests.some((r) => r.startsWith('POST /rest/v1/players')) && errors.length === 0, `25 PostgREST 요청: ${requests.join(', ')} · 오류 ${errors.length}건`);
    eq([boardQueries.includes('(wins.gt.0,losses.gt.0)'), reg.top?.length], [true, 0], '25 TOP 10 요청에 wins + losses > 0 필터 (가짜 PostgREST 가 무시해도 서버가 한 번 더 거른다)');
  } finally {
    globalThis.WebSocket = nativeWebSocket;
    await server.stop();
    rest.closeAllConnections?.();
    await new Promise((resolve) => rest.close(resolve));
  }
}

try {
  await phase1();
  await phase2();
  await phase3();
  await phase4();
  await phase5();
} catch (err) {
  fails.push(`테스트 중단: ${err.message}`);
  console.log(`  ✗ 테스트 중단: ${err.stack ?? err.message}`);
}

for (const socket of allSockets) socket.close();
ok(serverErrors.length === 0, `서버 오류 0건 (${serverErrors.map((e) => e.message).join(' | ')})`);
ok(clientErrors.length === 0, `클라이언트 연결 오류 0건 (${clientErrors.join(' | ')})`);

const ms = Math.round(performance.now() - T0);
console.log(fails.length === 0
  ? `PASS  ${pass} checks, 0 failed (서버 오류 0 · 클라이언트 오류 0) — ${ms} ms`
  : `FAIL  ${pass} passed, ${fails.length} failed — ${ms} ms`);
process.exitCode = fails.length === 0 ? 0 : 1;
setTimeout(() => { console.log('  ✗ 서버를 닫은 뒤에도 열린 핸들이 남아 있다'); process.exit(1); }, 1500).unref(); // 정상이면 이 타이머가 울리기 전에 프로세스가 끝난다
