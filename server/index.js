/**
 * LAST CHAMBER - 멀티플레이 서버 코어 (4-1단계)
 *
 *   Express(정적 파일) + Socket.io(실시간)를 한 프로세스에서 돌린다:  node server/index.js   (포트 process.env.PORT || 3000)
 *   게임 규칙은 src/engine/gameEngine.js 를 그대로 쓴다. 방마다 GameEngine 을 서버 메모리에 하나씩 들고 있는 '서버 권위' 구조라서
 *   클라이언트는 입력(game_action)만 보내고, 결과는 서버가 엔진에 반영한 뒤 각자의 시점으로 알려 준다.
 *
 *   ── 치트 차단 ──
 *   · 클라이언트에는 getPublicState(자기 좌석) 와 getLog(자기 좌석)만 보낸다 — 탄창 순서는 서버 밖으로 나가지 않고, 돋보기로 본 탄종은 쓴 사람의 로그에만 들어 있다.
 *   · 좌석은 서버가 소켓에 붙여 둔다. 클라이언트가 보낸 플레이어 id 는 읽지 않는다 → 남의 턴에 쏘거나 남의 아이템을 쓸 수 없다 (엔진이 NOT_YOUR_TURN 으로 거절).
 *   · 엔진 난수와 선공 · 타임아웃 격발 대상은 crypto.randomInt 기반이다 (Math.random 보다 예측하기 어렵다).
 *   · 프로필 · 코스메틱 · 이모트는 상대 화면에 그려지는 값이라 서버가 모양을 검사해 걸러서 넘긴다. 이벤트는 소켓당 초당 30개까지.
 *
 *   ── 로그인 (선택 — 안 해도 예전처럼 익명으로 대전할 수 있다) ──
 *   연결할 때 io(url, { auth: { userId, nickname } })   userId = 클라이언트가 처음 로그인할 때 만든 UUID · nickname = 2~10자 · 공백 없음 (server/userStore.js 규칙)
 *     → 그 소켓을 그 유저로 기억한다(socket.data.user). 값이 틀리면 조용히 익명으로 받는다.
 *     · 로그인한 소켓의 프로필 닉네임은 서버가 확인한 닉네임으로 덮어써서 상대에게 보낸다 (유저 ID 는 상대에게 절대 보내지 않는다)
 *     · 판이 끝나면 로그인한 좌석의 서버 전적(승/패)을 기록하고 game_over 의 record 로 알려 준다
 *
 *   ── 클라이언트 → 서버 (마지막 인자로 ack 콜백을 줄 수 있다: { ok: true, ... } | { ok: false, error: 'CODE' }) ──
 *   hello({ userId, nickname })                   로그인 · 닉네임 변경 (연결 뒤에 해도 된다) → { ok, user: { nickname, wins, losses, games, streak, maxStreak, mmr } }  ← 서버에 기록된 내 전적
 *   get_leaderboard()                             → { ok, top: [{ rank, nickname, wins, losses, games, streak, maxStreak, mmr, isMe }] (mmr 내림차순 10명), me: 내 전적 | null }
 *                                                 판 · 대기열 도중에 다른 유저 ID 로 바꿀 수는 없다 (ALREADY_IN_ROOM)
 *   create_private_room({ profile })              친구 초대 방 → { ok, code }  (+ room_created { code })   code = 4자리 영문/숫자 (예: A7K9)
 *   join_private_room(code | { code, profile })   → { ok, code }  → 곧바로 판이 시작된다
 *   join_queue({ tier: 'free'|'pro'|'vip', profile })   무작위 매칭 대기 → { ok, tier, fee, prize }  (+ queue_joined)   같은 등급 2명이 모이면 자동으로 방 생성
 *   leave_queue()                                 대기열에서 나가기
 *   game_action({ type: 'shoot', target: 'self'|'opponent' } | { type: 'use_item', index })   → { ok: true } | { ok: false, error }  (엔진 오류 코드 그대로)
 *   send_emote({ type: 'TAUNT', id, ... })        상대에게 그대로 중계 — 값이 문자열(32자)·숫자·불리언인 작은 평면 객체만, 0.5초에 1번
 *   rejoin_room({ code, token })                  연결이 끊겼다 돌아올 때 (match_found 로 받은 token 필요, 끊긴 뒤 15초 안에)
 *   leave_room()                                  방 나가기: 기다리는 방은 닫히고, 진행 중이면 항복(상대 승)
 *
 *   ── 서버 → 클라이언트 ──
 *   match_found   { code, mode: 'private'|'queue', tier, fee, prize, you: 'P1'|'P2', token, opponent: { id, profile }, turnMs, graceMs, resume }
 *   state_update  { code, reason: 'start'|'shoot'|'item'|'timeout'|'rejoin', by?, auto?, state, logFrom, events, deadline, now, opponentConnected }
 *                 state = getPublicState(내 좌석) · events = getLog(내 좌석, logFrom) (rejoin 은 logFrom 0 부터 전체) · deadline = 이 턴이 자동 격발되는 서버 시각(ms) · now = 서버 현재 시각(시계 보정용)
 *   game_over     { code, tier, fee, prize, winner, youWon, reason: 'normal'|'forfeit', payout, score: { you, opponent }, players: { P1: { mmr }, P2: { mmr } }, record? }
 *                 record = { nickname, wins, losses, games } — 받는 사람이 로그인한 경우에만, 이번 판까지 반영된 서버 전적
 *   opponent_status { connected: false, graceMs, until } | { connected: true }     receive_emote (보낸 객체 그대로)     room_closed { reason }     session_replaced
 *   오류 코드: BAD_REQUEST · RATE_LIMITED · ALREADY_IN_ROOM · ROOM_NOT_FOUND · ROOM_FULL · INVALID_TIER · NOT_IN_GAME · INVALID_ACTION · INVALID_NICKNAME · SERVER_BUSY · SERVER_ERROR · (엔진) NOT_YOUR_TURN · INVALID_TARGET · INVALID_ITEM …
 *
 *   ── 시간 규칙 ──
 *   · 턴 20초: 격발이 끝날 때마다(자신에게 쏜 공포탄으로 턴이 이어질 때도) 다시 센다. 아이템 사용은 세지 않는다. 0초가 되면 서버가 대신 방아쇠를 당긴다 — 자신 또는 상대, 무작위. 연출 시간은 기다려 주지 않는다.
 *   · 연결 끊김: 15초 안에 rejoin_room 으로 돌아오지 않으면 부전패(상대 승). 그동안 턴 타이머는 계속 흐른다. 친구를 기다리던 방은 만든 사람이 끊기면 바로 닫히고(10분 지나도 닫힘), 대기열에서는 즉시 빠진다.
 *
 *   ── 정산 ──
 *   free 0 · pro 참가비 200 → 승자 360 · vip 참가비 1000 → 승자 1800 (사설 방은 free). 서버에는 아직 지갑이 없어서 fee/prize/payout 숫자만 알려 주고, 탄피 차감·지급은 클라이언트가 한다 (계정·지갑은 이후 단계).
 *
 *   환경: PORT · HOST(비우면 모든 네트워크 — 이 PC에서만 열려면 127.0.0.1) · CORS_ORIGIN(다른 출처에서 붙을 때 허용할 출처, 쉼표로 여러 개 — '*' 이면 전부 · 비우면 같은 출처 + 앱/토스 웹뷰(capacitor://localhost · http(s)://localhost · *.tossmini.com) · 그 밖의 값이면 적어 준 출처만)
 *         USER_DATA_FILE(유저 닉네임 · 전적을 저장할 JSON 파일 — 기본 server/data/users.json, 빈 값이면 메모리에만. server/ 아래라 정적 파일로는 보이지 않는다)
 *         SUPABASE_URL · SUPABASE_KEY(service_role) — 둘 다 있으면 유저 기록을 Supabase players 테이블에 (USER_DATA_FILE 대신). 없으면 메모리 · 파일 (server/userStore.js)
 *   상태 확인: GET /health → { ok, uptime } (Render · Railway 헬스체크용) · GET /healthz → 방 · 대기열 · 유저 수 통계까지
 *   정적 파일은 프로젝트 루트를 그대로 서빙하되 server/ · tests/ · node_modules/ · scripts/ · www/ · android/ · ios/ · package*.json · capacitor.config.json · 점(.)으로 시작하는 파일은 404.
 *
 *   ── 파일 구성 (고칠 곳 찾기) ──
 *   server/index.js        진입점: Express 정적 파일 + Socket.io 이벤트 라우팅 · 소켓당 초당 이벤트 제한 · 위의 규약 주석
 *   server/roomManager.js  방 · 판: 사설 방 생성/입장 · 재접속 토큰 · 방마다 GameEngine · 20초 턴 타이머 · 15초 끊김 부전승 · 이모트 중계 · 프로필 검사(cleanProfile)
 *   server/matchmaker.js   free · pro · vip 등급표(QUEUE_TIERS)와 등급별 대기열 · 2명이 모이면 방을 만들어 시작
 *   server/userStore.js    로그인한 유저의 닉네임 · 서버 전적(승/패) · 닉네임 규칙(cleanNickname) · JSON 파일 저장
 */

import { createServer } from 'node:http';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { Server } from 'socket.io';
import { createRoomManager, fail, cleanProfile, ROOM_DEFAULTS, TURN_MS, GRACE_MS, ROOM_TTL_MS, RESULT_TTL_MS } from './roomManager.js';
import { createMatchmaker, QUEUE_TIERS } from './matchmaker.js';
import { createUserStore, cleanUserId, cleanNickname, NICK_RULE as USER_NICK_RULE, USER_DEFAULTS } from './userStore.js';

// 테스트 · 이후 단계가 server/index.js 하나만 import 해도 되도록 규칙 상수와 프로필 검사기를 그대로 다시 내보낸다
export { TURN_MS, GRACE_MS, ROOM_TTL_MS, RESULT_TTL_MS, QUEUE_TIERS, USER_NICK_RULE, cleanProfile };

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// 서버 전체 설정의 기본값 — 방 관련 값(턴 · 유예 · 만료 · 방 수 · 이모트 간격)은 roomManager 의 ROOM_DEFAULTS
const SERVER_DEFAULTS = {
  eventsPerSec: 30, // 소켓당 초당 이벤트 상한
  pingInterval: 5000, // 끊긴 연결을 빨리 알아채려고 기본(25초)보다 짧게
  pingTimeout: 5000,
  quiet: false,
  onError: (err) => console.error('[LAST CHAMBER] 서버 오류', err),
  userDataFile: null, // 유저 닉네임 · 전적 JSON 파일 (null = 메모리에만 — 직접 실행할 때는 아래 isMainModule 이 server/data/users.json 을 넘긴다)
  maxUsers: USER_DEFAULTS.maxUsers,
  userSaveDelayMs: USER_DEFAULTS.saveDelayMs,
  supabaseUrl: null, // 둘 다 있으면 Supabase (직접 실행할 때는 isMainModule 이 환경 변수를 넘긴다 — 테스트가 실제 DB 를 건드리지 않게)
  supabaseKey: null,
  supabaseClient: null, // 이미 만든 클라이언트 (테스트용 가짜 등)
};
const LEADERBOARD_SIZE = 10;

/** Supabase 클라이언트 — 패키지는 키가 있을 때만 불러온다 (실패하면 userStore 가 메모리로 돌아간다) */
const connectSupabase = (url, key) => import('@supabase/supabase-js')
  .then(({ createClient }) => createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } }));

// ───────── 정적 파일: 서버 내부 경로는 숨긴다 ─────────

const PRIVATE_TOP = new Set(['server', 'tests', 'node_modules', 'scripts', 'www', 'android', 'ios', 'package.json', 'package-lock.json', 'capacitor.config.json']);

function topSegment(urlPath) {
  const normalized = path.posix.normalize(`/${urlPath.replace(/\\/g, '/')}`); // . · .. 정리 (/x/../server 로 돌아 들어오는 길 차단)
  const seg = normalized.split('/').find(Boolean) ?? '';
  return seg.replace(/:.*$/, '').replace(/[. ]+$/, '').toLowerCase(); // 윈도우 별칭(끝의 점 · 공백 · :스트림)도 같은 이름으로
}

function blockServerInternals(req, res, next) {
  let top;
  try {
    top = topSegment(decodeURIComponent(req.path));
  } catch {
    return res.status(400).end();
  }
  if (PRIVATE_TOP.has(top) || top.startsWith('.') || top.includes('~')) return res.status(404).end(); // ~ = 윈도우 8.3 짧은 이름
  return next();
}

// ───────── CORS: 앱 · 토스 웹뷰 출처 ─────────

// Capacitor 앱 WebView 의 출처 — iOS 는 capacitor://localhost, Android 는 기본 https://localhost (androidScheme 을 http 로 바꾸면 http://localhost)
const APP_ORIGINS = ['capacitor://localhost', 'http://localhost', 'https://localhost'];
// 토스 미니앱 웹뷰 출처 (<앱 이름>.apps.tossmini.com · <앱 이름>.private-apps.tossmini.com 형태 — 실제 주소가 다르면 여기만 고친다)
const TOSS_ORIGIN = /^https:\/\/[a-z0-9-]+(\.[a-z0-9-]+)*\.tossmini\.com$/i;

/** CORS_ORIGIN 값 → Socket.io cors 옵션. '*' = 모든 출처 · 비어 있음 = 앱 + 토스 웹뷰 출처 (같은 출처는 CORS 가 필요 없다) · 그 밖 = 적어 준 출처만 */
function corsOptions(raw) {
  const list = String(raw ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (list.includes('*')) return { origin: '*' };
  if (list.length === 0) return { origin: [...APP_ORIGINS, TOSS_ORIGIN] };
  return { origin: list };
}

// ───────── 서버 ─────────

/**
 * 서버를 만든다 (listen 은 start 가 한다 — 테스트는 포트 0 으로 띄운다).
 * options 로 ROOM_DEFAULTS · SERVER_DEFAULTS 와 corsOrigin 을 바꿀 수 있다 (예: 테스트에서 turnMs: 250). onError(err) = 처리되지 않은 서버 오류가 날 때 부른다.
 * → { app, httpServer, io, start(port, host?) → Promise<실제 포트>, stop() → Promise, stats() }
 */
export function createGameServer(options = {}) {
  const cfg = { ...ROOM_DEFAULTS, ...SERVER_DEFAULTS, corsOrigin: process.env.CORS_ORIGIN ?? '', ...options };
  const log = (...args) => { if (!cfg.quiet) console.log('[LAST CHAMBER]', ...args); };
  const guard = (fn) => { // 타이머 · 이벤트 안의 예외가 프로세스를 죽이지 않게
    try { return fn(); } catch (err) { cfg.onError(err); return undefined; }
  };

  const app = express();
  const httpServer = createServer(app);
  const io = new Server(httpServer, {
    cors: corsOptions(cfg.corsOrigin),
    pingInterval: cfg.pingInterval,
    pingTimeout: cfg.pingTimeout,
    maxHttpBufferSize: 16 * 1024, // 프로필 · 액션은 아주 작다
  });

  const db = cfg.supabaseClient ?? (cfg.supabaseUrl && cfg.supabaseKey ? connectSupabase(cfg.supabaseUrl, cfg.supabaseKey) : null);
  const users = createUserStore({ file: cfg.userDataFile || null, db, maxUsers: cfg.maxUsers, saveDelayMs: cfg.userSaveDelayMs, onError: cfg.onError });
  if (db) log('유저 기록: Supabase players 테이블');
  const rooms = createRoomManager({ io, cfg, log, guard, tiers: QUEUE_TIERS, users });
  const matchmaker = createMatchmaker({ io, rooms, tiers: QUEUE_TIERS });
  const stats = () => ({ ...rooms.stats(), queued: matchmaker.queued(), users: users.size() });

  /**
   * 로그인: 이 소켓을 유저 { id, nickname } 로 기억하고 서버 기록을 만들거나 닉네임을 갱신한다 (handshake auth · hello 이벤트 공통).
   * → { ok: true, user: { nickname, wins, losses, games } } | { ok: false, error: 'BAD_REQUEST' | 'INVALID_NICKNAME' | 'ALREADY_IN_ROOM' }
   */
  function identifyUser(socket, payload) {
    const id = cleanUserId(payload?.userId);
    if (!id) return fail('BAD_REQUEST');
    const nickname = cleanNickname(payload?.nickname);
    if (!nickname) return fail('INVALID_NICKNAME');
    const current = socket.data.user;
    if (current && current.id !== id && socket.data.where) return fail('ALREADY_IN_ROOM'); // 판 · 대기열 도중에 다른 사람으로 바꿀 수 없다
    const record = users.identify(id, nickname); // 저장소가 가득 차면 null — 대전은 그대로, 기록만 남지 않는다
    socket.data.user = { id, nickname };
    // DB 모드면 그 유저를 불러온 뒤에 답한다 (메모리 모드는 바로)
    return users.ready(id).then(() => ({ ok: true, user: users.publicView(record) ?? { nickname, wins: 0, losses: 0, games: 0, streak: 0, maxStreak: 0, mmr: 1000 } }));
  }

  /** TOP 10 (mmr 내림차순) + 내 전적. 유저 ID 는 응답에 넣지 않는다 (내 줄은 isMe 로만) */
  async function getLeaderboard(socket) {
    const me = socket.data.user;
    if (me) await users.ready(me.id);
    const top = await users.leaderboard(LEADERBOARD_SIZE);
    return {
      ok: true,
      top: top.map((rec, i) => ({ rank: i + 1, ...users.publicView(rec), isMe: rec.id === me?.id })),
      me: me ? users.publicView(users.get(me.id)) : null,
    };
  }

  // ── HTTP: 상태 확인 + 정적 파일 ──
  app.disable('x-powered-by');
  app.get('/health', (req, res) => res.json({ ok: true, uptime: process.uptime() })); // 클라우드 호스팅(Render · Railway) 헬스체크
  app.get('/healthz',(req, res) => res.json({ ok: true, ...stats() }));
  app.use(blockServerInternals);
  app.use(express.static(ROOT, { dotfiles: 'ignore' }));

  // ── Socket.io 이벤트 라우팅: 이벤트 이름 → 처리하는 쪽 ──
  const handlers = {
    hello: identifyUser,
    get_leaderboard: getLeaderboard,
    create_private_room: rooms.createPrivateRoom,
    join_private_room: rooms.joinPrivateRoom,
    join_queue: matchmaker.joinQueue,
    leave_queue: matchmaker.leaveQueue,
    leave_room: (socket) => (socket.data.where?.kind === 'queue' ? matchmaker.leaveQueue(socket) : rooms.leaveRoom(socket)), // 대기 중이면 대기열에서, 아니면 방에서
    rejoin_room: rooms.rejoinRoom,
    game_action: rooms.gameAction,
    send_emote: rooms.sendEmote,
  };

  const allow = (socket) => { // 소켓당 초당 이벤트 수 제한
    const now = Date.now();
    const win = socket.data.win;
    if (now - win.start >= 1000) { win.start = now; win.n = 0; }
    win.n += 1;
    return win.n <= cfg.eventsPerSec;
  };

  io.on('connection', (socket) => {
    socket.data = { where: null, win: { start: 0, n: 0 }, lastEmote: 0, user: null };
    const auth = socket.handshake.auth;
    if (auth && typeof auth === 'object' && (auth.userId !== undefined || auth.nickname !== undefined)) {
      guard(() => identifyUser(socket, auth)); // 틀린 값이면 그냥 익명 소켓 (연결을 끊지 않는다 — 예전 클라이언트와 같은 흐름)
    }
    for (const [event, handler] of Object.entries(handlers)) {
      socket.on(event, (...args) => {
        const ack = typeof args.at(-1) === 'function' ? args.pop() : null;
        let result;
        try {
          result = allow(socket) ? handler(socket, args[0]) : fail('RATE_LIMITED');
        } catch (err) {
          cfg.onError(err);
          result = fail('SERVER_ERROR');
        }
        if (typeof result?.then === 'function') { // DB 를 거치는 처리(hello · get_leaderboard)는 끝난 뒤에 답한다
          result.then((value) => { if (ack) guard(() => ack(value)); }, (err) => { cfg.onError(err); if (ack) guard(() => ack(fail('SERVER_ERROR'))); });
          return;
        }
        if (ack) guard(() => ack(result));
      });
    }
    socket.on('disconnect', () => guard(() => {
      matchmaker.onDisconnect(socket); // 대기 중이었다면 대기열에서 빼고
      rooms.onDisconnect(socket); // 방에 앉아 있었다면 유예 타이머 · 방 정리
    }));
  });

  // ── 시작 · 종료 ──
  const start = (port = Number(process.env.PORT || 3000), host) => new Promise((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(port, host, () => {
      httpServer.off('error', reject);
      resolve(httpServer.address().port);
    });
  });

  async function stop() {
    rooms.shutdown();
    matchmaker.clear();
    const closed = new Promise((resolve) => { io.close(resolve); }); // 소켓을 모두 끊고 HTTP 서버도 닫는다
    httpServer.closeAllConnections?.();
    await closed;
    await users.close(); // 남은 유저 기록을 파일에 쓰고 닫는다
  }

  return { app, httpServer, io, start, stop, stats, users };
}

// ───────── 직접 실행: node server/index.js ─────────

const sameFile = (a, b) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);
function isMainModule() {
  try {
    const here = realpathSync(fileURLToPath(import.meta.url));
    const arg = realpathSync(process.argv[1] ?? '');
    return sameFile(arg, here) || sameFile(arg, path.dirname(here)); // node server/index.js · node server
  } catch {
    return false;
  }
}

if (isMainModule()) {
  // 유저 기록 파일: USER_DATA_FILE (빈 값이면 메모리에만) — 기본은 server/data/users.json (server/ 는 정적 파일로 서빙하지 않는 경로)
  const userDataFile = process.env.USER_DATA_FILE ?? path.join(ROOT, 'server', 'data', 'users.json');
  const server = createGameServer({ userDataFile, supabaseUrl: process.env.SUPABASE_URL || null, supabaseKey: process.env.SUPABASE_KEY || null });
  server.start(Number(process.env.PORT || 3000), process.env.HOST || undefined).then((port) => {
    console.log(`[LAST CHAMBER] http://localhost:${port}  (정적 파일 + Socket.io · 턴 ${TURN_MS / 1000}초 · 재접속 ${GRACE_MS / 1000}초)`);
  }).catch((err) => {
    console.error('[LAST CHAMBER] 서버를 시작하지 못했습니다:', err.message);
    process.exit(1);
  });
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => { server.stop().finally(() => process.exit(0)); });
  }
}
