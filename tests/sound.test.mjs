// 효과음 설계 검증 (브라우저 없음 · 소리 그래프를 기록하는 가짜 AudioContext): node tests/sound.test.mjs
//   1. 실탄: ① 160→35Hz 0.12초 펀치 ② 1200→180Hz 로 닫히는 노이즈 0.35초 ③ 짧은 잔향 — 전부 지수 감쇠로 0.4초 안에 끝 · 고음 오실레이터 없음
//   2. 공포탄: 0.06초에 끝나는 800~2500Hz 노이즈 클릭 · 오실레이터 없음
//   3. 피격 · 아이템: 총성 뒤에 '띠딩'으로 들리던 경고음 · 귀울림 · 고배음 없음
//   4. 배경음: 드문 먼 소리까지 전부 돌려 봐도 1kHz 이상 오실레이터 없음 (유리잔 '챙' 제거)
//   5. 녹음 재생 코드 제거 (preload · hasRecordedGunshot 없음)
import { SoundEngine } from '../src/ui/soundEngine.js';

const T0 = performance.now();
let pass = 0;
const fails = [];
const ok = (cond, name) => { if (cond) pass += 1; else { fails.push(name); console.log(`  ✗ ${name}`); } };
const near = (got, want, tol, name) => ok(Math.abs(got - want) <= tol, `${name} (got ${got}, want ${want}±${tol})`);

// ───────── 소리 그래프를 기록하는 가짜 Web Audio ─────────
class Param {
  constructor(value = 0) { this.value = value; this.events = []; }
  cancelScheduledValues() {}
  setValueAtTime(v, t) { this.value = v; this.events.push(['set', v, t]); }
  linearRampToValueAtTime(v, t) { this.value = v; this.events.push(['lin', v, t]); }
  exponentialRampToValueAtTime(v, t) { this.value = v; this.events.push(['exp', v, t]); }
  setTargetAtTime(v, t) { this.value = v; this.events.push(['target', v, t]); }
}
class Node {
  constructor(ctx, kind) {
    Object.assign(this, { ctx, kind, started: false, to: null, onended: null, type: '' });
    this.gain = new Param(1);
    this.frequency = new Param(440);
    this.Q = new Param(1);
    this.playbackRate = new Param(1);
    ctx.nodes.push(this);
  }
  connect(to) { this.to = to; return to; }
  disconnect() {}
  start() { this.started = true; }
  stop() {}
}
class FakeAudioContext {
  constructor() { Object.assign(this, { state: 'running', currentTime: 0, sampleRate: 48000, destination: {}, nodes: [] }); }
  createGain() { return new Node(this, 'gain'); }
  createOscillator() { return new Node(this, 'osc'); }
  createBufferSource() { return new Node(this, 'source'); }
  createBiquadFilter() { return new Node(this, 'filter'); }
  createBuffer(_ch, length, rate) { return { duration: length / rate, getChannelData: () => new Float32Array(length) }; }
}

const engine = () => {
  const ctx = new FakeAudioContext();
  return { ctx, sound: new SoundEngine({ context: ctx }) };
};
// 효과음 하나를 재생하고 겹(voice)마다 정리한다: { kind, type, f0, fEnd, glide, filters, peak, end, silentEnd }
function render(play) {
  const { ctx, sound } = engine();
  const before = ctx.nodes.length;
  const returned = play(sound);
  const voices = [];
  for (const src of ctx.nodes.slice(before).filter((n) => (n.kind === 'osc' || n.kind === 'source') && n.started && n.onended)) {
    const filters = [];
    let node = src.to;
    while (node && node.kind === 'filter') { filters.push(node); node = node.to; }
    const env = node?.gain.events ?? [];
    const exps = env.filter((e) => e[0] === 'exp');
    const fe = src.frequency.events;
    voices.push({
      kind: src.kind,
      type: src.type,
      f0: fe[0]?.[1] ?? src.frequency.value,
      fEnd: fe.findLast((e) => e[0] === 'exp')?.[1] ?? null,
      glide: fe.findLast((e) => e[0] === 'exp') ? fe.findLast((e) => e[0] === 'exp')[2] - fe[0][2] : 0,
      filters: filters.map((f) => ({
        type: f.type,
        f0: f.frequency.events[0]?.[1],
        fEnd: f.frequency.events.find((e) => e[0] === 'exp')?.[1] ?? null,
        sweep: f.frequency.events.find((e) => e[0] === 'exp')?.[2] - f.frequency.events[0][2],
      })),
      peak: exps[0]?.[1] ?? 0,
      start: env[0]?.[2] ?? 0,
      end: exps.at(-1)?.[2] ?? 0, // 소리가 −80dB 에 닿는 시각
      endLevel: exps.at(-1)?.[1] ?? 1,
      allExponential: env.length > 0 && env.slice(1).every((e) => e[0] === 'exp'),
    });
  }
  const t0 = Math.min(...voices.map((v) => v.start));
  return { returned, voices, t0, length: Math.max(...voices.map((v) => v.end)) - t0, oscs: voices.filter((v) => v.kind === 'osc'), noises: voices.filter((v) => v.kind === 'source') };
}

// ───────── 1. 실탄 ─────────
{
  const g = render((s) => s.playGunshot());
  ok(g.voices.length >= 3, `1 실탄은 세 겹 이상 (${g.voices.length}겹)`);
  ok(g.returned > 0 && g.returned < 0.4, `1 실탄은 0.4초 안에 끝 — 반환 ${g.returned.toFixed(3)}초`);
  ok(g.length <= 0.37, `1 소리가 −80dB 에 닿는 시각 ${g.length.toFixed(3)}초 ≤ 0.37`);
  ok(g.voices.every((v) => v.allExponential && v.endLevel <= 0.0001), '1 모든 겹이 지수 감쇠(exponentialRamp)로 무음까지');
  ok(g.oscs.every((v) => ['sine', 'triangle'].includes(v.type)), '1 오실레이터는 사인 · 트라이앵글뿐 (톱니 · 사각 없음)');
  ok(g.oscs.every((v) => v.f0 <= 160), `1 오실레이터 최고 음정 ${Math.max(...g.oscs.map((v) => v.f0))}Hz ≤ 160 (고음 '띠딩' 없음)`);
  const punch = g.oscs.find((v) => v.type === 'sine');
  ok(punch && punch.f0 === 160 && punch.fEnd === 35, '1 ① 사인 펀치 160Hz → 35Hz');
  near(punch?.glide ?? 0, 0.12, 0.0005, '1 ① 펀치가 0.12초에 급강하');
  ok(g.oscs.every((v) => v.fEnd === 35), '1 ① 트라이앵글도 같은 35Hz 로 떨어진다');
  const burst = g.noises.find((v) => v.filters[0]?.type === 'lowpass' && v.filters[0].f0 === 1200);
  ok(burst && burst.filters[0].fEnd === 180, '1 ② 노이즈 폭음: 로우패스 1200Hz → 180Hz');
  ok(burst && burst.filters[0].sweep <= 0.3, `1 ② 필터가 빠르게 닫힌다 (${burst?.filters[0].sweep.toFixed(3)}초)`);
  near((burst?.end ?? 0) - g.t0, 0.35, 0.002, '1 ② 폭음 버스트 길이 0.35초');
  const tail = g.noises.filter((v) => v.start - g.t0 > 0.02);
  ok(tail.length >= 1 && tail.every((v) => v.end - g.t0 <= 0.37), '1 ③ 잔향 꼬리가 0.4초 안에 끝');
  ok(tail.every((v) => v.filters.every((f) => (f.type === 'lowpass' ? f.f0 <= 800 : f.f0 <= 500))), '1 ③ 잔향은 어둡고 낮은 소리 (고음 반사음 없음)');
  ok(g.noises.every((v) => v.filters.every((f) => f.f0 <= 1500)), '1 노이즈 필터 중심 1500Hz 이하 (귀를 찌르는 고역 없음)');
  const sum = g.voices.reduce((a, v) => a + v.peak, 0);
  ok(sum <= 2.2, `1 겹들의 최대 합 ${sum.toFixed(2)} (한꺼번에 터져도 마스터에서 찌그러지지 않는 수준)`);
}

// ───────── 2. 공포탄 ─────────
{
  const c = render((s) => s.playClick());
  ok(c.oscs.length === 0, '2 공포탄에는 오실레이터가 없다 (음정 있는 울림 없음)');
  ok(c.noises.length >= 2, `2 노이즈 '딸' + 금속 틱 '깍' (${c.noises.length}겹)`);
  ok(c.length <= 0.0615 && c.length >= 0.055, `2 소리 길이 ${c.length.toFixed(4)}초 ≈ 0.06`);
  const band = c.noises[0].filters;
  ok(band.some((f) => f.type === 'highpass' && f.f0 === 800) && band.some((f) => f.type === 'lowpass' && f.f0 === 2500), '2 딸: 800~2500Hz 로 깎은 노이즈');
  ok(c.noises.every((v) => v.filters.every((f) => f.f0 >= 800 && f.f0 <= 2500)), '2 모든 필터가 800~2500Hz 안');
  ok(c.voices.every((v) => v.allExponential && v.endLevel <= 0.0001), '2 모든 겹이 지수 감쇠로 깔끔하게 끝');
  const gun = render((s) => s.playGunshot());
  ok(c.length < gun.length / 4, '2 실탄보다 훨씬 짧다 — 확실히 구분');
}

// ───────── 3. 피격 · 아이템 · 그 밖 ─────────
{
  const d = render((s) => s.playDamage());
  ok(d.oscs.every((v) => v.type === 'sine' && v.f0 <= 200), `3 피격음 오실레이터는 저음 사인뿐 (${d.oscs.map((v) => `${v.type}${v.f0}Hz`).join(',')}) — 경고음 · 귀울림 없음`);
  ok(d.voices.length === 2, `3 피격음은 둔탁한 '퍽' 두 겹 (${d.voices.length}겹)`);
  ok(d.length <= 0.3, `3 피격음이 0.3초 안에 끝 (${d.length.toFixed(3)}초)`);
  ok(d.voices.every((v) => v.allExponential && v.endLevel <= 0.0001), '3 피격음도 지수 감쇠로 뚝 끝');

  const it = render((s) => s.playItem());
  ok(it.oscs.every((v) => v.f0 <= 1300), `3 아이템 소리 오실레이터 최고 ${Math.max(...it.oscs.map((v) => v.f0)).toFixed(0)}Hz ≤ 1300 (고배음 '띠링' 없음)`);
  ok(it.length <= 0.3, `3 아이템 소리가 0.3초 안에 끝 (${it.length.toFixed(3)}초)`);

  const rl = render((s) => s.playReload());
  ok(rl.returned > 0 && rl.oscs.every((v) => v.type !== 'sawtooth'), '3 장전 소리: 톱니파 없음');
  ok(rl.oscs.filter((v) => v.f0 > 1000).every((v) => v.end - v.start <= 0.06), '3 장전 \'철컥\'의 고음 금속 울림은 0.06초 이하 (길게 울리는 \'띠링\' 없음)');
  const hb = render((s) => s.playHeartbeat());
  ok(hb.returned > 0 && hb.oscs.every((v) => v.f0 <= 200), '3 심장박동은 저음뿐');
}

// ───────── 4. 배경음 — 드문 먼 소리를 잔뜩 예약해서 전부 확인 ─────────
{
  const { ctx, sound } = engine();
  const realRandom = Math.random;
  let seed = 7;
  Math.random = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; }; // 매번 같은 순서 → 세 종류가 모두 나온다
  try {
    sound.startAmbient({ preschedule: 6000 }); // 9~25초 간격 → 300개 안팎
  } finally {
    Math.random = realRandom;
  }
  sound.stopAmbient({ fade: 0.05 });
  const oscs = ctx.nodes.filter((n) => n.kind === 'osc');
  const freqs = oscs.flatMap((o) => [o.frequency.value, ...o.frequency.events.map((e) => e[1])]);
  ok(oscs.length > 100, `4 배경음 오실레이터 ${oscs.length}개 점검 (먼 소리 수백 개 포함)`);
  ok(Math.max(...freqs) < 1000, `4 배경음 오실레이터 최고 ${Math.max(...freqs).toFixed(0)}Hz < 1000 — 유리잔 '챙' · 차임 없음`);
}

// ───────── 5. 녹음 재생 코드 제거 ─────────
{
  const { sound } = engine();
  ok(!('preload' in sound) && !('hasRecordedGunshot' in sound), '5 총성 녹음 불러오기 코드가 없다 (총성은 항상 합성)');
}

console.log(`\nsound.test.mjs ${pass} 통과 · ${fails.length} 실패 (${(performance.now() - T0).toFixed(0)}ms)`);
if (fails.length) process.exit(1);
