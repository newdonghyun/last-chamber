// 멀티플레이 서버 검증 (브라우저 없음): node tests/server.test.mjs   — socket.io-client · fetch 로 서버를 실제로 때려 본다. 15초 안팎 (비밀번호 해시 포함).
//   Phase 1 (기본 서버, 계정 2개): 로그인해야 방 생성 → 입장 → 격발 1회 · 치트 시도 거절 · 이모트 중계 · 항복 · 빠른 매칭(pro) · 정적 파일
//   Phase 2 (타이머를 줄인 서버): 20초 턴 타임아웃 강제 격발 · 연결 끊김 부전승 · 재접속 · 새 연결의 자리 인수
//   Phase 3 (계정 · 파일 저장): 회원가입(아이디 · 닉네임 중복 차단 · 규칙) · 로그인 · 토큰 접속 · 손님 제한 · 랭킹전/친선전 전적 · 닉네임 변경 · 저장/복원 · 토큰 위조
//   Phase 4 (계정 · Supabase 흉내): 기존 계정 로그인 · 가입 행 · 중복 · 전적 갱신 · TOP 10 계정만 · 닉네임 UPDATE · 재시작 뒤 토큰 · 계정 컬럼 없음 · 연결 실패
//   Phase 5 (실제 supabase-js · 전역 WebSocket 없음): 가입 insert · 로그인 조회 · 닉네임 PATCH · TOP 10 필터
//   Phase 6 (방 격리): 동시에 도는 방 3개 — 한 방의 이벤트가 다른 방 · 로비 소켓에 가지 않는다 · 모든 인게임 이벤트에 자기 방 코드 · 판이 끝나면 방 채널에서 나간다
//   Phase 7 (계정 보안): 비밀번호 오답 잠금 · 비밀번호 미노출 · 토큰 만료 · 위조 · CORS · 동시 가입 · IP 시도 제한
//   Phase 8 (공개 방): 로비 목록 실시간 · 손님 제한 · 자기 방 · 잘못된 입장 · 클릭 입장 즉시 시작(랭킹전) · 목록에서 빠짐 · 방장 이탈/끊김
//   Phase 11 (서버 지갑): 지갑 API 검증(구매 · 장착 · 서버 상자) · 출석 7일 사이클(한국 시간 자정 · 날짜 위조 무시) · 긴급 보급 하루 3회 · 연습 보상 하루 5판 · DB 컬럼 저장/복원 · 지갑 컬럼 없는 DB 폴백
//                (참가비 선결제 · 환불 · 상금 · 조기 종료 무효 · 같은 상대 하루 3판 제한 · 서버가 정한 스킨 표시 · 로비 접속자 통계)
//   Phase 10 (5초 가입): 닉네임을 비우면 서버가 느와르 닉네임을 중복 없이 붙인다 (메모리 · Supabase 흉내 — 흔한 이름이 모두 찼을 때는 숫자) · 직접 정한 닉네임 호환 · 닉네임 생성기 규칙
//   Phase 9 (항복): 공개 방 · 빠른 매칭 항복 = 항복자 −20 · 상대 +25 를 DB 요청 하나로 정산 · 친선 비밀방은 기록 없음 · 중복 · 동시 항복 · 재접속 · 끊김 유예 중 항복 · 방 격리
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { io as connect } from 'socket.io-client';
import { createGameServer, QUEUE_TIERS, clientAddress } from '../server/index.js';
import { roomChannel, ROOM_DEFAULTS } from '../server/roomManager.js';
import { cleanNickname } from '../server/userStore.js';
import { noirNickname, NOIR_ADJECTIVES, NOIR_NOUNS } from '../server/nicknames.js';
import { hashPassword, issueToken, TOKEN_TTL_SEC } from '../server/auth.js';

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
async function client(port, auth) { // auth = { token } 이면 로그인한 클라이언트 (handshake auth = 로그인 토큰)
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


/** 테스트 서버: 모두 127.0.0.1 에서 접속하므로 IP · 계정 제한을 넉넉히 둔다 (제한 자체는 Phase 14 에서 좁혀 검사) */
const testServer = (options = {}) => createGameServer({ signupPer10Min: 10_000, signupPerDay: 10_000, roomsPerMinute: 10_000, joinFailsPerMinute: 10_000, maxSocketsPerIp: 10_000, ...options });

// ───────── 계정 도우미 ─────────
const PASSWORD = 'secret-pass1';
let accountSeq = 0;
const nextName = () => `user${++accountSeq}${Math.random().toString(36).slice(2, 6)}`;
const nextNick = () => `P${++accountSeq}`;
/** HTTP 요청 한 번 (연결을 재사용하지 않는다 — fetch 의 연결 풀은 끝난 서버와 같은 포트를 받은 새 서버에 죽은 연결을 쓰려다 'fetch failed' 가 난다) */
const httpCall = (port, method, urlPath, { body, headers = {} } = {}) => new Promise((resolve, reject) => {
  const req = http.request({ host: '127.0.0.1', port, path: urlPath, method, agent: false, headers: { ...(body !== undefined ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } : {}), ...headers } }, (res) => {
    let text = '';
    res.setEncoding('utf8');
    res.on('data', (chunk) => { text += chunk; });
    res.on('end', () => resolve({ status: res.statusCode, headers: { get: (name) => res.headers[name.toLowerCase()] ?? null }, text }));
  });
  req.on('error', reject);
  if (body !== undefined) req.write(body);
  req.end();
});
const apiOf = (port) => async (route, body, { origin, raw } = {}) => {
  const res = await httpCall(port, 'POST', `/api/${route}`, { body: raw ?? JSON.stringify(body), headers: origin ? { Origin: origin } : {} });
  return { status: res.status, raw: res.text, headers: res.headers, ...JSON.parse(res.text) };
};
/** 회원가입 → { token, user_id, username, nickname, me, password } (실패하면 던진다) */
async function signupVia(port, nickname = nextNick(), { username = nextName(), password = PASSWORD } = {}) {
  const res = await apiOf(port)('signup', { username, password, nickname });
  if (!res.ok) throw new Error(`signup(${nickname}) 실패: ${res.error}`);
  return { ...res, password };
}
/** 가입한 계정으로 로그인한 소켓 (handshake auth = 로그인 토큰) */
async function player(port, nickname) {
  const account = await signupVia(port, nickname);
  const c = await client(port, { token: account.token });
  c.account = account;
  return c;
}
/**
 * 두 좌석이 서로에게만 쏘며 1라운드를 끝낸다 (한쪽 체력이 0 이 되어 2라운드가 시작될 때까지). 랭킹전은 1라운드가 끝나기 전의 항복 · 끊김을 무효로 보므로
 * 정산(MMR · 상금)을 확인하는 테스트는 먼저 이 도우미로 1라운드를 넘긴다.
 */
async function finishRound1(X, Y, code) {
  const latest = (P) => P.inbox.filter((m) => m.event === 'state_update' && m.payload.code === code).at(-1)?.payload.state;
  const until = Date.now() + 10_000; // 반복 횟수가 아니라 시간으로 끊는다 (상태 갱신이 늦어도 같은 턴에 헛발을 쏘며 횟수를 다 쓰지 않게)
  while (Date.now() < until) {
    const sx = latest(X);
    const sy = latest(Y);
    if (!sx || !sy) { await sleep(15); continue; }
    if (sx.round >= 2 || sx.winner) return;
    const shooter = sx.turn?.isMine ? X : sy.turn?.isMine ? Y : null;
    if (!shooter) { await sleep(15); continue; }
    await shooter.call('game_action', { type: 'shoot', target: 'opponent' });
    await sleep(12); // 쏜 결과(state_update)가 양쪽에 닿을 시간
  }
  throw new Error('1라운드가 끝나지 않았다');
}
/** X · Y 를 빠른 매칭(무료 테이블)으로 붙인다 — 이미 본 방 코드는 건너뛴다 */
async function queueMatch(X, Y) {
  X.seen ??= new Set();
  await X.call('join_queue', { tier: 'free', profile: {} });
  await Y.call('join_queue', { tier: 'free', profile: {} });
  const mX = await X.waitFor('match_found', (p) => p.mode === 'queue' && !X.seen.has(p.code));
  X.seen.add(mX.code);
  return [mX, await Y.waitFor('match_found', (p) => p.code === mX.code)];
}

// ───────── Phase 3: 계정 (파일 저장 서버) ─────────
async function phase3() {
  const dir = mkdtempSync(join(tmpdir(), 'lastchamber-users-'));
  const file = join(dir, 'users.json');
  const server = testServer({ quiet: true, onError, userDataFile: file, userSaveDelayMs: 20, authSecret: 'test-secret' });
  const port = await server.start(0, '127.0.0.1');
  const api = apiOf(port);

  // 14. 회원가입: 아이디(소문자로 맞춤) · 닉네임 중복 차단 · 규칙
  const a = await signupVia(port, '총잡이', { username: 'Gunner01' });
  eq([a.username, a.nickname, a.me], ['gunner01', '총잡이', { nickname: '총잡이', wins: 0, losses: 0, games: 0, streak: 0, maxStreak: 0, mmr: 1000 }], '14 회원가입 → 계정 · 기본 전적 (아이디는 소문자로)');
  ok(/^t1\.[0-9a-f-]{36}\.\d+\.[A-Za-z0-9_-]{43}$/.test(a.token) && /^[0-9a-f-]{36}$/.test(a.user_id), '14 로그인 토큰 · 서버가 만든 user_id');
  eq([(await api('signup', { username: 'GUNNER01', password: PASSWORD, nickname: '다른이름' })).error, (await api('signup', { username: 'other01', password: PASSWORD, nickname: '총잡이' })).error],
    ['USERNAME_TAKEN', 'NICKNAME_TAKEN'], '14 같은 아이디(대소문자 무관) · 같은 닉네임은 가입할 수 없다');
  const bad = await Promise.all([
    api('signup', { username: 'ab', password: PASSWORD, nickname: '새사람' }),
    api('signup', { username: '한글아이디', password: PASSWORD, nickname: '새사람' }),
    api('signup', { username: 'okname1', password: '12345', nickname: '새사람' }),
    api('signup', { username: 'okname1', password: PASSWORD, nickname: '새 사람' }),
  ]);
  eq(bad.map((r) => `${r.status} ${r.error}`), ['400 INVALID_USERNAME', '400 INVALID_USERNAME', '400 INVALID_PASSWORD', '400 INVALID_NICKNAME'], '14 아이디 4~16자 영문 소문자 · 숫자 · _ / 비밀번호 6자 이상 / 닉네임 규칙');

  // 15. 로그인: 맞으면 같은 계정 · 틀리면 BAD_CREDENTIALS (없는 아이디도 같은 답)
  const again = await api('login', { username: 'Gunner01', password: PASSWORD });
  eq([again.status, again.user_id, again.nickname], [200, a.user_id, '총잡이'], '15 아이디 + 비밀번호 → 같은 계정');
  const wrongPw = await api('login', { username: 'gunner01', password: 'nope-nope' });
  const noUser = await api('login', { username: 'ghost99', password: PASSWORD });
  eq([wrongPw.status, wrongPw.error, noUser.status, noUser.error], [401, 'BAD_CREDENTIALS', 401, 'BAD_CREDENTIALS'], '15 틀린 비밀번호 · 없는 아이디는 같은 답 (아이디가 있는지 알려 주지 않는다)');

  // 16. 소켓 로그인: 토큰으로 접속 → register_player 전적 · 틀린 토큰은 손님 · 손님은 방 · 매칭 불가
  const A = await client(port, { token: a.token });
  const reg = await A.call('register_player', {});
  eq([reg.ok, reg.me?.nickname, reg.me?.mmr], [true, '총잡이', 1000], '16 토큰으로 접속 → 내 계정 전적');
  const forged = await client(port, { token: `${a.token.slice(0, -3)}xyz` });
  eq((await forged.call('register_player', {})).error, 'AUTH_REQUIRED', '16 서명이 틀린 토큰은 로그인되지 않는다');
  eq((await forged.call('register_player', { token: 'nonsense' })).error, 'AUTH_REQUIRED', '16 엉터리 토큰 → AUTH_REQUIRED');
  const guest = await client(port);
  eq([(await guest.call('create_private_room', {})).error, (await guest.call('create_public_room', {})).error, (await guest.call('join_queue', { tier: 'free' })).error, (await guest.call('join_private_room', 'ABCD')).error],
    ['AUTH_REQUIRED', 'AUTH_REQUIRED', 'AUTH_REQUIRED', 'AUTH_REQUIRED'], '16 손님(로그인 안 함)은 방 만들기 · 입장 · 매칭 불가');
  const guestBoard = await guest.call('get_leaderboard');
  eq([guestBoard.ok, guestBoard.me, (await guest.call('watch_rooms')).ok], [true, null, true], '16 손님도 TOP 10 · 로비 방 목록은 볼 수 있다');

  // 17. 랭킹전(빠른 매칭) 전적 · 상대에게 보이는 이름은 계정 닉네임 · 친선 비밀방은 미반영 · 같은 계정끼리는 미반영
  const b = await signupVia(port, 'Ace_7', { username: 'ace7' });
  const B = await client(port, { token: b.token });
  const [mA, mB] = await queueMatch(A, B);
  eq([mB.opponent.profile.nickname, mA.opponent.profile.nickname, mA.ranked], ['총잡이', 'Ace_7', true], '17 상대 이름표는 계정 닉네임 · 빠른 매칭 = 랭킹전');
  ok(![mA, mB].some((m) => JSON.stringify(m).includes(a.user_id) || JSON.stringify(m).includes(b.user_id)), '17 유저 ID 는 match_found 어디에도 실리지 않는다');
  const [overA, overB] = [A.waitFor('game_over', (p) => p.code === mA.code), B.waitFor('game_over', (p) => p.code === mA.code)];
  await finishRound1(A, B, mA.code);
  await B.call('leave_room');
  const [goA, goB] = await Promise.all([overA, overB]);
  eq([goA.record?.mmr, goA.record?.wins, goA.mmrDelta, goB.record?.mmr, goB.record?.losses, goB.mmrDelta], [1025, 1, 25, 980, 1, -20], '17 랭킹전: 승 +25 · 패 −20');
  const friendly = await A.call('create_private_room', {});
  await B.call('join_private_room', friendly.code);
  await A.waitFor('match_found', (p) => p.code === friendly.code);
  const fOver = A.waitFor('game_over', (p) => p.code === friendly.code);
  await A.call('leave_room');
  eq([(await fOver).ranked, (await fOver).record?.mmr], [false, 1025], '17 친선 비밀방 결과는 전적 · MMR 미반영');
  const A2 = await client(port, { token: a.token }); // 같은 계정 · 다른 창
  await A.call('join_queue', { tier: 'free', profile: {} });
  eq((await A2.call('join_queue', { tier: 'free', profile: {} })).error, 'ACCOUNT_BUSY', '17 같은 계정의 두 번째 창은 대기열에 못 들어간다 (자기 자신과 대전 불가)');
  eq(server.stats().queued, 1, '17 대기열에는 한 자리만');
  await A.call('leave_queue');

  // 18. 닉네임 변경: 서버에서 바로 · 중복 차단 · 토큰 필요 · 접속 중인 소켓의 이름표도
  const renamed = await api('rename', { token: b.token, nickname: '에이스' });
  eq([renamed.ok, renamed.nickname, renamed.me?.losses], [true, '에이스', 1], '18 닉네임 변경 (전적 그대로)');
  eq([(await api('rename', { token: b.token, nickname: '총잡이' })).error, (await api('rename', { token: 'nope', nickname: '아무개' })).status], ['NICKNAME_TAKEN', 401], '18 남의 닉네임 → NICKNAME_TAKEN · 토큰 없으면 401');
  const [mA3, mB3] = await queueMatch(A, B);
  eq(mA3.opponent.profile.nickname, '에이스', '18 바꾼 닉네임이 바로 상대 이름표에');
  const over3 = A.waitFor('game_over', (p) => p.code === mA3.code);
  await finishRound1(A, B, mA3.code);
  await B.call('leave_room');
  await over3;
  void mB3;
  const board = await A.call('get_leaderboard');
  eq(board.top.map((r) => [r.rank, r.nickname, r.mmr, r.isMe]), [[1, '총잡이', 1050, true], [2, '에이스', 960, false]], '18 TOP 10: mmr 내림차순 · 내 줄 표시');
  ok(!/password|token|user_id|username/i.test(JSON.stringify(board)), '18 랭킹 응답에 계정 정보(아이디 · 비밀번호 · ID)가 없다');

  // 19. 저장 · 복원: 비밀번호는 해시로만 파일에 · 다시 켜도 로그인 · 토큰 그대로
  await server.stop();
  const saved = JSON.parse(readFileSync(file, 'utf8'));
  const gun = saved.users.find((u) => u.username === 'gunner01');
  ok(gun && /^p1\$/.test(gun.passwordHash) && !readFileSync(file, 'utf8').includes(PASSWORD), '19 파일에는 비밀번호 해시만 (원문 없음)');
  const reborn = testServer({ quiet: true, onError, userDataFile: file, authSecret: 'test-secret' });
  const port2 = await reborn.start(0, '127.0.0.1');
  const back = await apiOf(port2)('login', { username: 'gunner01', password: PASSWORD });
  eq([back.user_id, back.me?.mmr, back.me?.wins], [a.user_id, 1050, 2], '19 서버를 다시 켜도 로그인 · 전적 그대로');
  const oldToken = await client(port2, { token: a.token });
  eq((await oldToken.call('register_player', {})).me?.nickname, '총잡이', '19 재시작 전에 받은 토큰으로도 자동 로그인 (서버 메모리에 세션이 없어도)');
  await reborn.stop();
  const wrongSecret = testServer({ quiet: true, onError, userDataFile: file, authSecret: 'other-secret' });
  const port3 = await wrongSecret.start(0, '127.0.0.1');
  eq((await (await client(port3, { token: a.token })).call('register_player', {})).error, 'AUTH_REQUIRED', '19 AUTH_SECRET 이 다르면 토큰은 무효 (위조 방지)');
  await wrongSecret.stop();
  rmSync(dir, { recursive: true, force: true });
}

// ───────── Phase 4: 계정 · Supabase 흉내 ─────────
// accountColumns: false 면 username · password_hash 컬럼이 아직 없는 테이블 (ACCOUNT_SQL 실행 전)
function fakeSupabase(rows = [], { accountColumns = true, walletColumns = true } = {}) {
  const table = new Map(rows.map((r) => [r.user_id, { ...r }]));
  const calls = [];
  const ACCOUNT = /username|password_hash/;
  const WALLET = /shells|unlocked_skins|equipped_skin|attendance_days|last_checkin_date|emergency_date|emergency_count|wallet_extra/; // 지갑 컬럼 (WALLET_SQL)
  const noColumn = { data: null, error: { code: '42703', message: 'column players.username does not exist' } };
  const dup = (constraint) => ({ data: null, error: { code: '23505', message: `duplicate key value violates unique constraint "${constraint}"` } });
  const clash = (row) => {
    for (const r of table.values()) {
      if (r.user_id === row.user_id) continue;
      if (row.username && r.username === row.username) return dup('players_username_key');
      if (row.username && r.username && r.nickname === row.nickname) return dup('players_account_nickname_key');
    }
    return null;
  };
  const orFilter = (expr) => {
    const conds = expr.split(',').map((part) => {
      const [col, op, val] = part.split('.');
      return (r) => (op === 'gt' ? r[col] > Number(val) : op === 'eq' ? String(r[col]) === val : false);
    });
    return (r) => conds.some((f) => f(r));
  };
  const query = (filters = [], sorts = [], lim = Infinity, bad = false) => {
    const run = () => {
      const out = [...table.values()].filter((r) => filters.every((f) => f(r)));
      for (const [c, asc] of [...sorts].reverse()) out.sort((x, y) => (asc ? x[c] - y[c] : y[c] - x[c]));
      return out.slice(0, lim).map((r) => ({ ...r }));
    };
    const next = (more, sortMore = [], n = lim, col = '') => query([...filters, ...more], [...sorts, ...sortMore], n, bad || (!accountColumns && ACCOUNT.test(col)));
    return {
      eq: (c, v) => next([(r) => r[c] === v], [], lim, c),
      not: (c, op, v) => next([(r) => !(op === 'is' && v === null ? r[c] == null : r[c] === v)], [], lim, c),
      or: (expr) => { calls.push(`or:${expr}`); return next([orFilter(expr)]); },
      order: (c, o = {}) => next([], [[c, o.ascending !== false]]),
      limit: (n) => next([], [], n),
      maybeSingle: async () => (bad ? noColumn : { data: run()[0] ?? null, error: null }),
      then: (res, rej) => Promise.resolve(bad ? noColumn : { data: run(), error: null }).then(res, rej),
    };
  };
  return {
    table,
    calls,
    addAccountColumns: () => { accountColumns = true; }, // ACCOUNT_SQL 을 실행한 것처럼
    from: () => ({
      select: (cols = '*') => { calls.push('select'); return query([], [], Infinity, (!accountColumns && ACCOUNT.test(cols)) || (!walletColumns && WALLET.test(cols))); },
      insert: async (row) => {
        calls.push('insert');
        if (!accountColumns && Object.keys(row).some((k) => ACCOUNT.test(k))) return noColumn;
        if (!walletColumns && Object.keys(row).some((k) => WALLET.test(k))) return noColumn;
        if (table.has(row.user_id)) return dup('players_pkey');
        const c = clash(row);
        if (c) return c;
        table.set(row.user_id, { ...row });
        return { data: null, error: null };
      },
      upsert: async (rows) => { // 행 하나 또는 배열 — 배열은 SQL 문 하나라 전부 반영되거나 하나도 반영되지 않는다
        calls.push('upsert');
        const merged = [].concat(rows).map((row) => ({ ...table.get(row.user_id), ...row }));
        for (const m of merged) {
          const c = clash(m);
          if (c) return c;
        }
        for (const m of merged) table.set(m.user_id, m);
        return { data: null, error: null };
      },
      update: (patch) => ({
        eq: async (col, val) => {
          calls.push('update');
          if (!walletColumns && Object.keys(patch).some((k) => WALLET.test(k))) return noColumn;
          for (const r of table.values()) {
            if (r[col] !== val) continue;
            const c = clash({ ...r, ...patch });
            if (c) return c;
            Object.assign(r, patch);
          }
          return { data: null, error: null };
        },
      }),
    }),
  };
}

async function phase4() {
  const veteran = randomUUID();
  const legacy = randomUUID();
  const db = fakeSupabase([
    { user_id: veteran, username: 'veteran', password_hash: await hashPassword(PASSWORD), nickname: '고수', wins: 40, losses: 10, streak: 3, max_streak: 9, mmr: 1600 },
    { user_id: legacy, nickname: '옛행', wins: 9, losses: 0, streak: 9, max_streak: 9, mmr: 2000 }, // 계정이 아닌 예전 행 (전적이 있어도 순위 · 로그인 대상 아님)
  ]);
  const server = testServer({ quiet: true, onError, supabaseClient: db, authSecret: 'test-secret' });
  const port = await server.start(0, '127.0.0.1');
  const api = apiOf(port);
  await sleep(30);
  eq([server.stats().accountReady, server.stats().storage], [true, 'supabase'], '20 /healthz: 계정 컬럼 확인 → 회원가입 · 로그인 가능');

  // 20. DB 의 기존 계정으로 로그인 · 토큰으로 접속
  const v = await api('login', { username: 'veteran', password: PASSWORD });
  eq([v.ok, v.user_id, v.me?.wins, v.me?.mmr], [true, veteran, 40, 1600], '20 Supabase 계정 로그인 → DB 전적 그대로');
  const V = await client(port, { token: v.token });
  eq((await V.call('register_player', {})).me?.nickname, '고수', '20 토큰으로 접속');

  // 21. 회원가입 → players 에 행 1개 (비밀번호는 해시) · 중복은 DB 에서 막힌다
  const rows = db.table.size;
  const r = await signupVia(port, '신입', { username: 'rookie' });
  const row = db.table.get(r.user_id);
  eq([db.table.size, row?.username, row?.nickname, row?.mmr], [rows + 1, 'rookie', '신입', 1000], '21 회원가입 → players 에 새 행 (아이디 · 닉네임 · 기본 전적)');
  ok(/^p1\$/.test(row?.password_hash) && !JSON.stringify(row).includes(PASSWORD), '21 Supabase 에는 password_hash(해시)만');
  eq([(await api('signup', { username: 'ROOKIE', password: PASSWORD, nickname: '다른애' })).error, (await api('signup', { username: 'rookie2', password: PASSWORD, nickname: '고수' })).error, db.table.size],
    ['USERNAME_TAKEN', 'NICKNAME_TAKEN', rows + 1], '21 같은 아이디 · 닉네임 → 거절, 행은 늘지 않는다');
  const sameNickLegacy = await api('signup', { username: 'newold', password: PASSWORD, nickname: '옛행' });
  eq(sameNickLegacy.ok, true, '21 계정이 아닌 예전 행의 닉네임은 쓸 수 있다');

  // 22. 랭킹전 → DB 갱신 · TOP 10 은 계정만
  const R = await client(port, { token: r.token });
  const [mV] = await queueMatch(V, R);
  const over = R.waitFor('game_over', (p) => p.code === mV.code);
  await finishRound1(V, R, mV.code);
  await V.call('leave_room');
  eq([(await over).record?.mmr, (await over).mmrDelta], [1025, 25], '22 game_over 에 갱신된 MMR');
  await server.users.flush();
  eq([db.table.get(r.user_id).wins, db.table.get(r.user_id).mmr, db.table.get(veteran).losses, db.table.get(veteran).mmr, db.table.get(veteran).password_hash === row?.password_hash],
    [1, 1025, 11, 1580, false], '22 Supabase 행 갱신 (승자 +25 · 패자 −20, 계정 정보는 그대로)');
  ok(Boolean(db.table.get(veteran).username) && Boolean(db.table.get(veteran).password_hash), '22 전적 저장이 아이디 · 비밀번호 해시를 지우지 않는다');
  const board = await R.call('get_leaderboard');
  eq(board.top.map((x) => [x.nickname, x.mmr]), [['고수', 1580], ['신입', 1025]], '22 TOP 10: 계정만 · 랭킹전 1판 이상 (예전 행 · 0판 계정은 빠진다)');
  ok(db.calls.includes('or:wins.gt.0,losses.gt.0'), '22 TOP 10 쿼리에 wins + losses > 0');

  // 23. 닉네임 변경 → players 바로 UPDATE · DB 에서 겹치면 거절
  const ren = await api('rename', { token: r.token, nickname: '중수' });
  eq([ren.ok, db.table.get(r.user_id).nickname], [true, '중수'], '23 닉네임 변경 → players 즉시 UPDATE');
  eq([(await api('rename', { token: r.token, nickname: '고수' })).error, db.table.get(r.user_id).nickname], ['NICKNAME_TAKEN', '중수'], '23 다른 계정의 닉네임 → 거절 (DB 그대로)');
  await server.stop();

  // 24. 서버를 다시 켜도(캐시 없음) 토큰으로 바로 자동 로그인 — DB 에서 계정을 읽어 확인
  const again = testServer({ quiet: true, onError, supabaseClient: db, authSecret: 'test-secret' });
  const port2 = await again.start(0, '127.0.0.1');
  const R2 = await client(port2, { token: r.token });
  eq((await R2.call('register_player', {})).me, { nickname: '중수', wins: 1, losses: 0, games: 1, streak: 1, maxStreak: 1, mmr: 1025 }, '24 재시작 뒤 토큰 → DB 계정 · 전적');
  await again.stop();

  // 25. 계정 컬럼이 없는 테이블 (ACCOUNT_SQL 실행 전): 서버는 돌고 가입 · 로그인만 안내와 함께 막는다 → SQL 실행 뒤 다시 켜지 않아도 된다
  const errors = [];
  const oldDb = fakeSupabase([], { accountColumns: false });
  const old = testServer({ quiet: true, onError: (err) => errors.push(err), supabaseClient: oldDb, accountRecheckMs: 0 });
  const oldPort = await old.start(0, '127.0.0.1');
  await sleep(30);
  const blocked = await apiOf(oldPort)('signup', { username: 'early1', password: PASSWORD, nickname: '얼리' });
  eq([old.stats().accountReady, blocked.status, blocked.error], [false, 503, 'ACCOUNT_SETUP_REQUIRED'], '25 계정 컬럼이 없으면 503 ACCOUNT_SETUP_REQUIRED');
  ok(errors.some((e) => /add column if not exists username/.test(e.message)), '25 서버 로그에 실행할 SQL 을 알려 준다');
  oldDb.addAccountColumns();
  const afterSql = await apiOf(oldPort)('signup', { username: 'early1', password: PASSWORD, nickname: '얼리' });
  eq([afterSql.ok, old.stats().accountReady, oldDb.table.size], [true, true, 1], '25 SQL 실행 뒤 다음 가입부터 바로 된다 (재시작 없이)');
  await old.stop();

  // 26. DB 연결이 실패하면 메모리로 계속 돈다
  const errs = [];
  const solo = testServer({ quiet: true, onError: (err) => errs.push(err), supabaseClient: Promise.reject(new Error('fetch failed')) });
  const soloPort = await solo.start(0, '127.0.0.1');
  const memo = await apiOf(soloPort)('signup', { username: 'memo1', password: PASSWORD, nickname: '메모' });
  eq([memo.ok, solo.stats().storage, errs.length], [true, 'memory', 1], '26 Supabase 연결 실패 → 메모리로 가입 · 로그인 (오류는 한 번만)');
  await solo.stop();
}

// ───────── Phase 5: 실제 supabase-js (전역 WebSocket 없는 Node) + 가짜 PostgREST ─────────
async function phase5() {
  const rows = new Map();
  const requests = [];
  const pick = (url) => { // PostgREST 필터 몇 가지만 (eq · is.null · not.is.null)
    const conds = [];
    for (const [k, v] of url.searchParams) {
      if (['select', 'or', 'order', 'limit', 'offset', 'on_conflict', 'columns'].includes(k)) continue;
      if (v.startsWith('eq.')) conds.push((r) => String(r[k]) === v.slice(3));
      else if (v === 'is.null') conds.push((r) => r[k] == null);
      else if (v === 'not.is.null') conds.push((r) => r[k] != null);
    }
    return [...rows.values()].filter((r) => conds.every((f) => f(r)));
  };
  const rest = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const url = new URL(req.url, 'http://x');
      requests.push(`${req.method} ${url.pathname}?${[...url.searchParams.keys()].join(',')}`);
      res.setHeader('Content-Type', 'application/json');
      if (req.method === 'POST') {
        for (const row of [].concat(JSON.parse(body))) rows.set(row.user_id, { ...rows.get(row.user_id), ...row });
        res.statusCode = 201;
        res.end();
        return;
      }
      if (req.method === 'PATCH') {
        for (const r of pick(url)) Object.assign(r, JSON.parse(body));
        res.statusCode = 204;
        res.end();
        return;
      }
      res.end(JSON.stringify(pick(url).sort((a, b) => b.mmr - a.mmr)));
    });
  });
  await new Promise((resolve) => rest.listen(0, '127.0.0.1', resolve));
  const nativeWebSocket = globalThis.WebSocket;
  delete globalThis.WebSocket;
  const errors = [];
  const server = testServer({ quiet: true, onError: (err) => errors.push(err), supabaseUrl: `http://127.0.0.1:${rest.address().port}`, supabaseKey: 'test-service-role', authSecret: 'test-secret' });
  const port = await server.start(0, '127.0.0.1');
  try {
    const made = await apiOf(port)('signup', { username: 'node20', password: PASSWORD, nickname: '노드20' });
    eq([made.ok, server.stats().storage], [true, 'supabase'], `27 전역 WebSocket 이 없어도(Node 18/20) Supabase 클라이언트를 만든다 (${errors.map((e) => e.message.split('\n')[0]).join(' | ')})`);
    eq([rows.get(made.user_id)?.username, rows.get(made.user_id)?.nickname, /^p1\$/.test(rows.get(made.user_id)?.password_hash ?? '')], ['node20', '노드20', true], '27 실제 supabase-js 로 players 에 계정 행 insert');
    const back = await apiOf(port)('login', { username: 'node20', password: PASSWORD });
    eq(back.user_id, made.user_id, '27 실제 supabase-js 로 아이디 조회 → 로그인');
    const renamed = await apiOf(port)('rename', { token: back.token, nickname: '노드22' });
    eq([renamed.ok, rows.get(made.user_id)?.nickname], [true, '노드22'], '27 닉네임 변경 → PATCH(UPDATE)');
    const C = await client(port, { token: back.token });
    const reg = await C.call('register_player', {});
    eq([reg.ok, reg.top?.length], [true, 0], '27 토큰 접속 · TOP 10 (전적 없는 계정은 아직 없음)');
    ok(requests.some((r) => r.startsWith('GET /rest/v1/players') && r.includes('or') && r.includes('username')) && errors.length === 0, `27 TOP 10 요청에 wins + losses > 0 · 계정만 필터 · 오류 ${errors.length}건`);
  } finally {
    globalThis.WebSocket = nativeWebSocket;
    await server.stop();
    rest.closeAllConnections?.();
    await new Promise((resolve) => rest.close(resolve));
  }
}

// ───────── Phase 7: 계정 보안 ─────────
async function phase7() {
  const server = testServer({ quiet: true, onError, authSecret: 'test-secret', loginLimits: { maxFails: 3, lockMs: 60_000, maxPerIp: 500 } });
  const port = await server.start(0, '127.0.0.1');
  const api = apiOf(port);
  const acct = await signupVia(port, '보안관', { username: 'sheriff' });

  // 28. 비밀번호 여러 번 틀리면 잠금 (맞는 비밀번호도 잠시 막힌다)
  await api('login', { username: 'sheriff', password: 'wrong-1' });
  await api('login', { username: 'sheriff', password: 'wrong-2' });
  const locked = await api('login', { username: 'sheriff', password: 'wrong-3' });
  eq([locked.status, locked.error, locked.retryAfterSec > 0], [429, 'LOGIN_LOCKED', true], '28 3번 틀리면 잠금');
  eq((await api('login', { username: 'sheriff', password: PASSWORD })).error, 'LOGIN_LOCKED', '28 잠긴 동안은 맞는 비밀번호도 막는다 (무차별 대입 방지)');

  // 29. 응답 · 저장에 비밀번호가 없다 · 토큰 위조 · 만료
  ok(!/password/i.test(acct.raw) && !acct.raw.includes(PASSWORD), '29 가입 응답에 비밀번호 · 해시가 없다');
  const rec = server.users.get(acct.user_id);
  ok(/^p1\$/.test(rec.passwordHash) && !rec.passwordHash.includes(PASSWORD), '29 서버에는 scrypt 해시만');
  const expired = issueToken(rec, 'test-secret', Math.floor(Date.now() / 1000) - TOKEN_TTL_SEC - 10);
  const noSecret = issueToken(rec, '');
  const [e1, e2] = [await client(port, { token: expired }), await client(port, { token: noSecret })];
  eq([(await e1.call('register_player', {})).error, (await e2.call('register_player', {})).error], ['AUTH_REQUIRED', 'AUTH_REQUIRED'], '29 만료된 토큰 · 서버 비밀 없이 만든 토큰은 무효');

  // 30. CORS: 앱 출처만
  const pre = await httpCall(port, 'OPTIONS', '/api/login', { headers: { Origin: 'capacitor://localhost', 'Access-Control-Request-Method': 'POST' } });
  const evil = await api('login', { username: 'x', password: 'y' }, { origin: 'https://evil.example' });
  eq([pre.status, pre.headers.get('access-control-allow-origin'), evil.headers.get('access-control-allow-origin')], [204, 'capacitor://localhost', null], '30 앱 출처만 CORS 허용 (다른 출처는 브라우저가 응답을 못 읽는다)');
  eq((await api('login', null, { raw: '{broken' })).error, 'BAD_REQUEST', '30 깨진 JSON → 400');

  // 31. 같은 아이디로 동시에 5번 가입 → 계정 1개
  const burst = await Promise.all(Array.from({ length: 5 }, (_, i) => api('signup', { username: 'twin01', password: PASSWORD, nickname: `쌍둥이${i}` })));
  eq([burst.filter((x) => x.ok).length, burst.filter((x) => x.error === 'USERNAME_TAKEN').length], [1, 4], '31 동시 가입 → 계정 1개');
  await server.stop();

  const strict = testServer({ quiet: true, onError, loginLimits: { maxPerIp: 2 } });
  const strictPort = await strict.start(0, '127.0.0.1');
  const tries = [];
  for (let i = 0; i < 3; i += 1) tries.push((await apiOf(strictPort)('login', { username: 'nobody', password: 'whatever' })).error);
  eq(tries, ['BAD_CREDENTIALS', 'BAD_CREDENTIALS', 'RATE_LIMITED'], '31 같은 IP 의 시도 수 제한');
  await strict.stop();
}

// ───────── Phase 8: 공개 방 (로비 목록 · 클릭 입장 · 랭킹전) ─────────
async function phase8() {
  const server = testServer({ quiet: true, onError });
  const port = await server.start(0, '127.0.0.1');
  const host = await player(port, '방장');
  const guest = await client(port);
  const C = await player(port, '도전자');
  const listOf = (X) => X.inbox.filter((m) => m.event === 'room_list').at(-1)?.payload.rooms ?? null;

  // 32. 로비 목록 보기 → 공개 방을 만들면 즉시 목록에 (방장 닉네임 · MMR · 1/2)
  eq((await guest.call('watch_rooms')).rooms, [], '32 처음 목록은 비어 있다');
  await C.call('watch_rooms');
  eq((await guest.call('create_public_room', {})).error, 'AUTH_REQUIRED', '32 손님은 공개 방을 만들 수 없다');
  const made = await host.call('create_public_room', {});
  eq([made.ok, made.mode], [true, 'public'], '32 공개 방 만들기');
  await guest.waitFor('room_list', (p) => p.rooms.length === 1);
  const item = listOf(guest)[0];
  eq([item.code, item.host, item.mmr, item.players, item.capacity], [made.code, '방장', 1000, 1, 2], '32 목록에 즉시: 방장 닉네임 · MMR · 1/2명');
  ok(!JSON.stringify(listOf(guest)).includes(host.account.user_id), '32 목록에 유저 ID 는 없다');
  const secret = await (await player(port, '비밀')).call('create_private_room', {});
  await sleep(40);
  eq(listOf(guest).map((r) => r.code), [made.code], '32 친선 비밀방은 목록에 보이지 않는다');

  // 33. 잘못된 입장
  const twin = await client(port, { token: host.account.token }); // 같은 계정 · 다른 창
  eq((await twin.call('join_public_room', { code: made.code })).error, 'OWN_ROOM', '33 자기 공개 방에는 못 들어간다');
  eq([(await C.call('join_private_room', made.code)).error, (await C.call('join_public_room', { code: secret.code })).error], ['ROOM_NOT_FOUND', 'ROOM_NOT_FOUND'], '33 공개 방은 코드 입력으로 · 비밀방은 목록 입장으로 못 들어간다');

  // 34. 목록에서 누르면 바로 1:1 시작 (랭킹전) → 목록에서 빠진다 · 입장한 소켓은 더 이상 목록을 받지 않는다
  const joined = await C.call('join_public_room', { code: made.code });
  const [mH, mC] = await Promise.all([host.waitFor('match_found', (p) => p.code === made.code), C.waitFor('match_found', (p) => p.code === made.code)]);
  eq([joined.ok, mH.mode, mH.ranked, mC.opponent.profile.nickname], [true, 'public', true, '방장'], '34 입장 즉시 시작 · 공개 방 = 랭킹전');
  await guest.waitFor('room_list', (p) => p.rooms.length === 0);
  eq(listOf(guest), [], '34 시작된 방은 목록에서 즉시 빠진다');
  const cLists = C.inbox.filter((m) => m.event === 'room_list').length;
  const other = await (await player(port, '셋째')).call('create_public_room', {});
  await guest.waitFor('room_list', (p) => p.rooms.some((r) => r.code === other.code));
  eq(C.inbox.filter((m) => m.event === 'room_list').length, cLists, '34 방에 앉은 소켓은 로비 목록을 더 받지 않는다');
  eq((await C.call('join_public_room', { code: other.code })).error, 'ALREADY_IN_ROOM', '34 판 도중에는 다른 방에 못 들어간다');
  const over = host.waitFor('game_over', (p) => p.code === made.code);
  await finishRound1(host, C, made.code);
  await C.call('leave_room');
  eq([(await over).ranked, (await over).mmrDelta, (await over).record?.mmr], [true, 25, 1025], '34 공개 방 결과는 MMR 정산 (+25) — 1라운드 뒤의 이탈');

  // 35. 방장이 나가거나 연결이 끊기면 목록에서 바로 빠진다 · 목록의 MMR 은 서버 전적
  const relist = await host.call('create_public_room', {});
  await guest.waitFor('room_list', (p) => p.rooms.some((r) => r.code === relist.code && r.mmr === 1025));
  ok(true, '35 방장 MMR 은 서버 전적 (1025)');
  await host.call('leave_room');
  await guest.waitFor('room_list', (p) => !p.rooms.some((r) => r.code === relist.code));
  ok(true, '35 방장이 나가면 목록에서 빠진다');
  const dropper = await player(port, '끊김');
  const dropped = await dropper.call('create_public_room', {});
  await guest.waitFor('room_list', (p) => p.rooms.some((r) => r.code === dropped.code));
  dropper.socket.disconnect();
  await guest.waitFor('room_list', (p) => !p.rooms.some((r) => r.code === dropped.code));
  ok(true, '35 방장 연결이 끊기면 목록에서 빠진다');
  eq(guest.inbox.filter((m) => IN_GAME_EVENTS.includes(m.event)).length, 0, '35 목록만 보는 소켓은 인게임 이벤트를 하나도 받지 않는다');
  await guest.call('unwatch_rooms');
  const quiet = guest.inbox.length;
  await (await player(port, '조용')).call('create_public_room', {});
  await sleep(40);
  eq(guest.inbox.length, quiet, '35 unwatch_rooms 뒤에는 목록을 받지 않는다');
  await server.stop();
}



// ───────── Phase 9: 항복 (랭킹전 정산 · 친선전 · 중복 · 동시 · 재접속) ─────────
async function phase9() {
  const db = fakeSupabase([]); // Supabase 흉내 — 두 계정 정산이 요청 하나(upsert 배열)로 가는지도 본다
  const server = testServer({ quiet: true, onError, supabaseClient: db, authSecret: 'test-secret' });
  const port = await server.start(0, '127.0.0.1');
  const mem = (X) => { const r = server.users.get(X.account.user_id); return { w: r.wins, l: r.losses, s: r.streak, m: r.mmr }; }; // 서버 메모리 전적
  const row = (X) => { const r = db.table.get(X.account.user_id); return { w: r.wins, l: r.losses, s: r.streak, m: r.mmr }; }; // DB(players) 행
  const upserts = () => db.calls.filter((c) => c === 'upsert').length;
  const overs = (X, code) => X.inbox.filter((m) => m.event === 'game_over' && m.payload.code === code);
  const inChannel = (X, code) => server.io.sockets.sockets.get(X.socket.id)?.rooms.has(roomChannel(code)) === true;
  const A = await player(port, '항복자');
  const B = await player(port, '승자');

  // 구경꾼 판(다른 방) — 항복이 다른 방에 새지 않는지
  const D1 = await player(port, '구경1');
  const D2 = await player(port, '구경2');
  const bystander = await D1.call('create_private_room', {});
  await D2.call('join_private_room', bystander.code);
  await D1.waitFor('match_found', (p) => p.code === bystander.code);

  // 36. 공개 방(랭킹전): 항복자 −20 · 패배 +1 · 연승 0 / 상대 +25 · 승리 +1 · 연승 +1 — 양쪽에 결과, 방 채널에서 나감
  const made = await B.call('create_public_room', {});
  await A.call('join_public_room', { code: made.code });
  const [mB, mA] = await Promise.all([B.waitFor('match_found', (p) => p.code === made.code), A.waitFor('match_found', (p) => p.code === made.code)]);
  ok(inChannel(A, made.code) && inChannel(B, made.code), '36 판 중에는 둘 다 방 채널에 있다');
  await finishRound1(A, B, made.code); // 1라운드 전의 항복은 무효 — 1라운드를 넘긴 뒤에 항복
  const upBefore = upserts();
  eq(await A.call('surrender'), { ok: true }, '36 항복 → ok');
  const [oA, oB] = await Promise.all([A.waitFor('game_over', (p) => p.code === made.code), B.waitFor('game_over', (p) => p.code === made.code)]);
  eq([oA.reason, oA.youWon, oA.ranked, oA.mmrDelta, oA.payout], ['surrender', false, true, -20, 0], '36 항복자 결과: 항복 패배 · −20');
  eq([oB.reason, oB.youWon, oB.ranked, oB.mmrDelta], ['surrender', true, true, 25], '36 상대 결과: 상대 항복 승리 · +25');
  eq([oA.record.wins, oA.record.losses, oA.record.streak, oA.record.mmr], [0, 1, 0, 980], '36 항복자 서버 전적: 0승 1패 · 연승 0 · 980');
  eq([oB.record.wins, oB.record.losses, oB.record.streak, oB.record.mmr], [1, 0, 1, 1025], '36 상대 서버 전적: 1승 0패 · 연승 1 · 1025');
  eq([mem(A), mem(B)], [{ w: 0, l: 1, s: 0, m: 980 }, { w: 1, l: 0, s: 1, m: 1025 }], '36 서버 메모리 전적');
  await sleep(80);
  eq([row(A), row(B)], [{ w: 0, l: 1, s: 0, m: 980 }, { w: 1, l: 0, s: 1, m: 1025 }], '36 Supabase players 행에도 반영');
  eq(upserts() - upBefore, 1, '36 두 계정 정산이 DB 요청 하나(upsert 배열) — 한쪽만 반영되지 않는다');
  ok(!inChannel(A, made.code) && !inChannel(B, made.code), '36 정산 뒤 둘 다 방 채널(socket.leave)에서 나갔다');
  eq([overs(A, made.code).length, overs(B, made.code).length], [1, 1], '36 결과(game_over)는 각자 한 번만');
  eq(D1.inbox.concat(D2.inbox).filter((m) => m.event === 'game_over' || m.payload?.code === made.code).length, 0, '36 다른 방(구경꾼)에는 아무것도 가지 않는다');

  // 37. 이미 끝난 판에 다시 항복 · 방에 없는 소켓의 항복 → NOT_IN_GAME, 두 번 정산되지 않는다
  eq([(await A.call('surrender')).error, (await B.call('surrender')).error], ['NOT_IN_GAME', 'NOT_IN_GAME'], '37 끝난 판에 다시 항복하면 NOT_IN_GAME');
  const lone = await player(port, '혼자');
  const guest = await client(port);
  eq([(await lone.call('surrender')).error, (await guest.call('surrender')).error], ['NOT_IN_GAME', 'NOT_IN_GAME'], '37 방에 없는 소켓 · 손님의 항복은 NOT_IN_GAME');
  await sleep(60);
  eq([mem(A), mem(B), upserts() - upBefore], [{ w: 0, l: 1, s: 0, m: 980 }, { w: 1, l: 0, s: 1, m: 1025 }, 1], '37 전적 · DB 쓰기는 그대로 (중복 정산 없음)');
  const waiting = await lone.call('create_public_room', {});
  eq((await lone.call('surrender')).error, 'NOT_IN_GAME', '37 상대를 기다리는 방에서는 항복할 수 없다 (나가기는 leave_room)');
  ok((await guest.call('watch_rooms')).rooms.some((r) => r.code === waiting.code), '37 그 방은 그대로 목록에 남는다');
  await lone.call('leave_room');

  // 38. 끝난 판의 결과는 재접속으로 다시 받아도 새로 정산하지 않는다
  A.socket.disconnect();
  const A2 = await client(port, { token: A.account.token });
  A2.account = A.account;
  eq(await A2.call('rejoin_room', { code: made.code, token: mA.token }), { ok: true, over: true }, '38 끝난 판에 재접속 → 결과만 다시');
  const again = await A2.waitFor('game_over', (p) => p.code === made.code);
  eq([again.reason, again.youWon], ['surrender', false], '38 다시 받은 결과도 항복 패배');
  await sleep(60);
  eq([mem(A), upserts() - upBefore], [{ w: 0, l: 1, s: 0, m: 980 }, 1], '38 재접속해도 전적 · DB 쓰기는 그대로');

  // 39. 빠른 매칭(랭킹전)도 같은 정산 — 이번엔 이긴 쪽(B, 연승 1)이 항복 → 연승 초기화
  const [qB, qA] = await queueMatch(B, A2);
  eq([qB.mode, qB.ranked], ['queue', true], '39 빠른 매칭은 랭킹전');
  await finishRound1(B, A2, qB.code);
  await B.call('surrender');
  const [qoB, qoA] = await Promise.all([B.waitFor('game_over', (p) => p.code === qB.code), A2.waitFor('game_over', (p) => p.code === qB.code)]);
  eq([qoB.youWon, qoB.mmrDelta, qoB.record.streak, qoB.record.mmr, qoB.record.losses], [false, -20, 0, 1005, 1], '39 항복한 연승자: −20 · 연승 0 · 1005 · 1패');
  eq([qoA.youWon, qoA.mmrDelta, qoA.record.streak, qoA.record.mmr, qoA.record.wins], [true, 25, 1, 1005, 1], '39 상대: +25 · 연승 1 · 1005 · 1승');
  eq([qoB.reason, qoA.reason], ['surrender', 'surrender'], '39 두 사람 모두 reason surrender');
  ok(qA.code === qB.code, '39 같은 방');

  // 40. 친선 비밀방: 항복해도 MMR · 전적 변동 없음, 상대에게 승리 결과만, 방은 끝난다
  const C = await player(port, '친선A');
  const E = await player(port, '친선B');
  const pr = await C.call('create_private_room', {});
  await E.call('join_private_room', pr.code);
  await Promise.all([C.waitFor('match_found', (p) => p.code === pr.code), E.waitFor('match_found', (p) => p.code === pr.code)]);
  const upPrivate = upserts();
  const memC = mem(C);
  await C.call('surrender');
  const [pC, pE] = await Promise.all([C.waitFor('game_over', (p) => p.code === pr.code), E.waitFor('game_over', (p) => p.code === pr.code)]);
  eq([pC.reason, pC.youWon, pC.ranked, pC.mmrDelta, pC.record?.mmr], ['surrender', false, false, undefined, 1000], '40 친선 항복자: 패배 · MMR 변동 없음 (ranked false)');
  eq([pE.reason, pE.youWon, pE.ranked, pE.mmrDelta], ['surrender', true, false, undefined], '40 친선 상대: 승리 · MMR 변동 없음');
  await sleep(60);
  eq([mem(C), mem(E), upserts() - upPrivate], [memC, { w: 0, l: 0, s: 0, m: 1000 }, 0], '40 친선전은 전적도 DB 쓰기도 없다');
  ok(!inChannel(C, pr.code) && !inChannel(E, pr.code), '40 방이 끝나 둘 다 방 채널에서 나갔다');
  ok(['ROOM_FULL', 'ROOM_NOT_FOUND'].includes((await (await player(port, '늦은손님')).call('join_private_room', pr.code)).error), '40 끝난 친선방에는 다시 들어갈 수 없다');

  // 41. 동시에 서로 항복 → 한 판은 한 번만 끝난다 (결과 한 번 · 한 명 승리 · 한 명 패배 · 정산 한 번)
  const G = await player(port, '동시A');
  const H = await player(port, '동시B');
  const [mG] = await queueMatch(G, H);
  await finishRound1(G, H, mG.code);
  const upSim = upserts();
  const acks = await Promise.all([G.call('surrender'), H.call('surrender')]);
  eq(acks.filter((a) => a.ok).length, 1, '41 동시 항복: 하나만 처리된다');
  eq(acks.filter((a) => a.error === 'NOT_IN_GAME').length, 1, '41 나머지는 NOT_IN_GAME');
  const [sG, sH] = await Promise.all([G.waitFor('game_over', (p) => p.code === mG.code), H.waitFor('game_over', (p) => p.code === mG.code)]);
  eq([sG.youWon, sH.youWon].sort(), [false, true], '41 한 명 승리 · 한 명 패배');
  eq([overs(G, mG.code).length, overs(H, mG.code).length], [1, 1], '41 결과 화면은 각자 한 번만');
  await sleep(80);
  eq([mem(G).m + mem(H).m, upserts() - upSim], [2005, 1], '41 정산은 한 번 (+25 −20)');

  // 42. 상대가 끊겨 15초 유예 중일 때 항복 → 바로 끝, 끊긴 쪽이 이김 · 돌아오면 그 결과를 받는다 · 유예 타이머는 정리됨
  const I = await player(port, '유예A');
  const J = await player(port, '유예B');
  const [mI, mJ] = await queueMatch(I, J);
  await finishRound1(I, J, mI.code);
  J.socket.disconnect();
  await I.waitFor('opponent_status', (p) => p.code === mI.code && p.connected === false);
  await I.call('surrender');
  const oI = await I.waitFor('game_over', (p) => p.code === mI.code);
  eq([oI.youWon, oI.mmrDelta, oI.reason], [false, -20, 'surrender'], '42 유예 중에도 항복 즉시 정산');
  const J2 = await client(port, { token: J.account.token });
  eq(await J2.call('rejoin_room', { code: mJ.code, token: mJ.token }), { ok: true, over: true }, '42 끊겼던 쪽이 돌아오면 결과만');
  const oJ = await J2.waitFor('game_over', (p) => p.code === mJ.code);
  eq([oJ.youWon, oJ.mmrDelta, oJ.record.wins], [true, 25, 1], '42 끊겼던 쪽은 승리 · +25 로 기록돼 있다');
  await sleep(60);
  eq([mem(I).m, mem(J).m], [980, 1025], '42 정산은 한 번 (유예 타이머가 또 부전패를 만들지 않는다)');

  await server.stop();
}

// ───────── Phase 10: 5초 가입 (닉네임 자동 부여) ─────────
async function phase10() {
  // 43. 생성기: 모든 조합이 닉네임 규칙(2~10자 · 한글 · 공백 없음)을 통과한다
  const bases = NOIR_ADJECTIVES.flatMap((a) => NOIR_NOUNS.map((n) => a + n));
  ok(bases.length === NOIR_ADJECTIVES.length * NOIR_NOUNS.length && new Set(bases).size === bases.length, '43 형용사 × 명사 조합이 모두 다르다 (겹치는 말 없음)');
  ok(bases.every((n) => cleanNickname(n) === n), `43 모든 기본 조합(${bases.length}개)이 닉네임 규칙을 통과`);
  const numbered = Array.from({ length: 2000 }, () => noirNickname(Math.random, { number: true }));
  ok(numbered.every((n) => cleanNickname(n) === n && [...n].length <= 10 && /\d{2}$/.test(n)), '43 숫자를 붙인 이름도 규칙 안 (최대 10자 · 두 자리 숫자)');
  eq(noirNickname(() => 0), NOIR_ADJECTIVES[0] + NOIR_NOUNS[0], '43 난수를 고정하면 같은 이름 (결정적)');

  // 44. 메모리 서버: 닉네임 없이 가입 → 서버가 붙인다
  const server = testServer({ quiet: true, onError });
  const port = await server.start(0, '127.0.0.1');
  const api = apiOf(port);
  const made = [];
  for (let i = 0; i < 6; i += 1) made.push(await api('signup', { username: nextName(), password: PASSWORD }));
  ok(made.every((r) => r.ok && r.token && r.user_id), '44 닉네임 없이 가입 → 성공 · 토큰 · user_id');
  ok(made.every((r) => cleanNickname(r.nickname) === r.nickname), '44 서버가 붙인 닉네임은 규칙에 맞는다');
  eq(new Set(made.map((r) => r.nickname)).size, made.length, '44 서로 겹치지 않는다');
  const blank = await api('signup', { username: nextName(), password: PASSWORD, nickname: '' });
  const nul = await api('signup', { username: nextName(), password: PASSWORD, nickname: null });
  ok(blank.ok && nul.ok && blank.nickname && nul.nickname, '44 닉네임이 빈 문자열 · null 이어도 자동 부여');
  const picked = await api('signup', { username: nextName(), password: PASSWORD, nickname: 'Dealer7' });
  eq([picked.ok, picked.nickname], [true, 'Dealer7'], '44 직접 정한 닉네임은 그대로 (기존 호출 호환)');
  eq((await api('signup', { username: nextName(), password: PASSWORD, nickname: 'Dealer7' })).error, 'NICKNAME_TAKEN', '44 직접 정한 닉네임이 겹치면 NICKNAME_TAKEN');
  eq((await api('signup', { username: nextName(), password: PASSWORD, nickname: 'a' })).error, 'INVALID_NICKNAME', '44 잘못된 닉네임을 직접 주면 INVALID_NICKNAME (자동으로 넘어가지 않는다)');
  eq((await api('signup', { username: nextName(), password: PASSWORD, nickname: { x: 1 } })).error, 'INVALID_NICKNAME', '44 문자열이 아닌 닉네임도 거절');

  // 45. 자동 닉네임 계정도 평범한 계정: 로그인 · 닉네임 변경 · 소켓 접속 (프로필 이름 = 서버 닉네임)
  const who = made[0];
  const renamed = await api('rename', { token: who.token, nickname: '바꾼이름' });
  eq([renamed.ok, renamed.nickname], [true, '바꾼이름'], '45 자동 닉네임은 나중에 마음대로 바꿀 수 있다');
  const c = await client(port, { token: made[1].token });
  const reg = await c.call('register_player', { token: made[1].token });
  eq([reg.ok, reg.user?.nickname], [true, made[1].nickname], '45 소켓 로그인에서도 서버가 붙인 닉네임');
  await server.stop();

  // 46. Supabase 흉내: 흔한 이름(기본 조합 400개)이 모두 이미 있어도 → 숫자를 붙여 겹치지 않게
  const rows = bases.map((nickname, i) => ({ user_id: randomUUID(), username: `pre${i}`, password_hash: 'p1$x$y', nickname, wins: 0, losses: 0, streak: 0, max_streak: 0, mmr: 1000 }));
  const db = fakeSupabase(rows);
  const dbServer = testServer({ quiet: true, onError, supabaseClient: db, authSecret: 'test-secret' });
  const dbPort = await dbServer.start(0, '127.0.0.1');
  const dbApi = apiOf(dbPort);
  const crowded = await dbApi('signup', { username: nextName(), password: PASSWORD });
  ok(crowded.ok && /\d{2}$/.test(crowded.nickname) && cleanNickname(crowded.nickname) === crowded.nickname, `46 흔한 이름이 모두 찼으면 숫자를 붙인다 (${crowded.nickname})`);
  const row = [...db.table.values()].find((r) => r.user_id === crowded.user_id);
  eq([row?.nickname, row?.username === undefined], [crowded.nickname, false], '46 DB 행에도 그 닉네임으로 저장');
  const twice = await dbApi('signup', { username: nextName(), password: PASSWORD });
  ok(twice.ok && twice.nickname !== crowded.nickname, '46 연달아 가입해도 겹치지 않는다');
  await dbServer.stop();
}

// ───────── Phase 11: 서버 지갑 · 출석 · 긴급 보급 · 조기 종료 · 같은 상대 제한 · 참가비 · 로비 통계 ─────────
async function phase11() {
  const DAY = 24 * 60 * 60 * 1000;
  let clockMs = Date.parse('2026-11-10T03:00:00Z'); // 한국 시간 11월 10일 정오
  const db = fakeSupabase([]);
  const options = { quiet: true, onError, supabaseClient: db, authSecret: 'test-secret', clock: () => clockMs, lobbyStatsMs: 60, graceMs: 250 };
  const server = testServer(options);
  const port = await server.start(0, '127.0.0.1');
  const api = apiOf(port);
  const w = (token, action, args = {}) => api('wallet', { token, action, ...args });
  const setBrass = async (acc, n) => { const wl = await server.users.getWallet(acc.user_id); wl.brass = n; server.users.commitWallet(acc.user_id); };
  const brassOf = async (acc) => (await w(acc.token, 'get')).wallet.brass;
  const row = (acc) => db.table.get(acc.user_id);

  // 61. 지갑 API: 로그인 필요 · 새 계정의 지갑 · DB 에도 컬럼으로
  const K = await signupVia(port, '지갑주인');
  eq([(await w('nope', 'get')).status, (await w('nope', 'get')).error], [401, 'AUTH_REQUIRED'], '61 토큰이 없거나 틀리면 지갑을 열 수 없다');
  eq((await w(K.token, 'teleport')).error, 'BAD_REQUEST', '61 모르는 동작은 거절');
  const first = await w(K.token, 'get');
  eq([first.ok, first.wallet.brass, first.wallet.owned, first.wallet.equipped, first.state.attendance.days, first.state.attendance.todayDay, first.state.emergency.eligible],
    [true, 300, { gun: ['steel'], table: ['obsidian'] }, { gun: 'steel', table: 'obsidian' }, 0, 1, false], '61 새 계정: 탄피 300 · 기본 스킨 · 출석 1일차 · 긴급 보급 대상 아님');
  eq([row(K).shells, row(K).attendance_days, row(K).emergency_count, row(K).last_checkin_date], [300, 0, 0, null], '61 Supabase players 행의 지갑 컬럼 (shells · attendance_days …)');
  eq(first.state.today, '2026-11-10', '61 날짜는 서버가 한국 시간으로 정한다');

  // 62. 구매 · 장착 · 상자: 서버가 검증한다 (모자라면 거절 · 한정 스킨은 탄피로 못 산다 · 모르는 값 거절)
  eq((await w(K.token, 'buy', { kind: 'gun', id: 'gold' })).result, { ok: false, reason: 'insufficient', short: 200 }, '62 탄피가 모자라면 구매 거절 (서버 값 기준)');
  await setBrass(K, 2000);
  const bought = await w(K.token, 'buy', { kind: 'gun', id: 'gold' });
  eq([bought.result.ok, bought.wallet.brass, bought.wallet.owned.gun], [true, 1500, ['steel', 'gold']], '62 구매 → 탄피 차감 · 보유 스킨');
  eq((await w(K.token, 'buy', { kind: 'gun', id: 'gold' })).result.reason, 'owned', '62 이미 가진 스킨은 다시 못 산다');
  eq([(await w(K.token, 'buy', { kind: 'gun', id: 'phantom_black' })).result.reason, (await w(K.token, 'buy', { kind: 'gun', id: 'nope' })).result.reason, (await w(K.token, 'buy', { kind: 'x', id: 'gold' })).result.reason, (await w(K.token, 'buy', { kind: 'gun' })).result.reason],
    ['not_for_brass', 'unknown', 'bad_request', 'bad_request'], '62 출석 한정 스킨은 탄피로 못 산다 · 없는 스킨 · 잘못된 종류 · 빠진 값');
  eq([(await w(K.token, 'equip', { kind: 'gun', id: 'cyber' })).result.reason, (await w(K.token, 'equip', { kind: 'gun', id: 'gold' })).result.ok], ['not_owned', true], '62 가진 스킨만 장착');
  await server.users.flush();
  eq([row(K).shells, row(K).unlocked_skins.gun, row(K).equipped_skin.gun], [1500, ['steel', 'gold'], 'gold'], '62 DB 컬럼(shells · unlocked_skins · equipped_skin)에 바로 저장');
  const tampered = await w(K.token, 'buy', { kind: 'table', id: 'lab', brass: 99999, price: 0, owned: ['lab'] }); // 클라이언트가 가격 · 보유를 속여 보내도 서버가 정한다
  eq([tampered.result.ok, tampered.wallet.brass, tampered.wallet.owned.table], [true, 700, ['obsidian', 'lab']], '62 가격 · 보유를 속인 값은 무시 (lab 800 차감)');
  const chest = await w(K.token, 'chest');
  eq([chest.result.ok, typeof chest.result.item.id, Object.keys(chest.result.item), chest.wallet.chest.opened], [true, 'string', ['id'], 1], '62 상자 추첨은 서버가 (결과는 아이템 id 만)');
  eq([(await w(K.token, 'taunt_buy', { id: 'knock' })).result.reason, (await w(K.token, 'taunt_equip', { id: 'knock' })).result.reason], ['insufficient', 'not_owned'], '62 도발도 서버 값으로 검증');

  // 63. 출석 체크: 한국 시간 하루 한 번 · 7일 사이클 · 서버 시계만 믿는다
  const D = await signupVia(port, '출석왕');
  const claim = async () => (await w(D.token, 'checkin', { today: '2099-01-01', day: 7, date: '1999-01-01' })).result; // 클라이언트가 날짜를 속여 보내도 무시
  const c1 = await claim();
  eq([c1.ok, c1.day, c1.reward.brass, await brassOf(D)], [true, 1, 100, 400], '63 1일차: 탄피 100 (날짜를 속여 보내도 서버 시계)');
  eq([(await claim()).error, await brassOf(D)], ['ALREADY_CHECKED_IN', 400], '63 같은 날 두 번째는 거절 — 탄피 그대로');
  eq((await w(D.token, 'get')).state.attendance, { days: 1, claimedToday: true, todayDay: 1, rewards: (await w(D.token, 'get')).state.attendance.rewards }, '63 오늘 받았다는 상태');
  clockMs = Date.parse('2026-11-10T14:59:00Z'); // 한국 시간 23:59 — 아직 같은 날
  eq((await claim()).error, 'ALREADY_CHECKED_IN', '63 한국 시간 23:59 는 아직 같은 날');
  clockMs = Date.parse('2026-11-10T15:01:00Z'); // 한국 시간 다음 날 00:01 — 새 날
  const c2 = await claim();
  eq([c2.ok, c2.day, c2.reward.item], [true, 2, { kind: 'table', id: 'silver_roulette' }], '63 한국 시간 자정이 지나면 2일차: 실버 룰렛 스킨');
  const days = [c2];
  for (let d = 3; d <= 7; d += 1) { clockMs += DAY; days.push(await claim()); }
  eq(days.map((r) => [r.day, r.reward.brass, r.reward.item?.id ?? null]), [[2, 0, 'silver_roulette'], [3, 200, null], [4, 0, 'blue_flame'], [5, 300, null], [6, 0, 'blood_gold'], [7, 500, 'phantom_black']], '63 3일차 200 · 4일차 블루 플레임 · 5일차 300 · 6일차 블러드 골드 · 7일차 500 + 팬텀 블랙');
  const afterCycle = await w(D.token, 'get');
  eq([afterCycle.wallet.brass, afterCycle.wallet.owned.gun, afterCycle.wallet.owned.table, afterCycle.wallet.flames], [1400, ['steel', 'blood_gold', 'phantom_black'], ['obsidian', 'silver_roulette'], ['blue_flame']], '63 사이클 보상이 지갑에 (시작 300 + 100 + 200 + 300 + 500 = 1400)');
  await server.users.flush();
  eq([row(D).attendance_days, row(D).last_checkin_date, row(D).wallet_extra.flames], [7, '2026-11-16', ['blue_flame']], '63 DB: attendance_days · last_checkin_date(한국 날짜) · wallet_extra');
  clockMs += DAY;
  const c8 = await claim();
  eq([c8.day, c8.reward.brass], [1, 100], '63 7일 다음은 다시 1일차');
  clockMs += DAY;
  const c9 = await claim();
  eq([c9.day, c9.reward.duplicate, c9.reward.brass, c9.reward.item], [2, true, 150, null], '63 이미 가진 스킨이면 탄피 150 으로 대체');
  clockMs += 3 * DAY; // 며칠 빠뜨려도 사이클은 이어진다
  eq((await claim()).day, 3, '63 빠뜨린 날이 있어도 사이클은 이어진다 (3일차)');

  // 64. 긴급 보급: 탄피가 가장 싼 유료 테이블 참가비(200) 미만일 때 하루 3번 +50
  const E = await signupVia(port, '빈털터리');
  eq((await w(E.token, 'emergency')).result.error, 'NOT_ELIGIBLE', '64 탄피가 충분하면(300) 긴급 보급 불가');
  await setBrass(E, 0);
  const status0 = (await w(E.token, 'get')).state.emergency;
  eq([status0.eligible, status0.left, status0.amount, status0.minFee], [true, 3, 50, 200], '64 탄피 0 → 대상 · 오늘 3번 남음 · 50 탄피 · 기준 200');
  const e = [];
  for (let i = 0; i < 4; i += 1) { const r = await w(E.token, 'emergency'); e.push(r.result.ok ? [r.result.amount, r.result.left] : r.result.error); }
  eq([e, await brassOf(E)], [[[50, 2], [50, 1], [50, 0], 'LIMIT_REACHED'], 150], '64 하루 3번까지 · 4번째는 거절 (탄피 150)');
  await setBrass(E, 0);
  eq((await w(E.token, 'emergency')).result.error, 'LIMIT_REACHED', '64 탄피를 다시 0 으로 만들어도 횟수는 그대로 (서버가 센다)');
  clockMs += DAY;
  eq((await w(E.token, 'emergency')).result.ok, true, '64 한국 시간 다음 날이면 다시 받을 수 있다');
  await server.users.flush();
  eq([row(E).emergency_date, row(E).emergency_count], ['2026-11-22', 1], '64 DB: emergency_date · emergency_count');

  // 65. AI 연습 보상: 하루 5판까지 (승 150 · 패 40) — 서버가 검증할 수 없는 판이라 횟수로 제한
  const P = await signupVia(port, '연습생');
  const got = [];
  for (let i = 0; i < 6; i += 1) { const r = await w(P.token, 'practice', { won: i % 2 === 0 ? true : 'yes' }); got.push(r.result.granted); } // 문자열 'yes' 는 승리로 안 친다
  eq([got, await brassOf(P)], [[150, 40, 150, 40, 150, 0], 300 + 530], '65 하루 5판까지만 지급 (이긴 판 150 · 진 판 40 · 6번째는 0)');
  eq((await w(P.token, 'get')).state.practice, { perDay: 5, left: 0 }, '65 남은 횟수 0');
  clockMs += DAY;
  eq((await w(P.token, 'practice', { won: true })).result.granted, 150, '65 다음 날에는 다시');

  // 66. 요청 한도 (계정당 10초 40번)
  const R = await signupVia(port, '연타');
  const statuses = [];
  for (let i = 0; i < 46; i += 1) statuses.push((await w(R.token, 'get')).status); // HTTP 상태
  ok(statuses.slice(0, 40).every((x) => x === 200) && statuses.slice(40).every((x) => x === 429), '66 같은 계정이 지갑을 연타하면 429 RATE_LIMITED');

  // 67. 재시작해도 그대로 (DB 지갑 컬럼에서 다시 읽는다)
  await server.stop();
  const again = testServer(options);
  const port2 = await again.start(0, '127.0.0.1');
  const back = await apiOf(port2)('wallet', { token: D.token, action: 'get' });
  eq([back.wallet.brass, back.wallet.owned.gun, back.state.attendance.days], [afterCycle.wallet.brass + 100 + 150 + 200, ['steel', 'blood_gold', 'phantom_black'], 3], '67 서버를 다시 켜도 탄피 · 스킨 · 출석 그대로 (Supabase 에서)');
  await again.stop();

  // 68. 지갑 컬럼이 아직 없는 DB: 지갑만 꺼지고(503) 가입 · 로그인 · 대전은 그대로, 참가비는 클라이언트가 (feePaid false)
  const bare = fakeSupabase([], { walletColumns: false });
  const bareErrors = [];
  const bareServer = testServer({ quiet: true, onError: (err) => bareErrors.push(err.message), supabaseClient: bare, authSecret: 'test-secret' });
  const barePort = await bareServer.start(0, '127.0.0.1');
  const bareApi = apiOf(barePort);
  const old = await signupVia(barePort, '예전방식');
  eq([(await bareApi('wallet', { token: old.token, action: 'get' })).status, (await bareApi('wallet', { token: old.token, action: 'get' })).error], [503, 'WALLET_SETUP_REQUIRED'], '68 지갑 컬럼이 없으면 지갑 API 는 503 (SQL 안내가 서버 로그에)');
  eq([bareServer.users.health().walletReady, bareServer.users.health().accountReady, (await bareApi('login', { username: old.username, password: PASSWORD })).ok], [false, true, true], '68 그래도 계정 · 로그인은 정상');
  const [oa, ob] = [await player(barePort, '예전A'), await player(barePort, '예전B')];
  await oa.call('join_queue', { tier: 'pro', profile: {} });
  await ob.call('join_queue', { tier: 'pro', profile: {} });
  const oldMatch = await oa.waitFor('match_found');
  eq([oldMatch.fee, oldMatch.feePaid], [200, false], '68 지갑이 없으면 참가비는 예전처럼 클라이언트가 (feePaid false)');
  ok(bareErrors.some((m) => m.includes('shells') && m.includes('alter table public.players add column if not exists shells')), '68 서버 로그에 실행할 SQL(WALLET_SQL)이 그대로 나온다');
  await bareServer.stop();

  // 69. 참가비 선결제 · 환불 · 상금 (pro 테이블 참가비 200 · 승자 360)
  const s2 = testServer(options);
  const p2 = await s2.start(0, '127.0.0.1');
  const api2 = apiOf(p2);
  const W = (acc, action, args = {}) => api2('wallet', { token: acc.token, action, ...args });
  const Q1 = await player(p2, '참가자A');
  const Q2 = await player(p2, '참가자B');
  const poor = await player(p2, '무일푼');
  const setB = async (acc, n) => { const wl = await s2.users.getWallet(acc.account.user_id); wl.brass = n; s2.users.commitWallet(acc.account.user_id); };
  await setB(poor, 150);
  eq((await poor.call('join_queue', { tier: 'pro', profile: {} })).error, 'INSUFFICIENT_BRASS', '69 서버 지갑의 탄피가 모자라면 입장 거절 (클라이언트가 속일 수 없다)');
  eq([s2.stats().queued, (await W(poor.account, 'get')).wallet.brass], [0, 150], '69 거절되면 대기열에도 없고 탄피도 그대로');
  eq((await Q1.call('join_queue', { tier: 'pro', profile: {} })).ok, true, '69 대기열 입장');
  eq((await W(Q1.account, 'get')).wallet.brass, 100, '69 참가비 200 은 대기열에 들어갈 때 서버가 먼저 받는다 (300 → 100)');
  await Q1.call('leave_queue');
  eq([(await W(Q1.account, 'get')).wallet.brass, s2.stats().queued], [300, 0], '69 대기를 취소하면 참가비를 돌려준다');
  await Q1.call('join_queue', { tier: 'pro', profile: {} });
  Q1.socket.disconnect();
  await sleep(60);
  eq([(await W(Q1.account, 'get')).wallet.brass, s2.stats().queued], [300, 0], '69 대기 중 연결이 끊겨도 돌려준다');
  const Q1b = await client(p2, { token: Q1.account.token });
  Q1b.account = Q1.account;
  await Q1b.call('join_queue', { tier: 'pro', profile: {} });
  await Q2.call('join_queue', { tier: 'pro', profile: {} });
  const [pm1, pm2] = await Promise.all([Q1b.waitFor('match_found', (p) => p.mode === 'queue'), Q2.waitFor('match_found', (p) => p.mode === 'queue')]);
  eq([pm1.fee, pm1.feePaid, pm2.feePaid, (await W(Q2.account, 'get')).wallet.brass], [200, true, true, 100], '69 매칭 → feePaid true (클라이언트는 따로 내지 않는다) · 둘 다 100 남음');
  await finishRound1(Q1b, Q2, pm1.code);
  await Q1b.call('surrender');
  const [po1, po2] = await Promise.all([Q1b.waitFor('game_over', (p) => p.code === pm1.code), Q2.waitFor('game_over', (p) => p.code === pm1.code)]);
  eq([po1.youWon, po1.reward, po1.wallet.brass, po2.youWon, po2.reward, po2.wallet.brass], [false, { brass: 0, refunded: 0 }, 100, true, { brass: 360, refunded: 0 }, 460], '69 1라운드 뒤 항복: 승자는 상금 360 (100 → 460) · 항복자는 참가비를 잃는다 (game_over 에 reward · wallet)');
  eq([po1.voided, po2.voided], [null, null], '69 정상 정산');

  // 70. 조기 종료(1라운드 전 항복 · 이탈 · 끊김) → MMR · 전적 · 보상 무효, 참가비 환불
  const [X1, X2] = [await player(p2, '조기A'), await player(p2, '조기B')];
  await X1.call('join_queue', { tier: 'pro', profile: {} });
  await X2.call('join_queue', { tier: 'pro', profile: {} });
  const xm = await X1.waitFor('match_found', (p) => p.mode === 'queue' && p.code !== pm1.code);
  await X2.waitFor('match_found', (p) => p.code === xm.code);
  eq((await W(X1.account, 'get')).wallet.brass, 100, '70 (참가비 200 을 낸 상태)');
  await X1.call('surrender'); // 1라운드가 끝나기 전
  const [xo1, xo2] = await Promise.all([X1.waitFor('game_over', (p) => p.code === xm.code), X2.waitFor('game_over', (p) => p.code === xm.code)]);
  eq([xo1.voided, xo2.voided, xo1.mmrDelta, xo2.mmrDelta, xo1.record?.mmr, xo2.record?.mmr, xo1.record?.losses, xo2.record?.wins], ['EARLY_END', 'EARLY_END', undefined, undefined, 1000, 1000, 0, 0], '70 조기 종료: voided EARLY_END · MMR · 전적 변동 없음');
  eq([xo1.reward, xo2.reward, xo1.payout, xo2.payout, xo2.youWon], [{ brass: 0, refunded: 200 }, { brass: 0, refunded: 200 }, 0, 0, true], '70 보상 없음 · 상금 없음 · 참가비 200 환불 (승패 표시는 그대로)');
  eq([(await W(X1.account, 'get')).wallet.brass, (await W(X2.account, 'get')).wallet.brass], [300, 300], '70 두 사람 탄피 모두 원래대로 (300)');
  eq([s2.users.get(X1.account.user_id).losses, s2.users.get(X2.account.user_id).wins], [0, 0], '70 서버 전적에도 반영 없음');
  // 공개 방 이탈 · 끊김도 마찬가지
  const [Y1, Y2] = [await player(p2, '이탈A'), await player(p2, '이탈B')];
  const yroom = await Y1.call('create_public_room', {});
  await Y2.call('join_public_room', { code: yroom.code });
  await Promise.all([Y1.waitFor('match_found', (p) => p.code === yroom.code), Y2.waitFor('match_found', (p) => p.code === yroom.code)]);
  await Y2.call('leave_room');
  eq([(await Y1.waitFor('game_over', (p) => p.code === yroom.code)).voided, s2.users.get(Y1.account.user_id).wins], ['EARLY_END', 0], '70 공개 방에서 1라운드 전에 나가면 무효');
  const [Z1, Z2] = [await player(p2, '끊김A'), await player(p2, '끊김B')];
  const [zm] = await queueMatch(Z1, Z2);
  Z2.socket.disconnect(); // 유예(250ms) 안에 돌아오지 않는다
  const zo = await Z1.waitFor('game_over', (p) => p.code === zm.code, 3000);
  eq([zo.reason, zo.voided, zo.mmrDelta], ['forfeit', 'EARLY_END', undefined], '70 1라운드 전 연결 끊김(부전승)도 무효');
  // 친선 비밀방은 MMR 이 없지만 보상은 같은 규칙
  const [F1, F2] = [await player(p2, '친선가A'), await player(p2, '친선가B')];
  const froom = await F1.call('create_private_room', {});
  await F2.call('join_private_room', froom.code);
  await Promise.all([F1.waitFor('match_found', (p) => p.code === froom.code), F2.waitFor('match_found', (p) => p.code === froom.code)]);
  await F1.call('surrender');
  const fo = await F2.waitFor('game_over', (p) => p.code === froom.code);
  eq([fo.voided, fo.reward.brass, (await W(F2.account, 'get')).wallet.brass], ['EARLY_END', 0, 300], '70 친선 비밀방도 1라운드 전 종료면 보상 없음 (친선방 보상 어뷰징 차단)');

  // 71. 정상 종료의 보상: 랭킹전 승자 150 + 연승 보너스 30 · 패자 40 / 친선 150 · 40 (연승 보너스 없음)
  const [G1, G2] = [await player(p2, '정산A'), await player(p2, '정산B')];
  const [gm] = await queueMatch(G1, G2);
  await finishRound1(G1, G2, gm.code);
  await G1.call('surrender');
  const [go1, go2] = await Promise.all([G1.waitFor('game_over', (p) => p.code === gm.code), G2.waitFor('game_over', (p) => p.code === gm.code)]);
  eq([go1.reward.brass, go2.reward.brass, go1.wallet.brass, go2.wallet.brass, go2.voided], [40, 180, 340, 480, null], '71 랭킹전: 패자 +40 · 승자 +150 + 연승 보너스 30 (서버가 지급 — game_over.wallet 이 정산 뒤 지갑)');
  const proom = await G1.call('create_private_room', {});
  await G2.call('join_private_room', proom.code);
  await Promise.all([G1.waitFor('match_found', (p) => p.code === proom.code), G2.waitFor('match_found', (p) => p.code === proom.code)]);
  await finishRound1(G1, G2, proom.code);
  await G1.call('surrender');
  const [fo1, fo2] = await Promise.all([G1.waitFor('game_over', (p) => p.code === proom.code), G2.waitFor('game_over', (p) => p.code === proom.code)]);
  eq([fo1.reward.brass, fo2.reward.brass, fo2.mmrDelta], [40, 150, undefined], '71 친선: 패자 +40 · 승자 +150 (연승 보너스 · MMR 없음)');

  // 72. 같은 두 계정은 하루(한국 시간) 3판까지만 랭킹 정산
  const [U, V] = [await player(p2, '단골A'), await player(p2, '단골B')];
  const outcomes = [];
  for (let i = 0; i < 4; i += 1) {
    const [m] = await queueMatch(U, V);
    await finishRound1(U, V, m.code);
    await V.call('surrender');
    const o = await U.waitFor('game_over', (p) => p.code === m.code);
    outcomes.push([o.voided, o.mmrDelta ?? null, o.reward.brass]);
  }
  eq(outcomes.map((o) => o[0]), [null, null, null, 'PAIR_LIMIT'], '72 같은 상대와 4번째 판은 PAIR_LIMIT 으로 무효');
  eq(outcomes.map((o) => o[1]), [25, 25, 25, null], '72 앞 3판은 MMR +25, 4번째는 변동 없음');
  eq([s2.users.get(U.account.user_id).mmr, s2.users.get(V.account.user_id).mmr, s2.users.get(U.account.user_id).wins], [1075, 940, 3], '72 서버 전적: 3판만 반영 (1075 · 940)');
  eq(outcomes[3][2], 0, '72 무효가 된 판은 탄피 보상도 없다');
  const other = await player(p2, '다른상대');
  const [m5] = await queueMatch(U, other);
  await finishRound1(U, other, m5.code);
  await other.call('surrender');
  eq((await U.waitFor('game_over', (p) => p.code === m5.code)).voided, null, '72 다른 상대와는 따로 센다');
  clockMs += DAY;
  const [m6] = await queueMatch(U, V);
  await finishRound1(U, V, m6.code);
  await V.call('surrender');
  eq((await U.waitFor('game_over', (p) => p.code === m6.code)).voided, null, '72 한국 시간으로 날이 바뀌면 다시 반영');

  // 73. 상대에게 보이는 스킨 · 칭호는 서버 지갑의 장착값 (클라이언트가 보낸 값 무시)
  const [S1, S2] = [await player(p2, '장착A'), await player(p2, '장착B')];
  await setB(S1, 2000);
  await W(S1.account, 'buy', { kind: 'gun', id: 'gold' });
  await W(S1.account, 'equip', { kind: 'gun', id: 'gold' });
  const sroom = await S1.call('create_private_room', { profile: { cosmetics: { gun: 'crimson', table: 'velvet', flame: 'plasma', taunt: 'knock' } } });
  await S2.call('join_private_room', sroom.code);
  const [, sm2] = await Promise.all([S1.waitFor('match_found', (p) => p.code === sroom.code), S2.waitFor('match_found', (p) => p.code === sroom.code)]);
  eq(sm2.opponent.profile.cosmetics, { gun: 'gold', table: 'obsidian', flame: 'native', taunt: null }, '73 상대 화면의 스킨 = 서버가 아는 장착값 (보낸 crimson · velvet · plasma · knock 은 무시)');
  await S1.call('leave_room');

  // 74. 로비: 접속자 · 대기 인원 (watch_rooms 응답 + lobby_stats 주기 방송)
  const L1 = await client(p2);
  const watched = await L1.call('watch_rooms');
  ok(watched.ok && Number.isInteger(watched.online) && watched.online >= 2 && Number.isInteger(watched.queued), '74 watch_rooms 응답에 online(접속자) · queued(대기 인원)');
  const stat = await L1.waitFor('lobby_stats', () => true, 1500);
  ok(Number.isInteger(stat.online) && Number.isInteger(stat.queued) && Number.isInteger(stat.rooms), '74 lobby_stats 가 몇 초마다 온다 (online · queued · rooms)');
  await L1.call('unwatch_rooms');
  const seen = L1.inbox.filter((m) => m.event === 'lobby_stats').length;
  await sleep(250);
  eq(L1.inbox.filter((m) => m.event === 'lobby_stats').length, seen, '74 로비를 그만 보면 더는 받지 않는다');
  await s2.stop();
}

// ───────── Phase 12: 친선 비밀방 초대 — 방장이 링크를 보내러 자리를 비워도 방이 남는다 ─────────
async function phase12() {
  const server = testServer({ quiet: true, onError, userDataFile: null, authSecret: 'test-secret', hostAwayMs: 700 });
  const port = await server.start(0, '127.0.0.1');
  const again = async (who) => { const c = await client(port, { token: who.account.token }); c.account = who.account; return c; };
  const join = async (who, code) => who.call('join_private_room', code);

  const [host, friend, other] = [await player(port, '초대방장'), await player(port, '초대친구'), await player(port, '다른사람')];
  const made = await host.call('create_private_room', {});
  host.socket.disconnect(); // 링크를 보내러 다른 앱으로 — 연결이 끊김
  await sleep(60);
  eq([server.stats().waiting, (await join(friend, made.code)).error], [1, 'HOST_AWAY'], '75 방장이 끊겨도 친선 대기 방은 남고, 그동안 친구에게는 HOST_AWAY');
  eq((await other.call('resume_room', { code: made.code })).error, 'ROOM_NOT_FOUND', '75 다른 계정은 방을 가져갈 수 없다');
  const host2 = await again(host);
  eq((await join(host2, made.code)).error, 'OWN_ROOM', '75 방장 본인이 코드로 들어오려 하면 OWN_ROOM');
  eq(await host2.call('resume_room', { code: made.code }), { ok: true, code: made.code, mode: 'private', status: 'waiting' }, '75 돌아온 방장(같은 계정)은 방을 다시 받는다');
  eq((await host2.call('resume_room', { code: made.code })).status, 'waiting', '75 resume_room 은 여러 번 불러도 안전');
  eq((await join(friend, made.code)).ok, true, '75 그 뒤 친구가 입장하면 판이 시작된다');
  const [m1, m2] = await Promise.all([host2.waitFor('match_found', (p) => p.code === made.code), friend.waitFor('match_found', (p) => p.code === made.code)]);
  eq([m1.mode, m2.mode, server.stats().playing], ['private', 'private', 1], '75 새 연결의 방장도 match_found 를 받는다');

  // 76. 같은 계정이 새 접속으로 들어오면 끊긴 채 남은 기존 방을 알려 준다 · 방은 최소 3분 유지
  ok(ROOM_DEFAULTS.hostAwayMs >= 180_000 && ROOM_DEFAULTS.roomTtlMs >= 180_000, '76 기본값: 끊긴 방장을 3분 넘게 기다린다');
  const [h3, f3] = [await player(port, '복귀방장'), await player(port, '복귀친구')];
  const r3 = await h3.call('create_private_room', {});
  eq((await h3.call('register_player', { token: h3.account.token })).hostedRoom, undefined, '76 연결이 살아 있는 방은 알리지 않는다 (다른 창이 방을 가져가지 않게)');
  h3.socket.disconnect();
  await sleep(60);
  const h3b = await again(h3);
  eq((await h3b.call('register_player', { token: h3.account.token })).hostedRoom, r3.code, '76 끊겼던 방장이 다시 접속하면 기존 방 코드를 알려 준다');
  eq((await f3.call('register_player', { token: f3.account.token })).hostedRoom, undefined, '76 다른 계정에게는 알리지 않는다');
  eq((await h3b.call('resume_room', { code: r3.code })).status, 'waiting', '76 방장 자리 복구');
  eq((await join(f3, r3.code)).ok, true, '76 그 뒤 친구 입장 → 시작');

  // 77. 오래 비우면 닫힌다 · 직접 닫으면 바로 · 새 방을 만들면 이전 빈 방은 닫는다
  const [h4, f4] = [await player(port, '만료방장'), await player(port, '만료친구')];
  const r4 = await h4.call('create_private_room', {});
  h4.socket.disconnect();
  await sleep(900);
  eq((await join(f4, r4.code)).error, 'ROOM_NOT_FOUND', '77 비움 시간이 지나면 방이 닫힌다');
  const h5 = await player(port, '닫는방장');
  const r5 = await h5.call('create_private_room', {});
  await h5.call('leave_room');
  eq((await join(f4, r5.code)).error, 'ROOM_NOT_FOUND', '77 방장이 [방 닫기]를 누르면 바로 닫힌다');
  const h6 = await player(port, '새방방장');
  const r6 = await h6.call('create_private_room', {});
  h6.socket.disconnect();
  await sleep(60);
  const h6b = await again(h6);
  const r7 = await h6b.call('create_private_room', {});
  eq([(await join(f4, r6.code)).error, r7.ok, server.stats().waiting], ['ROOM_NOT_FOUND', true, 1], '77 같은 계정이 새 방을 만들면 이전 빈 방은 닫는다');

  // 78. 서버가 방장의 끊김을 알아채기 전에 친구가 들어와 판이 시작됨 → 돌아온 방장은 튕기지 않고 그 판의 자기 자리로
  const [h8, f8] = [await player(port, '늦은방장'), await player(port, '빠른친구')];
  const r8 = await h8.call('create_private_room', {});
  await join(f8, r8.code); // h8 의 옛 연결은 살아 있는 것으로 보인다 (실제 기기에서는 이미 멈춘 상태)
  const first = await h8.waitFor('match_found', (p) => p.code === r8.code);
  const h8b = await again(h8);
  const back = await h8b.call('resume_room', { code: r8.code });
  eq([back.ok, back.status], [true, 'playing'], '78 resume_room: 그새 시작된 판이면 status playing');
  const [m8, s8] = await Promise.all([h8b.waitFor('match_found', (p) => p.code === r8.code), h8b.waitFor('state_update', (p) => p.code === r8.code)]);
  eq([m8.resume, m8.you, m8.token, s8.reason, s8.logFrom], [true, first.you, first.token, 'rejoin', 0], '78 새 연결에 match_found(resume) · 같은 좌석 · 전체 상태');
  const f8m = await f8.waitFor('match_found', (p) => p.code === r8.code);
  eq([f8m.resume, server.stats().playing >= 1], [false, true], '78 친구의 판은 그대로');
  const turn = await (async () => { // 1턴: 차례인 쪽이 격발하면 양쪽이 같은 상태 갱신을 받는다
    const shooter = s8.state.turn.isMine ? h8b : f8;
    const before = [h8b, f8].map((p) => p.inbox.filter((m) => m.event === 'state_update' && m.payload.code === r8.code).length);
    const ack = await shooter.call('game_action', { type: 'shoot', target: 'opponent' });
    await sleep(80);
    return [ack.ok, [h8b, f8].every((p, i) => p.inbox.filter((m) => m.event === 'state_update' && m.payload.code === r8.code).length > before[i])];
  })();
  eq(turn, [true, true], '78 1턴 진행 — 양쪽 모두 상태 갱신');
  eq((await f4.call('resume_room', { code: r8.code })).error, 'ROOM_NOT_FOUND', '78 그 판의 사람이 아니면 자리를 가져갈 수 없다');
  await server.stop();
}

// ───────── Phase 13: 전송 데이터 — 탄창 순서는 어디에도 없고, 시점 상태가 로그와 짝을 이룬다 ─────────
async function phase13() {
  const server = testServer({ quiet: true, onError, userDataFile: null, authSecret: 'test-secret' });
  const port = await server.start(0, '127.0.0.1');
  const [A, B] = [await player(port, '엿보기A'), await player(port, '엿보기B')];
  const room = await A.call('create_private_room', {});
  await B.call('join_private_room', room.code);
  await Promise.all([A.waitFor('state_update', (p) => p.code === room.code), B.waitFor('state_update', (p) => p.code === room.code)]);
  const updates = (who) => who.inbox.filter((m) => m.event === 'state_update' && m.payload.code === room.code).map((m) => m.payload);
  const latest = (who) => updates(who).at(-1).state;
  for (let i = 0; i < 60 && !latest(A).winner; i += 1) {
    const actor = latest(A).turn?.isMine ? A : latest(B).turn?.isMine ? B : null;
    if (actor) {
      if (latest(actor).me.items.length && i % 3 === 0) await actor.call('game_action', { type: 'use_item', index: 0 });
      await actor.call('game_action', { type: 'shoot', target: i % 2 ? 'self' : 'opponent' });
    }
    await sleep(15);
  }
  const all = [...updates(A), ...updates(B)];
  ok(all.length > 10 && all.every((p) => Array.isArray(p.views) && p.views.length === p.events.length && p.views.every(Boolean)), '79 state_update 마다 사건 수만큼의 시점 상태(views)');
  ok(all.every((p) => !/chamber|"(LIVE|BLANK)"/.test(JSON.stringify([p.state, p.views]))), '79 상태 · 시점 상태에는 탄창 · 탄종 배열이 없다');
  const keys = JSON.stringify(['blank', 'live', 'me', 'obscured', 'opponent', 'round', 'total', 'turn', 'winner']);
  ok(all.every((p) => [p.state, ...p.views].every((v) => JSON.stringify(Object.keys(v).sort()) === keys)), '79 상태에 실리는 것은 정해진 항목뿐 (남은 수 · 차례 · 체력 · 아이템)');
  const spent = (e) => e.type === 'SHOT' || e.item === 'EJECT' || e.stolen === 'EJECT'; // 이미 나갔거나 빼낸 탄만 공개
  const leaked = [A, B].flatMap((who) => {
    const mine = updates(who)[0].state.me.id;
    return updates(who).flatMap((p) => p.events).filter((e) => 'shell' in e && !spent(e) && e.actor !== mine);
  });
  eq(leaked, [], '79 투시경으로 본 탄은 쓴 사람에게만 (상대의 사건에는 탄종이 없다)');
  await server.stop();
}

// ───────── Phase 14: 외부 공격 · 치트 · 어뷰징 방어 ─────────
async function phase14() {
  const server = createGameServer({ // 제한을 좁혀서 검사 (testServer 의 넉넉한 값을 쓰지 않는다)
    quiet: true, onError, userDataFile: null, authSecret: 'test-secret',
    signupPer10Min: 4, roomsPerMinute: 4, joinFailsPerMinute: 3, maxSocketsPerIp: 8, loginLimits: { maxPerIp: 30 },
  });
  const port = await server.start(0, '127.0.0.1');
  const base = `http://127.0.0.1:${port}`;

  // 80. 보안 헤더 · 정적 파일 허용 목록 · 상태 주소가 내부 정보를 내보내지 않음
  const want = { 'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY', 'referrer-policy': 'strict-origin-when-cross-origin' };
  const headersOf = async (path) => (await fetch(`${base}${path}`)).headers;
  for (const path of ['/', '/style.css', '/healthz', '/nope', '/socket.io/?EIO=4&transport=polling']) {
    const h = await headersOf(path);
    eq(Object.keys(want).map((k) => h.get(k)), Object.values(want), `80 보안 헤더: ${path.split('?')[0]}`);
  }
  ok(/frame-ancestors 'none'/.test((await headersOf('/')).get('content-security-policy') ?? ''), '80 다른 사이트의 iframe 에 담기지 않는다');
  const status = async (path) => (await fetch(`${base}${path}`)).status;
  for (const path of ['/server/index.js', '/server/userStore.js', '/tests/server.test.mjs', '/package.json', '/.env', '/.git/config', '/scripts/build-www.mjs', '/notes.txt', '/backup.sql', '/capacitor.config.json', '/node_modules/express/package.json']) {
    eq(await status(path), 404, `80 공개하지 않는 경로: ${path}`);
  }
  eq(await Promise.all(['/', '/index.html', '/style.css', '/src/ui/app.js', '/manifest.webmanifest'].map(status)), [200, 200, 200, 200, 200], '80 게임에 필요한 파일은 그대로');
  const health = await (await fetch(`${base}/healthz`)).json();
  eq([health.ok, 'dbHost' in health, 'dbKey' in health, 'node' in health, 'users' in health, typeof health.dbError, health.ipSource], [true, false, false, false, false, 'boolean', 'socket'], '80 /healthz 는 상태만 (DB 주소 · 키 종류 · 버전 · 오류 원문 없음)');

  // 81. IP 판별: 클라이언트가 지어낸 X-Forwarded-For 로는 제한을 피할 수 없다
  eq([
    clientAddress({ 'x-forwarded-for': '1.1.1.1', 'cf-connecting-ip': '2.2.2.2' }, '9.9.9.9').ip,
    clientAddress({ 'x-forwarded-for': '6.6.6.6, 3.3.3.3' }, '9.9.9.9', { proxyHops: 1 }).ip,
    clientAddress({ 'x-forwarded-for': '6.6.6.6, 3.3.3.3', 'cf-connecting-ip': '2.2.2.2' }, '9.9.9.9', { trustCloudflare: true, proxyHops: 1 }).ip,
  ], ['9.9.9.9', '3.3.3.3', '2.2.2.2'], '81 믿기로 한 앞단이 붙인 값만 읽는다 (기본은 소켓 주소 · 프록시는 뒤에서부터 · Cloudflare 헤더)');

  // 82. 가입 속도 제한
  const signup = async (i, headers = {}) => (await fetch(`${base}/api/signup`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ username: `sec_user${i}`, password: PASSWORD }) })).json();
  const joined = [];
  for (let i = 0; i < 6; i += 1) joined.push(await signup(i, { 'x-forwarded-for': `10.0.0.${i}` }));
  eq(joined.map((r) => r.error ?? 'ok'), ['ok', 'ok', 'ok', 'ok', 'RATE_LIMITED', 'RATE_LIMITED'], '82 같은 IP 의 가입 도배 차단 (위조 헤더를 바꿔 가며 보내도)');
  const as = async (i) => { const c = await client(port, { token: joined[i].token }); c.account = joined[i]; return c; };

  // 83. 계정당 활성 방 · 대기 1개 (창을 여러 개 열어도)
  const [a1, a2, b1] = [await as(0), await as(0), await as(1)];
  const room = await a1.call('create_public_room', {});
  eq([room.ok, (await a2.call('create_private_room', {})).error, (await a2.call('join_queue', { tier: 'free' })).error], [true, 'ACCOUNT_BUSY', 'ACCOUNT_BUSY'], '83 방을 연 계정의 두 번째 창은 새 방 · 대기 불가');
  const other = await b1.call('create_private_room', {});
  eq((await a2.call('join_private_room', other.code)).error, 'ACCOUNT_BUSY', '83 다른 방 입장도 불가');
  await a1.call('leave_room');
  await b1.call('leave_room');

  // 84. 방 만들기 · 매칭 요청 속도 제한 (계정당)
  const c2 = await as(2);
  const burst = [];
  for (let i = 0; i < 6; i += 1) { const r = await c2.call('create_public_room', {}); burst.push(r.error ?? 'ok'); if (r.ok) await c2.call('leave_room'); }
  eq(burst, ['ok', 'ok', 'ok', 'ok', 'RATE_LIMITED', 'RATE_LIMITED'], '84 방 만들기 연타 차단');

  // 85. 방 코드 대입 차단
  const d = await as(3);
  const real = await b1.call('create_private_room', {});
  const guesses = [];
  for (const code of ['AAAA', 'BBBB', 'CCCC', 'DDDD', real.code]) guesses.push((await d.call('join_private_room', code)).error ?? 'ok');
  eq(guesses, ['ROOM_NOT_FOUND', 'ROOM_NOT_FOUND', 'ROOM_NOT_FOUND', 'RATE_LIMITED', 'RATE_LIMITED'], '85 없는 방을 3번 두드리면 잠시 막는다 (맞는 코드도)');
  await b1.call('leave_room');
  await server.stop();

  // 86. 인게임 입력: 내 좌석 · 내 차례 · 실제 가진 아이템 · 중복 입력
  const play = testServer({ quiet: true, onError, userDataFile: null, authSecret: 'test-secret' });
  const p = await play.start(0, '127.0.0.1');
  const [X, Y] = [await player(p, '치트X'), await player(p, '치트Y')];
  const made = await X.call('create_private_room', {});
  await Y.call('join_private_room', made.code);
  const [sx, sy] = await Promise.all([X.waitFor('state_update', (m) => m.code === made.code), Y.waitFor('state_update', (m) => m.code === made.code)]);
  const [me, foe, mine] = sx.state.turn.isMine ? [X, Y, sx] : [Y, X, sy];
  const seq = mine.logFrom + mine.events.length;
  eq((await foe.call('game_action', { type: 'shoot', target: 'self' })).error, 'NOT_YOUR_TURN', '86 상대 차례에 격발 불가');
  eq([(await me.call('game_action', { type: 'use_item', index: 99, item: 'SCOPE' })).error, (await me.call('game_action', { type: 'use_item', index: '0' })).error, (await me.call('game_action', { type: 'give_item' })).error], ['INVALID_ITEM', 'INVALID_ITEM', 'INVALID_ACTION'], '86 갖지 않은 아이템 · 지어낸 값 · 모르는 동작 거절 (보낸 item 이름은 읽지 않는다)');
  eq((await me.call('game_action', { type: 'shoot', target: 'self', seq: seq - 1 })).error, 'STALE_ACTION', '86 지난 상태에 대한 입력 거절');
  const twice = await Promise.all([me.call('game_action', { type: 'shoot', target: 'self', seq }), me.call('game_action', { type: 'shoot', target: 'self', seq })]);
  eq(twice.map((r) => r.error ?? 'ok'), ['ok', 'STALE_ACTION'], '86 같은 입력이 두 번 도착하면 한 번만 처리 (더블 클릭 · 재전송)');
  const outsider = await player(p, '구경꾼');
  eq([(await outsider.call('game_action', { type: 'shoot', target: 'opponent' })).error, (await outsider.call('surrender')).error], ['NOT_IN_GAME', 'NOT_IN_GAME'], '86 그 판에 앉지 않은 소켓의 입력은 무시');
  await play.stop();

  // 87. IP 당 동시 접속 수
  const small = testServer({ quiet: true, onError, maxSocketsPerIp: 2 });
  const sp = await small.start(0, '127.0.0.1');
  const open = () => new Promise((resolve) => {
    const s = connect(`http://127.0.0.1:${sp}`, { transports: ['websocket'], reconnection: false, forceNew: true });
    allSockets.push(s);
    s.once('connect', () => resolve({ s, error: null }));
    s.once('connect_error', (err) => resolve({ s, error: err.message }));
  });
  const [o1, o2, o3] = [await open(), await open(), await open()];
  eq([o1.error, o2.error, o3.error], [null, null, 'RATE_LIMITED'], '87 같은 IP 의 소켓 도배 차단');
  o1.s.close();
  await sleep(80);
  eq((await open()).error, null, '87 연결을 닫으면 다시 접속할 수 있다');
  await small.stop();
}

async function phase1() {
  const server = testServer({ quiet: true, onError });
  const port = await server.start(0, '127.0.0.1');
  eq([QUEUE_TIERS.free, QUEUE_TIERS.pro, QUEUE_TIERS.vip], [{ fee: 0, prize: 0 }, { fee: 200, prize: 360 }, { fee: 1000, prize: 1800 }], '등급표: free 0 · pro 200→360 · vip 1000→1800');
  const A = await player(port, '알파');
  const B = await player(port, 'Bravo_7');
  const anon = await client(port);
  const profA = { nickname: '알파', mmr: 1100, tier: 'silver', title: '신입', cosmetics: { gun: 'gold', table: 'obsidian', flame: 'native' } };
  const profB = { nickname: 'Bravo_7', mmr: 900, cosmetics: { gun: '<img src=x onerror=alert(1)>', table: 'obsidian' } }; // 나쁜 id 는 걸러져야 한다

  // 1. 방 생성 (로그인한 계정만)
  eq((await anon.call('create_private_room', { profile: profA })).error, 'AUTH_REQUIRED', '1 로그인하지 않으면 방을 만들 수 없다');
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
  eq([mA.opponent.profile.nickname, mA.opponent.profile.mmr], ['Bravo_7', 1000], '2 A 가 보는 상대 프로필(B) — 이름 · MMR 은 서버 계정 값 (보낸 900 이 아니라)');
  eq(mA.opponent.profile.cosmetics, { gun: 'steel', table: 'obsidian', flame: 'native', taunt: null }, '2 상대에게 보이는 스킨은 서버 지갑의 장착값 — 클라이언트가 보낸 이상한 id 는 무시');
  eq(mB.opponent.profile, { nickname: '알파', mmr: 1000, tier: 'silver', title: '새로 온 손님', cosmetics: { gun: 'steel', table: 'obsidian', flame: 'native', taunt: null } }, '2 B 가 보는 상대 프로필(A) — 가진 적 없는 gold 를 보냈어도 서버 지갑의 기본 스킨');
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
  eq(await relayed, { ...emote, code: created.code }, '6 상대에게 그대로 중계 (+ 방 코드 — 다른 방 이벤트를 걸러 내는 표식)');
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
  const sniper = await player(port, '저격수');
  eq((await sniper.call('join_private_room', qA.code)).error, 'ROOM_NOT_FOUND', '8 매칭 방은 코드로 들어올 수 없다');
  const overQ = B.waitFor('game_over', (p) => p.code === qA.code);
  await finishRound1(A, B, qA.code);
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
  const server = testServer({ quiet: true, turnMs: 250, graceMs: 400, onError });
  const port = await server.start(0, '127.0.0.1');
  const mk = async (name) => {
    const [x, y] = [await player(port, `${name}X`), await player(port, `${name}Y`)];
    const made = await x.call('create_private_room', { profile: { nickname: `${name}1` } });
    const joined = await y.call('join_private_room', made.code); // 스펙 형태: join_private_room(code)
    const [mx, my] = await Promise.all([x.waitFor('match_found'), y.waitFor('match_found')]);
    return { x, y, mx, my, joined, code: made.code };
  };

  // 10. 턴 타임아웃: 아무도 안 쏘면 서버가 대신 격발
  const g1 = await mk('타임');
  eq(g1.joined.ok, true, '10 join_private_room(code) 문자열 형태');
  eq(g1.mx.opponent.profile.nickname, '타임Y', '10 프로필 없이 들어와도 계정 닉네임');
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
  const intruder = await client(port, { token: g2.x.account.token });
  eq(await intruder.call('rejoin_room', { code: g2.code, token: 'f'.repeat(32) }), { ok: false, error: 'ROOM_NOT_FOUND' }, '12 위조 토큰은 거절');
  const stranger = await client(port, { token: g2.x.account.token });
  eq((await stranger.call('rejoin_room', { code: g2.code, token: g2.my.token })).error, 'ROOM_NOT_FOUND', '12 좌석 토큰을 알아도 그 좌석의 계정이 아니면 거절');
  const back = await client(port, { token: g2.y.account.token });
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
  const takeover = await client(port, { token: g2.y.account.token });
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
  const lateJoin = await client(port, { token: g2.y.account.token });
  const lateOver = lateJoin.waitFor('game_over', undefined, 1000);
  eq((await lateJoin.call('rejoin_room', { code: g2.code, token: g2.my.token })).over, true, '13 끝난 판에 늦게 돌아오면 결과만 다시 받는다');
  eq((await lateOver).youWon, false, '13 늦게 온 사람은 패자로 확인');
  await server.stop();
}


const IN_GAME_EVENTS = ['match_found', 'state_update', 'game_over', 'opponent_status', 'receive_emote', 'room_closed', 'session_replaced'];

async function phase6() {
  const server = testServer({ quiet: true, onError });
  const port = await server.start(0, '127.0.0.1');
  const channelSize = (code) => server.io.sockets.adapter.rooms.get(roomChannel(code))?.size ?? 0;
  const [A, B, C, D, E, F] = await Promise.all(Array.from({ length: 6 }, () => player(port)));
  const G = await client(port); // 손님 (로비만)

  // 방 1 · 방 2 = 무작위 매칭(일반 테이블) 두 판이 동시에, 방 3 = 친구 방 코드
  await A.call('join_queue', { tier: 'free', profile: {} });
  await B.call('join_queue', { tier: 'free', profile: {} });
  const m1 = await A.waitFor('match_found');
  await C.call('join_queue', { tier: 'free', profile: {} });
  await D.call('join_queue', { tier: 'free', profile: {} });
  const m2 = await C.waitFor('match_found');
  const made = await E.call('create_private_room', { profile: {} });
  await F.call('join_private_room', made.code);
  const m3 = await E.waitFor('match_found');
  const rooms = new Map([[A, m1.code], [B, m1.code], [C, m2.code], [D, m2.code], [E, m3.code], [F, m3.code]]);
  eq(new Set([m1.code, m2.code, m3.code]).size, 3, '26 서로 다른 방 3개가 동시에 진행');
  eq([channelSize(m1.code), channelSize(m2.code), channelSize(m3.code)], [2, 2, 2], '26 방 채널마다 그 방 두 사람만 join');

  // 방 1 에서만 격발 · 아이템 · 이모트를 잔뜩 — 차례인 사람이 상대에게 쏜다
  const seatOf = new Map();
  for (const X of [A, B]) seatOf.set((await X.waitFor('match_found', (p) => p.code === m1.code)).you, X);
  const lastState = () => [...A.inbox].reverse().find((m) => m.event === 'state_update' && m.payload.code === m1.code)?.payload.state;
  for (let shot = 0; shot < 6; shot += 1) {
    const turn = lastState()?.turn?.player; // A 시점의 좌석 id
    const actor = seatOf.get(turn);
    if (!actor || lastState()?.winner) break;
    await actor.call('game_action', { type: 'use_item', index: 0 }); // 아이템이 없거나 못 쓰면 거절될 뿐
    await actor.call('send_emote', { type: 'TAUNT', id: 'knock' }).catch(() => null);
    await actor.call('game_action', { type: 'shoot', target: 'opponent' });
    await sleep(30);
  }
  await A.call('leave_room'); // 방 1 끝 (A 항복)
  await Promise.all([A.waitFor('game_over', (p) => p.code === m1.code), B.waitFor('game_over', (p) => p.code === m1.code)]);
  await sleep(80); // 늦게 새는 이벤트가 있다면 도착할 시간

  const leaks = [];
  for (const [X, code] of rooms) {
    for (const { event, payload } of X.inbox) {
      if (IN_GAME_EVENTS.includes(event) && payload?.code !== code) leaks.push(`${code} 좌석이 ${event}(${payload?.code ?? '코드 없음'}) 수신`);
    }
  }
  eq(leaks, [], '26 모든 인게임 이벤트는 자기 방 코드 — 다른 방 이벤트는 한 건도 오지 않는다');
  eq(G.inbox.filter((m) => IN_GAME_EVENTS.includes(m.event)).map((m) => m.event), [], '26 로비에만 있는 소켓은 어떤 방의 인게임 이벤트도 받지 않는다');
  const room1Events = [A, B].flatMap((X) => X.inbox.filter((m) => m.event === 'state_update')).length;
  ok(room1Events >= 4, `26 방 1 은 실제로 진행됐다 (state_update ${room1Events}건)`);
  eq([C, D, E, F].map((X) => X.inbox.filter((m) => m.payload?.code === m1.code).length), [0, 0, 0, 0], '26 방 2 · 방 3 좌석은 방 1 이벤트를 0건 받았다');

  // 판이 끝나면 방 채널에서 나간다 → 끝난 방 소켓은 그 뒤 아무것도 받지 않는다
  eq([channelSize(m1.code), channelSize(m2.code), channelSize(m3.code)], [0, 2, 2], '26 끝난 방 1 은 채널이 비고, 진행 중인 방 2 · 3 은 그대로');
  const afterOver = [A.inbox.length, B.inbox.length];
  await C.call('game_action', { type: 'shoot', target: 'opponent' }).catch(() => null); // 방 2 진행
  await D.call('game_action', { type: 'shoot', target: 'opponent' }).catch(() => null);
  await E.call('send_emote', { type: 'TAUNT', id: 'flick' }).catch(() => null); // 방 3 진행
  await sleep(80);
  eq([A.inbox.length, B.inbox.length], afterOver, '26 판이 끝난 방 1 소켓은 다른 방이 진행돼도 아무것도 받지 않는다');

  // 방 3(친선) 에서 나가기: 나간 사람도 결과는 받고, 그 즉시 채널에서 빠진다
  await F.call('leave_room');
  await Promise.all([E.waitFor('game_over', (p) => p.code === m3.code), F.waitFor('game_over', (p) => p.code === m3.code)]);
  eq(channelSize(m3.code), 0, '26 나가기 → 방 채널에서 바로 나간다');
  await server.stop();
}



try {
  await phase1();
  await phase2();
  await phase3();
  await phase4();
  await phase5();
  await phase6();
  await phase7();
  await phase8();
  await phase9();
  await phase10();
  await phase11();
  await phase12();
  await phase13();
  await phase14();
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
