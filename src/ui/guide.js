/**
 * ODD ROULETTE - 첫 판 가이드 상태 · 문구 (DOM 비의존 — 저장소를 주입받는다)
 *
 *   · 3줄 룰 카드: 첫 게임(어느 모드든)의 장전 연출과 함께 핵심 룰 3줄을 보여 준다 — 보여 준 순간 '봤음'으로 기록.
 *   · 4단계 코치마크: 첫 AI 연습 판에서 내 첫 턴이 시작될 때 ① 잔탄 ② 나에게/상대에게 쏘기 ③ 아이템 ④ 체력을 차례로 짚는다 — 끝까지 보거나 [건너뛰기]하면 '완료'로 기록.
 *     온라인 대전은 서버 시계가 흐르고 멈출 수 없어서 코치마크를 띄우지 않는다 (카드만). 그래서 첫 판이 온라인이었던 사람도 첫 AI 판에서는 코치마크를 본다.
 *   · 첫 AI 판은 턴 제한을 GUIDED_TURN_MS 로 넉넉하게 (코치마크가 떠 있는 동안에는 시간도 멈춘다).
 *   · 이미 게임을 해 본 사람(전적 · 연습 기록이 있는 프로필)은 처음부터 둘 다 '봤음'으로 본다 — 업데이트 때문에 기존 유저에게 튜토리얼이 뜨지 않게.
 *   2번째 판부터는 모두 생략된다. 저장 키: lastchamber.guide
 */

export const GUIDE_KEY = 'lastchamber.guide';
export const GUIDED_TURN_MS = 45_000; // 첫 AI 판의 턴 제한 (보통 20초)

/** 장전 연출과 함께 보여 주는 핵심 3줄 */
export const RULE_LINES = Object.freeze([
  '실탄 · 공포탄 개수를 보고, 상대에게 쏠지 나에게 쏠지 정하세요',
  '나에게 쏜 공포탄은 한 번 더 내 턴!',
  '아이템은 턴을 쓰지 않아요 — 적극 활용!',
]);

/** 코치마크 4단계: target = index.html 의 요소 id */
export const COACH_STEPS = Object.freeze([
  { target: 'shells', title: '남은 탄', text: '실탄과 공포탄의 개수는 공개돼요. 하지만 순서는 아무도 몰라요 — 개수로 확률을 읽으세요.' },
  { target: 'trigger-panel', title: '나에게 쏠까, 상대에게 쏠까', text: '나에게 쏜 탄이 공포탄이면 한 번 더 내 턴! 실탄이면 내가 맞고 턴이 넘어가요. 상대에게 쏘면 무엇이든 턴이 넘어가요.' },
  { target: 'player-items', title: '아이템 카드', text: '아이템은 턴을 쓰지 않아요. 카드를 눌러 사용하세요 — 약실을 몰래 보거나, 피해를 키우거나, 상대 턴을 건너뛰게 할 수 있어요.' },
  { target: 'player-hp', title: '체력', text: '체력이 0이 되면 그 판이 끝나요. 먼저 2판을 이기면 승리! 첫 판은 시간 제한이 45초로 넉넉해요.' },
]);

const safe = (fn, fallback) => {
  try {
    return fn();
  } catch {
    return fallback; // 저장소를 못 쓰는 환경 — 이번 접속에서만 기록이 남지 않는다 (가이드가 한 번 더 뜰 수 있을 뿐)
  }
};

export class GuideState {
  #storage;
  #state;

  /** @param {{ storage?: Storage, hadPlayed?: boolean }} [options] hadPlayed: 이미 게임을 해 본 프로필인가 */
  constructor({ storage = globalThis.localStorage, hadPlayed = false } = {}) {
    this.#storage = storage;
    const saved = safe(() => JSON.parse(storage.getItem(GUIDE_KEY) ?? 'null'), null);
    const valid = saved && typeof saved === 'object' && typeof saved.ruleCard === 'boolean' && typeof saved.coach === 'boolean';
    this.#state = valid ? { ruleCard: saved.ruleCard, coach: saved.coach } : { ruleCard: hadPlayed, coach: hadPlayed };
    if (!valid && hadPlayed) this.#save(); // 기존 유저는 한 번 기록해 둔다 (다음부터는 저장된 값을 따른다)
  }

  #save() {
    safe(() => this.#storage.setItem(GUIDE_KEY, JSON.stringify(this.#state)));
  }

  /** 3줄 룰 카드를 보여 줄 판인가 (첫 게임) */
  get shouldShowRuleCard() {
    return !this.#state.ruleCard;
  }

  markRuleCard() {
    if (this.#state.ruleCard) return;
    this.#state.ruleCard = true;
    this.#save();
  }

  /** 4단계 코치마크 · 넉넉한 턴 제한을 줄 AI 연습 판인가 (온라인 판은 항상 false) */
  shouldCoach({ online = false } = {}) {
    return !online && !this.#state.coach;
  }

  markCoachDone() {
    if (this.#state.coach) return;
    this.#state.coach = true;
    this.#state.ruleCard = true; // 코치마크까지 봤다면 룰 카드도 본 것
    this.#save();
  }
}
