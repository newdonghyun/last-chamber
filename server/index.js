/**
 * LAST CHAMBER - 멀티플레이 서버 코어
 *
 *   Express(정적 파일 + 계정 API) + Socket.io(실시간)를 한 프로세스에서 돌린다:  node server/index.js   (포트 process.env.PORT || 3000)
 *   게임 규칙은 src/engine/gameEngine.js 를 그대로 쓴다. 방마다 GameEngine 을 서버 메모리에 하나씩 들고 있는 '서버 권위' 구조라서
 *   클라이언트는 입력(game_action)만 보내고, 결과는 서버가 엔진에 반영한 뒤 각자의 시점으로 알려 준다.
 *
 *   ── 치트 차단 ──
 *   · 클라이언트에는 getPublicState(자기 좌석) 와 getLog(자기 좌석)만 보낸다 — 탄창 순서는 서버 밖으로 나가지 않고, 투시경으로 본 탄종은 쓴 사람의 로그에만 들어 있다.
 *   · 좌석은 서버가 소켓에 붙여 둔다. 클라이언트가 보낸 플레이어 id 는 읽지 않는다 → 남의 턴에 쏘거나 남의 아이템을 쓸 수 없다 (엔진이 NOT_YOUR_TURN 으로 거절).
 *   · 엔진 난수와 선공 · 타임아웃 격발 대상은 crypto.randomInt 기반이다 (Math.random 보다 예측하기 어렵다).
 *   · 프로필 · 코스메틱 · 이모트는 상대 화면에 그려지는 값이라 서버가 모양을 검사해 걸러서 넘긴다. 이벤트는 소켓당 초당 30개까지.
 *
 *   ── 계정 (HTTP · JSON) ── 오류: { ok: false, error } + HTTP 상태(API_STATUS)
 *   POST /api/signup { username, password, nickname? } 회원가입 → { ok, token, user_id, username, nickname, me }   USERNAME_TAKEN · NICKNAME_TAKEN · INVALID_*
 *     nickname 을 빼면(또는 빈 값) 서버가 '붉은총잡이' 같은 느와르 닉네임을 중복 없이 붙여 돌려준다 — 나중에 /api/rename 으로 바꿀 수 있다 (server/nicknames.js)
 *   POST /api/login  { username, password }             로그인   → 같은 모양   BAD_CREDENTIALS(아이디가 없거나 비밀번호가 틀림) · LOGIN_LOCKED(5번 틀리면 15분)
 *   POST /api/rename { token, nickname }                닉네임 변경 (players 바로 UPDATE) → { ok, nickname, me }   NICKNAME_TAKEN · AUTH_REQUIRED
 *     token = 로그인 토큰(server/auth.js) — 클라이언트가 localStorage 에 두고 자동 로그인에 쓴다. 비밀번호는 해시로만 저장한다.
 *
 *   ── 소켓 로그인 ── io(url, { auth: { token } }) 또는 register_player({ token }) → 그 소켓을 그 계정으로 기억한다(socket.data.user)
 *     · 토큰이 없거나 틀리면 손님(익명) 소켓: 로비 방 목록 · TOP 10 은 볼 수 있지만 방 만들기 · 입장 · 매칭은 AUTH_REQUIRED (AI 딜러 연습은 서버 없이 된다)
 *     · 상대에게 보내는 프로필 닉네임은 서버가 확인한 계정 닉네임으로 덮어쓴다 (유저 ID 는 상대에게 절대 보내지 않는다)
 *     · 랭킹전(공개 방 'public' · 빠른 매칭 'queue')이 끝나면 두 좌석의 서버 전적(승/패 · 연승 · MMR +25/−20)을 기록하고 game_over 의 record · mmrDelta 로 알려 준다
 *       친선 비밀방(mode 'private')은 친선전 — 전적 · MMR 을 기록하지 않는다 (ranked: false)
 *
 *   ── 클라이언트 → 서버 (마지막 인자로 ack 콜백을 줄 수 있다: { ok: true, ... } | { ok: false, error: 'CODE' }) ──
 *   register_player({ token })                    로비 접속 즉시: 토큰 확인 → { ok, user, me, top }  (me · top = get_leaderboard 와 같다) · 틀린 토큰은 AUTH_REQUIRED
 *   get_leaderboard()                             → { ok, top: [{ rank, nickname, wins, losses, games, streak, maxStreak, mmr, isMe }] (랭킹전 1판 이상 둔 계정만 · mmr 내림차순 10명), me: 내 전적 | null }
 *   watch_rooms() / unwatch_rooms()               로비 방 목록 보기 시작 · 그만 → { ok, rooms }  (+ 바뀔 때마다 room_list)
 *   create_public_room({ profile })               공개 방 (로비 목록에 보임 · 랭킹전) → { ok, code, mode }  (+ room_created { code, mode })   ⟵ 로그인 필요
 *   join_public_room({ code, profile })           목록에서 누른 공개 방에 입장 → 곧바로 판이 시작된다                                    ⟵ 로그인 필요
 *   create_private_room({ profile })              친선 비밀방 (목록에 안 보임 · 친선전) → { ok, code, mode }   code = 4자리 영문/숫자 (예: A7K9)  ⟵ 로그인 필요
 *   join_private_room(code | { code, profile })   방 코드로 입장 → 곧바로 판이 시작된다                                                  ⟵ 로그인 필요
 *   join_queue({ tier: 'free'|'pro'|'vip', profile })   빠른 매칭 대기 → { ok, tier, fee, prize }  (+ queue_joined)   같은 등급 2명이 모이면 자동으로 방 생성  ⟵ 로그인 필요
 *   leave_queue()                                 대기열에서 나가기
 *   game_action({ type: 'shoot', target: 'self'|'opponent' } | { type: 'use_item', index })   → { ok: true } | { ok: false, error }  (엔진 오류 코드 그대로)
 *   send_emote({ type: 'TAUNT', id, ... })        상대에게 그대로 중계 — 값이 문자열(32자)·숫자·불리언인 작은 평면 객체만, 0.5초에 1번
 *   rejoin_room({ code, token })                  연결이 끊겼다 돌아올 때 (match_found 로 받은 좌석 token 필요, 끊긴 뒤 15초 안에)
 *   leave_room()                                  방 나가기: 기다리는 방은 닫히고(공개 방이면 목록에서도 빠짐), 진행 중이면 항복(상대 승)
 *   surrender()                                   진행 중인 판에서 항복 → { ok: true } | NOT_IN_GAME.  두 사람 모두 game_over(reason 'surrender') — 항복자는 youWon false, 상대는 true.
 *                                                 랭킹전(공개 방 · 빠른 매칭): 항복자 −20 MMR · 패배 +1 · 연승 0, 상대 +25 MMR · 승리 +1 · 연승 +1 을 서버가 한 번에 기록.  친선 비밀방: 기록 없음.
 *
 *   ── 서버 → 클라이언트 ──
 *   ※ 인게임 이벤트는 모두 그 방 좌석의 소켓에게만 간다 (io.emit · socket.broadcast 없음). 모두 방 코드(code)를 싣는다 — 자기 방 코드가 아니면 버릴 것.
 *   ※ room_list 만 로비 채널(watch_rooms 한 소켓)에 보낸다 — 방 목록이지 인게임 이벤트가 아니다.
 *   room_list     { rooms: [{ code, host, mmr, players, capacity, createdAt }] }   상대를 기다리는 공개 방 (방장 닉네임 · 방장 서버 MMR · 1/2)
 *   match_found   { code, mode: 'public'|'queue'|'private', ranked, tier, fee, prize, you: 'P1'|'P2', token, opponent: { id, profile }, turnMs, graceMs, resume }
 *   state_update  { code, reason: 'start'|'shoot'|'item'|'timeout'|'rejoin', by?, auto?, state, logFrom, events, deadline, now, opponentConnected }
 *                 state = getPublicState(내 좌석) · events = getLog(내 좌석, logFrom) (rejoin 은 logFrom 0 부터 전체) · deadline = 이 턴이 자동 격발되는 서버 시각(ms) · now = 서버 현재 시각(시계 보정용)
 *   game_over     { code, mode, ranked, tier, fee, prize, winner, youWon, reason: 'normal'|'forfeit'|'surrender', payout, score: { you, opponent }, players: { P1: { mmr }, P2: { mmr } }, record?, mmrDelta? (랭킹전에서 기록된 내 MMR 변동) }
 *                 record = { nickname, wins, losses, games, streak, maxStreak, mmr } — 받는 사람의 계정 서버 전적 (이번 판까지 반영)
 *   opponent_status { code, connected: false, graceMs, until } | { code, connected: true }     receive_emote (보낸 객체 + code)     room_closed { code, reason }     session_replaced { code }
 *   오류 코드: BAD_REQUEST · RATE_LIMITED · AUTH_REQUIRED · ALREADY_IN_ROOM · ROOM_NOT_FOUND · ROOM_FULL · OWN_ROOM · INVALID_TIER · NOT_IN_GAME · INVALID_ACTION · SERVER_BUSY · SERVER_ERROR · (엔진) NOT_YOUR_TURN · INVALID_TARGET · INVALID_ITEM …
 *
 *   ── 시간 규칙 ──
 *   · 턴 20초: 격발이 끝날 때마다(자신에게 쏜 공포탄으로 턴이 이어질 때도) 다시 센다. 아이템 사용은 세지 않는다. 0초가 되면 서버가 대신 방아쇠를 당긴다 — 자신 또는 상대, 무작위. 연출 시간은 기다려 주지 않는다.
 *   · 연결 끊김: 15초 안에 rejoin_room 으로 돌아오지 않으면 부전패(상대 승). 그동안 턴 타이머는 계속 흐른다. 상대를 기다리던 방은 만든 사람이 끊기면 바로 닫히고(10분 지나도 닫힘), 대기열에서는 즉시 빠진다.
 *
 *   ── 정산 ──
 *   free 0 · pro 참가비 200 → 승자 360 · vip 참가비 1000 → 승자 1800 (공개 방 · 비밀방은 free). 서버에는 아직 지갑이 없어서 fee/prize/payout 숫자만 알려 주고, 탄피 차감·지급은 클라이언트가 한다.
 *
 *   환경: PORT · HOST(비우면 모든 네트워크 — 이 PC에서만 열려면 127.0.0.1) · CORS_ORIGIN(다른 출처에서 붙을 때 허용할 출처, 쉼표로 여러 개 — '*' 이면 전부 · 비우면 같은 출처 + 앱/토스 웹뷰(capacitor://localhost · http(s)://localhost · *.tossmini.com) · 그 밖의 값이면 적어 준 출처만)
 *         USER_DATA_FILE(계정 · 전적을 저장할 JSON 파일 — 기본 server/data/users.json, 빈 값이면 메모리에만. server/ 아래라 정적 파일로는 보이지 않는다)
 *         SUPABASE_URL · SUPABASE_KEY(service_role · secret) — 둘 다 있으면 계정 · 전적을 Supabase players 테이블에 (USER_DATA_FILE 대신). 없으면 메모리 · 파일 (server/userStore.js)
 *         AUTH_SECRET(로그인 토큰 서명용 서버 비밀 — 길고 무작위인 문자열. 바꾸면 모두 다시 로그인해야 한다)
 *   상태 확인: GET /health → { ok, uptime } (Render · Railway 헬스체크용) · GET /healthz → 방 · 대기열 · 유저 수 · DB · 계정 준비 상태
 *   정적 파일은 프로젝트 루트를 그대로 서빙하되 server/ · tests/ · node_modules/ · scripts/ · www/ · android/ · ios/ · package*.json · capacitor.config.json · 점(.)으로 시작하는 파일은 404.
 *
 *   ── 파일 구성 (고칠 곳 찾기) ──
 *   server/index.js        진입점: Express 정적 파일 + 계정 API + Socket.io 이벤트 라우팅 · 소켓 로그인 · 소켓당 초당 이벤트 제한 · 위의 규약 주석
 *   server/auth.js         아이디 · 비밀번호 규칙 · 비밀번호 해시 · 로그인 토큰 · 로그인 시도 제한
 *   server/roomManager.js  방 · 판: 공개 방(로비 목록) · 친선 비밀방(코드) · 재접속 토큰 · 방마다 GameEngine · 20초 턴 타이머 · 15초 끊김 부전승 · 이모트 중계 · 프로필 검사(cleanProfile)
 *   server/matchmaker.js   free · pro · vip 등급표(QUEUE_TIERS)와 등급별 빠른 매칭 대기열 · 2명이 모이면 방을 만들어 시작
 *   server/userStore.js    계정(가입 · 로그인 · 토큰 확인 · 닉네임 변경) · 랭킹 전적 · TOP 10 · 파일/Supabase 저장
 */

import { createServer } from 'node:http';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { Server } from 'socket.io';
import { createRoomManager, fail, cleanProfile, ROOM_DEFAULTS, TURN_MS, GRACE_MS, ROOM_TTL_MS, RESULT_TTL_MS, LOBBY_CHANNEL } from './roomManager.js';
import { createMatchmaker, QUEUE_TIERS } from './matchmaker.js';
import { createUserStore, cleanNickname, supabaseOrigin, NICK_RULE as USER_NICK_RULE, USER_DEFAULTS } from './userStore.js';
import { cleanUsername, cleanPassword, issueToken, createLoginLimiter, LOGIN_LIMITS } from './auth.js';

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
  authSecret: null, // 로그인 토큰 서명 비밀 (null = 환경 변수 AUTH_SECRET)
  loginLimits: null, // 로그인 시도 제한 (테스트에서 줄인다) — 기본 LOGIN_LIMITS
};
const LEADERBOARD_SIZE = 10;

/**
 * Supabase 클라이언트 — 패키지는 키가 있을 때만 불러온다 (실패하면 userStore 가 메모리로 돌아간다).
 * createClient 는 Realtime 클라이언트를 만들면서 WebSocket 을 찾는데, Node 22 미만(Render 기본 Node 등)에는 전역 WebSocket 이 없어
 * 'native WebSocket not found' 예외 → 서버가 메모리로 떨어져 players 에 아무것도 안 들어갔다 → ws 패키지로 채운다 (Realtime 은 쓰지 않는다)
 */
async function connectSupabase(url, key) {
  const { createClient } = await import('@supabase/supabase-js');
  const transport = globalThis.WebSocket ?? (await import('ws')).WebSocket;
  return createClient(supabaseOrigin(url), key.trim(), { auth: { persistSession: false, autoRefreshToken: false }, realtime: { transport } }); // 경로 · 공백이 섞인 환경 변수도 그대로 동작
}

/** 로그에 남길 키 종류 (키 값은 찍지 않는다): service_role · secret 이어야 서버가 RLS 에 막히지 않고 쓸 수 있다 */
function keyRole(key) {
  if (key.startsWith('sb_secret_')) return 'secret';
  if (key.startsWith('sb_publishable_')) return 'publishable — 서버에는 secret(service_role) 키가 필요합니다';
  try {
    const role = JSON.parse(Buffer.from(key.split('.')[1], 'base64url').toString('utf8')).role;
    return role === 'service_role' ? 'service_role' : `${role} — 서버에는 service_role 키가 필요합니다`;
  } catch {
    return '형식을 알 수 없음';
  }
}

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
/** 계정 API 오류 코드 → HTTP 상태 */
export const API_STATUS = Object.freeze({
  BAD_REQUEST: 400, INVALID_USERNAME: 400, INVALID_PASSWORD: 400, INVALID_NICKNAME: 400,
  BAD_CREDENTIALS: 401, AUTH_REQUIRED: 401, USERNAME_TAKEN: 409, NICKNAME_TAKEN: 409,
  LOGIN_LOCKED: 429, RATE_LIMITED: 429, ACCOUNT_SETUP_REQUIRED: 503, SERVER_BUSY: 503, SERVER_ERROR: 500,
});

/** /api 의 CORS: Socket.io 와 같은 허용 출처(앱 · 토스 웹뷰 · CORS_ORIGIN)만. 같은 출처(웹)는 헤더 없이도 된다 */
function apiCors(raw) {
  const { origin } = corsOptions(raw);
  const allowed = (o) => origin === '*' || (Array.isArray(origin) && origin.includes(o));
  return (req, res, next) => {
    const o = req.headers.origin;
    if (o && allowed(o)) {
      res.setHeader('Access-Control-Allow-Origin', origin === '*' ? '*' : o);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      res.setHeader('Access-Control-Max-Age', '600');
    }
    if (req.method === 'OPTIONS') { res.sendStatus(204); return; }
    next();
  };
}

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

  // 유저 기록(DB) 로그 — Render 로그에서 찾기 쉽게 [DB] · [DB ERROR] 머리말 (quiet(테스트)이면 오류는 onError 로만)
  const dbLog = (...args) => { if (!cfg.quiet) console.log(...args); };
  const dbError = (err) => { if (cfg.quiet) cfg.onError(err); else console.error('[DB ERROR]', err); };
  dbLog('[DB] SUPABASE_URL:', cfg.supabaseUrl ? 'set' : 'missing', '· SUPABASE_KEY:', cfg.supabaseKey ? `set (${keyRole(cfg.supabaseKey)})` : 'missing');
  const db = cfg.supabaseClient ?? (cfg.supabaseUrl && cfg.supabaseKey ? connectSupabase(cfg.supabaseUrl, cfg.supabaseKey) : null);
  const authSecret = cfg.authSecret ?? process.env.AUTH_SECRET ?? '';
  const keyKind = cfg.supabaseClient ? 'custom' : cfg.supabaseKey ? keyRole(cfg.supabaseKey).split(' ')[0] : null;
  if (!cfg.quiet && !authSecret) console.warn('[AUTH] AUTH_SECRET 이 없습니다 — 로그인 토큰이 비밀번호 해시로만 서명됩니다. Render 환경 변수에 길고 무작위인 AUTH_SECRET 을 넣으세요');
  const users = createUserStore({
    file: cfg.userDataFile || null, db, maxUsers: cfg.maxUsers, saveDelayMs: cfg.userSaveDelayMs, authSecret, onError: dbError, log: dbLog,
    ...(cfg.accountRecheckMs !== undefined ? { accountRecheckMs: cfg.accountRecheckMs } : {}),
  });
  const sendRoomList = () => io.to(LOBBY_CHANNEL).emit('room_list', { rooms: rooms.publicRooms() }); // 로비 목록을 보는 소켓에게만
  const rooms = createRoomManager({ io, cfg, log, guard, tiers: QUEUE_TIERS, users, onRoomsChanged: sendRoomList });
  const matchmaker = createMatchmaker({ io, rooms, tiers: QUEUE_TIERS });
  const stats = () => {
    const health = users.health();
    const dbKey = keyKind ?? (health.storage === 'supabase' ? 'publishable(기본값)' : null);
    return { ...rooms.stats(), queued: matchmaker.queued(), users: users.size(), ...health, dbKey, node: process.version };
  };
  const limiter = createLoginLimiter({ ...LOGIN_LIMITS, ...cfg.loginLimits }); // 아이디별 비밀번호 오답 잠금 · IP 별 시도 수

  // ── 계정: 가입 · 로그인 · 닉네임 변경 (HTTP) ──
  const sessionOf = (rec) => ({
    ok: true, token: issueToken(rec, authSecret), user_id: rec.id, username: rec.username, nickname: rec.nickname, me: users.publicView(rec),
  });

  /** POST /api/signup { username, password, nickname } */
  async function apiSignup(req) {
    if (!limiter.allowIp(req.ip ?? '?')) return fail('RATE_LIMITED');
    const username = cleanUsername(req.body?.username);
    if (!username) return fail('INVALID_USERNAME');
    const password = cleanPassword(req.body?.password);
    if (!password) return fail('INVALID_PASSWORD');
    const raw = req.body?.nickname;
    const auto = raw === undefined || raw === null || raw === ''; // 닉네임을 안 보내면 서버가 느와르 닉네임을 붙인다 (5초 가입)
    const nickname = auto ? null : cleanNickname(raw);
    if (!auto && !nickname) return fail('INVALID_NICKNAME');
    const res = await users.signup({ username, password, nickname });
    if (!res.ok) return fail(res.error);
    log('회원가입', username);
    return sessionOf(res.user);
  }

  /** POST /api/login { username, password } */
  async function apiLogin(req) {
    if (!limiter.allowIp(req.ip ?? '?')) return fail('RATE_LIMITED');
    const username = cleanUsername(req.body?.username);
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    if (!username || !password) return fail('BAD_CREDENTIALS'); // 형식이 틀려도 같은 답 (아이디가 있는지 알려 주지 않는다)
    const locked = () => ({ ...fail('LOGIN_LOCKED'), retryAfterSec: Math.ceil(limiter.lockedFor(username) / 1000) });
    if (limiter.lockedFor(username)) return locked();
    const res = await users.login({ username, password });
    if (!res.ok) {
      if (res.error === 'BAD_CREDENTIALS' && limiter.fail(username)) return locked();
      return fail(res.error);
    }
    limiter.succeed(username);
    return sessionOf(res.user);
  }

  /** POST /api/rename { token, nickname } — players 를 바로 UPDATE · 접속 중인 소켓의 닉네임도 바꾼다 */
  async function apiRename(req) {
    if (!limiter.allowIp(req.ip ?? '?')) return fail('RATE_LIMITED');
    const rec = await users.authenticate(req.body?.token);
    if (!rec) return fail('AUTH_REQUIRED');
    const nickname = cleanNickname(req.body?.nickname);
    if (!nickname) return fail('INVALID_NICKNAME');
    const res = await users.rename(rec.id, nickname);
    if (!res.ok) return fail(res.error);
    for (const socket of io.sockets.sockets.values()) if (socket.data.user?.id === rec.id) socket.data.user.nickname = nickname;
    return { ok: true, nickname, me: users.publicView(res.user) };
  }

  const respond = (res, result) => Promise.resolve(result).then(
    (body) => res.status(body?.ok ? 200 : (API_STATUS[body?.error] ?? 400)).json(body),
    (err) => { cfg.onError(err); res.status(500).json(fail('SERVER_ERROR')); },
  );

  // ── 소켓 로그인 · 로비 ──
  /** 토큰 → 이 소켓을 그 계정으로 (틀리면 손님으로 둔다) → 계정 | null */
  async function authSocket(socket, token) {
    const rec = await users.authenticate(token);
    if (!rec) return null;
    const current = socket.data.user;
    if (current && current.id !== rec.id && socket.data.where) return null; // 판 · 대기열 도중에 다른 계정으로 바꿀 수 없다
    socket.data.user = { id: rec.id, nickname: rec.nickname, rec }; // rec = 서버 계정 기록 (상대에게 보이는 이름 · MMR 은 여기서)
    return rec;
  }

  /** register_player({ token }): 로비 접속 즉시 — 토큰 확인 → 내 전적 + TOP 10 */
  async function registerPlayer(socket, payload) {
    await socket.data.authReady;
    if (payload?.token !== undefined && !(await authSocket(socket, payload.token))) return fail('AUTH_REQUIRED');
    if (!socket.data.user) return fail('AUTH_REQUIRED');
    const board = await getLeaderboard(socket);
    return { ok: true, user: board.me, me: board.me, top: board.top };
  }

  /** TOP 10 (mmr 내림차순) + 내 전적. 유저 ID 는 응답에 넣지 않는다 (내 줄은 isMe 로만) */
  async function getLeaderboard(socket) {
    await socket.data.authReady;
    const me = socket.data.user;
    if (me) await users.ready(me.id);
    const top = await users.leaderboard(LEADERBOARD_SIZE);
    return {
      ok: true,
      top: top.map((rec, i) => ({ rank: i + 1, ...users.publicView(rec), isMe: rec.id === me?.id })),
      me: me ? users.publicView(users.get(me.id)) : null,
    };
  }

  /** 로그인한 소켓만 (방 · 매칭) — 연결할 때 보낸 토큰 확인이 끝날 때까지 기다린다 */
  const needUser = (handler) => async (socket, payload) => {
    await socket.data.authReady;
    if (!socket.data.user) return fail('AUTH_REQUIRED');
    return handler(socket, payload);
  };

  // ── HTTP: 상태 확인 + 계정 API + 정적 파일 ──
  app.disable('x-powered-by');
  app.set('trust proxy', true); // Render 같은 프록시 뒤 → req.ip = 접속한 사람의 IP (IP 별 로그인 시도 제한)
  app.get('/health', (req, res) => res.json({ ok: true, uptime: process.uptime() })); // 클라우드 호스팅(Render · Railway) 헬스체크
  app.get('/healthz',(req, res) => res.json({ ok: true, ...stats() }));
  app.use('/api', apiCors(cfg.corsOrigin), express.json({ limit: '2kb' }));
  app.post('/api/signup', (req, res) => respond(res, apiSignup(req)));
  app.post('/api/login', (req, res) => respond(res, apiLogin(req)));
  app.post('/api/rename', (req, res) => respond(res, apiRename(req)));
  app.use('/api', (err, req, res, next) => { // 깨진 JSON 등
    if (res.headersSent) { next(err); return; }
    res.status(400).json(fail('BAD_REQUEST'));
  });
  app.use(blockServerInternals);
  app.use(express.static(ROOT, { dotfiles: 'ignore' }));

  // ── Socket.io 이벤트 라우팅: 이벤트 이름 → 처리하는 쪽 ──
  const handlers = {
    register_player: registerPlayer,
    get_leaderboard: getLeaderboard,
    watch_rooms: (socket) => { socket.join(LOBBY_CHANNEL); return { ok: true, rooms: rooms.publicRooms() }; },
    unwatch_rooms: (socket) => { socket.leave(LOBBY_CHANNEL); return { ok: true }; },
    create_public_room: needUser(rooms.createPublicRoom),
    join_public_room: needUser(rooms.joinPublicRoom),
    create_private_room: needUser(rooms.createPrivateRoom),
    join_private_room: needUser(rooms.joinPrivateRoom),
    join_queue: needUser(matchmaker.joinQueue),
    leave_queue: matchmaker.leaveQueue,
    surrender: rooms.surrender,
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
    socket.data = { where: null, win: { start: 0, n: 0 }, lastEmote: 0, user: null, authReady: Promise.resolve() };
    const auth = socket.handshake.auth;
    if (auth && typeof auth === 'object' && typeof auth.token === 'string') {
      socket.data.authReady = authSocket(socket, auth.token).catch((err) => { cfg.onError(err); }); // 틀린 토큰이면 손님 소켓 (연결은 끊지 않는다)
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
        if (typeof result?.then === 'function') { // DB · 토큰 확인을 거치는 처리는 끝난 뒤에 답한다
          result.then((value) => { if (ack) guard(() => ack(value)); }, (err) => { cfg.onError(err); if (ack) guard(() => ack(fail('SERVER_ERROR'))); });
          return;
        }
        if (ack) guard(() => ack(result));
      });
    }
    socket.on('disconnect', () => guard(() => {
      matchmaker.onDisconnect(socket); // 대기 중이었다면 대기열에서 빼고
      rooms.onDisconnect(socket); // 방에 앉아 있었다면 유예 타이머 · 방 정리 (공개 방이면 목록에서도 빠진다)
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
