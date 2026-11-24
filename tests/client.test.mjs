// 클라이언트 모듈 검증 (브라우저 없음): node tests/client.test.mjs
//   1. 진동(platformBridge): 결정적인 이벤트 4종만 · 1회만 · 300ms 쿨타임 · 사소한 이벤트 무시 · 연타 없음 · 웹 진동은 짧은 한 번
//   2. 닉네임 규칙(session.js validateNickname): 2~10자 · 공백 없음 · 보이지 않는 문자/이모지 금지 — 서버(userStore.cleanNickname)와 같은 판정
//   3. 세션(UserSession): 로그인 · UUID 발급 · 자동 로그인(다시 읽기) · 닉네임 변경 · 로그아웃(ID 유지) · 손상된 저장값 · 저장소 없음
//   4. 첫 화면 판단(sessionBoot.js): 로그인 기록이 없거나 깨졌으면 html.needs-login
//   5. 모드별 정산(PlayerProfile): AI 딜러 = 연습 기록만 · 랭킹전 = 서버 기록으로 MMR · 전적 · 연승 · 친선전 = 탄피만 · 예전 저장값 옮기기
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { PlatformBridge, HAPTIC_COOLDOWN_MS } from '../src/platform/platformBridge.js';
import { UserSession, validateNickname, createUserId, isUserId, SESSION_KEY } from '../src/ui/session.js';
import { cleanNickname as serverNickname } from '../server/userStore.js';
import { PlayerProfile, STORAGE_KEY, MMR as CLIENT_MMR, REWARD } from '../src/ui/storeData.js';
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
  const ids = new Set(Array.from({ length: 500 }, () => createUserId()));
  ok(ids.size === 500 && [...ids].every(isUserId), '3 UUID v4 발급 (500개 모두 형식이 맞고 겹치지 않음)');
  const viaRandomValues = createUserId({ getRandomValues: (b) => { for (let i = 0; i < b.length; i += 1) b[i] = (i * 37 + 11) & 0xff; return b; } });
  ok(isUserId(viaRandomValues) && viaRandomValues[14] === '4', `3 randomUUID 가 없는 환경(비보안 컨텍스트)도 v4 형식 (${viaRandomValues})`);
  ok(isUserId(createUserId(null)), '3 crypto 가 아예 없어도 형식은 맞는다');

  const storage = memoryStorage();
  let t = 1_000;
  const seen = [];
  const s1 = new UserSession({ storage, now: () => t });
  s1.subscribe((user) => seen.push(user?.nickname ?? null));
  eq([s1.user, s1.isLoggedIn], [null, false], '3 처음에는 로그인 전');
  eq(s1.login('총 잡이'), { ok: false, reason: 'whitespace' }, '3 규칙에 안 맞으면 로그인 거절');
  ok(storage.map.size === 0 && seen.length === 0, '3 거절된 로그인은 저장 · 알림 없음');
  const res = s1.login('총잡이');
  ok(res.ok && isUserId(res.user.id) && res.user.nickname === '총잡이', '3 로그인 → UUID 발급');
  const id = res.user.id;
  const stored = JSON.parse(storage.map.get(SESSION_KEY));
  eq([stored.id, stored.nickname, stored.loggedIn, stored.createdAt], [id, '총잡이', true, 1000], '3 localStorage 에 닉네임 · UUID 저장');

  const s2 = new UserSession({ storage });
  eq(s2.user, { id, nickname: '총잡이' }, '3 다시 접속하면 자동 로그인');
  eq([s1.rename('Ace_7').ok, s1.user.nickname, seen], [true, 'Ace_7', ['총잡이', 'Ace_7']], '3 닉네임 변경 → 구독자에게 바로 알림');
  eq([s1.rename('Ace_7').unchanged, seen.length], [true, 2], '3 같은 닉네임으로 바꾸면 알림 없음');
  eq(s1.rename('A'), { ok: false, reason: 'too_short' }, '3 규칙에 안 맞는 변경은 거절');
  s1.logout();
  eq([s1.user, s1.userId, s1.lastNickname, seen.at(-1)], [null, id, 'Ace_7', null], '3 로그아웃: 로그인 상태만 끄고 유저 ID · 마지막 닉네임은 남는다');
  eq(new UserSession({ storage }).user, null, '3 로그아웃 뒤 다시 접속하면 로그인 화면부터');
  eq(s1.rename('정상닉'), { ok: false, reason: 'not_logged_in' }, '3 로그아웃 중에는 닉네임을 바꿀 수 없다');
  t = 9_000;
  const again = s1.login('새이름');
  eq([again.user.id, JSON.parse(storage.map.get(SESSION_KEY)).createdAt], [id, 1000], '3 다시 로그인하면 같은 유저 ID (서버 전적이 이어진다)');

  const s3 = new UserSession({ storage });
  const heard = [];
  s3.subscribe((user) => heard.push(user?.nickname ?? null));
  storage.setItem(SESSION_KEY, JSON.stringify({ ...JSON.parse(storage.getItem(SESSION_KEY)), nickname: '다른탭' }));
  s3.reload();
  s3.reload();
  eq([s3.user.nickname, heard], ['다른탭', ['다른탭']], '3 다른 탭의 변경을 reload 로 한 번만 알린다');

  eq(new UserSession({ storage: memoryStorage({ [SESSION_KEY]: '{broken' }) }).user, null, '3 손상된 저장값 → 처음부터');
  eq(new UserSession({ storage: memoryStorage({ [SESSION_KEY]: JSON.stringify({ id: 'nope', nickname: '총잡이', loggedIn: true }) }) }).user, null, '3 UUID 가 아닌 ID → 처음부터');
  const badNick = new UserSession({ storage: memoryStorage({ [SESSION_KEY]: JSON.stringify({ id, nickname: '공백 있음', loggedIn: true }) }) });
  eq([badNick.user, badNick.userId], [null, id], '3 규칙에 안 맞게 저장된 닉네임 → 로그아웃 상태 (ID 는 유지)');
  const throwing = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } };
  const memoryOnly = new UserSession({ storage: throwing });
  eq(memoryOnly.login('비공개창').ok && memoryOnly.user.nickname, '비공개창', '3 저장소가 예외를 던져도 이번 방문 동안은 로그인 유지');
  eq(new UserSession({ storage: null }).login('저장소없음').user.nickname, '저장소없음', '3 저장소가 없어도 동작');
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
  const id = createUserId();
  eq(boot(null), true, '4 로그인 기록 없음 → needs-login');
  eq(boot(JSON.stringify({ v: 1, id, nickname: '총잡이', loggedIn: true })), false, '4 로그인 기록 있음 → 바로 타이틀');
  eq(boot(JSON.stringify({ v: 1, id, nickname: '총잡이', loggedIn: false })), true, '4 로그아웃 상태 → needs-login');
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

const ms = Math.round(performance.now() - T0);
console.log(fails.length === 0 ? `PASS  ${pass} checks, 0 failed — ${ms} ms` : `FAIL  ${pass} passed, ${fails.length} failed — ${ms} ms`);
process.exitCode = fails.length === 0 ? 0 : 1;
