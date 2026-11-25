// 클라이언트 모듈 검증 (브라우저 없음): node tests/client.test.mjs
//   1. 진동(platformBridge): 결정적인 이벤트 4종만 · 1회만 · 300ms 쿨타임 · 사소한 이벤트 무시 · 연타 없음 · 웹 진동은 짧은 한 번
//   2. 닉네임 규칙(session.js validateNickname): 2~10자 · 공백 없음 · 보이지 않는 문자/이모지 금지 — 서버(userStore.cleanNickname)와 같은 판정
//   3. 세션(UserSession): 서버가 준 토큰으로 로그인 · 자동 로그인(다시 읽기) · 닉네임 변경 · 로그아웃(아이디는 기본값으로) · 손님 · 예전(닉네임 · PIN) 세션 · 손상된 저장값
//   4. 첫 화면 판단(sessionBoot.js): 로그인 토큰도 손님 표시도 없으면 html.needs-login
//   6. 계정 API(accountApi): 회원가입 · 로그인 → 이 기기에 저장 (비밀번호는 저장 안 함) · 형식 검사 · 오류 문구 · 토큰 만료 → 다시 로그인 · 닉네임 변경 · 아이디/비밀번호 규칙이 서버와 같다
//   9. 5초 가입 · 첫 판 가이드 · 초대 링크 · 서버 깨우기: invite.js · wake.js · guide.js · signUp(닉네임 생략) · 화면 연결(index.html · multiplayer.js · app.js)
//   8. 소리 출력 지점 감사: Web Audio 는 soundEngine.js 한 곳뿐 · <audio> · new Audio · 음성 합성 · 시스템 벨(\x07) 없음 · 앱의 소리 호출 가드(포커스 · 인게임 화면)
//   7. 인게임 [항복] / [나가기]: app.js 가 쓰는 요소가 index.html 에 모두 있다 · 확인 모달 · AI 나가기는 전적 · MMR · 탄피를 기록하지 않는다 · 온라인 항복은 서버 요청뿐
//   5. 모드별 정산(PlayerProfile): AI 딜러 = 연습 기록만 · 랭킹전 = 서버 기록으로 MMR · 전적 · 연승 · 친선전 = 탄피만 · 예전 저장값 옮기기
import { readFileSync, readdirSync, statSync } from 'node:fs';
import vm from 'node:vm';
import { PlatformBridge, HAPTIC_COOLDOWN_MS } from '../src/platform/platformBridge.js';
import { randomUUID } from 'node:crypto';
import { UserSession, validateNickname, validateUsername, validatePassword, isUserId, SESSION_KEY } from '../src/ui/session.js';
import { signUp, logIn, changeNickname, serverBase } from '../src/ui/accountApi.js';
import { cleanUsername as serverUsername, cleanPassword as serverPassword } from '../server/auth.js';
import { cleanNickname as serverNickname } from '../server/userStore.js';
import { PlayerProfile, STORAGE_KEY, MMR as CLIENT_MMR, REWARD } from '../src/ui/storeData.js';
import { parseInviteCode, buildInviteLink, rememberInvite, peekInvite, clearInvite, captureInvite, INVITE_KEY, INVITE_TTL_MS } from '../src/ui/invite.js';
import { retryUntil } from '../src/ui/wake.js';
import { GuideState, GUIDE_KEY, GUIDED_TURN_MS, RULE_LINES, COACH_STEPS } from '../src/ui/guide.js';
import { MMR_RULE as SERVER_MMR } from '../server/userStore.js';

const T0 = performance.now();
let pass = 0;
const fails = [];
const ok = (cond, name) => { if (cond) pass += 1; else { fails.push(name); console.log(`  ✗ ${name}`); } };
const eq = (got, want, name) => ok(JSON.stringify(got) === JSON.stringify(want), `${name} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function memoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return { getItem: (k) => (map.has(k) ? map.get(k) : null), setItem: (k, v) => { map.set(k, String(v)); }, removeItem: (k) => { map.delete(k); }, map };
}

// ───────── 1. 진동 ─────────
{
  let t = 1000;
  const impacts = [];
  const env = { Capacitor: { isNativePlatform: () => true, Plugins: { Haptics: { impact: ({ style }) => { impacts.push(style); return Promise.resolve(); } } } } };
  const bridge = new PlatformBridge({ env, now: () => t });
  eq(bridge.getPlatform(), 'app', '1 Capacitor 네이티브 → app');
  eq(HAPTIC_COOLDOWN_MS, 300, '1 쿨타임 300ms');

  const minor = ['light', 'item', 'shot_blank', 'shot_live', 'click', 'turn', 'reload', 'toString', 'constructor', undefined, null, 42];
  ok(minor.every((name) => bridge.triggerHaptic(name) === false) && impacts.length === 0, '1 사소한 이벤트 · 모르는 이름 · 예전 이름은 진동하지 않는다');

  eq([bridge.triggerHaptic('shot'), impacts], [true, ['MEDIUM']], '1 실탄 발사 → Medium 1회');
  t += 120;
  eq([bridge.triggerHaptic('hit'), impacts], [false, ['MEDIUM']], '1 120ms 뒤 피격(같은 순간의 중복 이벤트) → 쿨타임으로 무시');
  t += HAPTIC_COOLDOWN_MS - 121;
  eq(bridge.triggerHaptic('hit'), false, '1 299ms 째도 무시');
  t += 1;
  eq([bridge.triggerHaptic('hit'), impacts], [true, ['MEDIUM', 'HEAVY']], '1 300ms 가 지나면 피격 → Heavy 1회');
  t += 50;
  ok(bridge.triggerHaptic('item') === false, '1 무시된 이벤트는 쿨타임을 새로 시작시키지 않는다 (1)');
  t += 250;
  eq([bridge.triggerHaptic('win'), impacts], [true, ['MEDIUM', 'HEAVY', 'MEDIUM']], '1 무시된 이벤트는 쿨타임을 새로 시작시키지 않는다 (2) · 승리 → Medium');
  t += 400;
  eq([bridge.triggerHaptic('lose'), impacts.at(-1)], [true, 'HEAVY'], '1 패배 → Heavy');
  await sleep(160); // 예전에는 setTimeout 으로 2연타를 이어 울렸다 — 이제 추가 진동이 없어야 한다
  eq(impacts.length, 4, '1 연타(지연 진동) 없음');

  const burst = new PlatformBridge({ env: { Capacitor: env.Capacitor }, now: () => 5000 });
  const before = impacts.length;
  const fired = ['shot', 'hit', 'shot', 'win', 'lose'].map((name) => burst.triggerHaptic(name));
  eq([fired, impacts.length - before], [[true, false, false, false, false], 1], '1 같은 순간 이벤트 5개 → 진동 1번');

  let wt = 0;
  const vibrations = [];
  const web = new PlatformBridge({ env: { navigator: { vibrate: (p) => { vibrations.push(p); return true; } } }, platform: 'web', now: () => wt });
  web.triggerHaptic('hit');
  wt = 400;
  web.triggerHaptic('shot');
  eq(vibrations, [35, 20], '1 웹(navigator.vibrate)은 패턴 없이 짧은 한 번');
  const quiet = new PlatformBridge({ env: {}, platform: 'web' });
  ok(quiet.triggerHaptic('hit') === true, '1 진동을 지원하지 않는 기기에서도 예외 없이 처리');
  const broken = new PlatformBridge({ env: { Capacitor: { isNativePlatform: () => true, Plugins: { Haptics: { impact: () => { throw new Error('boom'); } } } } } });
  let threw = false;
  try { broken.triggerHaptic('shot'); } catch { threw = true; }
  ok(!threw, '1 플러그인이 예외를 던져도 게임은 계속');
}

// ───────── 1-b. 결제 · 광고: SDK 연결 전에는 개발 PC(localhost)에서만 시뮬레이션, 공개 웹 · 앱은 '준비 중' ─────────
{
  const dev = new PlatformBridge({ env: { location: { hostname: 'localhost', search: '' } } });
  const pub = new PlatformBridge({ env: { location: { hostname: 'last-chamber-aaz9.onrender.com', search: '' } } });
  const app = new PlatformBridge({ env: { location: { hostname: 'localhost', search: '' }, Capacitor: { isNativePlatform: () => true, Plugins: {} } } });
  eq([dev.isAvailable('ads'), dev.isAvailable('purchase')], [true, true], '1b 개발 PC(localhost 웹)는 시뮬레이션 가능');
  eq([pub.isAvailable('ads'), pub.isAvailable('purchase'), app.isAvailable('ads'), app.isAvailable('purchase')], [false, false, false, false], '1b 공개 웹 · 앱은 준비 중');
  eq(await pub.purchaseProduct('starter_pack', 1900), { success: false, reason: 'unavailable' }, '1b 공개 웹 결제 → 무료 지급 없이 unavailable');
  eq(await pub.showRewardedAd('double_reward'), { rewarded: false, reason: 'unavailable' }, '1b 공개 웹 광고 → unavailable');
  pub.registerDriver('web', { purchase: async () => ({ success: true }) });
  eq([pub.isAvailable('purchase'), (await pub.purchaseProduct('starter_pack', 1900)).success], [true, true], '1b 실제 결제 드라이버가 붙으면 바로 열린다');
}

// ───────── 2. 닉네임 규칙 ─────────
{
  const cases = [
    ['방랑자', true, '방랑자'],
    ['  방랑자  ', true, '방랑자'],
    ['Ace_7', true, 'Ace_7'],
    ['ab', true, 'ab'],
    ['가나다라마바사아자차', true, '가나다라마바사아자차'], // 10자
    ['a.b-c·d', true, 'a.b-c·d'],
    ['방 랑자', false, 'whitespace'],
    ['Kim　Lee', false, 'whitespace'], // 전각 공백
    ['tab\there', false, 'whitespace'],
    ['a', false, 'too_short'],
    ['가나다라마바사아자차카', false, 'too_long'], // 11자
    ['', false, 'empty'],
    ['   ', false, 'empty'],
    [12345, false, 'empty'],
    ['!!', false, 'invalid_chars'],
    ['__', false, 'invalid_chars'], // 기호만
    ['ㅤㅤ', false, 'invalid_chars'], // 한글 채움 문자 — 보이지 않는 이름
    ['​가나', false, 'invalid_chars'], // 폭 없는 공백
    ['😀😀', false, 'invalid_chars'],
    ['<b>x</b>', false, 'invalid_chars'],
  ];
  for (const [raw, good, want] of cases) {
    const res = validateNickname(raw);
    eq(good ? [res.ok, res.nickname] : [res.ok, res.reason], [good, want], `2 닉네임 ${JSON.stringify(raw)}`);
    const server = serverNickname(raw);
    ok(good ? server === want : server === null, `2 서버도 같은 판정 ${JSON.stringify(raw)} (server: ${JSON.stringify(server)})`);
  }
}

// ───────── 3. 세션 ─────────
{
  const token = (id) => `t1.${id}.1800000000.${'a'.repeat(43)}`;
  const storage = memoryStorage();
  const seen = [];
  const s1 = new UserSession({ storage, now: () => 1000 });
  s1.subscribe((user) => seen.push(user?.nickname ?? null));
  eq([s1.user, s1.isLoggedIn, s1.isGuest, s1.token], [null, false, false, null], '3 처음에는 로그인 전');
  const id = randomUUID();
  eq(s1.signIn({ token: 'fake', id, username: 'gunner', nickname: '총잡이' }).ok, false, '3 토큰 모양이 틀리면 로그인하지 않는다');
  eq(s1.signIn({ token: token(id), id, username: 'gunner', nickname: '총 잡이' }), { ok: false, reason: 'whitespace' }, '3 닉네임 규칙이 틀리면 로그인하지 않는다');
  ok(storage.map.size === 0 && seen.length === 0, '3 거절된 로그인은 저장 · 알림 없음');
  const res = s1.signIn({ token: token(id), id, username: 'Gunner', nickname: '총잡이' });
  eq([res.ok, res.user], [true, { id, username: 'gunner', nickname: '총잡이' }], '3 서버가 준 토큰 · ID · 아이디 · 닉네임으로 로그인 (아이디는 소문자)');
  const stored = JSON.parse(storage.map.get(SESSION_KEY));
  eq([stored.v, stored.token, stored.id, stored.username, stored.nickname, stored.loggedIn, 'password' in stored], [3, token(id), id, 'gunner', '총잡이', true, false], '3 localStorage 에 토큰 · 계정 정보 저장 (비밀번호는 저장하지 않는다)');

  const s2 = new UserSession({ storage });
  eq([s2.user, s2.token], [{ id, username: 'gunner', nickname: '총잡이' }, token(id)], '3 다시 접속하면 자동 로그인');
  eq([s1.setNickname('Ace_7').ok, s1.user.nickname, seen], [true, 'Ace_7', ['총잡이', 'Ace_7']], '3 닉네임 변경 → 구독자에게 바로 알림');
  eq([s1.setNickname('Ace_7').unchanged, seen.length], [true, 2], '3 같은 닉네임이면 알림 없음');
  s1.logout();
  eq([s1.user, s1.token, s1.lastUsername, s1.lastNickname, seen.at(-1)], [null, null, 'gunner', 'Ace_7', null], '3 로그아웃: 토큰을 지우고 아이디 · 닉네임은 다음 로그인 화면의 기본값으로');
  eq(new UserSession({ storage }).isLoggedIn, false, '3 로그아웃 뒤 다시 접속하면 로그인 화면부터');
  eq(s1.setNickname('정상닉'), { ok: false, reason: 'not_logged_in' }, '3 로그아웃 중에는 닉네임을 바꿀 수 없다');

  eq([s1.continueAsGuest().ok, s1.isGuest, s1.user, new UserSession({ storage }).isGuest], [true, true, null, true], '3 둘러보기(손님) → 다음 접속에도 손님으로 (로그인 화면 없이)');
  s1.signIn({ token: token(id), id, username: 'gunner', nickname: '총잡이' });
  eq([s1.isGuest, s1.isLoggedIn], [false, true], '3 손님이 로그인하면 손님 표시는 사라진다');

  const s3 = new UserSession({ storage });
  const heard = [];
  s3.subscribe((user) => heard.push(user?.nickname ?? null));
  storage.setItem(SESSION_KEY, JSON.stringify({ ...JSON.parse(storage.getItem(SESSION_KEY)), nickname: '다른탭' }));
  s3.reload();
  s3.reload();
  eq([s3.user.nickname, heard], ['다른탭', ['다른탭']], '3 다른 탭의 변경을 reload 로 한 번만 알린다');

  const legacyV1 = new UserSession({ storage: memoryStorage({ [SESSION_KEY]: JSON.stringify({ v: 1, id, nickname: '옛사람', loggedIn: true }) }) });
  const legacyV2 = new UserSession({ storage: memoryStorage({ [SESSION_KEY]: JSON.stringify({ v: 2, id, nickname: '핀사람', pin: '1234', loggedIn: true }) }) });
  eq([legacyV1.isLoggedIn, legacyV1.lastNickname, legacyV2.isLoggedIn, legacyV2.lastNickname], [false, '옛사람', false, '핀사람'], '3 예전(닉네임만 · PIN) 세션은 토큰이 없어 로그아웃 상태 — 닉네임은 기본값으로만');
  eq(new UserSession({ storage: memoryStorage({ [SESSION_KEY]: '{broken' }) }).user, null, '3 손상된 저장값 → 처음부터');
  eq(new UserSession({ storage: memoryStorage({ [SESSION_KEY]: JSON.stringify({ v: 3, token: token(id), id: 'nope', username: 'gunner', nickname: '총잡이', loggedIn: true }) }) }).user, null, '3 UUID 가 아닌 ID → 로그아웃 상태');
  const throwing = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } };
  const memoryOnly = new UserSession({ storage: throwing });
  eq(memoryOnly.signIn({ token: token(id), id, username: 'gunner', nickname: '비공개창' }).ok && memoryOnly.user.nickname, '비공개창', '3 저장소가 예외를 던져도 이번 방문 동안은 로그인 유지');
}

// ───────── 4. 첫 화면 판단 (sessionBoot.js) ─────────
{
  const code = readFileSync(new URL('../src/ui/sessionBoot.js', import.meta.url), 'utf8');
  const boot = (value, { throws = false } = {}) => {
    const classes = new Set();
    const localStorage = { getItem: (k) => { if (throws) throw new Error('denied'); return k === SESSION_KEY ? value : null; } };
    vm.runInNewContext(code, { window: { localStorage }, document: { documentElement: { classList: { add: (c) => classes.add(c) } } }, JSON });
    return classes.has('needs-login');
  };
  const id = randomUUID();
  const tok = `t1.${id}.1800000000.${'a'.repeat(43)}`;
  eq(boot(null), true, '4 로그인 기록 없음 → needs-login');
  eq(boot(JSON.stringify({ v: 3, token: tok, id, username: 'gunner', nickname: '총잡이', loggedIn: true })), false, '4 로그인 토큰 있음 → 바로 타이틀');
  eq(boot(JSON.stringify({ v: 3, token: null, guest: true, loggedIn: false })), false, '4 손님(둘러보기) → 바로 타이틀');
  eq(boot(JSON.stringify({ v: 3, token: null, id: null, username: 'gunner', nickname: '총잡이', loggedIn: false })), true, '4 로그아웃 상태 → needs-login');
  eq(boot(JSON.stringify({ v: 1, id, nickname: '총잡이', loggedIn: true })), true, '4 예전(토큰 없는) 세션 → needs-login (다시 로그인)');
  eq(boot('{broken'), true, '4 손상된 값 → needs-login');
  eq(boot(null, { throws: true }), true, '4 저장소 접근 불가 → needs-login');
}

// ───────── 5. 모드별 정산 (PlayerProfile) ─────────
{
  const store = (initial) => memoryStorage(initial === undefined ? {} : { [STORAGE_KEY]: JSON.stringify(initial) });
  const ranked = (p) => [p.wins, p.losses, p.streak, p.maxStreak, p.mmr];
  eq([CLIENT_MMR.start, CLIENT_MMR.win, CLIENT_MMR.loss], [SERVER_MMR.start, SERVER_MMR.win, SERVER_MMR.loss], '5 랭킹 MMR 규칙(+25 / −20 · 시작 1000)이 서버와 같다');

  // 예전(v4) 저장값: AI 대전과 섞여 쌓인 전적 · MMR → 연습 기록으로, 랭킹 기록은 처음부터 · 얻은 칭호는 유지
  const old = new PlayerProfile({ storage: store({ v: 4, brass: 500, wins: 12, losses: 5, streak: 3, maxStreak: 4, mmr: 1240, titles: ['newcomer', 'silver_gun'] }) });
  eq(ranked(old), [0, 0, 0, 0, 1000], '5 예전 저장값 → 랭킹 기록은 0승 0패 · MMR 1000 (서버 값으로 다시 맞춘다)');
  eq([old.practice.wins, old.practice.losses, old.practice.streak, old.practice.maxStreak], [12, 5, 3, 4], '5 예전 전적 · 연승은 AI 연습 기록으로 옮긴다');
  ok(old.hasTitle('silver_gun') && old.hasTitle('first_blood'), '5 얻어 둔 칭호는 유지 · 연습 승리로도 전적 칭호를 얻는다');

  // AI 딜러 대전 = 연습: 랭킹 MMR · 전적 · 연승은 그대로
  const p = new PlayerProfile({ storage: store() });
  const before = ranked(p);
  const win = p.recordPractice(true);
  p.recordPractice(true);
  const loss = p.recordPractice(false);
  eq(ranked(p), before, '5 AI 딜러 대전은 랭킹 MMR · 전적 · 연승을 건드리지 않는다');
  eq([p.practice.wins, p.practice.losses, p.practice.maxStreak], [2, 1, 2], '5 AI 대전 승패는 연습 기록에만');
  eq([win.mode, win.ranked, 'mmrDelta' in win, 'tierChange' in win], ['practice', false, false, false], '5 연습 결과에는 MMR 증감 · 티어 변화가 없다');
  eq([win.total, loss.total, loss.canProtect], [REWARD.win + REWARD.streakStep, REWARD.loss, true], '5 탄피 보상 · 연습 연승 보너스 · 2연승 뒤 패배는 연승 보호 대상');
  p.restoreStreak(loss.prevStreak);
  eq([p.practice.streak, p.streak], [2, 0], '5 연승 보호는 연습 연승만 되돌린다');

  // 랭킹전: 서버 기록이 원본
  const r1 = p.recordRanked(true, { record: { wins: 1, losses: 0, streak: 1, maxStreak: 1, mmr: 1025 }, mmrDelta: 25 });
  eq([r1.mode, r1.mmrDelta, r1.mmr, ranked(p)], ['ranked', 25, 1025, [1, 0, 1, 1, 1025]], '5 랭킹전 승 → 서버 기록으로 MMR +25 · 1승 · 1연승');
  const r2 = p.recordRanked(false, { record: { wins: 1, losses: 1, streak: 0, maxStreak: 1, mmr: 1005 }, mmrDelta: -20 });
  eq([r2.mmrDelta, r2.canProtect, ranked(p)], [-20, false, [1, 1, 0, 1, 1005]], '5 랭킹전 패 → MMR −20 · 연승 0 (랭킹 연승은 광고로 되돌리지 않는다)');
  const r3 = p.recordRanked(true, {}); // game_over 를 못 받음 → 서버와 같은 규칙으로 미리
  eq([r3.mmrDelta, ranked(p)], [25, [2, 1, 1, 1, 1030]], '5 서버 기록을 못 받은 랭킹전 → 같은 규칙(+25)으로 미리 반영');
  eq([p.syncRanked({ wins: 2, losses: 1, streak: 1, maxStreak: 1, mmr: 1030 }), p.syncRanked({ wins: 2, losses: 1, streak: 1, maxStreak: 3, mmr: 1050 }), ranked(p)], [false, true, [2, 1, 1, 3, 1050]], '5 로비 접속 때 서버 기록으로 다시 맞춘다 (바뀐 때만 true)');
  eq(p.syncRanked({ wins: 'x' }), false, '5 모양이 틀린 서버 기록은 무시');
  const stale = new PlayerProfile({ storage: store() }); // 거울이 오래됨 (1000) — 서버는 이미 1290 → 1315
  eq(stale.recordRanked(true, { record: { wins: 9, losses: 3, streak: 2, maxStreak: 4, mmr: 1315 }, mmrDelta: 25 }).tierChange, 'up', '5 승급 판정은 서버 기준 직전 점수(1290 → 1315, 골드 진입)로');

  // 친선전: 탄피만
  const brass = p.brass;
  const f = p.recordFriendly(true);
  eq([f.mode, f.ranked, f.bonus, p.brass - brass, ranked(p), p.practice.wins], ['friendly', false, 0, REWARD.win, [2, 1, 1, 3, 1050], 2], '5 친선전은 기본 탄피만 — 랭킹 · 연습 기록 모두 그대로');
}

// ───────── 6. 계정 API (회원가입 · 로그인 · 닉네임 변경) ─────────
{
  const id = randomUUID();
  const tok = `t1.${id}.1800000000.${'b'.repeat(43)}`;
  const calls = [];
  const reply = (status, body) => async (url, init) => { calls.push({ url, body: JSON.parse(init.body) }); return { status, ok: status < 300, json: async () => body }; };
  const okBody = { ok: true, token: tok, user_id: id, username: 'gunner', nickname: '총잡이', me: { wins: 0, losses: 0, mmr: 1000 } };

  // 아이디 · 비밀번호 규칙이 서버와 같다
  const userCases = ['gunner', 'Gunner_01', 'ab', 'abc', 'abcd', 'a'.repeat(16), 'a'.repeat(17), 'gun ner', '한글아이디', 'gun-ner', '  pad1  '];
  eq(userCases.map((u) => (validateUsername(u).ok ? validateUsername(u).username : null)), userCases.map((u) => serverUsername(u)), '6 아이디 규칙: 클라이언트 = 서버 (영문 소문자 · 숫자 · _ 4~16자, 소문자로 맞춤)');
  const passCases = ['12345', '123456', ' 6char', 'x'.repeat(64), 'x'.repeat(65), '비밀번호여섯자'];
  eq(passCases.map((p) => validatePassword(p).ok), passCases.map((p) => serverPassword(p) !== null), '6 비밀번호 규칙: 클라이언트 = 서버 (6~64자)');

  const fresh = new UserSession({ storage: memoryStorage() });
  const made = await signUp({ username: 'Gunner', password: 'secret-pass1', nickname: '총잡이' }, { session: fresh, base: 'http://srv', fetchImpl: reply(200, okBody) });
  eq([made.ok, fresh.user, fresh.token, calls.at(-1).url, calls.at(-1).body], [true, { id, username: 'gunner', nickname: '총잡이' }, tok, 'http://srv/api/signup', { username: 'gunner', password: 'secret-pass1', nickname: '총잡이' }], '6 회원가입 → 바로 로그인 · 토큰 저장');
  ok(!JSON.stringify(fresh).includes('secret-pass1') && !(fresh.token ?? '').includes('secret'), '6 비밀번호는 세션에 남지 않는다');
  const before = calls.length;
  const badInputs = [
    await signUp({ username: 'ab', password: 'secret-pass1', nickname: '총잡이' }, { session: fresh }),
    await signUp({ username: 'gunner', password: '123', nickname: '총잡이' }, { session: fresh }),
    await signUp({ username: 'gunner', password: 'secret-pass1', nickname: '총 잡이' }, { session: fresh }),
    await logIn({ username: 'gunner', password: '' }, { session: fresh }),
  ];
  eq([badInputs.map((r) => r.error), calls.length], [['INVALID_USERNAME', 'INVALID_PASSWORD', 'INVALID_NICKNAME', 'BAD_CREDENTIALS'], before], '6 형식이 틀리면 서버에 보내지도 않는다');

  const other = new UserSession({ storage: memoryStorage() });
  const taken = await signUp({ username: 'gunner', password: 'secret-pass1', nickname: '다른이름' }, { session: other, base: 'http://srv', fetchImpl: reply(409, { ok: false, error: 'USERNAME_TAKEN' }) });
  const nickTaken = await signUp({ username: 'gunner2', password: 'secret-pass1', nickname: '총잡이' }, { session: other, base: 'http://srv', fetchImpl: reply(409, { ok: false, error: 'NICKNAME_TAKEN' }) });
  eq([taken.message, nickTaken.message, other.isLoggedIn], ['이미 사용 중인 아이디예요.', '이미 사용 중인 닉네임이에요.', false], '6 중복 아이디 · 닉네임 안내 (로그인하지 않는다)');
  const wrong = await logIn({ username: 'gunner', password: 'nope-nope' }, { session: other, base: 'http://srv', fetchImpl: reply(401, { ok: false, error: 'BAD_CREDENTIALS' }) });
  const locked = await logIn({ username: 'gunner', password: 'nope-nope' }, { session: other, base: 'http://srv', fetchImpl: reply(429, { ok: false, error: 'LOGIN_LOCKED', retryAfterSec: 600 }) });
  eq([wrong.message, /10분 뒤/.test(locked.message)], ['아이디 또는 비밀번호가 맞지 않아요.', true], '6 틀린 비밀번호 · 잠금 안내');
  const back = await logIn({ username: 'gunner', password: 'secret-pass1' }, { session: other, base: 'http://srv', fetchImpl: reply(200, okBody) });
  eq([back.ok, other.userId, calls.at(-1).url], [true, id, 'http://srv/api/login'], '6 다른 기기에서 로그인 → 같은 계정(user_id)');
  const offline = await logIn({ username: 'gunner', password: 'secret-pass1' }, { session: new UserSession({ storage: memoryStorage() }), base: 'http://srv', fetchImpl: async () => { throw new TypeError('Failed to fetch'); } });
  eq([offline.ok, offline.error], [false, 'OFFLINE'], '6 서버에 못 닿으면 OFFLINE (예외를 던지지 않는다)');

  const renamedOk = await changeNickname('바뀐이름', { session: fresh, base: 'http://srv', fetchImpl: reply(200, { ok: true, nickname: '바뀐이름' }) });
  eq([renamedOk.ok, fresh.user.nickname, calls.at(-1).url, calls.at(-1).body], [true, '바뀐이름', 'http://srv/api/rename', { token: tok, nickname: '바뀐이름' }], '6 닉네임 변경: 토큰과 함께 서버에서 바꾼 뒤 이 기기에도');
  const renamedNo = await changeNickname('남의이름', { session: fresh, base: 'http://srv', fetchImpl: reply(409, { ok: false, error: 'NICKNAME_TAKEN' }) });
  eq([renamedNo.ok, renamedNo.message, fresh.user.nickname], [false, '이미 사용 중인 닉네임이에요.', '바뀐이름'], '6 다른 계정의 닉네임으로는 바뀌지 않는다');
  const asked = [];
  globalThis.window = { dispatchEvent: (e) => asked.push(e.type) };
  const expired = await changeNickname('새닉네임', { session: fresh, base: 'http://srv', fetchImpl: reply(401, { ok: false, error: 'AUTH_REQUIRED' }) });
  delete globalThis.window;
  eq([expired.ok, fresh.isLoggedIn, asked], [false, false, ['lastchamber:need-login']], '6 토큰이 거절되면 로그아웃하고 로그인 화면을 연다');
  eq(serverBase({ LAST_CHAMBER_SERVER: 'https://x.example/', location: { protocol: 'https:', origin: 'https://y' } }), 'https://x.example', '6 서버 주소: LAST_CHAMBER_SERVER 우선');
}

// ───────── 7. 인게임 [항복] / [나가기] (화면 · 연결 — 동작은 tests/pvp-guard.test.mjs · server.test.mjs Phase 9 · 브라우저 확인) ─────────
{
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const app = readFileSync(new URL('../src/ui/app.js', import.meta.url), 'utf8');
  const ids = [...app.matchAll(/\$\('([a-z0-9-]+)'\)/g)].map((m) => m[1]);
  const missing = [...new Set(ids)].filter((id) => !html.includes(`id="${id}"`));
  eq(missing, [], '7 app.js 가 찾는 요소 id 가 index.html 에 모두 있다 (항복 버튼 · 확인 모달 포함)');
  ok(/id="btn-leave"[^>]*\bhidden\b/.test(html), '7 [항복]/[나가기] 버튼은 판이 아닐 때 숨김이 기본');
  ok(/<dialog[^>]*id="leave-modal"/.test(html) && /data-leave="cancel"/.test(html) && /data-leave="confirm"/.test(html), '7 확인 모달: 취소 · 확인 두 버튼');

  const fn = (name) => app.match(new RegExp(`function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}\\n`))?.[0] ?? '';
  const leaveAi = fn('leaveAiGame');
  ok(leaveAi.length > 200, '7 leaveAiGame 을 찾았다');
  ok(!/record|spendBrass|earn|settle/i.test(leaveAi.replace(/\/\/.*$/gm, '')), '7 AI 나가기는 전적 · MMR · 탄피를 기록하지 않는다 (정산 함수를 부르지 않음)');
  ok(/\+\+gameId/.test(leaveAi) && /stopTimer\(\)/.test(leaveAi), '7 AI 나가기는 진행 중인 연출 · 타이머를 끊는다');
  const confirm = fn('confirmLeave');
  ok(/pvpSurrender\(\)/.test(confirm) && !/profile\./.test(confirm), '7 온라인 항복은 서버에 요청만 한다 — 클라이언트가 전적 · MMR 을 직접 바꾸지 않는다');
  ok(/if \(!online\)[\s\S]*leaveAiGame\(\)/.test(confirm), '7 AI 연습이면 서버 없이 바로 나간다');
  ok(/recordedGame !== token/.test(app) && /pvpSettle\(won\)/.test(app), '7 온라인 결과 정산은 기존 endGame 한 곳 (판당 한 번)');
}

// ───────── 8. 소리 출력 지점 감사 · 호출 가드 ─────────
{
  const root = new URL('../', import.meta.url);
  const walk = (dir) => readdirSync(new URL(dir, root)).flatMap((name) => {
    const rel = `${dir}${name}`;
    return statSync(new URL(rel, root)).isDirectory() ? walk(`${rel}/`) : [rel];
  });
  const files = [...walk('src/'), ...walk('server/'), ...walk('scripts/'), 'index.html', 'style.css'].filter((f) => /\.(js|mjs|html|css)$/.test(f));
  const text = (f) => readFileSync(new URL(f, root), 'utf8');
  const hits = (re) => files.filter((f) => re.test(text(f)));
  eq(hits(/createOscillator|createBufferSource|new (?:window\.)?AudioContext|webkitAudioContext/), ['src/ui/soundEngine.js'], '8 Web Audio 를 쓰는 파일은 soundEngine.js 한 곳뿐');
  eq(hits(/new Audio\(|<audio\b|HTMLAudioElement|speechSynthesis|SpeechSynthesisUtterance/), [], '8 <audio> · new Audio · 음성 합성은 쓰지 않는다');
  eq(hits(/\x07|\\x07|\\u0007|\\a['"`]|\bbeep\b/i), [], '8 시스템 벨(\\x07) · beep 출력은 코드 어디에도 없다 (서버 포함)');
  eq(hits(/\bnew Notification\(|navigator\.mediaSession/), [], '8 알림음 · 미디어 세션(백그라운드 재생)은 쓰지 않는다');

  const app = text('src/ui/app.js');
  ok(/new SoundEngine\(\{[^}]*inGame: false/.test(app), '8 앱은 소리 엔진을 인게임 잠금을 잠근 채 만든다');
  ok(/function startGame\([\s\S]*?sound\.setInGame\(true\)[\s\S]*?sound\.startAmbient\(\)/.test(app), '8 판이 시작될 때 잠금을 열고 나서 배경음을 켠다');
  ok(/async function endGame\([\s\S]{0,1800}?sound\.setInGame\(false\)/.test(app), '8 결과 화면에서 잠금을 다시 닫는다');
  ok(/setInGame\(false\)/.test(app.match(/function leaveAiGame\([^)]*\) \{[\s\S]*?\n\}\n/)?.[0] ?? ''), '8 AI 나가기에서도 잠금을 다시 닫는다');
  ok(/const gameSoundOk = \(token = gameId\) => onGameScreen\(token\) && documentFocused\(\)/.test(app) && /const gameSfx = \(play, token = gameId\) => \{ if \(gameSoundOk\(token\)\) play\(\); \}/.test(app), '8 게임 효과음 가드: 같은 판의 게임 화면 + 창 포커스');
  ok(/if \(documentFocused\(\)\) \{[\s\S]{0,80}sound\.playGunshot\(\)/.test(app), '8 총성도 포커스가 있을 때만');
  ok(!/setTimeout\(\(\) => \(kind === 'item' \? sound\./.test(app) && /setTimeout\(\(\) => gameSfx\(/.test(app), '8 예약한 도발 효과음도 울리는 시점에 다시 가드 (판이 끝난 뒤에 새지 않는다)');
  // 게임 전용 소리 호출은 가드(gameSfx · onGameScreen · gameSoundOk) 안에서만 — 직접 호출 줄 수를 고정해 새 호출이 가드 없이 늘어나는 것을 잡는다
  const direct = app.split('\n').filter((l) => /sound\.(playGunshot|playDamage|playHeartbeat)\(/.test(l) && !/gameSfx\(/.test(l)).length;
  eq(direct, 2, '8 가드 없이 직접 부르는 게임 전용 소리는 총성 · 피격 두 줄뿐 (둘 다 onGameScreen + 포커스 블록 안)');
}

// ───────── 9. 5초 가입 · 첫 판 가이드 · 초대 링크 · 서버 깨우기 ─────────
{
  const store = () => { const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), map: m }; };

  // 초대 링크 (invite.js)
  eq([parseInviteCode('?room=a7k9'), parseInviteCode('?x=1&room=Q2WE'), parseInviteCode('?room=A7K0'), parseInviteCode('?room=ABC'), parseInviteCode('?room=<script>'), parseInviteCode(undefined), parseInviteCode('')],
    ['A7K9', 'Q2WE', null, null, null, null, null], '9 ?room= 코드: 소문자는 대문자로 · 모양이 틀리면(0 · 짧음 · 태그) 무시');
  eq([buildInviteLink('a7k9', 'https://last-chamber-aaz9.onrender.com'), buildInviteLink('A7K9', 'https://x.example/'), buildInviteLink('zzzz0', 'https://x.example'), buildInviteLink(undefined, 'https://x.example')],
    ['https://last-chamber-aaz9.onrender.com/?room=A7K9', 'https://x.example/?room=A7K9', '', ''], '9 초대 링크 = <서버 주소>/?room=코드 (끝의 / 중복 없음 · 잘못된 코드는 빈 값)');
  {
    const st = store();
    eq([rememberInvite('A7K9', st, 1000), peekInvite(st, 1000 + 60_000), peekInvite(st, 1000 + INVITE_TTL_MS - 1)], [true, 'A7K9', 'A7K9'], '9 보관한 초대 코드는 15분 안에는 그대로');
    eq([peekInvite(st, 1000 + INVITE_TTL_MS), st.getItem(INVITE_KEY)], [null, null], '9 15분이 지나면 버린다 (방도 10분이면 닫힌다)');
    rememberInvite('Q2WE', st, 5);
    clearInvite(st);
    eq([peekInvite(st, 6), rememberInvite('bad', st, 1)], [null, false], '9 쓴 뒤에는 지운다 · 잘못된 코드는 보관하지 않는다');
    st.setItem(INVITE_KEY, '{깨진 값');
    eq(peekInvite(st, 1), null, '9 깨진 저장값은 무시');
    const broken = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); }, removeItem: () => { throw new Error('blocked'); } };
    eq([rememberInvite('A7K9', broken), peekInvite(broken)], [false, null], '9 저장소를 못 쓰는 환경에서도 던지지 않는다');
  }
  {
    const st = store();
    const replaced = [];
    const win = { location: { search: '?room=q2we&ref=kakao', href: 'https://h.example/play?room=q2we&ref=kakao#top' }, history: { state: null, replaceState: (...a) => replaced.push(a[2]) } };
    eq([captureInvite({ win, storage: st, now: 10 }), replaced], ['Q2WE', ['/play?ref=kakao#top']], '9 링크로 들어오면 코드를 보관하고 주소창에서 room 만 지운다 (새로고침해도 다시 입장하지 않게)');
    eq(captureInvite({ win: { location: { search: '', href: 'https://h.example/' }, history: {} }, storage: st, now: 20 }), 'Q2WE', '9 주소에 코드가 없어도 보관 중인 코드는 가입이 끝날 때까지 남는다');
  }

  // 서버 깨우기 재시도 (wake.js)
  {
    let t = 0;
    const clock = { now: () => t, sleep: async (ms) => { t += ms; } };
    const slows = [];
    let tries = 0;
    const got = await retryUntil(async (i) => { tries += 1; if (i < 3) throw new Error('CONNECT_FAILED'); return 'connected'; }, { ...clock, deadlineMs: 100_000, gapMs: 2000, slowMs: 4000, onSlow: () => slows.push(t) });
    eq([got, tries, slows], ['connected', 4, [4000]], '9 서버가 깨어날 때까지 다시 시도하고, 4초가 지나면 "깨우는 중" 안내를 한 번만');
    t = 0;
    tries = 0;
    let last = null;
    try {
      await retryUntil(async () => { tries += 1; throw new Error('CONNECT_FAILED'); }, { ...clock, deadlineMs: 10_000, gapMs: 2000 });
    } catch (err) { last = err.message; }
    eq([last, tries], ['CONNECT_FAILED', 5], '9 마감(10초)이 지나면 마지막 오류로 포기 — 마감을 넘겨 시도하지 않는다');
    tries = 0;
    let cancelled = null;
    try {
      await retryUntil(async () => { tries += 1; throw new Error('CANCELLED'); }, { ...clock });
    } catch (err) { cancelled = err.message; }
    eq([cancelled, tries], ['CANCELLED', 1], '9 취소(로비를 닫음)는 다시 시도하지 않는다');
    tries = 0;
    let stopped = false;
    try {
      await retryUntil(async () => { tries += 1; throw new Error('CONNECT_FAILED'); }, { ...clock, shouldStop: () => tries >= 2 });
    } catch { stopped = true; }
    eq([stopped, tries], [true, 2], '9 shouldStop 이 참이 되면 바로 멈춘다');
    const live = [];
    const late = await retryUntil(() => new Promise((resolve) => { setTimeout(() => resolve('late'), 80); }), { slowMs: 20, onSlow: () => live.push('slow') });
    eq([late, live], ['late', ['slow']], '9 시도 하나가 오래 걸려도(30초씩 걸리는 콜드스타트) 실패를 기다리지 않고 안내가 바로 뜬다');
  }

  // 첫 판 가이드 (guide.js)
  {
    const st = store();
    const g = new GuideState({ storage: st });
    eq([g.shouldShowRuleCard, g.shouldCoach({ online: false }), g.shouldCoach({ online: true })], [true, true, false], '9 처음: 3줄 룰 카드 · 코치마크 대상 (온라인 판은 코치마크 없음)');
    g.markRuleCard();
    const g2 = new GuideState({ storage: st });
    eq([g2.shouldShowRuleCard, g2.shouldCoach()], [false, true], '9 룰 카드는 한 번 보여 주면 기록 (코치마크는 아직)');
    g2.markCoachDone();
    const g3 = new GuideState({ storage: st });
    eq([g3.shouldShowRuleCard, g3.shouldCoach(), JSON.parse(st.getItem(GUIDE_KEY))], [false, false, { ruleCard: true, coach: true }], '9 코치마크를 마치면 2번째 판부터 모두 생략');
    const veteran = new GuideState({ storage: store(), hadPlayed: true });
    eq([veteran.shouldShowRuleCard, veteran.shouldCoach()], [false, false], '9 이미 게임을 해 본 유저에게는 뜨지 않는다');
    const bad = store();
    bad.setItem(GUIDE_KEY, '{"ruleCard":"예"}');
    eq(new GuideState({ storage: bad }).shouldCoach(), true, '9 깨진 기록은 처음부터');
    const blocked = { getItem: () => { throw new Error('x'); }, setItem: () => { throw new Error('x'); } };
    const gb = new GuideState({ storage: blocked });
    gb.markRuleCard();
    gb.markCoachDone();
    eq(gb.shouldCoach(), false, '9 저장소가 막혀도 던지지 않는다 (이번 접속 안에서는 기억)');
    eq([GUIDED_TURN_MS > 20_000, RULE_LINES.length, COACH_STEPS.map((s) => s.target)], [true, 3, ['shells', 'trigger-panel', 'player-items', 'player-hp']], '9 첫 판 턴 제한은 보통(20초)보다 길다 · 3줄 룰 · 코치마크 4단계(잔탄 · 격발 · 아이템 · 체력)');
  }

  // 닉네임 없는 가입 (accountApi.signUp)
  {
    const sent = [];
    const fetchImpl = async (url, init) => { sent.push({ url, body: JSON.parse(init.body) }); return { ok: true, status: 200, json: async () => ({ ok: true, token: `t1.00000000-0000-4000-8000-000000000000.1800000000.${'c'.repeat(43)}`, user_id: '00000000-0000-4000-8000-000000000000', username: 'quick5', nickname: '붉은총잡이', me: null }) }; };
    const session = new UserSession({ storage: store() });
    const res = await signUp({ username: 'quick5', password: 'secret12' }, { session, base: 'http://srv', fetchImpl });
    eq([res.ok, sent[0].body, res.user?.nickname, session.isLoggedIn], [true, { username: 'quick5', password: 'secret12' }, '붉은총잡이', true], '9 아이디 · 비밀번호만 보낸다 (닉네임은 서버가 붙여 주고, 가입 즉시 로그인 상태)');
    const explicit = await signUp({ username: 'quick6', password: 'secret12', nickname: '직접정함' }, { session: new UserSession({ storage: store() }), base: 'http://srv', fetchImpl });
    eq([explicit.ok, sent[1].body.nickname], [true, '직접정함'], '9 닉네임을 주면 그대로 보낸다 (기존 호출 호환)');
    const before = sent.length;
    const bad = await signUp({ username: 'quick7', password: 'secret12', nickname: 'a' }, { session: new UserSession({ storage: store() }), base: 'http://srv', fetchImpl });
    eq([bad.ok, bad.error, sent.length], [false, 'INVALID_NICKNAME', before], '9 잘못된 닉네임을 직접 주면 요청 전에 거절');
  }

  // 화면 연결 (정적 점검)
  {
    const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
    const gateHtml = html.slice(html.indexOf('id="login-modal"'), html.indexOf('id="account-modal"'));
    ok(/id="tab-signup"[^>]*aria-selected="true"/.test(gateHtml) && /id="tab-login"[^>]*aria-selected="false"/.test(gateHtml) && /id="login-form"[^>]*data-mode="signup"/.test(gateHtml), '9 처음 열리는 탭은 회원가입');
    ok(!/id="login-pass2"|id="login-nick"|login-signup-fields/.test(gateHtml), '9 가입 입력칸은 아이디 · 비밀번호 두 칸뿐 (확인 · 닉네임 칸 없음)');
    ok(/id="login-eye"[^>]*aria-pressed="false"/.test(gateHtml) && /id="login-eye-icon"/.test(gateHtml) && /id="i-eye"/.test(html) && /id="i-eye-off"/.test(html), '9 비밀번호 보기 / 숨기기 눈 아이콘 토글');
    ok(/id="login-guest"[^>]*>[^<]*AI 맛보기/.test(gateHtml), '9 하단 버튼은 "로그인 없이 AI 맛보기"');
    ok(/id="trigger-panel"/.test(html) && /id="first-rules"/.test(html) && /<dialog[^>]*id="coach"/.test(html), '9 3줄 룰 카드 · 코치마크 요소와 짚을 대상(#trigger-panel)이 있다');
    for (const step of COACH_STEPS) ok(html.includes(`id="${step.target}"`), `9 코치마크 대상 #${step.target} 가 index.html 에 있다`);
    const lobby = readFileSync(new URL('../src/ui/multiplayer.js', import.meta.url), 'utf8');
    ok(/CONNECT_TIMEOUT_MS = 30_000/.test(lobby) && /retryUntil\(/.test(lobby) && /서버를 깨우는 중입니다/.test(lobby), '9 소켓 연결 제한 30초 · 재시도 · "서버를 깨우는 중입니다" 안내');
    ok(/case 'copy-invite'/.test(lobby) && /buildInviteLink\(/.test(lobby) && /data-act="copy-invite"/.test(lobby), '9 친선방에 [초대 링크 복사]');
    ok(/lastchamber:signed-in/.test(lobby) && /function joinInvite\(\)[\s\S]*?joinFriendlyRoom\(code\)/.test(lobby) && /captureInvite\(\);\s*\n?if \(peekInvite\(\) && loggedIn\(\)\)/.test(lobby), '9 가입 직후(또는 이미 로그인한 접속)에 보관한 코드로 비밀방에 자동 입장');
    const gate = readFileSync(new URL('../src/ui/loginGate.js', import.meta.url), 'utf8');
    ok(/lastchamber:signed-in/.test(gate) && !/nickname: gate\.nick/.test(gate) && /signUp\(\{ username: gate\.user\.value, password: gate\.pass\.value \}\)/.test(gate), '9 가입은 아이디 · 비밀번호만 보내고, 성공하면 signed-in 이벤트를 낸다');
    const app = readFileSync(new URL('../src/ui/app.js', import.meta.url), 'utf8');
    ok(/const turnLimit = \(\) => \(online \? TURN_MS : guidedGame \? GUIDED_TURN_MS : TURN_MS\)/.test(app) && /el\.coach\.open/.test(app), '9 첫 AI 판만 턴 제한이 길고, 코치마크가 열려 있는 동안 시간이 멈춘다 (온라인은 서버의 20초 그대로)');
    ok(/guide\.shouldCoach\(\{ online \}\) && !coaching/.test(app) && /guide\.markCoachDone\(\)/.test(app) && /guide\.markRuleCard\(\)/.test(app), '9 코치마크는 첫 AI 판 내 첫 턴에 한 번 · 끝(건너뛰기 포함)이면 기록');
  }
}

const ms = Math.round(performance.now() - T0);
console.log(fails.length === 0 ? `PASS  ${pass} checks, 0 failed — ${ms} ms` : `FAIL  ${pass} passed, ${fails.length} failed — ${ms} ms`);
process.exitCode = fails.length === 0 ? 0 : 1;
