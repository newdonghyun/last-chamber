/**
 * LAST CHAMBER - 출석 팝업의 판단 규칙 (DOM 없음 — Node 테스트에서도 그대로 돈다)
 *
 * 출석의 원본은 서버다 (server/wallet.js · walletStatus). 여기서는 서버가 알려 준 상태를 화면이 어떻게 읽을지만 정한다.
 */

import { getFlame, getItem } from './storeData.js';

const fmt = (n) => Number(n || 0).toLocaleString('ko-KR');

/** 이번 7일 사이클에서 도장이 찍힌 칸 수 — 7일을 다 받았고 오늘 아직이면 새 사이클(0칸)부터 */
export function claimedDays(att) {
  if (!att) return 0;
  return !att.claimedToday && att.days >= att.rewards.length ? 0 : att.days;
}

/** 보상 하나의 이름: '탄피 100' · '실버 룰렛' · '탄피 500 + 팬텀 블랙' */
export function rewardName(reward) {
  const parts = [];
  if (reward?.brass) parts.push(`탄피 ${fmt(reward.brass)}`);
  if (reward?.item) parts.push((reward.item.kind === 'flame' ? getFlame(reward.item.id) : getItem(reward.item.kind, reward.item.id))?.name ?? reward.item.id);
  return parts.join(' + ');
}

/** 수령 직후의 짧은 안내 — res = wallet.checkIn() 의 성공 결과 */
export function claimFeedback(res) {
  return `${rewardName(res.reward)} 획득!${res.reward.duplicate ? ' (이미 가진 스킨은 탄피로 지급)' : ''}`;
}

/** 자동으로 팝업을 띄울 '그날'의 열쇠 — 서버 상태가 없거나 오늘 이미 받았으면 null (띄우지 않는다). 같은 열쇠로는 한 번만 띄운다 */
export function autoOpenKey(userId, state) {
  return state?.attendance && !state.attendance.claimedToday ? `${userId ?? ''}|${state.today}` : null;
}
