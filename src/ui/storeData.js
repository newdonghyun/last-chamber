/**
 * LAST CHAMBER - 상점 데이터 · 황동 탄피(BRASS) 재화 · 플레이어 프로필 · 티어 · 리더보드
 *
 *   DOM을 건드리지 않는 순수 모듈이다 (저장소만 주입받는다). 화면은 src/ui/app.js가 그린다.
 *   1) 카탈로그: 총기 스킨 4종 · 테이블 테마 4종 — 각 항목의 vars 가 곧 CSS 커스텀 프로퍼티 묶음이다.
 *   2) PlayerProfile: 탄피 · 해금/장착 · 1판 체험 · 광고 누적 · 랭킹 기록(전적 · 연승 · MMR) · AI 연습 기록 · 닉네임 · 칭호 · 암시장(상자 천장 게이지 · 총구 화염 · 도발)을 localStorage에 영구 저장한다.
 *      모드별 정산 — 랭킹 기록은 온라인 랭킹전(무작위 매칭)만: 서버(Supabase players)가 원본이고 여기는 그 거울 (recordRanked · syncRanked).
 *                    AI 딜러 대전은 연습 기록(practice)에만 (recordPractice) · 친구 방 코드 대전은 친선전이라 탄피만 (recordFriendly).
 *   3) rewardFor(): 경기 종료 보상 계산 (승리 150 + 연승×30 · 패배 40).
 *   4) 티어(TIERS · tierOf) · 칭호(TITLES) · 닉네임 규칙(cleanNickname) · 승률(formatWinRate)
 *   5) 리더보드: Leaderboard(UI가 쓰는 창구) + VirtualLadder(가상 라이벌 150명). Step B에서 서버 소스로 갈아끼운다 → 아래 '리더보드' 구역 참고.
 *   6) 암시장: 낡은 탄약 상자(rollChest · 천장/중복 환급) · 총구 화염 3종 · 한정 칭호 4종 · 도발 액션 3종 + 도발 이벤트 형식(makeTauntEvent / validateTauntEvent)
 *   7) 유료 상품 2종: VIP 광고 스킵 패스(NO_ADS_PASS) · 초보자 스타터 팩(STARTER_PACK) — 구매 여부(hasNoAdsPass · starterPurchased) · 연승 보호권(streakShields)을 저장하고
 *      결제 성공 뒤의 지급만 맡는다 (grantNoAdsPass · grantStarterPack · useStreakShield). 결제 화면과 광고 INSTANT 훅은 src/ui/monetization.js.
 *
 *   ── CSS 계약 (style.css 맨 위 :root 가 기본값, 이 파일의 vars 는 그 기본값을 덮어쓴다) ──
 *   총기  --gun-hi/-primary/-shade/-low/-deep   프레임·총열 금속 그라데이션 5단
 *         --cyl-hi/-mid/-low/-deep              실린더 4단            --grip-hi/-mid/-lo        손잡이
 *         --case-1..4                           공이치기·방아쇠        --gun-accent-hi/-accent/-lo  나사·각인
 *         --gun-edge --gun-rib --gun-cap        모서리 빛·벤트 리브·총구 마개
 *         --muzzle-core/-color/-hot/-edge       총구 화염 4단          --smoke-color            화약 연기
 *               (장착한 총구 화염(암시장)은 이 5개 변수를 총기 스킨 위에 한 번 더 덮어쓴다 → SKIN_VAR_KEYS.flame)
 *         --gun-neon(+-opacity)                 네온 라인(사이버)      --gun-laser(+-opacity)   레이저 조준선(블러드 크롬)
 *   테이블 --table-rim --table-surface          림 / 상판 배경(그라데이션 통째로)   --table-edge   상판 안쪽 테두리
 *         --spot-rgb  --spotlight-color         스포트라이트 (r, g, b) / 상판 위 빛무리 색
 *         --lamp-anim --table-flicker           전등 빛기둥 깜빡임 / 테이블 위 형광등 깜빡임(애니메이션 shorthand)
 *   새 스킨을 추가하려면 이 파일의 목록에 항목만 넣으면 된다 (기본값과 같은 변수는 생략 가능).
 */

export const KIND = Object.freeze({ GUN: 'gun', TABLE: 'table' });
export const BRASS_START = 300; // 첫 지급 탄피
export const REWARD = Object.freeze({ win: 150, streakStep: 30, loss: 40 });
export const STORAGE_KEY = 'lastchamber.profile';
// 랭킹 MMR: 시작 1000 · 랭킹전 승 +25 / 패 −20 (서버 server/userStore.js MMR_RULE 과 같다 — 서버 기록을 못 받았을 때 미리 반영하는 값 · 순위표의 '승리 N번이면 역전' 어림셈)
// k · min/max 는 calculateEloDelta(Elo 계산 도구)용 — 지금 정산에는 쓰지 않는다
export const MMR = Object.freeze({ start: 1000, win: 25, loss: 20, k: 40, minWin: 5, maxWin: 38, minLoss: 5, maxLoss: 38 });
/** 내 티어에 맞춘 AI 딜러의 MMR (참고값 — AI 딜러 대전은 연습이라 랭킹 MMR 정산에 쓰지 않는다). 마피아는 최상위 딜러(1850)와 같다 */
export const AI_DEALER_MMR = Object.freeze({ bronze: 1050, silver: 1050, gold: 1450, platinum: 1850, master: 1850, mafia: 1850 });
export const NICKNAME = Object.freeze({ default: '방랑자', maxLength: 12 });
const MAX_BRASS = 99_999_999;
const MAX_STREAK = 9_999;
const MAX_MMR = 99_999;
const MAX_GAMES = 999_999;
const MAX_SHIELDS = 99; // 연승 보호권 보유 상한

// ───────── 카탈로그 ─────────

const rgbOf = ([r, g, b]) => `${r}, ${g}, ${b}`;

/** 총기 스킨의 CSS 변수 묶음을 만든다. 생략한 부분은 style.css 기본값(스틸)이 쓰인다. */
function gunVars({ metal, cyl, grip, hammer, accent, edge, rib, cap, flash, smoke, neon, laser }) {
  const vars = {};
  const put = (names, values) => values?.forEach((v, i) => { vars[names[i]] = v; });
  put(['--gun-hi', '--gun-primary', '--gun-shade', '--gun-low', '--gun-deep'], metal);
  put(['--cyl-hi', '--cyl-mid', '--cyl-low', '--cyl-deep'], cyl);
  put(['--grip-hi', '--grip-mid', '--grip-lo'], grip);
  put(['--case-1', '--case-2', '--case-3', '--case-4'], hammer);
  put(['--gun-accent-hi', '--gun-accent', '--gun-accent-lo'], accent);
  put(['--muzzle-core', '--muzzle-color', '--muzzle-hot', '--muzzle-edge'], flash);
  if (edge) vars['--gun-edge'] = edge;
  if (rib) vars['--gun-rib'] = rib;
  if (cap) vars['--gun-cap'] = cap;
  if (smoke) vars['--smoke-color'] = smoke;
  if (neon) { vars['--gun-neon'] = neon; vars['--gun-neon-opacity'] = '1'; }
  if (laser) { vars['--gun-laser'] = laser; vars['--gun-laser-opacity'] = '1'; }
  return vars;
}

/** 테이블 테마의 CSS 변수 묶음. spot = [r, g, b] 하나로 스포트라이트 관련 변수를 모두 맞춘다. */
function tableVars({ rim, surface, edge, spot, glow = 0.14, lamp, flicker }) {
  const vars = { '--table-rim': rim, '--table-surface': surface, '--table-edge': edge };
  if (spot) {
    vars['--spot-rgb'] = rgbOf(spot);
    vars['--spotlight-color'] = `rgba(${rgbOf(spot)}, ${glow})`;
  }
  if (lamp) vars['--lamp-anim'] = lamp;
  if (flicker) vars['--table-flicker'] = flicker;
  return vars;
}

// price: { free } 기본 지급 · { brass } 탄피로 구매 · { krw, productId, adUnlock } 유료(원) 또는 광고 N회 누적 시청으로 해금
export const GUN_SKINS = Object.freeze([
  {
    id: 'steel',
    name: '스틸 스탠다드',
    en: 'Standard Steel',
    blurb: '블루드 스틸 프레임과 월넛 손잡이. 기본으로 지급되는 한 자루',
    price: { free: true },
    chips: ['#7d899d', '#3d4555', '#c9a35b'],
    vars: {},
  },
  {
    id: 'gold',
    name: '골드 에디션',
    en: '24K Gold',
    blurb: '황금 총열과 흑단 손잡이, 금빛으로 번지는 총구 화염',
    price: { brass: 500 },
    chips: ['#fff4c2', '#e6b73a', '#ffd84a'],
    vars: gunVars({
      metal: ['#fff4c2', '#e6b73a', '#a47a1c', '#5c3f0c', '#241603'],
      cyl: ['#ffefb0', '#dcab36', '#86600f', '#2b1c05'],
      grip: ['#4a4a52', '#222227', '#0a0a0c'],
      hammer: ['#fff0b8', '#d9a82e', '#85600f', '#2b1c04'],
      accent: ['#fff6cf', '#7a560d', '#2a1b03'],
      edge: '#fff8dc',
      rib: '#6e4d0d',
      cap: '#c49a2a',
      flash: ['#fffbe6', '#ffd84a', '#ffa81a', '#ff7a00'],
      smoke: '#f1e2b0',
    }),
  },
  {
    id: 'cyber',
    name: '네온 사이버',
    en: 'Cyber Volt',
    blurb: '다크 티타늄 바디를 따라 흐르는 시안 네온 라인, 푸른 플라즈마 화염',
    price: { brass: 900 },
    chips: ['#93a8c0', '#3b4a5e', '#34e0ff'],
    vars: gunVars({
      metal: ['#93a8c0', '#3b4a5e', '#1b2432', '#0b111a', '#04070c'],
      cyl: ['#a8bdd3', '#475a72', '#1d2736', '#080c13'],
      grip: ['#2b3644', '#111820', '#05080c'],
      hammer: ['#d2f6ff', '#52b8da', '#1c5f7c', '#07222f'],
      accent: ['#d8f6ff', '#5fd4ff', '#14607f'],
      edge: '#bfe9ff',
      rib: '#141c27',
      cap: '#2e3d52',
      flash: ['#f2fdff', '#7fe3ff', '#2a7bff', '#2a3cff'],
      smoke: '#b8dcff',
      neon: '#34e0ff',
    }),
  },
  {
    id: 'crimson',
    name: '블러드 크롬',
    en: 'Crimson Executive',
    blurb: '흑요석 크롬 바디, 조준할 때 선혈빛 레이저 조준선과 붉은 화염',
    price: { krw: 1900, productId: 'skin_gun_crimson', adUnlock: 3 },
    chips: ['#f4f8fc', '#2a2c33', '#ff2a36'],
    vars: gunVars({
      metal: ['#f4f8fc', '#4a4e59', '#16171c', '#07070a', '#000000'],
      cyl: ['#e3e9f1', '#4f545f', '#15161b', '#050507'],
      grip: ['#6a161c', '#2e080c', '#0d0203'],
      hammer: ['#ffd5d8', '#c8404c', '#6f1219', '#250408'],
      accent: ['#ffb0b6', '#e0303c', '#5e0a0c'],
      edge: '#ffffff',
      rib: '#0d0d11',
      cap: '#34090d',
      flash: ['#fff2f0', '#ff6a5e', '#ff1f2d', '#8a0010'],
      smoke: '#e2baba',
      laser: '#ff2a36',
    }),
  },
  {
    // 스타터 팩(STARTER_PACK) 한정: 탄피·결제로는 팔지 않는다 (price.limited). 상점에서는 광고 '1판 체험'으로만 미리 써 볼 수 있다.
    id: 'silver_vampire',
    name: '실버 뱀파이어',
    en: 'Silver Vampire',
    blurb: '창백한 은빛 총열에 핏빛 루비를 박은 한정 스킨 — 스타터 팩 전용',
    price: { limited: 'starter_pack' },
    chips: ['#e9edf4', '#8d97a8', '#c4163f'],
    vars: gunVars({
      metal: ['#ffffff', '#d5dbe6', '#8d97a8', '#444c5c', '#161a23'],
      cyl: ['#f2f5fa', '#b4bccb', '#5c6575', '#1a1e27'],
      grip: ['#46304f', '#1f1426', '#0a060d'],
      hammer: ['#ffd9e2', '#d8385c', '#7d1230', '#2a0612'],
      accent: ['#ffc2cf', '#c4163f', '#4a0618'],
      edge: '#ffffff',
      rib: '#1f242e',
      cap: '#7d1230',
      flash: ['#fff5f8', '#ff6f93', '#d4144d', '#5c0a2e'],
      smoke: '#d9ccd6',
    }),
  },
  {
    // 출석 체크 6일차 보상 한정 (price.limited) — 탄피 · 결제로는 팔지 않는다
    id: 'blood_gold',
    name: '블러드 골드',
    en: 'Blood Gold',
    blurb: '황금빛 총열에 핏빛 문양이 번지는 한정 스킨 — 출석 체크 6일차 보상',
    price: { limited: 'attendance', day: 6 },
    chips: ['#ffe9b0', '#d4a02c', '#b3201f'],
    vars: gunVars({
      metal: ['#ffe9b0', '#d4a02c', '#8c1f1f', '#3a0a0a', '#140303'],
      cyl: ['#ffd98a', '#b8862a', '#6b1414', '#1d0505'],
      grip: ['#4a0f12', '#220708', '#0a0203'],
      hammer: ['#ffe0b0', '#c9892a', '#7d1616', '#2a0606'],
      accent: ['#ffe9b0', '#8c1f1f', '#2a0606'],
      edge: '#ffe9c0',
      rib: '#4a0f12',
      cap: '#8c1f1f',
      flash: ['#fff6dd', '#ffb347', '#e0301e', '#6a0a0a'],
      smoke: '#e8c9b0',
    }),
  },
  {
    // 출석 체크 7일차 보상 한정 (price.limited)
    id: 'phantom_black',
    name: '팬텀 블랙',
    en: 'Phantom Black',
    blurb: '빛을 먹는 무광 블랙 바디에 보랏빛 광택만 스치는 한정 스킨 — 출석 체크 7일차 보상',
    price: { limited: 'attendance', day: 7 },
    chips: ['#4a4a55', '#14141a', '#8f78ff'],
    vars: gunVars({
      metal: ['#4a4a55', '#23232b', '#0f0f14', '#050507', '#000000'],
      cyl: ['#5a5a66', '#2a2a33', '#101015', '#030304'],
      grip: ['#1a1a20', '#0b0b0e', '#030304'],
      hammer: ['#8a7fb0', '#3d3558', '#1a1530', '#08060f'],
      accent: ['#b8a8e8', '#4b3a8a', '#140e2e'],
      edge: '#8f86b8',
      rib: '#0b0b0f',
      cap: '#17141f',
      flash: ['#f3eaff', '#a98cff', '#5a2ee6', '#1d0a66'],
      smoke: '#bcb4d6',
    }),
  },
]);

export const TABLE_THEMES = Object.freeze([
  {
    id: 'obsidian',
    name: '흑요석 카지노',
    en: 'Obsidian Table',
    blurb: '마호가니 림과 흑요석 상판 위로 떨어지는 따뜻한 전등빛. 기본 테이블',
    price: { free: true },
    chips: ['#1c1d22', '#5e2519', '#ffd696'],
    vars: {},
  },
  {
    id: 'emerald',
    name: '에메랄드 VIP',
    en: 'Royal Emerald',
    blurb: '깊은 에메랄드 펠트 위로 번지는 녹빛 스포트라이트, 황동 테두리',
    price: { brass: 400 },
    chips: ['#136a4b', '#e0bb62', '#46e09c'],
    vars: tableVars({
      rim: 'linear-gradient(180deg, rgba(255, 244, 196, .3), transparent 26%, transparent 80%, rgba(0, 0, 0, .38)), repeating-linear-gradient(90deg, rgba(255, 255, 255, .07) 0 1px, transparent 1px 4px), linear-gradient(135deg, #e0bb62 0%, #a57d33 38%, #6f4f1a 68%, #c39544 100%)',
      surface: 'radial-gradient(ellipse 100% 90% at 50% 45%, #136a4b 0%, #0a3f2d 55%, #031a11 100%)',
      edge: 'rgba(244, 221, 162, .6)',
      spot: [70, 224, 156],
      glow: 0.16,
    }),
  },
  {
    id: 'lab',
    name: '폐쇄된 연구소',
    en: 'Cold Lab',
    blurb: '차가운 청회색 메탈 테이블, 오래된 형광등이 깜빡이는 분위기',
    price: { brass: 800 },
    chips: ['#3f5163', '#5d6c7d', '#acdeff'],
    vars: tableVars({
      rim: 'linear-gradient(180deg, rgba(210, 235, 255, .22), transparent 26%, transparent 80%, rgba(0, 0, 0, .42)), repeating-linear-gradient(90deg, rgba(255, 255, 255, .05) 0 1px, transparent 1px 3px), linear-gradient(135deg, #5d6c7d 0%, #36424f 40%, #1f2730 70%, #3d4a59 100%)',
      surface: 'repeating-linear-gradient(90deg, rgba(255, 255, 255, .035) 0 1px, transparent 1px 3px), radial-gradient(ellipse 100% 90% at 50% 45%, #3f5163 0%, #25313e 55%, #0f151c 100%)',
      edge: 'rgba(150, 205, 240, .5)',
      spot: [172, 222, 255],
      glow: 0.16,
      lamp: 'lamp-flicker-lab 2.9s steps(1) infinite',
      flicker: 'lab-flicker 4.6s steps(1) infinite',
    }),
  },
  {
    id: 'velvet',
    name: '블러드 문',
    en: 'Red Velvet',
    blurb: '딥 버건디 벨벳과 붉은 달빛이 쏟아지는 스포트라이트',
    price: { brass: 1200 },
    chips: ['#84112a', '#451017', '#ff5262'],
    vars: tableVars({
      rim: 'linear-gradient(180deg, rgba(255, 170, 170, .16), transparent 26%, transparent 80%, rgba(0, 0, 0, .46)), repeating-linear-gradient(88deg, rgba(0, 0, 0, .28) 0 1.5px, transparent 1.5px 6px), linear-gradient(135deg, #451017 0%, #28070b 45%, #14030a 72%, #34090f 100%)',
      surface: 'radial-gradient(circle at 50% 36%, rgba(255, 110, 120, .12), transparent 46%), radial-gradient(ellipse 100% 90% at 50% 45%, #84112a 0%, #4f0716 55%, #200309 100%)',
      edge: 'rgba(255, 128, 136, .42)',
      spot: [255, 82, 98],
      glow: 0.16,
    }),
  },
  {
    // 출석 체크 2일차 보상 한정 (price.limited) — 탄피 · 결제로는 팔지 않는다
    id: 'silver_roulette',
    name: '실버 룰렛',
    en: 'Silver Roulette',
    blurb: '은빛 펠트 위로 룰렛 휠의 광택이 번지는 한정 테이블 — 출석 체크 2일차 보상',
    price: { limited: 'attendance', day: 2 },
    chips: ['#8b94a3', '#d9dee6', '#dfe9ff'],
    vars: tableVars({
      rim: 'linear-gradient(180deg, rgba(255, 255, 255, .32), transparent 26%, transparent 80%, rgba(0, 0, 0, .4)), repeating-linear-gradient(90deg, rgba(255, 255, 255, .08) 0 1px, transparent 1px 4px), linear-gradient(135deg, #e8edf5 0%, #aab3c2 38%, #6b7484 68%, #cfd6e2 100%)',
      surface: 'radial-gradient(ellipse 100% 90% at 50% 45%, #8b94a3 0%, #5a6270 55%, #262b34 100%)',
      edge: 'rgba(223, 233, 255, .55)',
      spot: [223, 233, 255],
      glow: 0.17,
    }),
  },
]);

export const CATALOG = Object.freeze({ [KIND.GUN]: GUN_SKINS, [KIND.TABLE]: TABLE_THEMES });
export const DEFAULT_ID = Object.freeze({ [KIND.GUN]: 'steel', [KIND.TABLE]: 'obsidian' });

// 총구 화염(암시장)이 덮어쓰는 CSS 변수 5개 — 총기 스킨의 화염 색과 같은 변수다 (화염이 스킨 위에 얹힌다)
const FLAME_KEYS = Object.freeze(['--muzzle-core', '--muzzle-color', '--muzzle-hot', '--muzzle-edge', '--smoke-color']);

/** 종류별로 스킨이 건드리는 CSS 변수 이름 전체 (적용 전에 이걸 모두 지워 기본값으로 되돌린다). flame = 장착한 총구 화염 */
export const SKIN_VAR_KEYS = Object.freeze({
  [KIND.GUN]: Object.freeze([...new Set(GUN_SKINS.flatMap((s) => Object.keys(s.vars)))]),
  [KIND.TABLE]: Object.freeze([...new Set(TABLE_THEMES.flatMap((s) => Object.keys(s.vars)))]),
  flame: FLAME_KEYS,
});

export function getItem(kind, id) {
  return CATALOG[kind]?.find((item) => item.id === id) ?? null;
}

/** 장착 조합에 해당하는 CSS 변수 묶음 (기본 스킨은 빈 객체 → style.css 기본값). 총구 화염은 총기 스킨의 화염 색 위에 덮어쓴다. */
export function loadoutVars(gunId, tableId, flameId = DEFAULT_FLAME_ID) {
  return { ...(getItem(KIND.GUN, gunId)?.vars ?? {}), ...(getItem(KIND.TABLE, tableId)?.vars ?? {}), ...(getFlame(flameId)?.vars ?? {}) };
}

export const isFree = (item) => item.price.free === true;
export const adGoalOf = (item) => item.price.adUnlock ?? 0;

// ───────── 보상 ─────────

/** 경기 종료 보상. streakAfter = 이번 경기 결과가 반영된 연승 수 (승리 시 이번 승리 포함) */
export function rewardFor(won, streakAfter = 0) {
  if (!won) return { base: REWARD.loss, bonus: 0, total: REWARD.loss };
  const bonus = Math.max(0, streakAfter) * REWARD.streakStep;
  return { base: REWARD.win, bonus, total: REWARD.win + bonus };
}

// ───────── 티어 (MMR 구간) ─────────

/**
 * 느와르 티어 6단계. min = 이 티어의 MMR 하한 (다음 티어 하한 − 1 까지가 이 티어).
 * 색: hi(하이라이트) · main · lo(그림자) · glow(뱃지 빛) → style.css 의 .tier-badge 가 CSS 변수(--tier-hi/-main/-lo/-glow)로 받아 그린다.
 */
export const TIERS = Object.freeze([
  { id: 'bronze', ko: '브론즈 칩', en: 'BRONZE', min: 0, roman: 'I', hi: '#e8b98a', main: '#b9824a', lo: '#6b3f1c', glow: 'rgba(185, 130, 74, .5)' },
  { id: 'silver', ko: '실버 리볼버', en: 'SILVER', min: 1100, roman: 'II', hi: '#f1f5fa', main: '#b4bfcd', lo: '#59636f', glow: 'rgba(180, 191, 205, .5)' },
  { id: 'gold', ko: '골드 체임버', en: 'GOLD', min: 1300, roman: 'III', hi: '#fff0b5', main: '#e6b73a', lo: '#7a560d', glow: 'rgba(230, 183, 58, .55)' },
  { id: 'platinum', ko: '블러드 크롬', en: 'PLATINUM', min: 1600, roman: 'IV', hi: '#ffd9dc', main: '#e0505c', lo: '#6a0f19', glow: 'rgba(224, 80, 92, .6)' },
  { id: 'master', ko: '언더월드 로드', en: 'MASTER', min: 1900, roman: 'V', hi: '#e2d4ff', main: '#9a78f0', lo: '#2f1c6b', glow: 'rgba(154, 120, 240, .6)' },
  { id: 'mafia', ko: '마피아', en: 'MAFIA', min: 2500, roman: 'VI', hi: '#fff6d2', main: '#f3cf6b', lo: '#3a0a0e', glow: 'rgba(217, 38, 38, .7)' },
]);

const toMmr = (v) => (Number.isFinite(v) ? Math.min(MAX_MMR, Math.max(0, Math.floor(v))) : 0);

/**
 * Elo 변동값: 기대 승률 = 1 / (1 + 10^((상대 − 나) / 400)), 변동 = round(K × (결과 − 기대 승률)).
 * 승리는 +5 ~ +38, 패배는 −38 ~ −5 로 제한 — 동점이면 +20 / −20, 언더독이 이길수록 크게 오르고 강자가 질수록 크게 내린다.
 * 점수가 숫자가 아니면 상대와 같다고 본다 (동점 계산).
 */
export function calculateEloDelta(myMmr, opponentMmr, won) {
  const me = Number.isFinite(myMmr) ? myMmr : MMR.start;
  const foe = Number.isFinite(opponentMmr) ? opponentMmr : me;
  const expected = 1 / (1 + Math.pow(10, (foe - me) / 400));
  const raw = Math.round(MMR.k * ((won ? 1 : 0) - expected));
  return won ? Math.min(MMR.maxWin, Math.max(MMR.minWin, raw)) : Math.max(-MMR.maxLoss, Math.min(-MMR.minLoss, raw));
}

/** MMR → 티어 + 다음 티어까지의 진행도: { ...티어, index, label, next, toNext(다음 티어까지 남은 MMR), progress(0~1) } */
export function tierOf(mmr) {
  const v = toMmr(mmr);
  let index = 0;
  for (let i = TIERS.length - 1; i >= 0; i--) {
    if (v >= TIERS[i].min) {
      index = i;
      break;
    }
  }
  const tier = TIERS[index];
  const next = TIERS[index + 1] ?? null;
  return {
    ...tier,
    index,
    label: `${tier.ko} (${tier.en})`,
    next: next && { id: next.id, ko: next.ko, en: next.en, min: next.min },
    toNext: next ? next.min - v : 0,
    progress: next ? (v - tier.min) / (next.min - tier.min) : 1,
  };
}

// ───────── 전적 · 승률 · 닉네임 · 칭호 ─────────

/** 승률(%) — 소수 첫째 자리까지 (경기가 없으면 0) */
export function winRateOf(wins, losses) {
  const games = wins + losses;
  return games > 0 ? Math.round((wins / games) * 1000) / 10 : 0;
}
export const formatWinRate = (wins, losses) => `${winRateOf(wins, losses).toFixed(1)}%`; // 'XX.X%'

// 글자·숫자·( _ . - · ) 와 단어 사이 공백 하나만 — 제어문자·보이지 않는 문자·이모지·태그 문자는 막는다
const NICK_PATTERN = /^[\p{L}\p{N}_.\-·]+(?: [\p{L}\p{N}_.\-·]+)*$/u;

/** 닉네임 검사·정리: 앞뒤 공백 제거 · 연속 공백 하나로 · 1~12자 → { ok, nickname } | { ok: false, reason: 'empty' | 'too_long' | 'invalid_chars' } */
export function cleanNickname(raw) {
  if (typeof raw !== 'string') return { ok: false, reason: 'empty' };
  const name = raw.normalize('NFC').replace(/\s+/g, ' ').trim();
  if (!name) return { ok: false, reason: 'empty' };
  if ([...name].length > NICKNAME.maxLength) return { ok: false, reason: 'too_long' };
  if (!NICK_PATTERN.test(name) || !/[\p{L}\p{N}]/u.test(name)) return { ok: false, reason: 'invalid_chars' };
  return { ok: true, nickname: name };
}

const TIER_MIN = Object.fromEntries(TIERS.map((t) => [t.id, t.min]));

/**
 * 칭호(수집품). req = 해금 조건 한 가지 { wins | losses | games | maxStreak | mmr: 최소값 } — null이면 처음부터 가진다.
 * 한 번 해금한 칭호는 티어가 내려가도 남는다 (프로필의 titles). 새 칭호는 이 목록에 항목만 넣으면 된다.
 * chest: true = 전적으로는 얻을 수 없고 암시장 상자(CHEST_ITEMS)에서만 나온다. hint = 잠겨 있을 때 보여 줄 획득 방법.
 */
export const DEFAULT_TITLE_ID = 'newcomer';
export const TITLES = Object.freeze([
  { id: 'newcomer', name: '새로 온 손님', desc: '테이블에 처음 앉은 손님', req: null },
  { id: 'first_blood', name: '첫 피', desc: '첫 승리를 거뒀다', req: { wins: 1 } },
  { id: 'survivor', name: '살아남은 자', desc: '10승을 거뒀다', req: { wins: 10 } },
  { id: 'regular', name: '단골 도박꾼', desc: '25판을 치렀다', req: { games: 25 } },
  { id: 'unlucky', name: '불운의 단골', desc: '10번 쓰러졌다', req: { losses: 10 } },
  { id: 'hot_hand', name: '불붙은 손', desc: '3연승을 달성했다', req: { maxStreak: 3 } },
  { id: 'iron_heart', name: '무쇠 심장', desc: '7연승을 달성했다', req: { maxStreak: 7 } },
  { id: 'silver_gun', name: '은빛 총잡이', desc: '실버 리볼버 티어에 올랐다', req: { mmr: TIER_MIN.silver } },
  { id: 'gold_hand', name: '황금의 손', desc: '골드 체임버 티어에 올랐다', req: { mmr: TIER_MIN.gold } },
  { id: 'chrome_shadow', name: '붉은 크롬의 그림자', desc: '블러드 크롬 티어에 올랐다', req: { mmr: TIER_MIN.platinum } },
  { id: 'underworld_lord', name: '지하 세계의 군주', desc: '언더월드 로드 티어에 올랐다', req: { mmr: TIER_MIN.master } },
  { id: 'godfather', name: '대부', desc: '마피아 티어에 올랐다', req: { mmr: TIER_MIN.mafia } },
  // 암시장 한정 칭호 (낡은 탄약 상자)
  { id: 'brave_heart', name: '강심장', desc: '총구 앞에서도 맥박이 흔들리지 않는다', hint: '암시장 상자에서 얻을 수 있다', chest: true, req: null },
  { id: 'guillotine_outlaw', name: '단두대의 무법자', desc: '단두대 위에서도 웃던 무법자', hint: '암시장 상자에서 얻을 수 있다', chest: true, req: null },
  { id: 'death_cheater', name: '죽음을 속인 자', desc: '마지막 한 발 앞에서 죽음을 속였다', hint: '암시장 상자에서 얻을 수 있다', chest: true, req: null },
  { id: 'magazine_master', name: '탄창의 지배자', desc: '모든 약실을 손바닥 위에 올려놓았다', hint: '암시장 상자에서 얻을 수 있다', chest: true, req: null },
]);

const STAT_OF = {
  wins: (s) => s.wins,
  losses: (s) => s.losses,
  games: (s) => s.wins + s.losses,
  maxStreak: (s) => s.maxStreak,
  mmr: (s) => s.mmr,
};

export const getTitle = (id) => TITLES.find((t) => t.id === id) ?? null;

/** 이 전적({ wins, losses, maxStreak, mmr })으로 얻을 수 있는 칭호 id 전부 (카탈로그 순서). 암시장 한정 칭호(chest)는 전적으로는 얻을 수 없다.
 *  프로필에서는 titleStats(): 승 · 패 · 최대 연승 = 랭킹전 + AI 연습 합산(수집품이라 연습으로도 얻는다), MMR 칭호 = 랭킹 MMR 만 */
export function titlesUnlockedBy(stats) {
  return TITLES
    .filter((t) => !t.chest && (!t.req || Object.entries(t.req).every(([stat, min]) => (STAT_OF[stat]?.(stats) ?? 0) >= min)))
    .map((t) => t.id);
}

// ───────── 암시장: 낡은 탄약 상자 · 총구 화염 · 도발 액션 ─────────

/**
 * 낡은 탄약 상자: 한 번 열 때마다 price 탄피. 이미 가진 것이 나오면 payback 탄피를 돌려받고 천장 게이지 +1,
 * 게이지가 pity 에 닿으면 다음 상자는 미보유 희귀 등급 확정 (희귀를 모두 모았다면 미보유 아이템 확정) 후 게이지 0.
 */
export const CHEST = Object.freeze({ price: 300, payback: 120, pity: 5 });
export const RARITY = Object.freeze({
  common: Object.freeze({ id: 'common', ko: '일반', en: 'COMMON' }),
  rare: Object.freeze({ id: 'rare', ko: '희귀', en: 'RARE' }),
});
export const DEFAULT_FLAME_ID = 'native'; // 총기 스킨 고유의 화염 (아무것도 덮어쓰지 않음)
export const NATIVE_FLAME = Object.freeze({ id: DEFAULT_FLAME_ID, type: 'flame', name: '스킨 고유 화염', tone: '기본', blurb: '장착한 총기 스킨 본래의 총구 화염 색', chips: [], vars: {} });

// 총구 화염 4단(--muzzle-core/-color/-hot/-edge) + 화약 연기. 장착하면 총기 스킨의 화염 색 위에 덮어쓴다 (키 목록은 FLAME_KEYS 하나만 쓴다).
const flameVars = ([core, color, hot, edge], smoke) => Object.fromEntries(FLAME_KEYS.map((key, i) => [key, [core, color, hot, edge, smoke][i]]));
const titleItem = (id, rarity, weight) => {
  const t = getTitle(id);
  return { id, type: 'title', name: t.name, blurb: t.desc, rarity, weight };
};

/**
 * 상자에서 나오는 한정 아이템 7종. weight = 상자 한 번에 이 아이템이 나올 확률(%) — 합계 100 (일반 76 · 희귀 24).
 * type 'flame' = 총구 화염(vars 를 장착 시 CSS 변수로 덮어씀) · 'title' = 프로필 칭호(TITLES 의 같은 id).
 */
export const CHEST_ITEMS = Object.freeze([
  { id: 'goblin_fire', type: 'flame', name: '도깨비불', en: 'Goblin Fire', tone: '에메랄드 그린', blurb: '푸르게 일렁이는 도깨비불처럼 타오르는 총구 화염', rarity: 'common', weight: 20,
    chips: ['#f0fff6', '#5dffa0', '#12c26a'], vars: flameVars(['#f0fff6', '#5dffa0', '#12c26a', '#06703a'], '#b8f0d0') },
  { id: 'plasma', type: 'flame', name: '고압 플라즈마', en: 'High-Voltage Plasma', tone: '퍼플 바이올렛', blurb: '보랏빛 전하가 튀는 고압 플라즈마 화염', rarity: 'common', weight: 18,
    chips: ['#f6eeff', '#c08bff', '#8a3dff'], vars: flameVars(['#f6eeff', '#c08bff', '#8a3dff', '#4b1bb8'], '#d6c2ff') },
  { id: 'solar_wind', type: 'flame', name: '태양풍', en: 'Solar Wind', tone: '블라인드 화이트', blurb: '눈이 멀 만큼 하얗게 터지는 총구 화염', rarity: 'rare', weight: 10,
    chips: ['#ffffff', '#fffdf0', '#ffeeb0'], vars: flameVars(['#ffffff', '#fffdf0', '#ffeeb0', '#ffd36a'], '#ffffff') },
  titleItem('brave_heart', 'common', 20),
  titleItem('guillotine_outlaw', 'common', 18),
  titleItem('death_cheater', 'rare', 8),
  titleItem('magazine_master', 'rare', 6),
]);

export const getChestItem = (id) => CHEST_ITEMS.find((it) => it.id === id) ?? null;
/** 총구 화염 조회: 기본(스킨 고유) 또는 상자에서 나오는 화염. 화염이 아니면 null */
/** 출석 체크 보상 화염 — 상자 추첨 풀(CHEST_ITEMS)에는 없고 출석 체크로만 얻는다 */
export const LIMITED_FLAMES = Object.freeze([
  { id: 'blue_flame', type: 'flame', name: '블루 플레임', en: 'Blue Flame', tone: '아이스 블루', blurb: '차갑게 타오르는 푸른 총구 화염 — 출석 체크 4일차 보상', rarity: 'rare', limited: 'attendance', day: 4,
    chips: ['#f2fbff', '#74d4ff', '#1f7bff'], vars: flameVars(['#f2fbff', '#74d4ff', '#1f7bff', '#0b3aa8'], '#cfe8ff') },
]);
const ALL_FLAME_ITEMS = Object.freeze([...CHEST_ITEMS.filter((it) => it.type === 'flame'), ...LIMITED_FLAMES]); // 지닐 수 있는 화염 전체 (상자 + 출석)
export const FLAMES = Object.freeze([NATIVE_FLAME, ...ALL_FLAME_ITEMS]);
export const getFlame = (id) => FLAMES.find((f) => f.id === id) ?? null;
/** 상자 아이템(화염 · 칭호)을 이 저장 데이터(d)가 이미 가졌는가 */
const hasChestItem = (d, item) => (item.type === 'flame' ? d.flames : d.titles).includes(item.id);

/** 화면에 보여 줄 확률표: 등급별 합계와 아이템별 확률(%) */
export function chestOdds() {
  const total = CHEST_ITEMS.reduce((sum, it) => sum + it.weight, 0);
  return Object.values(RARITY).map((rarity) => {
    const items = CHEST_ITEMS.filter((it) => it.rarity === rarity.id).map((it) => ({ ...it, percent: Math.round((it.weight / total) * 1000) / 10 }));
    return { rarity, percent: Math.round((items.reduce((sum, it) => sum + it.weight, 0) / total) * 1000) / 10, items };
  });
}

// 가중치 추첨: rng() ∈ [0, 1) → 앞에서부터 가중치를 빼 가며 0 아래로 내려가는 항목
function pickWeighted(pool, rng) {
  let r = rng() * pool.reduce((sum, it) => sum + it.weight, 0);
  for (const it of pool) {
    r -= it.weight;
    if (r < 0) return it;
  }
  return pool[pool.length - 1]; // 부동소수 오차 대비
}

/**
 * 상자 한 번의 결과를 정한다 (순수 함수 — 저장·탄피 처리는 PlayerProfile.openChest).
 *   owns(item) → 이미 가졌는가 · pity → 지금 천장 게이지 · rng → [0,1) 난수
 *   천장(pity ≥ CHEST.pity)이면 미보유 희귀만 추첨 (희귀를 다 모았으면 미보유 전체) → 중복 없음, 게이지 0
 *   그 밖에는 7종 전체에서 weight 대로 추첨 — 이미 가진 것이 나오면 duplicate, 게이지 +1 (최대 CHEST.pity)
 * → { item, duplicate, pityTriggered, guarantee('rare' | 'any' | null), pityAfter }
 */
export function rollChest({ owns, pity = 0, rng = Math.random }) {
  const unowned = CHEST_ITEMS.filter((it) => !owns(it));
  const triggered = pity >= CHEST.pity && unowned.length > 0;
  let pool = CHEST_ITEMS;
  let guarantee = null;
  if (triggered) {
    const rares = unowned.filter((it) => it.rarity === 'rare');
    pool = rares.length ? rares : unowned;
    guarantee = rares.length ? 'rare' : 'any';
  }
  const item = pickWeighted(pool, rng);
  const duplicate = owns(item);
  return { item, duplicate, pityTriggered: triggered, guarantee, pityAfter: triggered ? 0 : duplicate ? Math.min(CHEST.pity, pity + 1) : pity };
}

/** 도발 액션 3종 (각 450 탄피). text = 테이블 중앙에 번쩍이는 네온 글자 · icon = 스프라이트 id · sound 는 app.js 가 기존 효과음을 조합한다. */
export const TAUNT_PRICE = 450;
export const TAUNTS = Object.freeze([
  { id: 'knock', name: '테이블 두드리기', en: 'Table Knock', blurb: '손마디로 테이블을 세 번 두드려 상대의 신경을 긁는다', price: TAUNT_PRICE, text: '똑 · 똑 · 똑', icon: 'i-knock', chips: ['#fff7e4', '#ffb547', '#7a4a10'] },
  { id: 'smoke', name: '시가 연기 뿜기', en: 'Cigar Smoke', blurb: '느긋하게 시가 연기를 내뿜으며 여유를 과시한다', price: TAUNT_PRICE, text: '후우…', icon: 'i-cigar', chips: ['#eef4f8', '#a0bed7', '#46586a'] },
  { id: 'flick', name: '비웃음 탄피 튕기기', en: 'Casing Flick', blurb: '황동 탄피를 손끝으로 튕겨 비웃음을 던진다', price: TAUNT_PRICE, text: '탱그랑~', icon: 'i-brass', chips: ['#fff3c4', '#ffd25a', '#8a6314'] },
]);
export const getTaunt = (id) => TAUNTS.find((t) => t.id === id) ?? null;

/**
 * 도발 이벤트 — 온라인 대전(Step B)에서 상대에게 보내는 형식. 지금은 화면 안에서만 쓰고,
 * app.js 가 같은 형태를 CustomEvent('lastchamber:taunt-out')로 내보내고 ('lastchamber:taunt-in')으로 받으면 같은 연출을 보여 준다.
 * 받는 쪽은 반드시 validateTauntEvent 를 거친다 — 알려진 도발 id 만 통과하고 나머지 필드는 버린다.
 */
export const makeTauntEvent = (id) => ({ type: 'TAUNT', id });
export function validateTauntEvent(raw) {
  if (!raw || typeof raw !== 'object' || raw.type !== 'TAUNT' || typeof raw.id !== 'string' || !getTaunt(raw.id)) return null;
  return { type: 'TAUNT', id: raw.id };
}

// ───────── 유료 상품 2종 (결제 = PlatformBridge.purchaseProduct · 지급 = PlayerProfile · 화면 = src/ui/monetization.js) ─────────

/**
 * VIP 광고 스킵 패스 (₩3,900 · 영구). 보유하면 결과 화면의 '보상 2배' · '연승 보호'와 상점의 '1판 체험' 보상형 광고가
 * 광고 화면·대기 없이 바로(INSTANT) 지급된다 — 훅은 monetization.js 의 installAdSkip.
 */
export const NO_ADS_PASS = Object.freeze({ productId: 'no_ads_pass', krw: 3900, name: 'VIP 광고 스킵 패스', en: 'VIP Ad-Skip Pass' });

/**
 * 초보자 스타터 팩 (₩1,900 · 계정당 1회 · 정가 ₩9,500 → 80% 할인): 탄피 + 한정 총기 스킨 + 연승 보호권을 한 번에 지급한다.
 * 한정 스킨(skinId)은 GUN_SKINS 에 들어 있지만 탄피·결제로는 팔지 않는다 (price.limited) — 이 팩으로만 얻고, 상점에서는 광고 '1판 체험'만 된다.
 */
export const STARTER_PACK = Object.freeze({
  productId: 'starter_pack', krw: 1900, listKrw: 9500, name: '초보자 스타터 팩', en: 'Starter Pack',
  brass: 1500, skinId: 'silver_vampire', shields: 2,
});
export const STARTER_DISCOUNT_PCT = Math.round((1 - STARTER_PACK.krw / STARTER_PACK.listKrw) * 100); // 화면에 쓰는 할인율 (80)

// ───────── 플레이어 프로필 (영구 저장) ─────────

const toInt =(v, fallback, max) => (Number.isFinite(v) ? Math.min(max, Math.max(0, Math.floor(v))) : fallback);

function freshData() {
  return {
    v: 5,
    brass: BRASS_START,
    owned: { [KIND.GUN]: [DEFAULT_ID.gun], [KIND.TABLE]: [DEFAULT_ID.table] },
    equipped: { ...DEFAULT_ID },
    trial: { [KIND.GUN]: null, [KIND.TABLE]: null }, // 다음 1판에만 적용되는 체험 스킨
    adViews: {}, // 항목 id → 광고 누적 시청 횟수 (adUnlock 항목만)
    // 랭킹 기록 = 온라인 랭킹전(무작위 매칭)만. 서버(Supabase players)가 원본 — 판이 끝나거나 로비에 들어갈 때 서버 값으로 맞춘다 (syncRanked)
    streak: 0,
    maxStreak: 0, // 최대 연승 (v1 저장값의 bestStreak 를 이어받는다)
    wins: 0,
    losses: 0,
    mmr: MMR.start,
    // v5 AI 딜러 대전 = 연습 기록 (랭킹 MMR · 랭킹 전적과 섞이지 않는다). 연습 연승은 탄피 연승 보너스 · 연승 보호에만 쓴다
    practice: { wins: 0, losses: 0, streak: 0, maxStreak: 0 },
    nickname: NICKNAME.default,
    titles: [DEFAULT_TITLE_ID], // 얻은 칭호 (한 번 얻으면 유지) — 상자에서 나온 한정 칭호도 여기에 들어온다
    equippedTitle: DEFAULT_TITLE_ID,
    // v3 암시장: 상자에서 얻은 총구 화염 · 구매한 도발 · 상자 천장 게이지 (v2 이하 저장값에는 없으므로 빈 값으로 이어받는다)
    flames: [],
    equippedFlame: DEFAULT_FLAME_ID,
    taunts: [],
    equippedTaunt: null, // 장착한 도발 하나 (게임 화면의 도발 버튼) — null 이면 버튼이 없다
    chest: { pity: 0, opened: 0 }, // 천장 게이지(0~CHEST.pity) · 지금까지 연 상자 수
    // v4 유료 상품: VIP 광고 스킵 패스 · 스타터 팩 구매 여부 · 연승 보호권 잔여 횟수 (v3 이하 저장값에는 없으므로 false · 0 으로 이어받는다)
    hasNoAdsPass: false,
    starterPurchased: false,
    streakShields: 0,
  };
}

/** 저장된 값을 믿지 않고 검증·복구한다 (손상·구버전·수동 편집) */
function sanitize(raw) {
  const d = freshData();
  if (!raw || typeof raw !== 'object') return d;
  d.brass = toInt(raw.brass, BRASS_START, MAX_BRASS);
  d.starterPurchased = raw.starterPurchased === true; // 엄격히 true 만 인정 (손상·수동 편집 값은 미구매로)
  for (const kind of Object.values(KIND)) {
    const owned = new Set([DEFAULT_ID[kind]]);
    for (const id of Array.isArray(raw.owned?.[kind]) ? raw.owned[kind] : []) if (getItem(kind, id)) owned.add(id);
    if (kind === KIND.GUN && d.starterPurchased) owned.add(STARTER_PACK.skinId); // 팩을 샀다면 한정 스킨은 항상 보유 (결제했는데 스킨이 없는 상태를 막는다)
    d.owned[kind] = [...owned];
    const eq = raw.equipped?.[kind];
    d.equipped[kind] = owned.has(eq) ? eq : DEFAULT_ID[kind];
    const tr = raw.trial?.[kind];
    d.trial[kind] = getItem(kind, tr) && !owned.has(tr) && !isFree(getItem(kind, tr)) ? tr : null;
  }
  for (const item of [...GUN_SKINS, ...TABLE_THEMES]) {
    const n = raw.adViews?.[item.id];
    if (adGoalOf(item) && Number.isFinite(n) && n > 0) d.adViews[item.id] = toInt(n, 0, adGoalOf(item));
  }
  // v4 이하: 전적 · 연승 · MMR 이 AI 딜러 대전과 섞여 쌓였다 → 그 값은 연습 기록으로 옮기고, 랭킹 기록은 처음부터 (다음 로비 접속 · 랭킹전에서 서버 값으로 맞춘다)
  const legacy = !raw.practice || typeof raw.practice !== 'object';
  const ranked = legacy ? {} : raw;
  d.streak = toInt(ranked.streak, 0, MAX_STREAK);
  d.maxStreak = Math.max(toInt(ranked.maxStreak, 0, MAX_STREAK), d.streak);
  d.wins = toInt(ranked.wins, 0, MAX_GAMES);
  d.losses = toInt(ranked.losses, 0, MAX_GAMES);
  d.mmr = toInt(ranked.mmr, MMR.start, MAX_MMR);
  const p = legacy ? { wins: raw.wins, losses: raw.losses, streak: raw.streak, maxStreak: raw.maxStreak ?? raw.bestStreak } : raw.practice; // v1 저장값(bestStreak)도 이어받는다
  const practiceStreak = toInt(p.streak, 0, MAX_STREAK);
  d.practice = { wins: toInt(p.wins, 0, MAX_GAMES), losses: toInt(p.losses, 0, MAX_GAMES), streak: practiceStreak, maxStreak: Math.max(toInt(p.maxStreak, 0, MAX_STREAK), practiceStreak) };
  const nick = cleanNickname(raw.nickname);
  d.nickname = nick.ok ? nick.nickname : NICKNAME.default;
  // 칭호: 저장된 것 + 지금 전적이 이미 조건을 채운 것 (구버전 프로필도 최대 연승 같은 기록으로 칭호를 이어받는다)
  const got = new Set([DEFAULT_TITLE_ID, ...(Array.isArray(raw.titles) ? raw.titles.filter((id) => getTitle(id)) : []), ...titlesUnlockedBy(titleStats(d))]);
  d.titles = TITLES.map((t) => t.id).filter((id) => got.has(id));
  d.equippedTitle = got.has(raw.equippedTitle) ? raw.equippedTitle : DEFAULT_TITLE_ID;
  // 암시장: 알 수 없는 id 는 버리고, 장착값은 가진 것만 인정한다
  const flames = new Set(Array.isArray(raw.flames) ? raw.flames : []);
  d.flames = ALL_FLAME_ITEMS.filter((it) => flames.has(it.id)).map((it) => it.id);
  d.equippedFlame = d.flames.includes(raw.equippedFlame) ? raw.equippedFlame : DEFAULT_FLAME_ID;
  const taunts = new Set(Array.isArray(raw.taunts) ? raw.taunts : []);
  d.taunts = TAUNTS.filter((t) => taunts.has(t.id)).map((t) => t.id);
  d.equippedTaunt = d.taunts.includes(raw.equippedTaunt) ? raw.equippedTaunt : null;
  d.chest = { pity: toInt(raw.chest?.pity, 0, CHEST.pity), opened: toInt(raw.chest?.opened, 0, MAX_GAMES) };
  d.hasNoAdsPass = raw.hasNoAdsPass === true;
  d.streakShields = toInt(raw.streakShields, 0, MAX_SHIELDS);
  return d;
}

// 칭호 조건에 쓰는 전적: 승 · 패 · 최대 연승은 랭킹전 + AI 연습 합산 (수집품), MMR 은 랭킹 MMR 만
const titleStats = (d) => ({
  wins: d.wins + d.practice.wins,
  losses: d.losses + d.practice.losses,
  maxStreak: Math.max(d.maxStreak, d.practice.maxStreak),
  mmr: d.mmr,
});

// 새로 조건을 채운 칭호를 더하고, 이번에 새로 얻은 칭호 id 를 돌려준다
function grantTitles(d) {
  const had = new Set(d.titles);
  const got = new Set([...d.titles, ...titlesUnlockedBy(titleStats(d))]);
  d.titles = TITLES.map((t) => t.id).filter((id) => got.has(id));
  return d.titles.filter((id) => !had.has(id));
}

const fixedReward = (brass) => {
  const total = Math.max(0, Math.floor(brass) || 0);
  return { base: total, bonus: 0, total };
};
/** 서버가 정한 보상 총액을 기본 보상(승 150) + 연승 보너스로 나눠 보여 준다 */
const serverReward = (total, won) => {
  const t = Math.max(0, Math.floor(total) || 0);
  const base = won ? Math.min(t, REWARD.win) : t;
  return { base, bonus: t - base, total: t };
};

/** 서버가 준 랭킹 기록 { wins, losses, mmr, streak?, maxStreak? } 의 모양 검사 → 깨끗한 값 | null */
export function readServerRecord(r) {
  if (!r || typeof r !== 'object' || !['wins', 'losses', 'mmr'].every((k) => Number.isFinite(r[k]))) return null;
  const streak = toInt(r.streak, 0, MAX_STREAK);
  return {
    wins: toInt(r.wins, 0, MAX_GAMES),
    losses: toInt(r.losses, 0, MAX_GAMES),
    mmr: toInt(r.mmr, MMR.start, MAX_MMR),
    streak,
    maxStreak: Math.max(toInt(r.maxStreak, 0, MAX_STREAK), streak),
  };
}

function applyServerRecord(d, r) {
  Object.assign(d, { wins: r.wins, losses: r.losses, mmr: r.mmr, streak: r.streak, maxStreak: r.maxStreak });
}

// 서버 기록을 받지 못한 랭킹전(연결이 끊겨 game_over 를 놓침): 서버와 같은 규칙으로 미리 반영 — 다음 로비 접속 때 서버 값으로 다시 맞춘다
function applyRankedRule(d, won) {
  if (won) {
    d.wins = Math.min(MAX_GAMES, d.wins + 1);
    d.streak = Math.min(MAX_STREAK, d.streak + 1);
    d.maxStreak = Math.max(d.maxStreak, d.streak);
    d.mmr = toMmr(d.mmr + MMR.win);
  } else {
    d.losses = Math.min(MAX_GAMES, d.losses + 1);
    d.streak = 0;
    d.mmr = toMmr(d.mmr - MMR.loss);
  }
}

function defaultStorage() {
  try {
    return globalThis.localStorage ?? null; // 접근만으로 예외가 나는 환경(비공개 창 등) 대비
  } catch {
    return null;
  }
}

export class PlayerProfile {
  #storage;
  #key;
  #data;

  /** storage: getItem/setItem 을 가진 객체 (생략하면 localStorage, 못 쓰면 이번 방문에서만 유지) */
  constructor({ storage = defaultStorage(), key = STORAGE_KEY } = {}) {
    this.#storage = storage;
    this.#key = key;
    this.#data = freshData();
    this.reload();
  }

  /**
   * 저장소에서 다시 읽는다 (다른 탭에서 바뀌었을 수 있으므로 변경 직전·탭 복귀 때 호출).
   * 저장소가 없거나 읽기에 실패하면 지금 메모리 값을 그대로 쓰고, 저장된 값이 손상됐으면 새 프로필로 시작한다.
   */
  reload() {
    if (!this.#storage) return this;
    let text;
    try {
      text = this.#storage.getItem(this.#key);
    } catch {
      return this;
    }
    if (text == null) return this; // 저장된 값 없음 → 새 프로필(또는 현재 값) 유지
    try {
      this.#data = sanitize(JSON.parse(text));
    } catch {
      this.#data = sanitize(null);
    }
    return this;
  }

  #save() {
    try {
      this.#storage?.setItem(this.#key, JSON.stringify(this.#data));
    } catch {
      // 저장 실패(용량·비공개 창) → 이번 방문에서만 유지
    }
  }

  /** 변경 직전에 최신 값으로 맞추고 → 변경 → 저장 */
  #mutate(fn) {
    this.reload();
    const result = fn(this.#data);
    this.#save();
    return result;
  }

  /**
   * 서버 지갑(계정의 원본)으로 이 기기의 거울을 맞춘다 — 로그인한 계정은 탄피 · 스킨 · 화염 · 도발 · 칭호 · 상자 기록을 서버가 정하므로,
   * 이 기기에서 값을 고쳐도 다음 동기화 때 서버 값으로 되돌아간다 (랭킹 전적 · 연습 기록 · 체험 · 광고 누적은 이 기기 것 그대로).
   * wallet = 서버가 보낸 { brass, owned, equipped, flames, equippedFlame, taunts, equippedTaunt, titles, equippedTitle, chest } → 바뀌었으면 true
   * 칭호는 꾸밈 요소라 이 기기 것을 지우지 않는다 (AI 연습 전적으로 얻은 칭호는 서버가 모른다) — 서버가 아는 칭호(상자)를 더하고, 장착도 이 기기 값 그대로.
   */
  adoptWallet(wallet) {
    if (!wallet || typeof wallet !== 'object') return false;
    return this.#mutate((d) => {
      const before = JSON.stringify(d);
      const next = sanitize({
        ...d,
        brass: wallet.brass, owned: wallet.owned, equipped: wallet.equipped,
        flames: wallet.flames, equippedFlame: wallet.equippedFlame,
        taunts: wallet.taunts, equippedTaunt: wallet.equippedTaunt,
        titles: [...d.titles, ...(Array.isArray(wallet.titles) ? wallet.titles : [])], equippedTitle: d.equippedTitle, chest: wallet.chest,
        hasNoAdsPass: wallet.hasNoAdsPass === true, starterPurchased: wallet.starterPurchased === true, streakShields: wallet.streakShields ?? 0, // 결제 권한도 서버 값이 원본 (지금은 서버에 결제가 없어 항상 없음)
      });
      Object.assign(d, next);
      return JSON.stringify(d) !== before;
    });
  }

  // ── 조회 ──
  get brass() { return this.#data.brass; }
  get streak() { return this.#data.streak; }
  get maxStreak() { return this.#data.maxStreak; }
  get wins() { return this.#data.wins; }
  get losses() { return this.#data.losses; }
  get games() { return this.#data.wins + this.#data.losses; }
  get winRate() { return winRateOf(this.#data.wins, this.#data.losses); } // 숫자(%)
  get winRateText() { return formatWinRate(this.#data.wins, this.#data.losses); } // 'XX.X%'
  get mmr() { return this.#data.mmr; }
  get tier() { return tierOf(this.#data.mmr); }
  /** AI 딜러 대전(연습) 기록 — 랭킹 MMR · 랭킹 전적과 별개 */
  get practice() {
    const p = this.#data.practice;
    return { ...p, games: p.wins + p.losses, winRateText: formatWinRate(p.wins, p.losses) };
  }
  get nickname() { return this.#data.nickname; }
  get equippedTitle() { return this.#data.equippedTitle; }
  get titles() { return [...this.#data.titles]; }
  hasTitle(id) { return this.#data.titles.includes(id); }
  // 암시장
  get chestPity() { return this.#data.chest.pity; }
  get chestOpened() { return this.#data.chest.opened; }
  get flames() { return [...this.#data.flames]; }
  get equippedFlame() { return this.#data.equippedFlame; }
  get taunts() { return [...this.#data.taunts]; }
  get equippedTaunt() { return this.#data.equippedTaunt; }
  ownsFlame(id) { return this.#data.flames.includes(id); }
  ownsTaunt(id) { return this.#data.taunts.includes(id); }
  /** 상자 아이템(화염 · 칭호)을 가졌는가 */
  ownsChestItem(item) { return hasChestItem(this.#data, item); }
  // 유료 상품
  get hasNoAdsPass() { return this.#data.hasNoAdsPass; }
  get starterPurchased() { return this.#data.starterPurchased; }
  get streakShields() { return this.#data.streakShields; }
  /** 리더보드에 내 줄을 그리기 위한 입력 (Leaderboard.getStandings 의 me) */
  forLeaderboard() {
    return { id: 'me', nickname: this.#data.nickname, mmr: this.#data.mmr, title: getTitle(this.#data.equippedTitle)?.name };
  }
  owns(kind, id) { return this.#data.owned[kind]?.includes(id) === true; }
  equippedId(kind) { return this.#data.equipped[kind]; }
  trialId(kind) { return this.#data.trial[kind]; }
  /** 지금 화면에 적용될 스킨: 체험 예약이 있으면 체험 스킨, 없으면 장착한 스킨 */
  activeId(kind) { return this.#data.trial[kind] ?? this.#data.equipped[kind]; }
  /** 지금 화면에 적용될 조합: 총기 · 테이블 스킨(체험 예약 우선) + 장착한 총구 화염 */
  activeLoadout() { return { gun: this.activeId(KIND.GUN), table: this.activeId(KIND.TABLE), flame: this.#data.equippedFlame }; }
  adViews(id) { return this.#data.adViews[id] ?? 0; }
  snapshot() { return JSON.parse(JSON.stringify(this.#data)); }

  // ── 재화 ──
  grantBrass(amount) {
    return this.#mutate((d) => {
      d.brass = toInt(d.brass + Math.max(0, Math.floor(amount) || 0), d.brass, MAX_BRASS);
      return d.brass;
    });
  }

  /** 탄피를 낸다 (PvP 참가비). 모자라면 아무것도 바꾸지 않고 { ok: false, brass } → { ok: true, brass(남은 탄피) } */
  spendBrass(amount) {
    return this.#mutate((d) => {
      const cost = Math.max(0, Math.floor(amount) || 0);
      if (d.brass < cost) return { ok: false, brass: d.brass };
      d.brass -= cost;
      return { ok: true, brass: d.brass };
    });
  }

  /** 탄피로 구매 (구매만 하고 장착은 따로 한다) */
  buyWithBrass(kind, id) {
    return this.#mutate((d) => {
      const item = getItem(kind, id);
      if (!item) return { ok: false, reason: 'unknown' };
      if (d.owned[kind].includes(id)) return { ok: false, reason: 'owned' };
      const cost = item.price.brass;
      if (!cost) return { ok: false, reason: 'not_for_brass' };
      if (d.brass < cost) return { ok: false, reason: 'insufficient', short: cost - d.brass };
      d.brass -= cost;
      d.owned[kind].push(id);
      if (d.trial[kind] === id) d.trial[kind] = null;
      return { ok: true, brass: d.brass };
    });
  }

  /** 탄피 이외의 방법(결제 · 광고 누적)으로 영구 해금 */
  unlock(kind, id) {
    return this.#mutate((d) => {
      const item = getItem(kind, id);
      if (!item) return { ok: false, reason: 'unknown' };
      if (!d.owned[kind].includes(id)) d.owned[kind].push(id);
      if (d.trial[kind] === id) d.trial[kind] = null;
      return { ok: true };
    });
  }

  equip(kind, id) {
    return this.#mutate((d) => {
      if (!getItem(kind, id)) return { ok: false, reason: 'unknown' };
      if (!d.owned[kind].includes(id)) return { ok: false, reason: 'not_owned' };
      d.equipped[kind] = id;
      d.trial[kind] = null; // 직접 고른 스킨이 체험 예약보다 우선
      return { ok: true };
    });
  }

  /**
   * 보상형 광고를 1회 시청한 결과를 반영한다: 다음 1판 체험을 예약하고, adUnlock 항목이면 누적 횟수를 올린다.
   * 누적이 목표에 닿으면 영구 해금(체험 예약은 해제). → { ok, views, goal, unlocked }
   */
  recordAdView(kind, id) {
    return this.#mutate((d) => {
      const item = getItem(kind, id);
      if (!item) return { ok: false, reason: 'unknown' };
      if (d.owned[kind].includes(id)) return { ok: false, reason: 'owned' };
      if (isFree(item)) return { ok: false, reason: 'free' };
      const goal = adGoalOf(item);
      let views = 0;
      let unlocked = false;
      if (goal) {
        views = Math.min(goal, (d.adViews[id] ?? 0) + 1);
        d.adViews[id] = views;
        unlocked = views >= goal;
      }
      if (unlocked) {
        d.owned[kind].push(id);
        d.trial[kind] = null;
      } else {
        d.trial[kind] = id;
      }
      return { ok: true, views, goal, unlocked };
    });
  }

  /** 새 판 시작: 이번 판에 쓸 스킨 조합을 돌려주고, 체험 예약은 이 판으로 소모한다. */
  beginGame() {
    return this.#mutate((d) => {
      const loadout = { gun: d.trial.gun ?? d.equipped.gun, table: d.trial.table ?? d.equipped.table, flame: d.equippedFlame };
      d.trial.gun = null;
      d.trial.table = null;
      return loadout;
    });
  }

  // ── 닉네임 · 칭호 ──
  /** 닉네임 변경 (검사·정리는 cleanNickname) → { ok, nickname } | { ok: false, reason } */
  setNickname(raw) {
    const res = cleanNickname(raw);
    if (!res.ok) return res;
    return this.#mutate((d) => {
      d.nickname = res.nickname;
      return { ok: true, nickname: d.nickname };
    });
  }

  /** 칭호 장착 — 얻은 칭호만 */
  equipTitle(id) {
    return this.#mutate((d) => {
      if (!getTitle(id)) return { ok: false, reason: 'unknown' };
      if (!d.titles.includes(id)) return { ok: false, reason: 'locked' };
      d.equippedTitle = id;
      return { ok: true };
    });
  }

  // ── 암시장: 상자 · 화염 · 도발 ──
  /**
   * 낡은 탄약 상자를 연다 (CHEST.price 탄피). 어떤 아이템이 나올지는 rollChest 가 정한다.
   *   새 아이템이면 바로 수집(화염은 보관함, 칭호는 titles), 이미 가진 것이면 CHEST.payback 탄피를 돌려받고 천장 게이지 +1.
   *   7종을 모두 모았거나 탄피가 모자라면 아무것도 바뀌지 않는다.
   * rng: [0, 1) 난수 함수 (테스트에서 시드 난수를 넣는다)
   * → { ok: true, item, duplicate, payback, pityTriggered, guarantee, pity(열고 난 뒤 게이지), brass, opened } | { ok: false, reason: 'all_owned' | 'insufficient', short? }
   */
  openChest(rng = Math.random) {
    return this.#mutate((d) => {
      const owns = (it) => hasChestItem(d, it);
      if (CHEST_ITEMS.every(owns)) return { ok: false, reason: 'all_owned' };
      if (d.brass < CHEST.price) return { ok: false, reason: 'insufficient', short: CHEST.price - d.brass };
      const roll = rollChest({ owns, pity: d.chest.pity, rng }); // 추첨은 상태를 바꾸기 전에 — rng 가 예외를 던져도 탄피는 그대로
      const { item } = roll;
      d.brass -= CHEST.price;
      let payback = 0;
      if (roll.duplicate) {
        payback = CHEST.payback;
        d.brass = toInt(d.brass + payback, d.brass, MAX_BRASS);
      } else if (item.type === 'flame') {
        const got = new Set([...d.flames, item.id]);
        d.flames = ALL_FLAME_ITEMS.filter((it) => got.has(it.id)).map((it) => it.id);
      } else {
        const got = new Set([...d.titles, item.id]);
        d.titles = TITLES.map((t) => t.id).filter((id) => got.has(id));
      }
      d.chest.pity = roll.pityAfter;
      d.chest.opened = Math.min(MAX_GAMES, d.chest.opened + 1);
      return { ok: true, item, duplicate: roll.duplicate, payback, pityTriggered: roll.pityTriggered, guarantee: roll.guarantee, pity: d.chest.pity, brass: d.brass, opened: d.chest.opened };
    });
  }

  /** 총구 화염 장착 — 얻은 화염 또는 DEFAULT_FLAME_ID(총기 스킨 고유 화염) */
  equipFlame(id) {
    return this.#mutate((d) => {
      if (!getFlame(id)) return { ok: false, reason: 'unknown' };
      if (id !== DEFAULT_FLAME_ID && !d.flames.includes(id)) return { ok: false, reason: 'not_owned' };
      d.equippedFlame = id;
      return { ok: true };
    });
  }

  /** 도발 액션 구매 (TAUNT_PRICE 탄피). 구매만 한다 — 장착은 equipTaunt */
  buyTaunt(id) {
    return this.#mutate((d) => {
      const taunt = getTaunt(id);
      if (!taunt) return { ok: false, reason: 'unknown' };
      if (d.taunts.includes(id)) return { ok: false, reason: 'owned' };
      if (d.brass < taunt.price) return { ok: false, reason: 'insufficient', short: taunt.price - d.brass };
      d.brass -= taunt.price;
      d.taunts = TAUNTS.filter((t) => t.id === id || d.taunts.includes(t.id)).map((t) => t.id);
      return { ok: true, brass: d.brass };
    });
  }

  /** 도발 장착 (산 것만, 한 번에 하나). null 이면 해제 → 게임 화면의 도발 버튼이 사라진다 */
  equipTaunt(id) {
    return this.#mutate((d) => {
      if (id == null) {
        d.equippedTaunt = null;
        return { ok: true };
      }
      if (!getTaunt(id)) return { ok: false, reason: 'unknown' };
      if (!d.taunts.includes(id)) return { ok: false, reason: 'not_owned' };
      d.equippedTaunt = id;
      return { ok: true };
    });
  }

  // ── 유료 상품 지급 (반드시 결제가 성공한 뒤에만 호출 — 결제는 PlatformBridge.purchaseProduct) ──
  /** VIP 광고 스킵 패스 지급. 이미 있으면 아무것도 바꾸지 않고 { ok: false, reason: 'owned' } */
  grantNoAdsPass() {
    return this.#mutate((d) => {
      if (d.hasNoAdsPass) return { ok: false, reason: 'owned' };
      d.hasNoAdsPass = true;
      return { ok: true };
    });
  }

  /**
   * 스타터 팩 지급 (계정당 1회): 탄피 STARTER_PACK.brass + 한정 스킨 보유 + 연승 보호권 STARTER_PACK.shields 회를 한 번의 저장으로 처리한다.
   * 스킨은 보유만 하고 장착은 하지 않는다 (직접 [장착하기]). 이미 샀으면 { ok: false, reason: 'owned' } — 아무것도 바뀌지 않는다.
   * → { ok: true, brass(지급 뒤 보유 탄피), skinId, shields(지급 뒤 보호권) }
   */
  grantStarterPack() {
    return this.#mutate((d) => {
      if (d.starterPurchased) return { ok: false, reason: 'owned' };
      d.starterPurchased = true;
      d.brass = toInt(d.brass + STARTER_PACK.brass, d.brass, MAX_BRASS);
      if (!d.owned[KIND.GUN].includes(STARTER_PACK.skinId)) d.owned[KIND.GUN].push(STARTER_PACK.skinId);
      if (d.trial[KIND.GUN] === STARTER_PACK.skinId) d.trial[KIND.GUN] = null; // 체험 예약해 둔 스킨을 샀다면 예약은 필요 없다
      d.streakShields = toInt(d.streakShields + STARTER_PACK.shields, d.streakShields, MAX_SHIELDS);
      return { ok: true, brass: d.brass, skinId: STARTER_PACK.skinId, shields: d.streakShields };
    });
  }

  /** 연승 보호권 1회 사용 (연승 보호 광고 대신 — monetization.js 의 광고 훅이 부른다). 없으면 { ok: false, reason: 'none' } → { ok: true, left } */
  useStreakShield() {
    return this.#mutate((d) => {
      if (d.streakShields < 1) return { ok: false, reason: 'none' };
      d.streakShields -= 1;
      return { ok: true, left: d.streakShields };
    });
  }

  // ── 경기 결과 (판당 한 번만 — 모드별로 하나) ──

  /**
   * AI 딜러 대전 = 연습: 연습 전적(승·패) · 연습 연승 · 탄피(승리/패배 보상 + 연습 연승 보너스) · 칭호만 갱신한다.
   * 랭킹 MMR · 랭킹 전적 · 랭킹 연승 · 티어는 건드리지 않는다.
   * → { mode: 'practice', ranked: false, won, base, bonus, total(탄피), brass, streak, prevStreak, maxStreak(연습), canProtect, practice: { wins, losses }, newTitles }
   */
  recordPractice(won) {
    return this.#mutate((d) => {
      const p = d.practice;
      const prevStreak = p.streak;
      p.streak = won ? Math.min(MAX_STREAK, prevStreak + 1) : 0;
      p.maxStreak = Math.max(p.maxStreak, p.streak);
      if (won) p.wins = Math.min(MAX_GAMES, p.wins + 1);
      else p.losses = Math.min(MAX_GAMES, p.losses + 1);
      const reward = rewardFor(won, p.streak);
      d.brass = toInt(d.brass + reward.total, d.brass, MAX_BRASS);
      return {
        mode: 'practice', ranked: false, won, ...reward, brass: d.brass,
        streak: p.streak, prevStreak, maxStreak: p.maxStreak, canProtect: !won && prevStreak >= 2,
        practice: { wins: p.wins, losses: p.losses }, newTitles: grantTitles(d),
      };
    });
  }

  /**
   * 온라인 랭킹전(무작위 매칭): 랭킹 전적 · 연승 · MMR 을 서버 기록(record)으로 맞추고 탄피를 지급한다.
   *   record   game_over 로 받은 서버(Supabase players)의 내 기록 — 원본. 없으면(연결이 끊겨 못 받음) 서버와 같은 규칙(승 +25 · 패 −20)으로 미리 반영
   *   mmrDelta 서버가 알려 준 이번 판 MMR 변동 (없으면 기록 차이)
   *   brass    판돈 테이블의 서버 상금 (없으면 승리/패배 보상 + 랭킹 연승 보너스)
   * → { mode: 'ranked', ranked: true, won, base, bonus, total, brass, streak, prevStreak, maxStreak, canProtect: false,
   *     mmr, prevMmr, mmrDelta, tier, prevTier, tierChange('up' | 'down' | null), wins, losses, newTitles }
   */
  recordRanked(won, { record = null, mmrDelta = null, brass = null, reward: granted = null } = {}) {
    return this.#mutate((d) => {
      const prevStreak = d.streak;
      const server = readServerRecord(record);
      const delta = Number.isFinite(mmrDelta) ? Math.trunc(mmrDelta) : null;
      const prevMmr = server && delta !== null ? toMmr(server.mmr - delta) : d.mmr; // 서버 기준 직전 점수 (거울이 오래됐어도 승급 · 강등을 바르게)
      if (server) applyServerRecord(d, server);
      else applyRankedRule(d, won);
      const reward = brass !== null ? fixedReward(brass) : granted !== null ? serverReward(granted, won) : rewardFor(won, won ? d.streak : 0); // reward = 서버 지갑이 이미 지급한 탄피
      d.brass = toInt(d.brass + reward.total, d.brass, MAX_BRASS);
      const tier = tierOf(d.mmr);
      const prevTier = tierOf(prevMmr);
      return {
        mode: 'ranked', ranked: true, won, ...reward, brass: d.brass,
        streak: d.streak, prevStreak, maxStreak: d.maxStreak, canProtect: false, // 랭킹 연승은 서버 기록이라 광고로 되돌리지 않는다
        mmr: d.mmr, prevMmr, mmrDelta: delta ?? d.mmr - prevMmr,
        tier, prevTier, tierChange: tier.index > prevTier.index ? 'up' : tier.index < prevTier.index ? 'down' : null,
        wins: d.wins, losses: d.losses, newTitles: grantTitles(d),
      };
    });
  }

  /**
   * 친구 초대(방 코드) 대전 = 친선전: 랭킹 MMR · 랭킹 전적 · 연승은 그대로, 탄피만 (승리/패배 기본 보상 — 연승 보너스 없음, 판돈이 있으면 상금).
   * → { mode: 'friendly', ranked: false, won, base, bonus, total, brass, canProtect: false, newTitles: [] }
   */
  recordFriendly(won, { brass = null, reward: granted = null } = {}) {
    return this.#mutate((d) => {
      const reward = brass !== null ? fixedReward(brass) : granted !== null ? serverReward(granted, false) : rewardFor(won, 0);
      d.brass = toInt(d.brass + reward.total, d.brass, MAX_BRASS);
      return { mode: 'friendly', ranked: false, won, ...reward, brass: d.brass, canProtect: false, newTitles: [] };
    });
  }

  /**
   * 무효 판(서버 판정 — 1라운드 전 조기 종료 · 같은 상대 하루 3판 초과): MMR · 전적 · 연승 · 탄피 보상 없이 결과 화면용 값만 만든다.
   * reason: 'EARLY_END' | 'PAIR_LIMIT'.  → recordRanked / recordFriendly 와 같은 모양 + voided
   */
  recordVoided(won, { ranked = true, reason = 'EARLY_END' } = {}) {
    const d = this.#data;
    const tier = tierOf(d.mmr);
    return {
      mode: ranked ? 'ranked' : 'friendly', ranked, won, base: 0, bonus: 0, total: 0, brass: d.brass, voided: reason, canProtect: false, newTitles: [],
      streak: d.streak, prevStreak: d.streak, maxStreak: d.maxStreak, mmr: d.mmr, prevMmr: d.mmr, mmrDelta: 0,
      tier, prevTier: tier, tierChange: null, wins: d.wins, losses: d.losses,
    };
  }

  /** 로비 접속 등에서 받은 서버 랭킹 기록으로 랭킹 전적 · 연승 · MMR 을 맞춘다 (서버가 원본). 바뀌었으면 true */
  syncRanked(record) {
    const server = readServerRecord(record);
    if (!server) return false;
    return this.#mutate((d) => {
      const changed = ['wins', 'losses', 'mmr', 'streak', 'maxStreak'].some((k) => d[k] !== server[k]);
      applyServerRecord(d, server);
      grantTitles(d);
      return changed;
    });
  }

  /** 연승 보호: 패배로 끊긴 AI 연습 연승을 되돌린다 (보상형 광고 · 연승 보호권). 전적은 그대로 — 연승 기록만 지킨다. 랭킹 연승은 서버 기록이라 대상이 아니다. */
  restoreStreak(prevStreak) {
    return this.#mutate((d) => {
      const p = d.practice;
      p.streak = Math.max(p.streak, toInt(prevStreak, 0, MAX_STREAK));
      p.maxStreak = Math.max(p.maxStreak, p.streak);
      return p.streak;
    });
  }
}

// ───────── 리더보드 ─────────
//
// UI(app.js)는 Leaderboard 하나만 쓴다:
//   const standings = await leaderboard.getStandings(profile.forLeaderboard(), { top: 15 });
// 순위 데이터의 출처(소스)는 갈아끼울 수 있다 — Step B 멀티플레이 서버를 붙일 때는 이 한 줄이면 된다:
//   leaderboard.useSource(serverSource);
//
// 소스 규약: getStandings(me, { top }) 를 가진 객체 (동기·비동기 모두 가능)
//   me        = { id, nickname, mmr, title? }                     내 정보 (profile.forLeaderboard())
//   Standings = {
//     source:  'virtual' | 'server' | …                            화면 안내문 구분용
//     total:   전체 인원 (나 포함)
//     me:      { rank, nickname, mmr, percentile? }                내 순위(1부터). percentile 을 안 주면 rank/total 로 계산
//     entries: [{ rank, id, nickname, mmr, isMe? }]                화면에 그릴 줄 (순위 순: 상위 top명, 내가 상위권이면 내 줄 포함)
//     above:   { rank, nickname, mmr, gap } | null                 한 칸 위 상대 (1위면 null)
//   }
// 서버는 mmr 만 넘기면 된다 — 티어(tier) · percentile · isMe 는 Leaderboard 가 채우고 형식이 틀리면 에러로 알려 준다.

export const LEADERBOARD = Object.freeze({ top: 15, population: 150 }); // 화면에 보이는 상위 인원 · 가상 래더 라이벌 수 (나 제외)

const percentileOf = (rank, total) => Math.max(1, Math.ceil((rank / total) * 100)); // '상위 N%' (낮을수록 좋음)

// 상위 15명은 이름과 점수를 직접 정했다 (마피아 2명 · 언더월드 로드 6명 · 블러드 크롬 4명 · 골드 3명)
const TOP_RIVALS = Object.freeze([
  ['카인 · 지하의 지배인', 2684],
  ['마담 룰렛', 2517],
  ['검은 장미', 2361],
  ['철의 크루피에', 2248],
  ['새벽의 딜러', 2130],
  ['붉은 장갑', 2046],
  ['독사', 1968],
  ['라스트 콜', 1904],
  ['재즈바 스카', 1842],
  ['외눈박이 잭', 1771],
  ['은빛 늑대', 1703],
  ['낡은 회중시계', 1648],
  ['담배 연기', 1581],
  ['구두닦이 마르코', 1519],
  ['안개 속의 여우', 1462],
]);
const RIVAL_ADJ = ['붉은', '검은', '은빛', '녹슨', '조용한', '웃는', '마지막', '새벽', '밤안개', '철의', '독한', '늙은', '젊은', '외눈', '절름발이', '불꽃', '얼음', '유리', '낡은', '비 오는'];
const RIVAL_NOUN = ['딜러', '장미', '총잡이', '카드', '칩', '시계', '까마귀', '여우'];

/** 가상 라이벌 래더 (결정적 — 언제 만들어도 같다): 상위 15명 + 나머지는 이름·점수를 규칙으로 만든다 (이름이 겹치지 않는 한도는 174명) */
export function buildVirtualLadder(population = LEADERBOARD.population) {
  const rivals = TOP_RIVALS.map(([nickname, mmr]) => ({ nickname, mmr }));
  const used = new Set(rivals.map((r) => r.nickname));
  for (let k = 0, n = 0; rivals.length < population && k < RIVAL_ADJ.length * RIVAL_NOUN.length; k++) {
    const nickname = `${RIVAL_ADJ[k % RIVAL_ADJ.length]} ${RIVAL_NOUN[Math.floor(k / RIVAL_ADJ.length) % RIVAL_NOUN.length]}`;
    if (used.has(nickname)) continue; // 상위 15명 이름과 겹치면 건너뜀
    used.add(nickname);
    rivals.push({ nickname, mmr: Math.max(0, Math.round(1436 - n * 5.85 - ((n * 37) % 5))) });
    n++;
  }
  rivals.sort((a, b) => b.mmr - a.mmr || (a.nickname < b.nickname ? -1 : a.nickname > b.nickname ? 1 : 0));
  return rivals.slice(0, population).map((r, i) => ({ id: `ai-${String(i + 1).padStart(3, '0')}`, nickname: r.nickname, mmr: r.mmr }));
}

/** 서버 연동 전 소스: 가상 라이벌 래더 안에서 내 MMR 로 실시간 순위를 계산한다 (동점이면 내가 앞) */
export class VirtualLadder {
  #rivals;

  constructor({ rivals = buildVirtualLadder() } = {}) {
    this.#rivals = rivals.map((r) => ({ ...r })).sort((a, b) => b.mmr - a.mmr);
  }

  get size() {
    return this.#rivals.length;
  }

  async getStandings(me, { top = LEADERBOARD.top } = {}) {
    const mmr = toMmr(me?.mmr);
    const total = this.#rivals.length + 1;
    const ahead = this.#rivals.filter((r) => r.mmr > mmr).length;
    const rank = ahead + 1;
    const mine = { rank, id: me?.id ?? 'me', nickname: me?.nickname ?? NICKNAME.default, mmr, isMe: true, ...(me?.title ? { title: me.title } : {}) };
    const limit = Math.max(1, Math.floor(top));
    const rows = this.#rivals.slice(0, limit).map((r) => ({ id: r.id, nickname: r.nickname, mmr: r.mmr, isMe: false }));
    if (ahead < limit) rows.splice(ahead, 0, mine); // 내 점수가 상위 목록 안이면 그 자리에 끼어든다
    rows.forEach((row, i) => { row.rank = i + 1; });
    const above = ahead > 0 ? this.#rivals[ahead - 1] : null;
    return {
      source: 'virtual',
      total,
      me: { ...mine, percentile: percentileOf(rank, total) },
      entries: rows,
      above: above && { rank: ahead, id: above.id, nickname: above.nickname, mmr: above.mmr, gap: above.mmr - mmr },
    };
  }
}

// 소스가 준 응답을 검사하고 UI가 쓰는 모양으로 정리한다 (티어 · 퍼센트 · isMe 채움)
function normalizeStandings(raw, me) {
  const bad = (why) => {
    throw new Error(`리더보드 응답 형식 오류: ${why}`);
  };
  if (!raw || typeof raw !== 'object') bad('객체가 아님');
  const { total, me: mine } = raw;
  if (!Number.isInteger(mine?.rank) || mine.rank < 1) bad('me.rank');
  if (!Number.isInteger(total) || total < mine.rank) bad('total');
  if (!Array.isArray(raw.entries)) bad('entries');
  const row = (e, isMe = false) => {
    if (!e || !Number.isInteger(e.rank) || e.rank < 1 || typeof e.nickname !== 'string' || !Number.isFinite(e.mmr)) bad('entries 항목');
    return { ...e, mmr: toMmr(e.mmr), isMe: isMe || e.isMe === true || (me?.id != null && e.id === me.id), tier: tierOf(e.mmr) };
  };
  const entries = raw.entries.map((e) => row(e));
  const meRow = row({ id: me?.id ?? 'me', nickname: me?.nickname, mmr: me?.mmr, title: me?.title, ...mine }, true);
  meRow.percentile = Number.isInteger(mine.percentile) && mine.percentile >= 1 ? mine.percentile : percentileOf(mine.rank, total);
  if (raw.above && (!Number.isFinite(raw.above.gap) || typeof raw.above.nickname !== 'string')) bad('above');
  return {
    source: raw.source ?? 'custom',
    total,
    me: meRow,
    meInList: entries.some((e) => e.isMe),
    entries,
    above: raw.above ? { ...raw.above, gap: Math.max(1, Math.floor(raw.above.gap)) } : null,
  };
}

/** UI가 쓰는 창구. 소스는 useSource() 로 바꾼다 (기본: 가상 라이벌 래더). */
export class Leaderboard {
  #source;

  constructor(source = new VirtualLadder()) {
    this.useSource(source);
  }

  useSource(source) {
    if (typeof source?.getStandings !== 'function') throw new TypeError('리더보드 소스에는 getStandings(me, { top }) 가 필요합니다');
    this.#source = source;
    return this;
  }

  /** → { source, total, me: { rank, percentile, mmr, tier, … }, meInList, entries: [{ rank, nickname, mmr, tier, isMe }], above } */
  async getStandings(me, opts = {}) {
    return normalizeStandings(await this.#source.getStandings(me, { top: LEADERBOARD.top, ...opts }), me);
  }
}

export const leaderboard = new Leaderboard();