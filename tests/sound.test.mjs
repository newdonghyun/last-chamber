// 효과음 설계 검증 (브라우저 없음 · 소리 그래프를 기록하는 가짜 AudioContext): node tests/sound.test.mjs
//   1. 실탄(좁은 방의 대구경 리볼버): ① 0~15ms 2~5kHz 해머 · 뇌관 클릭 ② 0~80ms 400→45Hz 급강하 + 포화 노이즈 폭발 ③ 0~180ms 110→50Hz 저음 펀치
//      ④ 50~650ms 방 울림(ConvolverNode + 어두운 로우패스) — 직접음은 지수 감쇠 · 총성 전용 체인(증폭 → DynamicsCompressor → 소프트클립 → 마스터) · '띠딩' 없음
//      더블샷: 저음 · 폭발 · 잔향 증폭 + 더 낮은 한 겹
//   2. 공포탄: 빈 쇳소리 '찰칵' + 공기 빠지는 소리 (음정 · 저음 · 잔향 · 압축 없음 — 실탄과 극명한 대비) · 화면 조작 클릭은 0.06초
//   3. 피격 · 아이템: 총성 뒤에 '띠딩'으로 들리던 경고음 · 귀울림 · 고배음 없음
//   4. 배경음: 드문 먼 소리까지 전부 돌려 봐도 1kHz 이상 오실레이터 없음 (유리잔 '챙' 제거)
//   5. 실탄 녹음(public/sounds/live-shot.mp3): 실탄에만 · 앞 무음 건너뛰기 · 크기 맞춤 · 마스터로 직접 · 실패하면 합성음
import { readFileSync } from 'node:fs';
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
    this.buffer = null; // BufferSource · ConvolverNode
    this.normalize = true;
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
  createConvolver() { return new Node(this, 'convolver'); }
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
const dryRoute = JSON.stringify(['gain', 'compressor', 'shaper', 'gain', null]);
const roomRoute = JSON.stringify(['convolver', 'filter', 'gain', 'gain', 'compressor', 'shaper', 'gain', null]);
const span = (v) => v.end - v.start;
const isRoom = (v) => v.route[0] === 'convolver';
const gunshot = render((s) => s.playGunshot());
{
  const g = gunshot;
  const dry = g.voices.filter((v) => !isRoom(v));
  ok(g.voices.length === 10, `1 네 겹 = 클릭 2 + 폭발 5 + 저음 2 + 방 울림 1 (${g.voices.length}개 소리)`);
  ok(g.returned >= 0.65 && g.returned <= 0.75, `1 잔향까지 0.65초 남짓 — 반환 ${g.returned.toFixed(3)}초`);
  ok(dry.every((v) => v.end - g.t0 <= 0.1801), `1 직접음은 0.18초 안에 끝 (${Math.max(...dry.map((v) => v.end - g.t0)).toFixed(4)}초)`);
  ok(g.voices.every((v) => v.allExponential && v.endLevel <= 0.0001), '1 모든 겹이 지수 감쇠(exponentialRamp)로 무음까지');
  ok(g.oscs.every((v) => ['sine', 'triangle', 'square'].includes(v.type)) && g.oscs.filter((v) => v.type === 'sine').every((v) => v.f0 <= 120), '1 사인파는 저음 펀치에만 (사인 알림음 · 톱니 없음)');

  // ① 해머 · 뇌관 타격 0~15ms
  const click = g.voices.filter((v) => span(v) <= 0.0151);
  ok(click.length === 2, `1 ① 0~15ms 에 끝나는 타격음 두 겹 (${click.length})`);
  ok(click.some((v) => v.kind === 'source' && v.filters.some((f) => f.type === 'highpass' && f.f0 >= 2000) && v.filters.some((f) => f.type === 'lowpass' && f.f0 <= 5000)), '1 ① 2~5kHz 로 깎은 노이즈 클릭');
  ok(click.some((v) => v.kind === 'osc' && v.f0 === 4800 && v.fEnd === 2100 && v.filters[0]?.type === 'bandpass' && v.filters[0].f0 >= 2000), '1 ① 금속 트랜지언트 4.8k → 2.1kHz');
  ok(g.oscs.filter((v) => v.f0 > 1000).every((v) => span(v) <= 0.0151), '1 ① 1kHz 넘는 오실레이터는 15ms 안에만 (고음 띠딩 없음)');

  // ② 화약 폭발 0~80ms
  const drop = g.oscs.find((v) => v.f0 === 400);
  ok(drop && drop.fEnd === 45 && drop.shaped, '1 ② 400Hz → 45Hz 급강하를 WaveShaper 로 포화');
  near(drop?.glide ?? 0, 0.07, 0.0001, '1 ② 급강하 0.07초');
  ok(drop && span(drop) <= 0.0801, '1 ② 폭발 피치 드롭은 0.08초 안');
  const burst = g.noises.find((v) => v.shaped && v.filters.some((f) => f.type === 'lowpass' && f.f0 === 7500));
  ok(burst && span(burst) <= 0.0801 && burst.filters.some((f) => f.type === 'lowpass' && f.fEnd === 1100), '1 ② 포화시킨 노이즈 버스트 0~80ms (7.5k → 1.1kHz)');
  ok(g.noises.filter((v) => v.shaped).length >= 3, '1 ② 노이즈 포화(디스토션) 겹: 버스트 · 중음 크랙 · 몸통');

  // ③ 저음 펀치 0~180ms
  const punch = g.oscs.find((v) => v.type === 'sine');
  ok(punch && punch.f0 === 110 && punch.fEnd === 50 && span(punch) <= 0.1801 && span(punch) >= 0.15, `1 ③ 서브 베이스 110 → 50Hz, 0.18초 (${punch ? span(punch).toFixed(3) : '-'})`);
  ok(g.oscs.some((v) => v.f0 === 165 && v.fEnd === 60 && v.shaped), '1 ③ 작은 스피커용 배음 (포화)');
  ok(punch.peak >= 0.8, `1 ③ 저음 펀치 출력 ${punch.peak} ≥ 0.8`);

  // ④ 방 울림 50~650ms
  const room = g.voices.filter(isRoom);
  ok(room.length === 1 && JSON.stringify(room[0].route) === roomRoute, `1 ④ 폭발음 하나를 방 울림으로 (경로 ${JSON.stringify(room[0]?.route)})`);
  const conv = room[0]?.out;
  near(conv?.buffer?.duration ?? 0, 0.65, 0.001, '1 ④ 임펄스 응답 0.65초');
  ok(conv?.normalize === false && conv.to?.type === 'lowpass' && conv.to.frequency.value <= 1600, '1 ④ 잔향은 어둡게 깎는다 (로우패스 ≤ 1.6kHz)');

  // 총성 전용 체인
  ok(dry.every((v) => JSON.stringify(v.route) === dryRoute), `1 직접음은 증폭 버스 → 컴프레서 → 소프트클립 → 마스터 (경로 ${JSON.stringify(dry[0].route)})`);
  ok(dry.every((v) => v.out.kind === 'gain' && v.out.gain.value > 1), '1 총성 버스는 1 보다 크게 증폭');
  ok(g.voices.every((v) => v.comp && v.comp.ratio >= 4 && v.comp.threshold <= -6 && v.comp.attack <= 0.002), `1 DynamicsCompressor 가 피크를 누른다 (threshold ${g.voices[0].comp?.threshold}dB · ratio ${g.voices[0].comp?.ratio})`);
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


// ───────── 1-1. 더블샷: 저음 · 폭발 · 잔향이 한 단계 더 ─────────
{
  const d = render((s) => s.playGunshot({ double: true }));
  const pick = (r, test) => r.voices.find(test);
  const sub = (r) => pick(r, (v) => v.kind === 'osc' && v.f0 === 110);
  const boom = (r) => pick(r, (v) => v.kind === 'source' && v.filters.some((f) => f.type === 'lowpass' && f.f0 === 7500));
  const send = (r) => pick(r, isRoom);
  ok(d.voices.length === gunshot.voices.length + 1, '1-1 더블샷은 더 낮은 저음 한 겹이 추가');
  ok(d.oscs.some((v) => v.f0 < 80 && v.fEnd <= 40), "1-1 추가 겹: 78 → 36Hz '쿵'");
  ok(sub(d).peak >= sub(gunshot).peak * 1.3 && span(sub(d)) > span(sub(gunshot)) * 1.3, '1-1 저음 펀치가 더 크고 길다');
  ok(boom(d).peak >= boom(gunshot).peak * 1.3, '1-1 폭발 파열음이 더 크다');
  ok(send(d).peak >= send(gunshot).peak * 1.3, '1-1 잔향도 더 크다');
  ok(d.voices.every((v) => v.comp), '1-1 키운 만큼 같은 컴프레서 · 소프트클립을 지난다 (넘치지 않게)');
}

// ───────── 1-2. 화면을 떠나면 방 안에 남은 꼬리도 버린다 ─────────
{
  const { ctx, sound } = engine();
  const rooms = () => ctx.nodes.filter((n) => n.kind === 'convolver').length;
  const before = rooms();
  sound.playGunshot();
  await sound.suspend();
  ok(before === 1 && rooms() === 2, `1-2 suspend 하면 울림 노드를 갈아 끼운다 (${before} → ${rooms()})`);
  await sound.resume();
  await sound.suspend();
  ok(rooms() === 2, '1-2 울린 것이 없으면 다시 만들지 않는다');
}

// ───────── 2. 공포탄 · 화면 클릭 ─────────
{
  const b = render((s) => s.playBlank());
  ok(b.oscs.length === 0, '2 공포탄에는 오실레이터가 없다 (음정 있는 울림 없음)');
  ok(b.noises.length === 3, `2 '찰' · '칵' · 공기 빠지는 '푸슉' (${b.noises.length}겹)`);
  ok(b.length <= 0.14 && b.length >= 0.1 && b.returned < 0.2, `2 짧다 (${b.length.toFixed(3)}초)`);
  ok(b.noises.every((v) => v.filters.every((f) => f.f0 >= 1000)), '2 저음이 없는 가벼운 쇳소리');
  ok(b.voices.every((v) => JSON.stringify(v.route) === JSON.stringify(['gain', null])), '2 증폭 · 압축 · 잔향 없음 (실탄 체인을 타지 않는다)');
  ok(b.returned < gunshot.returned / 3, '2 실탄보다 훨씬 짧다 — 확실히 구분');
  const loudest = (r) => r.voices.reduce((sum, v) => sum + v.peak * (v.out?.gain.value ?? 1), 0);
  ok(loudest(gunshot) > loudest(b) * 4, `2 실탄의 총 출력이 공포탄의 4배 이상 (${loudest(gunshot).toFixed(1)} vs ${loudest(b).toFixed(1)})`);
  ok(b.voices.every((v) => v.allExponential && v.endLevel <= 0.0001), '2 모든 겹이 지수 감쇠로 깔끔하게 끝');

  const c = render((s) => s.playClick());
  ok(c.oscs.length === 0 && c.length <= 0.0615 && c.length >= 0.055, `2 화면 클릭은 음정 없이 0.06초 (${c.length.toFixed(4)})`);
  const band = c.noises[0].filters;
  ok(band.some((f) => f.type === 'highpass' && f.f0 === 800) && band.some((f) => f.type === 'lowpass' && f.f0 === 2500), '2 클릭: 800~2500Hz 로 깎은 노이즈');
  ok(c.voices.every((v) => JSON.stringify(v.route) === JSON.stringify(['gain', null])), '2 클릭은 총성 체인을 타지 않는다');
  const locked = engine();
  locked.sound.setInGame(false);
  ok(locked.sound.playBlank() === 0 && locked.sound.playGunshot({ double: true }) === 0, '2 판 밖에서는 실탄 · 공포탄 소리가 나지 않는다');
}

// ───────── 3. 피격 · 아이템 · 그 밖 ─────────
{
  const d = render((s) => s.playDamage());
  ok(d.oscs.every((v) => v.type === 'sine' && v.f0 <= 200), `3 피격음 오실레이터는 저음 사인뿐 (${d.oscs.map((v) => `${v.type}${v.f0}Hz`).join(',')}) — 경고음 · 귀울림 없음`);
  ok(d.voices.length === 2, `3 피격음은 둔탁한 '퍽' 두 겹 (${d.voices.length}겹)`);
  ok(d.voices.every((v) => v.comp), '3 피격음도 총성 체인을 지난다 — 총성과 겹쳐도 넘치지 않게');
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

// ───────── 5. 실탄 녹음 ─────────
{
  const file = readFileSync(new URL('../public/sounds/live-shot.mp3', import.meta.url));
  ok(file.length > 10_000 && (file.subarray(0, 3).toString() === 'ID3' || (file[0] === 0xff && (file[1] & 0xe0) === 0xe0)), '5 public/sounds/live-shot.mp3 가 MP3 파일 (' + file.length + 'B)');

  // 가짜 녹음: 0.5초, 앞 0.1초는 무음, 최대 0.5
  const rate = 48000;
  const data = new Float32Array(rate / 2);
  for (let i = rate / 10; i < data.length; i += 1) data[i] = i === rate / 10 ? 0.5 : 0.3 * Math.sin(i);
  const buffer = { duration: 0.5, sampleRate: rate, numberOfChannels: 1, getChannelData: () => data };
  const loaded = async (fetchImpl) => {
    const { ctx, sound } = engine();
    ctx.decodeAudioData = (_bytes, resolve) => { resolve(buffer); };
    const okLoad = await sound.loadShotSample(fetchImpl);
    return { ctx, sound, okLoad };
  };
  const requested = [];
  const fine = async (url) => { requested.push(url); return { ok: true, arrayBuffer: async () => new ArrayBuffer(8) }; };
  const voicesOf = (ctx, from) => ctx.nodes.slice(from).filter((n) => n.kind === 'source' && n.started);

  const { ctx, sound, okLoad } = await loaded(fine);
  ok(okLoad && sound.shotSampleReady && requested[0].endsWith('/public/sounds/live-shot.mp3'), '5 녹음을 불러온다 (' + (requested[0] ?? '').split('/').slice(-3).join('/') + ')');
  let from = ctx.nodes.length;
  const seconds = sound.playGunshot();
  let voices = voicesOf(ctx, from);
  ok(voices.length === 1 && voices[0].buffer === buffer && ctx.nodes.slice(from).every((n) => !['osc', 'convolver', 'compressor'].includes(n.kind)), '5 실탄 = 녹음 하나 (합성 겹 없음)');
  ok(voices[0].to.kind === 'gain' && voices[0].to.to.kind === 'gain' && voices[0].to.to.to === ctx.destination, '5 크기 맞춤 → 마스터 → 출력 (총성 압축 · 포화를 거치지 않는다)');
  near(voices[0].to.gain.value, 0.85 / 0.5, 0.001, '5 녹음의 최대 크기를 0.85 로 맞춘다');
  near(seconds, 0.5 - (0.1 - 0.003), 0.002, '5 앞의 무음은 건너뛰고 재생 (섬광과 맞게)');
  from = ctx.nodes.length;
  sound.playGunshot({ double: true });
  voices = voicesOf(ctx, from);
  ok(voices[0].playbackRate.value === 0.9 && voices[0].to.gain.value > 0.85 / 0.5 && voices[0].to.gain.value * 0.5 < 1, '5 더블샷: 조금 낮고 크게 (그래도 최대 1 미만)');
  from = ctx.nodes.length;
  ok(sound.playDamage() === 0 && ctx.nodes.length === from, '5 녹음을 쓰면 합성 피격음을 겹치지 않는다 (출력이 넘치지 않게)');
  from = ctx.nodes.length;
  sound.playBlank();
  ok(voicesOf(ctx, from).every((v) => v.buffer !== buffer), '5 공포탄에는 녹음을 쓰지 않는다');
  sound.setInGame(false);
  ok(sound.playGunshot() === 0, '5 판 밖에서는 녹음도 나지 않는다');

  const broken = await loaded(async () => ({ ok: false, status: 404 }));
  from = broken.ctx.nodes.length;
  broken.sound.playGunshot();
  ok(!broken.okLoad && !broken.sound.shotSampleReady && broken.ctx.nodes.slice(from).some((n) => n.kind === 'osc'), '5 불러오기에 실패하면 합성 총성이 대신 난다');
  ok(broken.sound.playDamage() > 0, '5 합성 총성일 때는 피격음도 그대로');
}

console.log(`\nsound.test.mjs ${pass} 통과 · ${fails.length} 실패 (${(performance.now() - T0).toFixed(0)}ms)`);
if (fails.length) process.exit(1);
