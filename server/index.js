/**
 * ODD ROULETTE - 멀티플레이 서버 코어
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
 *   POST /api/signup { username, password, nickname }  회원가입 → { ok, token, user_id, username, nickname, me }   USERNAME_TAKEN · NICKNAME_TAKEN · INVALID_*
 *     nickname 은 필수 — 한글 · 영문 · 숫자 2~10자, 비속어 불가 (src/engine/nicknameRules.js). 대소문자 구분 없이 중복이면 NICKNAME_TAKEN
 *   POST /api/nickname { nickname }                     가입 화면의 중복 확인 → { ok, nickname, available }   INVALID_NICKNAME · RATE_LIMITED
 *   POST /api/login  { username, password }             로그인   → 같은 모양   BAD_CREDENTIALS(아이디가 없거나 비밀번호가 틀림) · LOGIN_LOCKED(5번 틀리면 15분)
 *   POST /api/rename { token, nickname }                닉네임 변경 (players 바로 UPDATE) → { ok, nickname, me }   NICKNAME_TAKEN · AUTH_REQUIRED
 *     token = 로그인 토큰(server/auth.js) — 클라이언트가 localStorage 에 두고 자동 로그인에 쓴다. 비밀번호는 해시로만 저장한다.
 *
 *   POST /api/wallet { token, action, ...args }          서버 지갑 (탄피 · 스킨 · 출석 · 긴급 보급) — 로그인한 계정의 원본은 이 서버다 → { ok, result, wallet, state }
 *     action: get · buy{kind,id} · equip{kind,id} · chest · flame{id} · taunt_buy{id} · taunt_equip{id|null} · title{id} · checkin · emergency · practice{won}
 *     result = 그 동작의 결과 (PlayerProfile 메서드와 같은 { ok, reason, short, ... } · 출석 { ok, day, reward } · 긴급 보급 { ok, amount, left } · 연습 보상 { ok, granted, limited })
 *     wallet = 클라이언트가 거울로 받는 지갑 · state = 출석 · 긴급 보급 · 연습 보상의 지금 상태.  오류: AUTH_REQUIRED · RATE_LIMITED · WALLET_SETUP_REQUIRED(DB 지갑 컬럼 없음 — server/userStore.js WALLET_SQL)
 *     시간 규칙은 모두 한국 시간(Asia/Seoul) 날짜 기준 (server/wallet.js).
 *
 *   ── 소켓 로그인 ── io(url, { auth: { token } }) 또는 register_player({ token }) → 그 소켓을 그 계정으로 기억한다(socket.data.user)
 *     · 토큰이 없거나 틀리면 손님(익명) 소켓: 로비 방 목록 · TOP 10 은 볼 수 있지만 방 만들기 · 입장 · 매칭은 AUTH_REQUIRED (AI 딜러 연습은 서버 없이 된다)
 *     · 상대에게 보내는 프로필 닉네임은 서버가 확인한 계정 닉네임으로 덮어쓴다 (유저 ID 는 상대에게 절대 보내지 않는다)
 *     · 랭킹전(공개 방 'public' · 빠른 매칭 'queue')이 끝나면 두 좌석의 서버 전적(승/패 · 연승 · MMR +25/−20)을 기록하고 game_over 의 record · mmrDelta 로 알려 준다
 *       친선 비밀방(mode 'private')은 친선전 — 전적 · MMR 을 기록하지 않는다 (ranked: false)
 *
 *   ── 클라이언트 → 서버 (마지막 인자로 ack 콜백을 줄 수 있다: { ok: true, ... } | { ok: false, error: 'CODE' }) ──
 *   register_player({ token })                    로비 접속 즉시: 토큰 확인 → { ok, user, me, top }  (me · top = get_leaderboard 와 같다) · 틀린 토큰은 AUTH_REQUIRED
 *                                                 끊긴 채 남아 있는 내 친선 방이 있으면 hostedRoom: 코드 (→ resume_room)
 *   get_leaderboard()                             → { ok, top: [{ rank, nickname, wins, losses, games, streak, maxStreak, mmr, isMe }] (랭킹전 1판 이상 둔 계정만 · mmr 내림차순 10명), me: 내 전적 | null }
 *   watch_rooms() / unwatch_rooms()               로비 방 목록 보기 시작 · 그만 → { ok, rooms, online, queued }  (+ 바뀔 때마다 room_list, 주기적으로 lobby_stats)
 *   create_public_room({ profile })               공개 방 (로비 목록에 보임 · 랭킹전) → { ok, code, mode }  (+ room_created { code, mode })   ⟵ 로그인 필요
 *   join_public_room({ code, profile })           목록에서 누른 공개 방에 입장 → 곧바로 판이 시작된다                                    ⟵ 로그인 필요
 *   create_private_room({ profile })              친선 비밀방 (목록에 안 보임 · 친선전) → { ok, code, mode }   code = 4자리 영문/숫자 (예: A7K9)  ⟵ 로그인 필요
 *   join_private_room(code | { code, profile })   방 코드로 입장 → 곧바로 판이 시작된다                                                  ⟵ 로그인 필요
 *                                                 방장이 자리를 비운 방은 HOST_AWAY (잠시 뒤 다시 시도)
 *   resume_room({ code })                         돌아온 방장이 자기 친선 방 자리를 다시 받는다 → { ok, code, mode, status: 'waiting'|'playing'|'over' }   ⟵ 로그인 필요
 *                                                 (대기 방은 끊긴 뒤 5분 안 · 그새 판이 시작됐으면 match_found(resume) · state_update 를 다시 보낸다)
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
 *   lobby_stats   { online, queued, rooms }   접속자 수 · 빠른 매칭 대기 인원 · 기다리는 공개 방 수 — 로비를 보는 소켓에게 몇 초마다
 *   room_list     { rooms: [{ code, host, mmr, players, capacity, createdAt }] }   상대를 기다리는 공개 방 (방장 닉네임 · 방장 서버 MMR · 1/2)
 *   match_found   { code, mode: 'public'|'queue'|'private', ranked, tier, fee, prize, feePaid(서버 지갑이 이미 참가비를 받았다 — 클라이언트는 따로 내지 않는다), you: 'P1'|'P2', token, opponent: { id, profile }, turnMs, graceMs, resume }
 *   state_update  { code, reason: 'start'|'shoot'|'item'|'timeout'|'rejoin', by?, auto?, state, logFrom, events, deadline, now, opponentConnected }
 *                 state = getPublicState(내 좌석) · events = getLog(내 좌석, logFrom) (rejoin 은 logFrom 0 부터 전체) · deadline = 이 턴이 자동 격발되는 서버 시각(ms) · now = 서버 현재 시각(시계 보정용)
 *   game_over     { code, mode, ranked, tier, fee, prize, winner, youWon, reason: 'normal'|'forfeit'|'surrender', payout, score: { you, opponent }, players: { P1: { mmr }, P2: { mmr } }, record?, mmrDelta? (랭킹전에서 기록된 내 MMR 변동) }
 *                 record = { nickname, wins, losses, games, streak, maxStreak, mmr } — 받는 사람의 계정 서버 전적 (이번 판까지 반영)
 *                 voided = 'EARLY_END'(1라운드가 끝나기 전 항복 · 끊김) | 'PAIR_LIMIT'(같은 두 계정이 하루 3판을 넘김) | null — 무효면 MMR · 전적 · 탄피 보상 없음 (참가비는 환불)
 *                 reward = { brass, refunded } 서버 지갑이 이 판에 지급한 탄피 · 돌려준 참가비,  wallet = 정산 뒤 지갑 (거울을 맞춘다)
 *   opponent_status { code, connected: false, graceMs, until } | { code, connected: true }     receive_emote (보낸 객체 + code)     room_closed { code, reason }     session_replaced { code }
 *   오류 코드: BAD_REQUEST · RATE_LIMITED · AUTH_REQUIRED · ALREADY_IN_ROOM · ROOM_NOT_FOUND · ROOM_FULL · OWN_ROOM · HOST_AWAY · ACCOUNT_BUSY(이 계정이 다른 접속으로 이미 방 · 대기열에 있다) · STALE_ACTION(같은 상태에 대한 중복 입력) · INVALID_TIER · NOT_IN_GAME · INVALID_ACTION · SERVER_BUSY · SERVER_ERROR · (엔진) NOT_YOUR_TURN · INVALID_TARGET · INVALID_ITEM …
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
import { randomInt } from 'node:crypto';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { Server } from 'socket.io';
import { createRoomManager, fail, cleanProfile, ROOM_DEFAULTS, TURN_MS, GRACE_MS, ROOM_TTL_MS, RESULT_TTL_MS, LOBBY_CHANNEL } from './roomManager.js';
import { createMatchmaker, QUEUE_TIERS } from './matchmaker.js';
import { createUserStore, supabaseOrigin, USER_DEFAULTS } from './userStore.js';
import { cleanUsername, cleanPassword, issueToken, createLoginLimiter, createWindowLimiter, LOGIN_LIMITS } from './auth.js';
import { checkNewNickname } from '../src/engine/nicknameRules.js';
import { runStoreAction, checkIn, claimEmergency, claimPractice, walletView, walletStatus, grantBrass, spendBrass } from './wallet.js';

// 테스트 · 이후 단계가 server/index.js 하나만 import 해도 되도록 규칙 상수와 프로필 검사기를 그대로 다시 내보낸다
export { TURN_MS, GRACE_MS, ROOM_TTL_MS, RESULT_TTL_MS, QUEUE_TIERS, cleanProfile };

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// 서버 전체 설정의 기본값 — 방 관련 값(턴 · 유예 · 만료 · 방 수 · 이모트 간격)은 roomManager 의 ROOM_DEFAULTS
const SERVER_DEFAULTS = {
  eventsPerSec: 30, // 소켓당 초당 이벤트 상한
  pingInterval: 5000, // 끊긴 연결을 빨리 알아채려고 기본(25초)보다 짧게
  pingTimeout: 5000,
  quiet: false,
  onError: (err) => console.error('[ODD ROULETTE] 서버 오류', err),
  userDataFile: null, // 유저 닉네임 · 전적 JSON 파일 (null = 메모리에만 — 직접 실행할 때는 아래 isMainModule 이 server/data/users.json 을 넘긴다)
  maxUsers: USER_DEFAULTS.maxUsers,
  userSaveDelayMs: USER_DEFAULTS.saveDelayMs,
  supabaseUrl: null, // 둘 다 있으면 Supabase (직접 실행할 때는 isMainModule 이 환경 변수를 넘긴다 — 테스트가 실제 DB 를 건드리지 않게)
  supabaseKey: null,
  supabaseClient: null, // 이미 만든 클라이언트 (테스트용 가짜 등)
  authSecret: null, // 로그인 토큰 서명 비밀 (null = 환경 변수 AUTH_SECRET)
  loginLimits: null, // 로그인 시도 제한 (테스트에서 줄인다) — 기본 LOGIN_LIMITS
  lobbyStatsMs: 10_000, // 로비를 보는 소켓에게 접속자 수 · 대기 인원을 보내는 간격
  walletRatePer10s: 40, // 계정당 지갑 요청 (10초 안에)
  signupPer10Min: 10, // IP 당 가입 시도 (10분)
  signupPerDay: 40, // IP 당 가입 시도 (하루)
  nickChecksPerMinute: 60, // IP 당 닉네임 중복 확인 (1분) — 가입 화면에서 입력을 멈출 때마다 한 번
  roomsPerMinute: 12, // 계정당 방 만들기 · 매칭 요청 (1분)
  joinFailsPerMinute: 15, // 계정 · IP 당 '없는 방' 응답 (1분) — 4자리 방 코드 대입 방지
  maxSocketsPerIp: 60, // IP 당 동시 소켓 (봇 도배 방지 · 같은 공유기를 쓰는 사람들은 넉넉히)
  // 접속자 IP 를 어디서 읽는가: Render 는 Cloudflare 뒤라 cf-connecting-ip 를 믿는다. 그 밖의 프록시는 TRUST_PROXY_HOPS(앞단 프록시 수).
  // 둘 다 아니면 소켓 주소 — 클라이언트가 보낸 X-Forwarded-For 를 그대로 믿으면 IP 제한이 위조로 뚫린다
  trustCloudflare: process.env.RENDER === 'true',
  proxyHops: Number(process.env.TRUST_PROXY_HOPS) || (process.env.RENDER === 'true' ? 1 : 0),
};

/** 모든 HTTP 응답에 붙이는 보안 헤더 */
export const SECURITY_HEADERS = Object.freeze({
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "frame-ancestors 'none'; object-src 'none'; base-uri 'self'",
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Strict-Transport-Security': 'max-age=15552000',
});

/** 요청 헤더 + 소켓 주소 → { ip, source } — 믿기로 한 앞단이 붙인 값만 읽는다 */
export function clientAddress(headers, remote, { trustCloudflare = false, proxyHops = 0 } = {}) {
  const cf = trustCloudflare ? headers?.['cf-connecting-ip'] : null;
  if (typeof cf === 'string' && cf) return { ip: cf, source: 'cloudflare' };
  if (proxyHops > 0) {
    const chain = String(headers?.['x-forwarded-for'] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    if (chain.length) return { ip: chain[Math.max(0, chain.length - proxyHops)], source: 'forwarded' }; // 뒤에서부터 — 앞쪽 항목은 클라이언트가 지어낼 수 있다
  }
  return { ip: remote ?? '?', source: 'socket' };
}
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

// 허용 목록: 여기 없는 것은 모두 404 (서버 소스 · 설정 · 나중에 생길 파일까지) — 게임 화면에 필요한 것만 연다
const PUBLIC_TOP = new Set(['', 'index.html', 'style.css', 'manifest.webmanifest', 'favicon.ico', 'src', 'assets', 'public']); // public/ = 효과음 같은 정적 파일

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
  if (!PUBLIC_TOP.has(top) || req.path.includes('~')) return res.status(404).end(); // ~ = 윈도우 8.3 짧은 이름
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
  WALLET_SETUP_REQUIRED: 503,
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
  const log = (...args) => { if (!cfg.quiet) console.log('[ODD ROULETTE]', ...args); };
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
  // 서버 지갑 창구 (대기열 · 방이 쓴다): 이미 불러 둔 지갑만 다룬다 — 소켓 로그인 때 getWallet 으로 미리 불러 두고, 불러오지 못한 계정은 예전 방식(클라이언트 정산)
  const nowMs = () => cfg.clock();
  const wallets = {
    managed: (userId) => Boolean(userId && users.walletNow(userId)),
    spend: (userId, amount) => {
      const w = users.walletNow(userId);
      if (!w || !spendBrass(w, amount)) return false;
      users.commitWallet(userId);
      return true;
    },
    grant: (userId, amount) => {
      const w = users.walletNow(userId);
      if (!w) return null;
      grantBrass(w, amount);
      users.commitWallet(userId);
      return w.brass;
    },
    view: (userId) => {
      const w = users.walletNow(userId);
      return w ? walletView(w) : null;
    },
  };
  const MIN_ENTRY_FEE = Math.min(...Object.values(QUEUE_TIERS).map((t) => t.fee).filter((f) => f > 0)); // 가장 싼 유료 테이블의 참가비 — 이 미만이면 긴급 보급 대상
  const rooms = createRoomManager({ io, cfg, log, guard, tiers: QUEUE_TIERS, users, wallets, onRoomsChanged: sendRoomList, queuedElsewhere: (userId, socketId) => matchmaker.queuedElsewhere(userId, socketId) });
  const matchmaker = createMatchmaker({ io, rooms, tiers: QUEUE_TIERS, wallets });
  const lobbyStats = () => ({ online: io.engine.clientsCount, queued: matchmaker.queued(), rooms: rooms.publicRooms().length });
  const stats = () => {
    const health = users.health();
    const dbKey = keyKind ?? (health.storage === 'supabase' ? 'publishable(기본값)' : null);
    return { ...rooms.stats(), queued: matchmaker.queued(), users: users.size(), ...health, dbKey, node: process.version };
  };
  const limiter = createLoginLimiter({ ...LOGIN_LIMITS, ...cfg.loginLimits }); // 아이디별 비밀번호 오답 잠금 · IP 별 시도 수
  const signupBurst = createWindowLimiter({ max: cfg.signupPer10Min, windowMs: 10 * 60_000 });
  const signupDaily = createWindowLimiter({ max: cfg.signupPerDay, windowMs: 24 * 3600_000 });
  const nickChecks = createWindowLimiter({ max: cfg.nickChecksPerMinute, windowMs: 60_000 });
  const roomStarts = createWindowLimiter({ max: cfg.roomsPerMinute, windowMs: 60_000 });
  const joinMisses = createWindowLimiter({ max: cfg.joinFailsPerMinute, windowMs: 60_000 });
  const addressOf = (headers, remote) => clientAddress(headers, remote, cfg);
  const ipOfRequest = (req) => addressOf(req.headers, req.socket?.remoteAddress).ip;

  // ── 계정: 가입 · 로그인 · 닉네임 변경 (HTTP) ──
  const sessionOf = (rec) => ({
    ok: true, token: issueToken(rec, authSecret), user_id: rec.id, username: rec.username, nickname: rec.nickname, me: users.publicView(rec),
  });

  /** POST /api/signup { username, password, nickname } */
  async function apiSignup(req) {
    const ip = ipOfRequest(req);
    if (!limiter.allowIp(ip)) return fail('RATE_LIMITED');
    const username = cleanUsername(req.body?.username);
    if (!username) return fail('INVALID_USERNAME');
    const password = cleanPassword(req.body?.password);
    if (!password) return fail('INVALID_PASSWORD');
    const checked = checkNewNickname(req.body?.nickname); // 닉네임은 필수 · 한글/영문/숫자 2~10자 · 비속어 불가
    if (!checked.ok) return { ...fail('INVALID_NICKNAME'), reason: checked.reason };
    const { nickname } = checked;
    if (!signupBurst.hit(ip) || !signupDaily.hit(ip)) return fail('RATE_LIMITED'); // 계정 도배(봇) 방지
    const res = await users.signup({ username, password, nickname });
    if (!res.ok) return fail(res.error);
    log('회원가입', username);
    return sessionOf(res.user);
  }

  /** POST /api/nickname { nickname } — 가입 화면의 중복 확인 (로그인 없이) → { ok, nickname, available } */
  async function apiNickname(req) {
    if (!nickChecks.hit(ipOfRequest(req))) return fail('RATE_LIMITED');
    const checked = checkNewNickname(req.body?.nickname);
    if (!checked.ok) return { ...fail('INVALID_NICKNAME'), reason: checked.reason };
    const res = await users.checkNickname(checked.nickname);
    return res.ok ? { ok: true, nickname: checked.nickname, available: res.available } : fail(res.error);
  }

  /** POST /api/login { username, password } */
  async function apiLogin(req) {
    if (!limiter.allowIp(ipOfRequest(req))) return fail('RATE_LIMITED');
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
    if (!limiter.allowIp(ipOfRequest(req))) return fail('RATE_LIMITED');
    const rec = await users.authenticate(req.body?.token);
    if (!rec) return fail('AUTH_REQUIRED');
    // 지금 쓰는 이름 그대로면 검사 없이 (예전 규칙으로 만든 닉네임 포함), 바꿀 때만 새 규칙
    const checked = req.body?.nickname === rec.nickname ? { ok: true, nickname: rec.nickname } : checkNewNickname(req.body?.nickname);
    if (!checked.ok) return { ...fail('INVALID_NICKNAME'), reason: checked.reason };
    const { nickname } = checked;
    const res = await users.rename(rec.id, nickname);
    if (!res.ok) return fail(res.error);
    for (const socket of io.sockets.sockets.values()) if (socket.data.user?.id === rec.id) socket.data.user.nickname = nickname;
    return { ok: true, nickname, me: users.publicView(res.user) };
  }

  /** POST /api/wallet { token, action, ...args } */
  const walletHits = new Map(); // 계정 → { start, n } 10초 창
  async function apiWallet(req) {
    const rec = await users.authenticate(req.body?.token);
    if (!rec) return fail('AUTH_REQUIRED');
    const t = Date.now();
    const hit = walletHits.get(rec.id);
    if (walletHits.size > 10_000) for (const [id, w] of walletHits) if (t - w.start >= 10_000) walletHits.delete(id);
    if (!hit || t - hit.start >= 10_000) walletHits.set(rec.id, { start: t, n: 1 });
    else if ((hit.n += 1) > cfg.walletRatePer10s) return fail('RATE_LIMITED');
    const wallet = await users.getWallet(rec.id);
    if (!wallet) return fail('WALLET_SETUP_REQUIRED');
    const args = req.body ?? {};
    const stats = { wins: rec.wins, losses: rec.losses, streak: rec.streak, maxStreak: rec.maxStreak, mmr: rec.mmr, nickname: rec.nickname };
    // 한 번에 하나씩 — 아래 동작은 await 없이 동기로 지갑을 바꾸므로 같은 계정의 요청이 겹쳐도 서로 끼어들지 못한다
    let result;
    switch (args.action) {
      case 'get': result = { ok: true }; break;
      case 'checkin': result = checkIn(wallet, nowMs()); break;
      case 'emergency': result = claimEmergency(wallet, nowMs(), MIN_ENTRY_FEE); break;
      case 'practice': result = claimPractice(wallet, args.won === true, nowMs()); break;
      case 'buy': case 'equip': case 'chest': case 'flame': case 'taunt_buy': case 'taunt_equip': case 'title':
        result = runStoreAction(wallet, stats, args.action, args, () => randomInt(2 ** 32) / 2 ** 32); // 상자 추첨은 서버 난수
        break;
      default: return fail('BAD_REQUEST');
    }
    if (args.action !== 'get') users.commitWallet(rec.id);
    return { ok: true, result, wallet: walletView(wallet), state: walletStatus(wallet, nowMs(), MIN_ENTRY_FEE) };
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
    await users.getWallet(rec.id).catch(() => null); // 서버 지갑을 미리 불러 둔다 (판 진행 중에는 동기로 쓴다) — 못 불러오면 지갑 없이 (예전 방식)
    if (socket.data.user && socket.data.user.id !== rec.id && socket.data.where) return null; // 불러오는 사이 앉았다
    socket.data.user = { id: rec.id, nickname: rec.nickname, rec }; // rec = 서버 계정 기록 (상대에게 보이는 이름 · MMR 은 여기서)
    return rec;
  }

  /** register_player({ token }): 로비 접속 즉시 — 토큰 확인 → 내 전적 + TOP 10 */
  async function registerPlayer(socket, payload) {
    await socket.data.authReady;
    if (payload?.token !== undefined && !(await authSocket(socket, payload.token))) return fail('AUTH_REQUIRED');
    if (!socket.data.user) return fail('AUTH_REQUIRED');
    const board = await getLeaderboard(socket);
    const hostedRoom = rooms.hostedRoomOf(socket.data.user.id); // 끊긴 채 남아 있는 내 친선 방
    return { ok: true, user: board.me, me: board.me, top: board.top, ...(hostedRoom ? { hostedRoom } : {}) };
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
    if (!socket.connected) return fail('NOT_CONNECTED'); // 확인하는 사이 끊겼다 — 끊긴 소켓이 방 · 대기열에 남거나 참가비를 잃지 않게
    return handler(socket, payload);
  };
  /** 방 만들기 · 매칭: 계정당 분당 횟수 제한 */
  const paced = (handler) => (socket, payload) => (roomStarts.hit(socket.data.user.id) ? handler(socket, payload) : fail('RATE_LIMITED'));
  /** 방 코드로 들어가기: '없는 방' 이 쌓이면 잠시 막는다 (4자리 코드를 대입해 남의 비밀방에 끼어드는 것 방지) */
  const guarded = (handler) => (socket, payload) => {
    const keys = [`u:${socket.data.user.id}`, `ip:${socket.data.ip}`];
    if (keys.some((key) => joinMisses.blocked(key))) return fail('RATE_LIMITED');
    const result = handler(socket, payload);
    if (result?.error === 'ROOM_NOT_FOUND') for (const key of keys) joinMisses.hit(key);
    return result;
  };

  // ── HTTP: 상태 확인 + 계정 API + 정적 파일 ──
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);
    next();
  });
  io.engine.on('headers', (headers) => Object.assign(headers, SECURITY_HEADERS)); // Socket.io 의 polling 응답에도
  app.get('/health', (req, res) => res.json({ ok: true, uptime: process.uptime() })); // 클라우드 호스팅(Render · Railway) 헬스체크
  app.get('/healthz', (req, res) => { // 공개 주소다 — 상태만 (DB 주소 · 오류 원문 · 키 종류 · 런타임 버전은 내보내지 않는다: 원인은 서버 로그의 [DB ERROR])
    const { rooms: roomCount, waiting, playing, queued, storage, dbOk, dbError: lastError, accountReady, walletReady, authSecret: hasSecret } = stats();
    res.json({ ok: true, rooms: roomCount, waiting, playing, queued, storage, dbOk, dbError: Boolean(lastError), accountReady, walletReady, authSecret: hasSecret, ipSource: addressOf(req.headers, req.socket?.remoteAddress).source });
  });
  app.use('/api', apiCors(cfg.corsOrigin), (req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); }, express.json({ limit: '2kb' }));
  app.post('/api/signup', (req, res) => respond(res, apiSignup(req)));
  app.post('/api/nickname', (req, res) => respond(res, apiNickname(req)));
  app.post('/api/login', (req, res) => respond(res, apiLogin(req)));
  app.post('/api/rename', (req, res) => respond(res, apiRename(req)));
  app.post('/api/wallet', (req, res) => respond(res, apiWallet(req)));
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
    watch_rooms: (socket) => { socket.join(LOBBY_CHANNEL); const { online, queued } = lobbyStats(); return { ok: true, rooms: rooms.publicRooms(), online, queued }; },
    unwatch_rooms: (socket) => { socket.leave(LOBBY_CHANNEL); return { ok: true }; },
    create_public_room: needUser(paced(rooms.createPublicRoom)),
    join_public_room: needUser(guarded(rooms.joinPublicRoom)),
    create_private_room: needUser(paced(rooms.createPrivateRoom)),
    join_private_room: needUser(guarded(rooms.joinPrivateRoom)),
    resume_room: needUser(guarded(rooms.resumeRoom)), // 자리를 비웠던 방장이 자기 친선 방을 다시 받는다
    join_queue: needUser(paced(matchmaker.joinQueue)),
    leave_queue: matchmaker.leaveQueue,
    surrender: rooms.surrender,
    leave_room: (socket) => (socket.data.where?.kind === 'queue' ? matchmaker.leaveQueue(socket) : rooms.leaveRoom(socket)), // 대기 중이면 대기열에서, 아니면 방에서
    rejoin_room: needUser(guarded(rooms.rejoinRoom)), // 좌석 토큰 + 그 좌석의 계정
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

  const socketsPerIp = new Map(); // IP → 열린 연결 수
  io.use((socket, next) => {
    const { ip } = addressOf(socket.handshake.headers, socket.handshake.address);
    const open = socketsPerIp.get(ip) ?? 0;
    if (open >= cfg.maxSocketsPerIp) { next(new Error('RATE_LIMITED')); return; }
    socketsPerIp.set(ip, open + 1);
    socket.conn.once('close', () => {
      const left = (socketsPerIp.get(ip) ?? 1) - 1;
      if (left > 0) socketsPerIp.set(ip, left);
      else socketsPerIp.delete(ip);
    });
    socket.data.ip = ip;
    next();
  });

  io.on('connection', (socket) => {
    socket.data = { ip: socket.data.ip, where: null, win: { start: 0, n: 0 }, lastEmote: 0, user: null, authReady: Promise.resolve() };
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

  // 로비를 보는 소켓에게 접속자 수 · 대기 인원을 몇 초마다 (보는 사람이 없으면 보내지 않는다)
  const statsTimer = setInterval(() => {
    if (io.sockets.adapter.rooms.get(LOBBY_CHANNEL)?.size) io.to(LOBBY_CHANNEL).emit('lobby_stats', lobbyStats());
  }, cfg.lobbyStatsMs);
  statsTimer.unref?.();

  // ── 시작 · 종료 ──
  const start = (port = Number(process.env.PORT || 3000), host) => new Promise((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(port, host, () => {
      httpServer.off('error', reject);
      resolve(httpServer.address().port);
    });
  });

  async function stop() {
    clearInterval(statsTimer);
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
    console.log(`[ODD ROULETTE] http://localhost:${port}  (정적 파일 + Socket.io · 턴 ${TURN_MS / 1000}초 · 재접속 ${GRACE_MS / 1000}초)`);
  }).catch((err) => {
    console.error('[ODD ROULETTE] 서버를 시작하지 못했습니다:', err.message);
    process.exit(1);
  });
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => { server.stop().finally(() => process.exit(0)); });
  }
}
