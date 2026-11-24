/**
 * LAST CHAMBER - AI 딜러 (gameEngine.js 공개 API 전용, DOM 비의존 ES Module)
 *
 *   const dealer = new AIDealer('B');
 *   const memory = { knownShell: null };
 *   // 결정 전마다 딜러 시점의 새 로그를 전부 알려 준다 (상대 행동 포함 · 상대의 비밀 정보는 엔진이 가려서 준다)
 *   dealer.observe(engine.getLog('B', since), memory);
 *   const action = dealer.decideNextAction(engine.getPublicState('B'), memory);
 *   // action: { type: 'item', slotIndex } | { type: 'shoot', target: 'self' | 'opponent' } | null(내 턴 아님)
 *
 * memory.knownShell  지금 약실 탄 (투시경으로 본 것, 탄종변환으로 뒤집히면 같이 뒤집음)
 * memory.belief      탄종변환으로 공개 개수가 가려졌을 때 쓰는 추정 탄 구성 { live, blank, frontFlipped }
 * memory.ejected     이번 턴에 탄제거를 이미 썼는지 (정찰 전 탄제거는 한 턴에 한 번만)
 *
 * - decideNextAction은 memory를 바꾸지 않으며 같은 입력엔 같은 행동을 낸다.
 * - 사용 가능 판정은 엔진 규칙과 같거나 더 엄격하다 → 엔진 에러가 나지 않음.
 * - 더블샷이 걸린 발은 항상 상대에게 쏜다 (더블샷을 자기 격발로 날리는 일이 없음).
 */
import { ITEM, SHELL } from './gameEngine.js';

const LEAN = 0.6; // 실탄/공포탄 우세 판단 기준
const WORTH_STEALING = new Set([ITEM.SCOPE, ITEM.EJECT, ITEM.FLASH, ITEM.DRINK, ITEM.DOUBLE]);
const flip = (shell) => (shell === SHELL.LIVE ? SHELL.BLANK : SHELL.LIVE);
const key = (shell) => (shell === SHELL.LIVE ? 'live' : 'blank');

export class AIDealer {
  constructor(playerId = 'B') {
    this.playerId = playerId;
  }

  /**
   * @param {object} publicState engine.getPublicState(this.playerId)
   * @param {{ knownShell?: 'LIVE'|'BLANK'|null, belief?: object }} [memory]
   */
  decideNextAction(publicState, memory) {
    const s = publicState;
    if (s?.me?.id !== this.playerId) throw new Error(`AIDealer(${this.playerId}) 시점의 publicState가 필요합니다.`);
    if (s.winner != null || !s.turn?.isMine) return null;

    const { me, opponent: opp, turn } = s;
    const remembered = this.#knownShell(s, memory?.knownShell);
    const pLive = remembered ? Number(remembered === SHELL.LIVE) : this.#liveOdds(s, memory);
    const pBlank = 1 - pLive;
    // 기억·개수·추정 중 무엇으로든 확률이 0 또는 1이면 확정으로 취급
    const known = remembered ?? (pLive === 1 ? SHELL.LIVE : pLive === 0 ? SHELL.BLANK : null);
    const can = (item) => me.items.includes(item) && this.#usable(item, s);
    const use = (item) => ({ type: 'item', slotIndex: me.items.indexOf(item) });
    const shoot = (target) => ({ type: 'shoot', target });
    const doubleReady = opp.hp >= 2 && can(ITEM.DOUBLE); // 이번 발을 2배로 만들 수 있는가 (상대 체력 1이면 의미 없음)
    const shotDamage = turn.doubleActive || doubleReady ? 2 : 1;

    // 1) 회복: 최대 체력 미만이면 (단두대에서도 가능)
    if (can(ITEM.DRINK)) return use(ITEM.DRINK);
    // 2) 탄제거: 약실을 모를 때(아는 탄을 버리지 않도록) 앞 탄을 배출하며 상대 아이템 1개를 부순다 — 한 턴에 한 번
    if (!known && s.total >= 2 && opp.items.length >= 1 && !memory?.ejected && can(ITEM.EJECT)) return use(ITEM.EJECT);
    // 3) 정찰: 약실을 모를 때 투시경
    if (!known && can(ITEM.SCOPE)) return use(ITEM.SCOPE);
    // 더블샷이 걸린 발은 무조건 상대에게
    if (turn.doubleActive) return shoot('opponent');
    // 탄종변환 ①: 공포탄임을 알고, 실탄으로 뒤집으면 이번 발로 끝낼 수 있을 때
    if (known === SHELL.BLANK && can(ITEM.CONVERT) && opp.hp <= shotDamage) return use(ITEM.CONVERT);
    // 탄종변환 ②: 실탄임을 알지만 내가 단두대이고 이번 발로 끝낼 수 없으며 다음 탄들도 실탄 쪽이면
    //          → 공포탄으로 뒤집어 자기 격발로 턴을 이어 간다 (위험한 다음 탄을 상대에게 넘기지 않음)
    if (known === SHELL.LIVE && can(ITEM.CONVERT) && me.hp === 1 && opp.hp > shotDamage
      && this.#restLiveOdds(s, memory, known) >= 0.5) return use(ITEM.CONVERT);
    // 4) 실탄 우세: DOUBLE → (DOUBLE 미사용 시) FLASH → 상대 격발
    if (pLive >= LEAN) {
      if (doubleReady) return use(ITEM.DOUBLE);
      const finishing = known === SHELL.LIVE && opp.hp <= 1; // 확정 마무리 발이면 섬광탄 생략
      if (!finishing && can(ITEM.FLASH)) return use(ITEM.FLASH);
      return shoot('opponent');
    }
    // 5) 공포탄 우세: 자기 격발 (단두대면 확실한 공포탄일 때만)
    if (pBlank >= LEAN && (known === SHELL.BLANK || me.hp > 1)) return shoot('self');
    // 6) 애매할 때: EJECT → PICKPOCKET(쓸 만한 게 있을 때) → 확률대로 격발
    if (can(ITEM.EJECT)) return use(ITEM.EJECT);
    if (can(ITEM.PICKPOCKET) && this.#stealable(s).some((it) => WORTH_STEALING.has(it))) return use(ITEM.PICKPOCKET);
    return shoot(pLive >= 0.5 || me.hp === 1 ? 'opponent' : 'self');
  }

  /** 엔진 로그(또는 액션 결과)를 반영한다. 상대 행동까지 넘겨야 탄종변환 이후 추정이 정확하다. */
  observe(result, memory = {}) {
    const events = Array.isArray(result) ? result : (result?.events ?? []);
    for (const e of events) {
      const item = e.stolen ?? e.item;
      const mine = e.actor === this.playerId;
      switch (e.type) {
        case 'LOAD':
          memory.belief = { live: e.live, blank: e.blank, frontFlipped: false };
          memory.knownShell = null;
          break;
        case 'SHOT':
          this.#reveal(memory, e.shell);
          memory.knownShell = null;
          break;
        case 'TURN':
          memory.knownShell = null;
          memory.ejected = false;
          break;
        case 'ITEM':
          if (item === ITEM.EJECT) {
            this.#reveal(memory, e.shell);
            memory.knownShell = null;
            if (mine) memory.ejected = true;
          } else if (item === ITEM.SCOPE && mine) {
            this.#learn(memory, e.shell);
          } else if (item === ITEM.CONVERT) {
            const b = memory.belief;
            let front = memory.knownShell;
            if (!front && b && !b.frontFlipped) front = b.live === 0 ? SHELL.BLANK : b.blank === 0 ? SHELL.LIVE : null; // 한 종류만 남았던 경우
            if (front) { // 알던 탄이면 구성까지 정확히 반영
              if (b && !b.frontFlipped) {
                b[key(front)] = Math.max(0, b[key(front)] - 1);
                b[key(flip(front))]++;
              } else if (b) b.frontFlipped = false;
              memory.knownShell = flip(front);
            } else if (b) {
              b.frontFlipped = !b.frontFlipped; // 무엇이 됐는지 모름 → 약실 탄 확률이 뒤집힘
            }
          }
          break;
        default:
          break;
      }
    }
    return memory;
  }

  // 엔진의 사용 불가 조건과 같거나 더 엄격하게 판정 → 엔진 에러가 나지 않음
  #usable(item, s) {
    const { me, turn } = s;
    switch (item) {
      case ITEM.SCOPE: return !turn.scopeUsed && !turn.doubleUsed;
      case ITEM.DOUBLE: return !turn.doubleActive && turn.stunned == null && !turn.scopeUsed;
      case ITEM.FLASH: return !turn.doubleUsed && !turn.flashLocked;
      case ITEM.EJECT: return true;
      case ITEM.CONVERT: return true;
      case ITEM.DRINK: return me.hp < me.maxHp; // 단두대(체력 1)에서도 가능
      case ITEM.PICKPOCKET: return this.#stealable(s).length > 0;
      default: return false;
    }
  }

  // PICKPOCKET으로 훔쳐 즉시 발동될 수 있는 상대 아이템 (엔진과 동일하게 PICKPOCKET 제외)
  #stealable(s) {
    return s.opponent.items.filter((it) => it !== ITEM.PICKPOCKET && this.#usable(it, s));
  }

  // 기억한 탄종이 공개 탄 구성과 모순되면 무시하고, 한 종류만 남았으면 확정으로 취급
  #knownShell(s, remembered) {
    if (remembered === SHELL.LIVE && s.live !== 0) return SHELL.LIVE;
    if (remembered === SHELL.BLANK && s.blank !== 0) return SHELL.BLANK;
    if (s.live === 0) return SHELL.BLANK;
    if (s.blank === 0) return SHELL.LIVE;
    return null;
  }

  // 지금 약실이 실탄일 확률: 공개 개수 → (가려졌으면) 관찰로 쌓은 추정 → 그래도 모르면 반반
  #liveOdds(s, memory) {
    if (s.live !== null) return s.total ? s.live / s.total : 0;
    const b = memory?.belief;
    if (!b || s.total === 0 || b.live + b.blank !== s.total) return 0.5;
    return (b.frontFlipped ? b.blank : b.live) / s.total;
  }

  // 약실 다음 탄들이 실탄일 확률 (약실 탄을 알고 있을 때)
  #restLiveOdds(s, memory, front) {
    const rest = s.total - 1;
    if (rest <= 0) return 0;
    let live;
    if (s.live !== null) live = s.live;
    else if (memory?.belief && memory.belief.live + memory.belief.blank === s.total) live = memory.belief.live;
    else return 0.5;
    return Math.min(1, Math.max(0, (live - (front === SHELL.LIVE ? 1 : 0)) / rest));
  }

  // 약실 탄을 알게 됨: 뒤집힌 채 모르던 탄이면 추정 구성을 실제로 맞춘다
  #learn(memory, shell) {
    if (shell !== SHELL.LIVE && shell !== SHELL.BLANK) return;
    const b = memory.belief;
    if (b?.frontFlipped) {
      b[key(flip(shell))] = Math.max(0, b[key(flip(shell))] - 1);
      b[key(shell)]++;
      b.frontFlipped = false;
    }
    memory.knownShell = shell;
  }

  // 약실 탄이 공개됨(격발·탄제거): 추정 구성에서 원래 탄종을 뺀다
  #reveal(memory, shell) {
    const b = memory.belief;
    if (!b || (shell !== SHELL.LIVE && shell !== SHELL.BLANK)) return;
    const original = b.frontFlipped ? flip(shell) : shell;
    b[key(original)] = Math.max(0, b[key(original)] - 1);
    b.frontFlipped = false;
  }
}
