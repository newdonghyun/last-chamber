/**
 * LAST CHAMBER - 순수 게임 엔진 (DOM 비의존 ES Module)
 *
 *   const game = new GameEngine({ players: ['A', 'B'], rng: Math.random });
 *   game.useItem('A', 0);          // 자신의 아이템 슬롯 인덱스
 *   game.shoot('A', 'opponent');   // 'self' | 'opponent'
 *   game.getPublicState('A');      // A 시점 공개 상태 (탄 순서는 비공개)
 *   game.getLog('B', since);       // B 시점 로그 (투시경으로 본 탄은 사용자만)
 *
 * 액션 결과: { ok: true, ...결과, events } | { ok: false, error }
 * 로그 type: ROUND_START, LOAD, DEAL, TURN, SKIP, SHOT, ITEM, ROUND_END, GAME_OVER
 * 비공개 규칙
 *  - SCOPE(투시경)로 본 약실 탄종은 사용자에게만 (secret)
 *  - CONVERT(탄종변환)는 바뀐 탄종을 누구에게도 알리지 않으며, 이번 장전이 끝날 때까지 공개 실탄/공포탄 개수를 가린다
 *    (live·blank = null, total만 공개 → 개수 변화로 뒤집힌 탄종을 역산할 수 없음)
 * 지급 규칙: 장전마다 1인당 라운드별 1·2·2개 · 최대 6칸 · 같은 아이템 2개(섬광탄은 1개) · 섬광탄·위스키 한잔은 다른 아이템의 절반 확률
 * 위스키 한잔(DRINK)은 단두대(체력 1)에서도 쓸 수 있다 (가득 찬 체력에서만 불가)
 * 탄제거(EJECT): 현재 탄을 배출(종류 공개)하고 상대 아이템 1개를 무작위로 파괴한다 (ITEM 로그의 destroyed, 상대 아이템이 없으면 배출만)
 * 턴 규칙
 *  - 자신에게 쏜 공포탄만 턴을 이어 간다. 그 밖의 격발(상대에게 쏨 · 자신에게 실탄)은 상대에게 턴이 넘어간다.
 *  - 마지막 발이라 재장전이 일어나도 재장전은 턴을 바꾸지 않는다 — 턴은 그 격발의 결과를 그대로 따른다.
 *    (마지막 공포탄을 자신에게 쏘면 재장전 뒤에도 내 턴 · 탄제거로 마지막 탄을 빼도 사용자의 턴이 이어진다)
 *  - 새 라운드(누군가 체력 0)가 시작될 때만 '직전 마지막 격발자의 상대'가 선공한다 (게임 첫 라운드는 players[0]).
 *  - TURN 로그는 턴이 새로 시작될 때만 나온다 → 턴이 이어지는 재장전(LOAD · DEAL)에는 TURN이 뒤따르지 않는다.
 */

export const SHELL = Object.freeze({ LIVE: 'LIVE', BLANK: 'BLANK' });

export const ITEM = Object.freeze({
  SCOPE: 'SCOPE', // 투시경: 약실 탄 몰래 확인
  DOUBLE: 'DOUBLE', // 더블샷: 다음 한 발 피해 2배
  FLASH: 'FLASH', // 섬광탄: 상대 다음 턴 스킵
  EJECT: 'EJECT', // 탄제거: 약실 탄 배출 + 상대 아이템 1개 파괴
  DRINK: 'DRINK', // 위스키 한잔: 체력 +1
  PICKPOCKET: 'PICKPOCKET', // 소매치기: 상대 아이템을 훔쳐 즉시 사용
  CONVERT: 'CONVERT', // 탄종변환: 약실 탄 실탄↔공포탄
});

const ROUNDS = [
  { hp: 3, shells: [3, 5], items: 1 }, // items: 장전할 때마다 1인당 지급 개수
  { hp: 4, shells: [5, 7], items: 2 },
  { hp: 4, shells: [6, 8], items: 2 },
];
const ITEM_TYPES = Object.values(ITEM);
const MAX_SLOTS = 6;
const MAX_SAME_ITEM = 2;
const DROP_WEIGHT = { [ITEM.FLASH]: 1, [ITEM.DRINK]: 1 }; // 지급 가중치 (기본 2) → 섬광탄·위스키 한잔은 다른 아이템의 절반 확률
const HOLD_LIMIT = { [ITEM.FLASH]: 1 }; // 같은 아이템 동시 보유 한도 (기본 MAX_SAME_ITEM) → 섬광탄은 1개만
const MAX_DRINK_DROPS = 2; // 플레이어별, 라운드당
const WINS_NEEDED = 2;
const flip = (shell) => (shell === SHELL.LIVE ? SHELL.BLANK : SHELL.LIVE);

export class GameEngine {
  #rng;
  #players; // [{ id, hp, items, wins, drinks }]
  #round = 1;
  #chamber = []; // 비공개 탄창, [0] = 현재 약실
  #obscured = false; // 이번 장전에서 CONVERT가 쓰여 공개 탄 구성이 가려졌는지
  #turn = null; // { player, scope, double, doubleUsed, flashUsed }
  #flash = null; // { by, pending } : pending이면 by의 상대가 다음 턴 스킵
  #lastShooter = null;
  #winner = null;
  #log = [];
  #views = []; // 로그 항목마다 '그 사건 직후'의 공개 상태 [좌석 0 시점, 좌석 1 시점] — 화면이 연출한 데까지만 보여 줄 수 있게 (탄 순서는 없다)

  constructor({ players = ['P1', 'P2'], rng = Math.random } = {}) {
    if (!Array.isArray(players) || players.length !== 2 || players[0] === players[1]) {
      throw new Error('서로 다른 플레이어 ID 2개가 필요합니다.');
    }
    this.#rng = rng;
    this.#players = players.map((id) => ({ id, hp: 0, items: [], wins: 0, drinks: 0 }));
    this.#startRound();
  }

  /** @param {'self'|'opponent'} target */
  shoot(playerId, target) {
    const p = this.#find(playerId);
    const error = this.#actionError(p) ?? (target === 'self' || target === 'opponent' ? null : 'INVALID_TARGET');
    if (error) return { ok: false, error };

    const from = this.#log.length;
    const victim = target === 'self' ? p : this.#other(p);
    const shell = this.#chamber.shift();
    const damage = shell === SHELL.LIVE ? (this.#turn.double ? 2 : 1) : 0;
    this.#turn.double = false;
    this.#lastShooter = p;
    victim.hp = Math.max(0, victim.hp - damage);
    this.#emit({ type: 'SHOT', actor: p.id, target: victim.id, shell, damage });

    const keepsTurn = victim === p && damage === 0; // 자신에게 쏜 공포탄일 때만 턴 유지
    if (victim.hp === 0) this.#endRound(this.#other(victim));
    else {
      if (this.#chamber.length === 0) this.#fillChamber(); // 마지막 발 → 재장전 (턴은 건드리지 않음)
      if (!keepsTurn) this.#beginTurn(this.#other(p)); // 턴 전환은 재장전 여부와 상관없이 이 격발의 결과로만 정해진다
    }
    return { ok: true, shell, target: victim.id, damage, events: this.getLog(playerId, from) };
  }

  /** @param {number} itemIndex 자신의 아이템 슬롯 인덱스 */
  useItem(playerId, itemIndex) {
    const p = this.#find(playerId);
    const item = p && Number.isInteger(itemIndex) ? p.items[itemIndex] : undefined;
    const error = this.#actionError(p) ?? (item ? this.#blockReason(p, item) : 'INVALID_ITEM');
    if (error) return { ok: false, error };

    const from = this.#log.length;
    p.items.splice(itemIndex, 1);
    const effect = this.#apply(p, item);
    this.#emit({ type: 'ITEM', actor: p.id, item, ...effect });
    if (this.#chamber.length === 0) this.#fillChamber(); // EJECT로 마지막 탄 배출 시 재장전 (아이템은 턴을 끝내지 않으므로 사용자의 턴이 그대로 이어짐)
    return { ok: true, item, ...effect, events: this.getLog(playerId, from) };
  }

  getPublicState(playerId) {
    const me = this.#mustFind(playerId);
    const t = this.#turn;
    const total = this.#chamber.length;
    const live = this.#obscured ? null : this.#chamber.filter((s) => s === SHELL.LIVE).length;
    const side = (p) => ({
      id: p.id, hp: p.hp, maxHp: this.#cfg.hp, guillotine: p.hp === 1, wins: p.wins, items: [...p.items],
    });
    return {
      round: this.#round,
      total, // 남은 총 발수 (항상 정확)
      live, // 탄종변환으로 가려졌으면 null
      blank: live === null ? null : total - live,
      obscured: this.#obscured,
      me: side(me),
      opponent: side(this.#other(me)),
      turn: t && {
        player: t.player.id,
        isMine: t.player === me,
        doubleActive: t.double,
        doubleUsed: t.doubleUsed, // 이번 턴 DOUBLE 사용 → 같은 턴 FLASH·SCOPE 불가
        scopeUsed: t.scope, // 이번 턴 SCOPE 사용 → 같은 턴 DOUBLE 불가
        stunned: this.#flash?.pending ? this.#other(this.#flash.by).id : null,
        flashLocked: this.#flash !== null, // 섬광탄 효과 진행 중(스킵 대기 또는 스킵 후 연속 턴) → FLASH 재사용 불가
      },
      winner: this.#winner?.id ?? null,
    };
  }

  /** 로그 index 번째 사건 직후의 playerId 시점 공개 상태 (getPublicState 와 같은 모양) | null */
  getViewAfter(playerId, index) {
    const p = this.#mustFind(playerId);
    return this.#views[index]?.[this.#players.indexOf(p)] ?? null;
  }

  getLog(playerId, since = 0) {
    this.#mustFind(playerId);
    return this.#log.slice(since).map((e) => this.#view(e, playerId));
  }

  // ───────── 내부 ─────────

  get #cfg() {
    return ROUNDS[this.#round - 1];
  }

  #find(id) {
    return this.#players.find((p) => p.id === id);
  }

  #mustFind(id) {
    const p = this.#find(id);
    if (!p) throw new Error(`알 수 없는 플레이어: ${id}`);
    return p;
  }

  #other(p) {
    return this.#players[this.#players[0] === p ? 1 : 0];
  }

  #actionError(p) {
    if (!p) return 'INVALID_PLAYER';
    if (this.#winner) return 'GAME_OVER';
    return this.#turn.player === p ? null : 'NOT_YOUR_TURN';
  }

  #blockReason(p, item) {
    const t = this.#turn;
    switch (item) {
      case ITEM.SCOPE: return t.scope ? 'SCOPE_USED' : t.doubleUsed ? 'DOUBLE_SCOPE_CONFLICT' : null;
      case ITEM.DOUBLE: return t.double ? 'DOUBLE_ACTIVE' : t.flashUsed ? 'DOUBLE_FLASH_CONFLICT' : t.scope ? 'DOUBLE_SCOPE_CONFLICT' : null;
      case ITEM.FLASH: return t.doubleUsed ? 'DOUBLE_FLASH_CONFLICT' : this.#flash ? 'FLASH_LOCKED' : null;
      case ITEM.DRINK: return p.hp >= this.#cfg.hp ? 'HP_FULL' : null; // 단두대(체력 1)에서도 사용 가능
      case ITEM.PICKPOCKET: return this.#stealable(p).length ? null : 'NOTHING_TO_STEAL';
      default: return null; // EJECT, CONVERT
    }
  }

  #apply(p, item) {
    const t = this.#turn;
    switch (item) {
      case ITEM.SCOPE:
        t.scope = true;
        return { shell: this.#chamber[0], secret: true };
      case ITEM.DOUBLE:
        t.double = t.doubleUsed = true;
        return {};
      case ITEM.FLASH:
        t.flashUsed = true;
        this.#flash = { by: p, pending: true };
        return { target: this.#other(p).id };
      case ITEM.EJECT: { // 현재 탄을 배출(종류 공개)하고 상대 아이템 1개를 무작위로 파괴 (파괴는 공개, 상대 아이템이 없으면 배출만)
        const shell = this.#chamber.shift();
        const foe = this.#other(p);
        if (!foe.items.length) return { shell };
        const [destroyed] = foe.items.splice(this.#int(0, foe.items.length - 1), 1);
        return { shell, destroyed };
      }
      case ITEM.DRINK:
        return { hp: ++p.hp };
      case ITEM.PICKPOCKET: {
        const slots = this.#stealable(p);
        const [stolen] = this.#other(p).items.splice(slots[this.#int(0, slots.length - 1)], 1);
        return { stolen, ...this.#apply(p, stolen) };
      }
      case ITEM.CONVERT: // 약실 탄 성질 반전. 결과는 아무에게도 알리지 않고 공개 개수를 가린다
        this.#chamber[0] = flip(this.#chamber[0]);
        this.#obscured = true;
        return {};
      default:
        return {};
    }
  }

  // PICKPOCKET으로 훔쳐 즉시 발동 가능한 상대 슬롯 (PICKPOCKET 및 지금 사용 불가한 아이템 제외)
  #stealable(p) {
    return this.#other(p).items.flatMap((it, i) => (it !== ITEM.PICKPOCKET && !this.#blockReason(p, it) ? [i] : []));
  }

  #startRound() {
    for (const p of this.#players) Object.assign(p, { hp: this.#cfg.hp, items: [], drinks: 0 });
    this.#flash = null;
    this.#emit({ type: 'ROUND_START', hp: this.#cfg.hp });
    this.#fillChamber();
    // 새 라운드 선공: 직전 마지막 격발자의 상대 (게임 첫 라운드는 격발 기록이 없으므로 players[0])
    const last = this.#lastShooter;
    this.#beginTurn(last ? this.#other(last) : this.#players[0]);
  }

  /** 새 탄창을 채우고 아이템을 지급한다 (LOAD · DEAL). 턴은 건드리지 않는다 — 누가 이어서 행동하는지는 호출한 쪽이 정한다. */
  #fillChamber() {
    const { shells: [min, max], items } = this.#cfg;
    const total = this.#int(min, max);
    const live = this.#int(Math.max(1, Math.floor(total / 2) - 1), Math.min(total - 1, Math.ceil(total / 2) + 1));
    this.#chamber = this.#shuffle(Array.from({ length: total }, (_, i) => (i < live ? SHELL.LIVE : SHELL.BLANK)));
    this.#obscured = false;
    this.#emit({ type: 'LOAD', live, blank: total - live });
    for (const p of this.#players) this.#emit({ type: 'DEAL', player: p.id, items: this.#deal(p, items) });
  }

  #deal(p, count) {
    const dealt = [];
    for (let n = 0; n < count && p.items.length < MAX_SLOTS; n++) {
      const pool = ITEM_TYPES.filter((it) => p.items.filter((x) => x === it).length < (HOLD_LIMIT[it] ?? MAX_SAME_ITEM)
        && (it !== ITEM.DRINK || p.drinks < MAX_DRINK_DROPS));
      if (!pool.length) break;
      const it = this.#weighted(pool);
      if (it === ITEM.DRINK) p.drinks++;
      p.items.push(it);
      dealt.push(it);
    }
    return Object.freeze(dealt);
  }

  // DROP_WEIGHT 가중치 추첨 (기본 2)
  #weighted(pool) {
    const weight = (it) => DROP_WEIGHT[it] ?? 2;
    let r = this.#int(0, pool.reduce((sum, it) => sum + weight(it), 0) - 1);
    return pool.find((it) => (r -= weight(it)) < 0);
  }

  #beginTurn(p) {
    const c = this.#flash;
    if (c && c.by !== p) {
      if (c.pending) {
        // 섬광탄: 이번 턴 스킵 → 사용자 연속 턴 (상대가 실제 턴을 가질 때까지 섬광탄 재사용 불가)
        c.pending = false;
        this.#emit({ type: 'SKIP', player: p.id });
        p = c.by;
      } else {
        this.#flash = null;
      }
    }
    this.#turn = { player: p, scope: false, double: false, doubleUsed: false, flashUsed: false };
    this.#emit({ type: 'TURN', player: p.id });
  }

  #endRound(winner) {
    winner.wins++;
    this.#emit({ type: 'ROUND_END', winner: winner.id });
    if (winner.wins >= WINS_NEEDED) {
      this.#winner = winner;
      this.#turn = null;
      this.#emit({ type: 'GAME_OVER', winner: winner.id });
    } else {
      this.#round++;
      this.#startRound();
    }
  }

  #emit(entry) {
    this.#log.push(Object.freeze({ seq: this.#log.length, round: this.#round, ...entry }));
    this.#views.push(this.#players.map((p) => this.getPublicState(p.id)));
  }

  // 시점별 로그: 투시경으로 본 탄종(secret)은 사용자에게만
  #view(e, viewerId) {
    if (!e.secret || e.actor === viewerId) return e;
    const { shell: _hidden, ...rest } = e;
    return rest;
  }

  #int(min, max) {
    return min + Math.floor(this.#rng() * (max - min + 1));
  }

  #shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = this.#int(0, i);
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }
}
