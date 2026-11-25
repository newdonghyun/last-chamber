// 효과음 설계 검증 (브라우저 없음 · 소리 그래프를 기록하는 가짜 AudioContext): node tests/sound.test.mjs
//   1. 실탄(스마트폰 스피커용): ① 0~0.03초 2200→400Hz 뇌관 파열음 ② 280→65Hz 0.18초 사각 · 삼각파 + WaveShaper 포화 ③ 2500→350Hz 로우패스 노이즈 0.45초(2배 출력)
//      — 총성 전용 체인(증폭 → DynamicsCompressor → 소프트클립 → 마스터) · 전부 지수 감쇠로 0.45초 안에 끝 · 2.2kHz 소리는 0.03초뿐
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
    for (const name of ['threshold', 'knee', 'ratio', 'attack', 'release']) this[name] = new Param(0); // DynamicsCompressorNode
    this.curve = null; // WaveShaperNode
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
  createWaveShaper() { return new Node(this, 'shaper'); }
  createDynamicsCompressor() { return new Node(this, 'compressor'); }
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
    let shaped = false;
    while (node && (node.kind === 'filter' || node.kind === 'shaper')) { if (node.kind === 'filter') filters.push(node); else shaped = true; node = node.to; }
    const route = []; // 엔벌로프 뒤 경로: 노드 종류들 (마지막은 destination)
    for (let n = node?.to; n; n = n.to) route.push(n.kind);
    const out = node?.to ?? null; // 엔벌로프 다음 노드
    const env = node?.gain.events ?? [];
    const exps = env.filter((e) => e[0] === 'exp');
    const fe = src.frequency.events;
    voices.push({
      kind: src.kind,
      type: src.type,
      shaped,
      route,
      out,
      comp: (() => { for (let n = out; n; n = n.to) if (n.kind === 'compressor') return { threshold: n.threshold.value, ratio: n.ratio.value, knee: n.knee.value, attack: n.attack.value }; return null; })(),
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
  ok(g.voices.length === 4, `1 세 겹 = 뇌관 1 + 바디 2(사각 · 삼각) + 노이즈 1 (${g.voices.length}개 소리)`);
  ok(g.returned > 0 && g.returned <= 0.5, `1 실탄 전체가 0.45초 안에 끝 — 반환 ${g.returned.toFixed(3)}초`);
  ok(g.length <= 0.4511, `1 소리가 −80dB 에 닿는 시각 ${g.length.toFixed(4)}초 ≤ 0.451`);
  ok(g.voices.every((v) => v.allExponential && v.endLevel <= 0.0001), '1 모든 겹이 지수 감쇠(exponentialRamp)로 무음까지 — 뒤에 꼬리가 남지 않는다');
  ok(g.oscs.every((v) => ['triangle', 'square'].includes(v.type)), '1 오실레이터는 삼각 · 사각파뿐 (사인 알림음 · 톱니 없음)');

  // ① 뇌관 파열음
  const snap = g.oscs.find((v) => v.f0 === 2200);
  ok(snap && snap.fEnd === 400 && snap.type === 'triangle', '1 ① 뇌관 파열음 2200Hz → 400Hz');
  near(snap?.glide ?? 0, 0.03, 0.0001, '1 ① 급강하 0.03초');
  ok(snap && snap.end - snap.start <= 0.0306, `1 ① 뇌관 파열음은 0~0.03초 구간에서 끝 (${((snap?.end ?? 0) - (snap?.start ?? 0)).toFixed(4)}초)`);
  ok(g.oscs.filter((v) => v.f0 > 400).length === 1, '1 400Hz 넘는 오실레이터는 뇌관 파열음 하나뿐 (고음 띠딩 없음)');

  // ② 중저음 바디
  const body = g.oscs.filter((v) => v.f0 === 280);
  ok(body.length === 2 && body.some((v) => v.type === 'square') && body.some((v) => v.type === 'triangle'), '1 ② 바디: 280Hz 사각파 + 삼각파');
  ok(body.every((v) => v.fEnd === 65), '1 ② 바디가 65Hz 까지 떨어진다');
  ok(body.every((v) => Math.abs(v.glide - 0.18) < 0.0001), '1 ② 바디가 0.18초 동안 떨어진다');
  ok(body.every((v) => v.shaped), '1 ② 바디는 WaveShaper(포화)를 통과 — 배음 증폭');
  ok(body.every((v) => v.end - v.start <= 0.2311), `1 ② 바디도 0.23초 안에 끝 (${Math.max(...body.map((v) => v.end - v.start)).toFixed(3)}초)`);

  // ③ 화약 폭발 노이즈
  const burst = g.noises[0];
  ok(g.noises.length === 1 && burst.filters[0]?.type === 'lowpass' && burst.filters[0].f0 === 2500 && burst.filters[0].fEnd === 350, '1 ③ 화이트 노이즈: 로우패스 2500Hz → 350Hz');
  near(burst?.filters[0].sweep ?? 0, 0.45, 0.0001, '1 ③ 필터가 0.45초 동안 닫힌다');
  near((burst?.end ?? 0) - g.t0, 0.45, 0.001, '1 ③ 폭발 노이즈 길이 0.45초');
  ok(burst.peak >= 1.1, `1 ③ 노이즈 출력 ${burst.peak} ≥ 1.1 (기존 0.55 의 2배 이상)`);

  // 총성 전용 체인: 증폭 버스(gain) → 컴프레서 → 소프트클립(shaper) → 마스터(gain) → 출력(destination)
  ok(g.voices.every((v) => JSON.stringify(v.route) === JSON.stringify(['gain', 'compressor', 'shaper', 'gain', null])), `1 모든 겹이 총성 체인을 지난다: 증폭 버스 → 컴프레서 → 소프트클립 → 마스터 (경로 ${JSON.stringify(g.voices[0].route)})`);
  ok(g.voices.every((v) => v.out.kind === 'gain' && v.out.gain.value > 1), '1 총성 버스는 1 보다 크게 증폭');
  ok(g.voices.every((v) => v.comp && v.comp.ratio >= 4 && v.comp.threshold <= -6), `1 DynamicsCompressor 가 피크를 누른다 (threshold ${g.voices[0].comp?.threshold}dB · ratio ${g.voices[0].comp?.ratio})`);
}
{
  // 소프트클립 곡선: 어떤 입력에도 ±1 을 넘지 않고, 0 은 0, 단조 증가 — 컴프레서가 놓친 피크의 마지막 방어선
  const { ctx } = engine();
  const clip = ctx.nodes.find((n) => n.kind === 'shaper');
  const c = clip?.curve;
  ok(c instanceof Float32Array && c.length >= 256, '1 소프트클립 곡선이 설정돼 있다');
  ok(c && Math.max(...c) <= 1 && Math.min(...c) >= -1, '1 소프트클립 출력은 ±1 을 넘지 않는다');
  ok(c && Math.abs(c[0] + 1) < 1e-6 && Math.abs(c.at(-1) - 1) < 1e-6, '1 소프트클립 양 끝은 ±1 (큰 입력도 ±1 로)');
  ok(c && c.every((v, i) => i === 0 || v >= c[i - 1]), '1 소프트클립은 단조 증가 (소리가 뒤집히지 않는다)');
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
  ok(c.voices.every((v) => JSON.stringify(v.route) === JSON.stringify(['gain', null])), '2 공포탄은 총성 체인(컴프레서)을 타지 않는다 — 날카로운 클릭이 눌리지 않게');
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
