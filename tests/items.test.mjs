// 아이템 7종 검증 (브라우저 없음): node tests/items.test.mjs
//   1. 엔진 ID · 화면 이름 · 도감 이름이 새 느와르 콘셉트(투시경 · 더블샷 · 섬광탄 · 탄제거 · 위스키 한잔 · 소매치기 · 탄종변환)와 맞는가
//   2. 시드 고정 무작위 대전 수백 판: 아이템마다 효과가 그대로인가 (비공개 정보 · 피해 2배 · 턴 스킵 · 배출+파괴 · 회복 · 강탈 · 탄종 가림)
//   3. AI 딜러끼리 대전: 엔진이 거절하는 행동 없이 끝까지 가는가
//   4. 게임 소스(화면 · 스타일 · 클라이언트 · 서버) 어디에도 예전 아이템 이름이 남지 않았는가
import { readFileSync, readdirSync } from 'node:fs';
import { GameEngine, ITEM, SHELL } from '../src/engine/gameEngine.js';
import { AIDealer } from '../src/engine/aiDealer.js';

const T0 = performance.now();
let pass = 0;
const fails = [];
const ok = (cond, name) => { if (cond) pass += 1; else { fails.push(name); console.log(`  ✗ ${name}`); } };
const eq = (got, want, name) => ok(JSON.stringify(got) === JSON.stringify(want), `${name} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`);
const ROOT = new URL('../', import.meta.url);
const read = (path) => readFileSync(new URL(path, ROOT), 'utf8');

function seeded(seed) { // mulberry32 — 같은 시드면 같은 판
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const NAMES = {
  SCOPE: '투시경', DOUBLE: '더블샷', FLASH: '섬광탄', EJECT: '탄제거', DRINK: '위스키 한잔', PICKPOCKET: '소매치기', CONVERT: '탄종변환',
};

// ───────── 1. 이름 ─────────
{
  eq(Object.keys(ITEM), Object.keys(NAMES), '1 엔진 아이템 ID 7종');
  ok(Object.entries(ITEM).every(([k, v]) => k === v), '1 ID 값 = 키 (서버 ↔ 클라이언트 그대로 주고받는 값)');
  const app = read('src/ui/app.js');
  for (const [id, name] of Object.entries(NAMES)) {
    ok(app.includes(`[ITEM.${id}]: { name: '${name}',`), `1 화면 이름 ${id} → ${name}`);
  }
  const html = read('index.html');
  const codex = [...html.matchAll(/<h3>([^<]+)<small>/g)].map((m) => m[1]);
  eq(codex, Object.values(NAMES), '1 도감 7종 이름 · 순서');
  const icons = [...app.matchAll(/icon: '(i-[a-z]+)', desc/g)].map((m) => m[1]);
  ok(icons.length === 7 && icons.every((id) => html.includes(`<symbol id="${id}"`)), `1 아이템 아이콘 7종이 스프라이트에 있다 (${icons.join(' ')})`);
}

// ───────── 2. 무작위 대전으로 효과 확인 ─────────
{
  const BLOCK_CODES = new Set(['SCOPE_USED', 'DOUBLE_ACTIVE', 'DOUBLE_FLASH_CONFLICT', 'DOUBLE_SCOPE_CONFLICT', 'FLASH_LOCKED', 'HP_FULL', 'NOTHING_TO_STEAL']);
  const used = Object.fromEntries(Object.keys(ITEM).map((k) => [k, 0]));
  const bad = [];
  const blocked = new Set();
  let doubleHits = 0;
  let skips = 0;
  let finished = 0;
  const GAMES = 400;
  for (let g = 0; g < GAMES; g++) {
    const game = new GameEngine({ players: ['A', 'B'], rng: seeded(g + 1) });
    const choose = seeded(90_000 + g);
    const other = (id) => (id === 'A' ? 'B' : 'A');
    let doubled = null; // 더블샷을 건 사람
    let flashTarget = null; // 섬광탄을 맞은 사람
    let seen = game.getLog('A').length;
    for (let step = 0; step < 600 && !game.getPublicState('A').winner; step++) {
      const me = game.getPublicState('A').turn.player;
      const foe = other(me);
      const before = game.getPublicState(me);
      const foeItems = [...before.opponent.items];
      const tryItem = before.me.items.length && choose() < 0.6;
      if (tryItem) {
        const idx = Math.floor(choose() * before.me.items.length);
        const item = before.me.items[idx];
        const from = game.getLog(foe).length;
        const r = game.useItem(me, idx);
        if (!r.ok) { blocked.add(r.error); continue; }
        used[item] += 1;
        const after = game.getPublicState(me);
        const foeSaw = game.getLog(foe, from).find((e) => e.type === 'ITEM');
        const reloaded = game.getLog(foe, from).some((e) => e.type === 'LOAD'); // 마지막 탄을 빼면 재장전 → 양쪽에 새 아이템 지급
        switch (item) {
          case ITEM.SCOPE:
            if (!(r.secret && (r.shell === SHELL.LIVE || r.shell === SHELL.BLANK) && !('shell' in foeSaw))) bad.push(`SCOPE g${g}`);
            break;
          case ITEM.DOUBLE:
            if (!after.turn.doubleActive) bad.push(`DOUBLE g${g}`);
            doubled = me;
            break;
          case ITEM.FLASH:
            if (after.turn.stunned !== foe || !after.turn.flashLocked) bad.push(`FLASH g${g}`);
            flashTarget = foe;
            break;
          case ITEM.EJECT: {
            const totalOk = reloaded ? before.total === 1 : after.total === before.total - 1;
            const destroyOk = foeItems.length
              ? foeItems.includes(r.destroyed) && (reloaded || after.opponent.items.length === foeItems.length - 1)
              : r.destroyed === undefined;
            if (!(r.shell && totalOk && destroyOk)) bad.push(`EJECT g${g}`);
            break;
          }
          case ITEM.DRINK:
            if (r.hp !== before.me.hp + 1) bad.push(`DRINK g${g}`);
            break;
          case ITEM.PICKPOCKET:
            if (!(foeItems.includes(r.stolen) && r.stolen !== ITEM.PICKPOCKET && (reloaded || after.opponent.items.length < foeItems.length))) bad.push(`PICKPOCKET g${g}`);
            if (r.stolen === ITEM.DOUBLE) doubled = me;
            if (r.stolen === ITEM.FLASH) flashTarget = foe;
            break;
          case ITEM.CONVERT:
            if (!(after.live === null && after.obscured && after.total === before.total)) bad.push(`CONVERT g${g}`);
            break;
          default:
            bad.push(`unknown ${item}`);
        }
      } else {
        const r = game.shoot(me, choose() < 0.5 ? 'self' : 'opponent');
        if (!r.ok) { bad.push(`shoot ${r.error} g${g}`); break; }
        if (doubled === me && r.shell === SHELL.LIVE) { doubleHits += 1; if (r.damage !== 2) bad.push(`DOUBLE damage g${g}`); }
        if (doubled === me) doubled = null; // 쏘고 나면(공포탄이어도) 사라진다
      }
      for (const e of game.getLog('A', seen)) {
        if (e.type === 'SKIP') { skips += 1; if (e.player !== flashTarget) bad.push(`SKIP player g${g}`); }
        if (e.type === 'ROUND_START') { doubled = null; flashTarget = null; }
        for (const k of ['item', 'stolen', 'destroyed']) if (e[k] !== undefined && !(e[k] in ITEM)) bad.push(`event ${k}=${e[k]}`);
      }
      seen = game.getLog('A').length;
    }
    if (game.getPublicState('A').winner) finished += 1;
  }
  eq(bad.slice(0, 5), [], '2 효과 위반 없음');
  ok(Object.values(used).every((n) => n > 20), `2 7종 모두 충분히 사용됨 ${JSON.stringify(used)}`);
  ok(doubleHits > 0 && skips > 0, `2 더블샷 실탄 ${doubleHits}회 · 섬광탄 스킵 ${skips}회 관찰`);
  ok([...blocked].every((code) => BLOCK_CODES.has(code)), `2 사용 불가 코드는 새 이름만 (${[...blocked].join(' ')})`);
  eq(finished, GAMES, '2 모든 판이 끝까지 진행');
}

// ───────── 3. AI 딜러끼리 ─────────
{
  let refused = 0;
  let finished = 0;
  const GAMES = 300;
  for (let g = 0; g < GAMES; g++) {
    const game = new GameEngine({ players: ['A', 'B'], rng: seeded(500_000 + g) });
    const side = { A: { ai: new AIDealer('A'), memory: {}, since: 0 }, B: { ai: new AIDealer('B'), memory: {}, since: 0 } };
    for (let step = 0; step < 800 && !game.getPublicState('A').winner; step++) {
      const id = game.getPublicState('A').turn.player;
      const p = side[id];
      p.ai.observe(game.getLog(id, p.since), p.memory);
      p.since = game.getLog(id).length;
      const action = p.ai.decideNextAction(game.getPublicState(id), p.memory);
      const r = action.type === 'item' ? game.useItem(id, action.slotIndex) : game.shoot(id, action.target);
      if (!r.ok) { refused += 1; game.shoot(id, 'opponent'); }
    }
    if (game.getPublicState('A').winner) finished += 1;
  }
  eq(refused, 0, '3 AI 딜러 행동을 엔진이 거절한 횟수');
  eq(finished, GAMES, '3 AI 대전 모두 끝까지 진행');
}

// ───────── 4. 예전 이름이 남지 않았는가 ─────────
{
  const files = ['index.html', 'style.css', 'manifest.webmanifest'];
  for (const dir of ['src', 'server']) {
    for (const f of readdirSync(new URL(`${dir}/`, ROOT), { recursive: true })) {
      const path = `${dir}/${String(f).replaceAll('\\', '/')}`;
      if (/\.(js|mjs|css|html)$/.test(path) && !path.startsWith('server/data/')) files.push(path);
    }
  }
  const LEGACY = [
    /\b(LOUPE|SAW|CUFFS|WHISKEY|CIGAR|MAGNET|INVERTER)\b/, // 예전 엔진 ID
    /i-(loupe|saw|cuffs|whiskey|magnet|inverter)\b/, // 예전 아이콘
    /\b(loupe\w*|is-sawed|sawed|is-cuffed|badge-cuffed|cuffed|cuffs\w*|saw(Active|Used|Ready)|inverter|whiskeyPour|magnet)\b/i, // 예전 클래스 · 필드
    /돋보기|쇠톱|수갑|자석|변환기|인버터|맥주|아드레날린|벅샷/, // 예전 한국어 이름
    /위스키(?! 한잔)/, // '위스키'는 이제 '위스키 한잔'(회복)만
    /buckshot|handsaw|handcuff|magnifying|adrenaline|burner phone/i,
  ];
  const hits = [];
  for (const path of files) {
    read(path).split('\n').forEach((line, i) => {
      if (LEGACY.some((re) => re.test(line))) hits.push(`${path}:${i + 1}`);
    });
  }
  ok(files.length > 15, `4 검사한 파일 ${files.length}개`);
  eq(hits, [], '4 예전 아이템 이름이 남은 줄');
}

const ms = Math.round(performance.now() - T0);
console.log(fails.length === 0 ? `PASS  ${pass} checks, 0 failed — ${ms} ms` : `FAIL  ${pass} passed, ${fails.length} failed — ${ms} ms`);
process.exitCode = fails.length === 0 ? 0 : 1;
