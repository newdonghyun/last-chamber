// 멀티플레이 서버 검증 (브라우저 없음): node tests/server.test.mjs   — socket.io-client · fetch 로 서버를 실제로 때려 본다. 15초 안팎 (비밀번호 해시 포함).
//   Phase 1 (기본 서버, 계정 2개): 로그인해야 방 생성 → 입장 → 격발 1회 · 치트 시도 거절 · 이모트 중계 · 항복 · 빠른 매칭(pro) · 정적 파일
//   Phase 2 (타이머를 줄인 서버): 20초 턴 타임아웃 강제 격발 · 연결 끊김 부전승 · 재접속 · 새 연결의 자리 인수
//   Phase 3 (계정 · 파일 저장): 회원가입(아이디 · 닉네임 중복 차단 · 규칙) · 로그인 · 토큰 접속 · 손님 제한 · 랭킹전/친선전 전적 · 닉네임 변경 · 저장/복원 · 토큰 위조
//   Phase 4 (계정 · Supabase 흉내): 기존 계정 로그인 · 가입 행 · 중복 · 전적 갱신 · TOP 10 계정만 · 닉네임 UPDATE · 재시작 뒤 토큰 · 계정 컬럼 없음 · 연결 실패
//   Phase 5 (실제 supabase-js · 전역 WebSocket 없음): 가입 insert · 로그인 조회 · 닉네임 PATCH · TOP 10 필터
//   Phase 6 (방 격리): 동시에 도는 방 3개 — 한 방의 이벤트가 다른 방 · 로비 소켓에 가지 않는다 · 모든 인게임 이벤트에 자기 방 코드 · 판이 끝나면 방 채널에서 나간다
//   Phase 7 (계정 보안): 비밀번호 오답 잠금 · 비밀번호 미노출 · 토큰 만료 · 위조 · CORS · 동시 가입 · IP 시도 제한
//   Phase 8 (공개 방): 로비 목록 실시간 · 손님 제한 · 자기 방 · 잘못된 입장 · 클릭 입장 즉시 시작(랭킹전) · 목록에서 빠짐 · 방장 이탈/끊김
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { io as connect } from 'socket.io-client';
import { createGameServer, QUEUE_TIERS } from '../server/index.js';
import { roomChannel } from '../server/roomManager.js';
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
  const server = createGameServer({ quiet: true, onError, userDataFile: file, userSaveDelayMs: 20, authSecret: 'test-secret' });
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
  const [self] = await queueMatch(A, A2);
  const selfOver = A.waitFor('game_over', (p) => p.code === self.code);
  await A2.call('leave_room');
  eq((await selfOver).record?.mmr, 1025, '17 같은 계정끼리(창 두 개) 둔 판은 기록하지 않는다');

  // 18. 닉네임 변경: 서버에서 바로 · 중복 차단 · 토큰 필요 · 접속 중인 소켓의 이름표도
  const renamed = await api('rename', { token: b.token, nickname: '에이스' });
  eq([renamed.ok, renamed.nickname, renamed.me?.losses], [true, '에이스', 1], '18 닉네임 변경 (전적 그대로)');
  eq([(await api('rename', { token: b.token, nickname: '총잡이' })).error, (await api('rename', { token: 'nope', nickname: '아무개' })).status], ['NICKNAME_TAKEN', 401], '18 남의 닉네임 → NICKNAME_TAKEN · 토큰 없으면 401');
  const [mA3, mB3] = await queueMatch(A, B);
  eq(mA3.opponent.profile.nickname, '에이스', '18 바꾼 닉네임이 바로 상대 이름표에');
  const over3 = A.waitFor('game_over', (p) => p.code === mA3.code);
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
  const reborn = createGameServer({ quiet: true, onError, userDataFile: file, authSecret: 'test-secret' });
  const port2 = await reborn.start(0, '127.0.0.1');
  const back = await apiOf(port2)('login', { username: 'gunner01', password: PASSWORD });
  eq([back.user_id, back.me?.mmr, back.me?.wins], [a.user_id, 1050, 2], '19 서버를 다시 켜도 로그인 · 전적 그대로');
  const oldToken = await client(port2, { token: a.token });
  eq((await oldToken.call('register_player', {})).me?.nickname, '총잡이', '19 재시작 전에 받은 토큰으로도 자동 로그인 (서버 메모리에 세션이 없어도)');
  await reborn.stop();
  const wrongSecret = createGameServer({ quiet: true, onError, userDataFile: file, authSecret: 'other-secret' });
  const port3 = await wrongSecret.start(0, '127.0.0.1');
  eq((await (await client(port3, { token: a.token })).call('register_player', {})).error, 'AUTH_REQUIRED', '19 AUTH_SECRET 이 다르면 토큰은 무효 (위조 방지)');
  await wrongSecret.stop();
  rmSync(dir, { recursive: true, force: true });
}

// ───────── Phase 4: 계정 · Supabase 흉내 ─────────
// accountColumns: false 면 username · password_hash 컬럼이 아직 없는 테이블 (ACCOUNT_SQL 실행 전)
function fakeSupabase(rows = [], { accountColumns = true } = {}) {
  const table = new Map(rows.map((r) => [r.user_id, { ...r }]));
  const calls = [];
  const ACCOUNT = /username|password_hash/;
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
      select: (cols = '*') => { calls.push('select'); return query([], [], Infinity, !accountColumns && ACCOUNT.test(cols)); },
      insert: async (row) => {
        calls.push('insert');
        if (!accountColumns && Object.keys(row).some((k) => ACCOUNT.test(k))) return noColumn;
        if (table.has(row.user_id)) return dup('players_pkey');
        const c = clash(row);
        if (c) return c;
        table.set(row.user_id, { ...row });
        return { data: null, error: null };
      },
      upsert: async (row) => {
        calls.push('upsert');
        const merged = { ...table.get(row.user_id), ...row };
        const c = clash(merged);
        if (c) return c;
        table.set(row.user_id, merged);
        return { data: null, error: null };
      },
      update: (patch) => ({
        eq: async (col, val) => {
          calls.push('update');
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
  const server = createGameServer({ quiet: true, onError, supabaseClient: db, authSecret: 'test-secret' });
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
  const again = createGameServer({ quiet: true, onError, supabaseClient: db, authSecret: 'test-secret' });
  const port2 = await again.start(0, '127.0.0.1');
  const R2 = await client(port2, { token: r.token });
  eq((await R2.call('register_player', {})).me, { nickname: '중수', wins: 1, losses: 0, games: 1, streak: 1, maxStreak: 1, mmr: 1025 }, '24 재시작 뒤 토큰 → DB 계정 · 전적');
  await again.stop();

  // 25. 계정 컬럼이 없는 테이블 (ACCOUNT_SQL 실행 전): 서버는 돌고 가입 · 로그인만 안내와 함께 막는다 → SQL 실행 뒤 다시 켜지 않아도 된다
  const errors = [];
  const oldDb = fakeSupabase([], { accountColumns: false });
  const old = createGameServer({ quiet: true, onError: (err) => errors.push(err), supabaseClient: oldDb, accountRecheckMs: 0 });
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
  const solo = createGameServer({ quiet: true, onError: (err) => errs.push(err), supabaseClient: Promise.reject(new Error('fetch failed')) });
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
  const server = createGameServer({ quiet: true, onError: (err) => errors.push(err), supabaseUrl: `http://127.0.0.1:${rest.address().port}`, supabaseKey: 'test-service-role', authSecret: 'test-secret' });
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
  const server = createGameServer({ quiet: true, onError, authSecret: 'test-secret', loginLimits: { maxFails: 3, lockMs: 60_000, maxPerIp: 500 } });
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

  const strict = createGameServer({ quiet: true, onError, loginLimits: { maxPerIp: 2 } });
  const strictPort = await strict.start(0, '127.0.0.1');
  const tries = [];
  for (let i = 0; i < 3; i += 1) tries.push((await apiOf(strictPort)('login', { username: 'nobody', password: 'whatever' })).error);
  eq(tries, ['BAD_CREDENTIALS', 'BAD_CREDENTIALS', 'RATE_LIMITED'], '31 같은 IP 의 시도 수 제한');
  await strict.stop();
}

// ───────── Phase 8: 공개 방 (로비 목록 · 클릭 입장 · 랭킹전) ─────────
async function phase8() {
  const server = createGameServer({ quiet: true, onError });
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
  await C.call('leave_room');
  eq([(await over).ranked, (await over).mmrDelta, (await over).record?.mmr], [true, 25, 1025], '34 공개 방 결과는 MMR 정산 (+25)');

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



async function phase1() {
  const server = createGameServer({ quiet: true, onError });
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
  eq(mA.opponent.profile.cosmetics, { gun: null, table: 'obsidian', flame: null, taunt: null }, '2 위험한 코스메틱 id 는 걸러진다');
  eq(mB.opponent.profile, { nickname: '알파', mmr: 1000, tier: 'silver', title: '신입', cosmetics: { gun: 'gold', table: 'obsidian', flame: 'native', taunt: null } }, '2 B 가 보는 상대 프로필(A)');
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


const IN_GAME_EVENTS = ['match_found', 'state_update', 'game_over', 'opponent_status', 'receive_emote', 'room_closed', 'session_replaced'];

async function phase6() {
  const server = createGameServer({ quiet: true, onError });
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
