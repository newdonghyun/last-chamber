/**
 * LAST CHAMBER - 서버 지갑 (탄피 · 스킨 · 출석 · 긴급 보급) — DOM 비의존
 *
 *   로그인한 계정의 탄피(shells) · 해금/장착 스킨 · 화염 · 도발 · 칭호 · 상자 기록 · 출석 · 긴급 보급 횟수는 이 서버가 원본이다.
 *   클라이언트(src/ui/walletClient.js)는 거울일 뿐 — 이 기기에서 값을 고쳐도 다음 동기화 때 서버 값으로 되돌아가고, 서버는 요청마다 다시 검증한다.
 *
 *   지갑(wallet) 한 벌:
 *     { brass, owned: { gun: [...], table: [...] }, equipped: { gun, table },
 *       attendanceDays(이번 7일 사이클에서 마지막으로 받은 날 1~7, 0 = 아직), lastCheckin('YYYY-MM-DD' 한국 시간 | null),
 *       emergency: { date, count },                      // 긴급 보급을 받은 날 · 그날 받은 횟수
 *       extra: { flames, equippedFlame, taunts, equippedTaunt, titles, equippedTitle, chest: { pity, opened }, practice: { date, count } } }
 *   Supabase players 컬럼: shells · unlocked_skins · equipped_skin · attendance_days · last_checkin_date · emergency_date · emergency_count · wallet_extra
 *   (SQL 은 server/userStore.js 의 WALLET_SQL).
 *
 *   상점 동작(구매 · 장착 · 상자 · 화염 · 도발 · 칭호)은 클라이언트와 같은 PlayerProfile(src/ui/storeData.js)을 메모리 저장소 위에서 서버가 대신 실행한다
 *   → 가격 · 확률 · 천장 규칙이 한 벌이고, 클라이언트가 값을 정하지 못한다 (상자 추첨도 서버 난수).
 *   시간 규칙은 모두 한국 시간(Asia/Seoul, UTC+9) 날짜 기준: 출석 하루 1회 · 긴급 보급 하루 3회 · AI 연습 보상 하루 5판.
 */

import { PlayerProfile, BRASS_START, rewardFor } from '../src/ui/storeData.js';

export const WALLET_RULES = Object.freeze({
  emergencyAmount: 50, // [긴급 보급] 한 번에 받는 탄피
  emergencyPerDay: 3, // 하루 최대 횟수
  practicePerDay: 5, // 하루에 탄피 보상을 받는 AI 연습 판 수 (AI 판은 서버가 검증할 수 없어 횟수로 제한한다)
  duplicateSkinBrass: 150, // 출석 보상 스킨을 이미 가졌을 때 대신 받는 탄피
  maxBrass: 99_999_999,
});

const CYCLE = 7;
/** 출석 체크 7일 사이클: 탄피 · 스킨(kind: gun | table | flame) */
export const ATTENDANCE_REWARDS = Object.freeze([
  Object.freeze({ day: 1, brass: 100 }),
  Object.freeze({ day: 2, item: Object.freeze({ kind: 'table', id: 'silver_roulette' }) }), // 실버 룰렛 스킨
  Object.freeze({ day: 3, brass: 200 }),
  Object.freeze({ day: 4, item: Object.freeze({ kind: 'flame', id: 'blue_flame' }) }), // 블루 플레임 이펙트
  Object.freeze({ day: 5, brass: 300 }),
  Object.freeze({ day: 6, item: Object.freeze({ kind: 'gun', id: 'blood_gold' }) }), // 블러드 골드 스킨
  Object.freeze({ day: 7, brass: 500, item: Object.freeze({ kind: 'gun', id: 'phantom_black' }) }), // 500 탄피 + 팬텀 블랙 스킨
]);

const KST_MS = 9 * 60 * 60 * 1000;
/** 한국 시간 날짜 'YYYY-MM-DD' */
export const kstDate = (ms = Date.now()) => new Date(ms + KST_MS).toISOString().slice(0, 10);
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const cleanDate = (v) => (typeof v === 'string' && DATE.test(v.slice(0, 10)) ? v.slice(0, 10) : null);
const int = (v, min, max, fallback = min) => (Number.isFinite(v) ? Math.min(max, Math.max(min, Math.floor(v))) : fallback);
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

const memoryStorage = (text) => {
  let value = text;
  return { getItem: () => value, setItem: (_key, next) => { value = next; } };
};

/** PlayerProfile 이 읽는 저장 모양으로 (랭킹 전적은 서버 기록 — 칭호 조건에 쓰인다) */
const asProfileJson = (w, stats = {}) => ({
  v: 5,
  brass: w.brass,
  owned: w.owned,
  equipped: w.equipped,
  flames: w.extra?.flames,
  equippedFlame: w.extra?.equippedFlame,
  taunts: w.extra?.taunts,
  equippedTaunt: w.extra?.equippedTaunt,
  titles: w.extra?.titles,
  equippedTitle: w.extra?.equippedTitle,
  chest: w.extra?.chest,
  wins: stats.wins ?? 0,
  losses: stats.losses ?? 0,
  streak: stats.streak ?? 0,
  maxStreak: stats.maxStreak ?? 0,
  mmr: stats.mmr ?? 1000,
  nickname: stats.nickname ?? '방랑자',
  practice: { wins: 0, losses: 0, streak: 0, maxStreak: 0 },
  hasNoAdsPass: false, // 결제 권한은 아직 서버에 없다 (결제를 연결할 때 영수증 검증과 함께 이 지갑에 둔다)
  starterPurchased: false,
  streakShields: 0,
});

/** PlayerProfile 스냅샷 → 지갑 (출석 · 긴급 보급 · 연습 보상 기록은 이전 값을 이어받는다) */
function fromSnapshot(snap, prev = {}) {
  const practice = isObject(prev.extra?.practice) ? prev.extra.practice : {};
  return {
    brass: snap.brass,
    owned: { gun: [...snap.owned.gun], table: [...snap.owned.table] },
    equipped: { gun: snap.equipped.gun, table: snap.equipped.table },
    attendanceDays: int(prev.attendanceDays, 0, CYCLE),
    lastCheckin: cleanDate(prev.lastCheckin),
    emergency: { date: cleanDate(prev.emergency?.date), count: int(prev.emergency?.count, 0, 99) },
    extra: {
      flames: [...snap.flames],
      equippedFlame: snap.equippedFlame,
      taunts: [...snap.taunts],
      equippedTaunt: snap.equippedTaunt,
      titles: [...snap.titles],
      equippedTitle: snap.equippedTitle,
      chest: { pity: snap.chest.pity, opened: snap.chest.opened },
      practice: { date: cleanDate(practice.date), count: int(practice.count, 0, 999) },
    },
  };
}

/** 저장된 값(DB · 파일)을 믿지 않고 검증한다 — 카탈로그에 없는 스킨 · 잘못된 장착은 PlayerProfile 의 규칙대로 걸러진다. 아무것도 없으면 새 지갑 */
export function normalizeWallet(raw, stats = {}) {
  const r = isObject(raw) ? raw : {};
  const seed = { ...r, brass: Number.isFinite(r.brass) ? r.brass : BRASS_START };
  const profile = new PlayerProfile({ storage: memoryStorage(JSON.stringify(asProfileJson(seed, stats))) });
  return fromSnapshot(profile.snapshot(), r);
}

export const defaultWallet = (stats) => normalizeWallet(null, stats);

/** 클라이언트가 거울로 받는 모양 (PlayerProfile.adoptWallet 이 읽는다) */
export function walletView(w) {
  return {
    brass: w.brass,
    owned: w.owned,
    equipped: w.equipped,
    flames: w.extra.flames,
    equippedFlame: w.extra.equippedFlame,
    taunts: w.extra.taunts,
    equippedTaunt: w.extra.equippedTaunt,
    titles: w.extra.titles,
    equippedTitle: w.extra.equippedTitle,
    chest: w.extra.chest,
    hasNoAdsPass: false,
    starterPurchased: false,
    streakShields: 0,
  };
}

const publicReward = (r) => ({ day: r.day, ...(r.brass ? { brass: r.brass } : {}), ...(r.item ? { item: { ...r.item } } : {}) });

/** 출석 · 긴급 보급 · 연습 보상의 지금 상태 (로비 화면이 그린다). minFee = 유료 테이블의 최소 참가비 */
export function walletStatus(w, now = Date.now(), minFee = 0) {
  const today = kstDate(now);
  const claimedToday = w.lastCheckin === today;
  const used = w.emergency.date === today ? w.emergency.count : 0;
  const left = Math.max(0, WALLET_RULES.emergencyPerDay - used);
  const practiceUsed = w.extra.practice.date === today ? w.extra.practice.count : 0;
  return {
    today,
    attendance: {
      days: w.attendanceDays,
      claimedToday,
      todayDay: claimedToday ? w.attendanceDays : (w.attendanceDays % CYCLE) + 1, // 오늘 받은(또는 받을) 사이클의 몇째 날
      rewards: ATTENDANCE_REWARDS.map(publicReward),
    },
    emergency: { amount: WALLET_RULES.emergencyAmount, perDay: WALLET_RULES.emergencyPerDay, used, left, minFee, eligible: minFee > 0 && w.brass < minFee && left > 0 },
    practice: { perDay: WALLET_RULES.practicePerDay, left: Math.max(0, WALLET_RULES.practicePerDay - practiceUsed) },
  };
}

// ───────── 탄피 ─────────

export function grantBrass(w, amount) {
  const n = Math.max(0, Math.floor(amount) || 0);
  w.brass = Math.min(WALLET_RULES.maxBrass, w.brass + n);
  return w.brass;
}

/** 모자라면 아무것도 바꾸지 않고 false */
export function spendBrass(w, amount) {
  const n = Math.max(0, Math.floor(amount) || 0);
  if (w.brass < n) return false;
  w.brass -= n;
  return true;
}

// ───────── 상점 (PlayerProfile 을 서버에서 대신 실행) ─────────

const KINDS = new Set(['gun', 'table']);
const idOf = (v) => (typeof v === 'string' && v.length <= 40 ? v : null);

/**
 * 구매 · 장착 · 상자 · 화염 · 도발 · 칭호. 결과는 PlayerProfile 메서드의 반환값 그대로 ({ ok, reason, short, brass, ... }) — 지갑(w)은 그 결과대로 바뀐다.
 * 알 수 없는 동작 · 모양이 틀린 인자는 { ok: false, reason: 'bad_request' }.
 */
export function runStoreAction(w, stats, action, args, rng) {
  const profile = new PlayerProfile({ storage: memoryStorage(JSON.stringify(asProfileJson(w, stats))) });
  const kind = KINDS.has(args?.kind) ? args.kind : null;
  const id = idOf(args?.id);
  let result;
  switch (action) {
    case 'buy': result = kind && id ? profile.buyWithBrass(kind, id) : null; break;
    case 'equip': result = kind && id ? profile.equip(kind, id) : null; break;
    case 'chest': result = profile.openChest(rng); break;
    case 'flame': result = id ? profile.equipFlame(id) : null; break;
    case 'taunt_buy': result = id ? profile.buyTaunt(id) : null; break;
    case 'taunt_equip': result = args?.id === null ? profile.equipTaunt(null) : id ? profile.equipTaunt(id) : null; break;
    case 'title': result = id ? profile.equipTitle(id) : null; break;
    default: result = null;
  }
  if (!result) return { ok: false, reason: 'bad_request' };
  Object.assign(w, fromSnapshot(profile.snapshot(), w));
  if (result.item) result = { ...result, item: { id: result.item.id } }; // 상자 결과는 id 만 — 화면은 자기 카탈로그로 그린다
  return result;
}

// ───────── 출석 · 긴급 보급 · 연습 보상 ─────────

function giveItem(w, { kind, id }) {
  if (kind === 'flame') {
    if (w.extra.flames.includes(id)) return false;
    w.extra.flames.push(id);
    return true;
  }
  if (!KINDS.has(kind) || w.owned[kind].includes(id)) return false;
  w.owned[kind].push(id);
  return true;
}

/**
 * 출석 체크: 한국 시간 하루 한 번. 오늘 받을 날 = 이번 사이클에서 마지막으로 받은 날 + 1 (7일 다음은 1일차).
 * 빠뜨린 날이 있어도 사이클은 이어진다 (연속이 끊겨도 처음부터 다시 하지 않는다). 이미 가진 스킨이면 duplicateSkinBrass 탄피로 대신한다.
 * → { ok: true, day, today, reward: { brass, item, duplicate } } | { ok: false, error: 'ALREADY_CHECKED_IN' }
 */
export function checkIn(w, now = Date.now()) {
  const today = kstDate(now);
  if (w.lastCheckin === today) return { ok: false, error: 'ALREADY_CHECKED_IN' };
  const day = (w.attendanceDays % CYCLE) + 1;
  const entry = ATTENDANCE_REWARDS[day - 1];
  let brass = entry.brass ?? 0;
  let item = null;
  let duplicate = false;
  if (entry.item) {
    if (giveItem(w, entry.item)) item = { ...entry.item };
    else {
      duplicate = true;
      brass += WALLET_RULES.duplicateSkinBrass;
    }
  }
  grantBrass(w, brass);
  w.attendanceDays = day;
  w.lastCheckin = today;
  return { ok: true, day, today, reward: { brass, item, duplicate } };
}

/** 긴급 보급: 탄피가 minFee(가장 싼 유료 테이블 참가비) 미만일 때 하루 emergencyPerDay 번까지 emergencyAmount 탄피 */
export function claimEmergency(w, now = Date.now(), minFee = 0) {
  const today = kstDate(now);
  if (w.emergency.date !== today) w.emergency = { date: today, count: 0 };
  if (!(minFee > 0 && w.brass < minFee)) return { ok: false, error: 'NOT_ELIGIBLE' };
  if (w.emergency.count >= WALLET_RULES.emergencyPerDay) return { ok: false, error: 'LIMIT_REACHED' };
  w.emergency.count += 1;
  grantBrass(w, WALLET_RULES.emergencyAmount);
  return { ok: true, amount: WALLET_RULES.emergencyAmount, used: w.emergency.count, left: WALLET_RULES.emergencyPerDay - w.emergency.count };
}

/**
 * AI 연습 판 보상 (서버는 AI 판의 결과를 검증할 수 없으므로 하루 practicePerDay 판까지만, 연승 보너스 없이 승 150 · 패 40).
 * 한도가 차면 { ok: true, granted: 0, limited: true } — 판 결과(전적)는 이 기기에 그대로 기록된다.
 */
export function claimPractice(w, won, now = Date.now()) {
  const today = kstDate(now);
  const practice = w.extra.practice;
  if (practice.date !== today) w.extra.practice = { date: today, count: 0 };
  if (w.extra.practice.count >= WALLET_RULES.practicePerDay) return { ok: true, granted: 0, limited: true, left: 0 };
  w.extra.practice.count += 1;
  const granted = rewardFor(Boolean(won), 0).total;
  grantBrass(w, granted);
  return { ok: true, granted, limited: false, left: WALLET_RULES.practicePerDay - w.extra.practice.count };
}

// ───────── Supabase 행 ↔ 지갑 ─────────

export const WALLET_COLUMNS = 'shells, unlocked_skins, equipped_skin, attendance_days, last_checkin_date, emergency_date, emergency_count, wallet_extra';

/** 지갑 → players 행의 지갑 컬럼들 (PostgREST update 에 그대로 쓴다) */
export const walletToRow = (w) => ({
  shells: w.brass,
  unlocked_skins: w.owned,
  equipped_skin: w.equipped,
  attendance_days: w.attendanceDays,
  last_checkin_date: w.lastCheckin,
  emergency_date: w.emergency.date,
  emergency_count: w.emergency.count,
  wallet_extra: w.extra,
});

/** players 행 → 지갑 (컬럼이 비어 있으면 새 지갑) */
export function walletFromRow(row, stats) {
  if (!row || row.shells === undefined) return null; // 지갑 컬럼을 select 하지 않았다
  return normalizeWallet({
    brass: row.shells,
    owned: row.unlocked_skins,
    equipped: row.equipped_skin,
    attendanceDays: row.attendance_days,
    lastCheckin: row.last_checkin_date,
    emergency: { date: row.emergency_date, count: row.emergency_count },
    extra: row.wallet_extra,
  }, stats);
}
