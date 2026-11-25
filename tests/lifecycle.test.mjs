// 오디오 생명주기 검증 (브라우저 없음 · 가짜 AudioContext / window / document): node tests/lifecycle.test.mjs
//   1. SoundEngine.suspend(): 즉시 무음 · 울리던 효과음 끊기 · 배경음 예약 타이머 해제 · 컨텍스트 정지 — 그동안 새 효과음 없음
//   2. 화면 밖에서는 무엇도 컨텍스트를 깨우지 못한다: iOS 'interrupted' 자동 복구 · unlock() · 음량 조절 · 깨우는 도중 숨김(경쟁)
//   3. resume(): 컨텍스트 재가동 · 음량 복구 · 배경음 예약 재개 (화면 밖에서 시작된 판의 배경음도 돌아와서 켜짐)
//   4. close(): 모든 소스 정지 · 타이머 해제 · 컨텍스트 close() → 돌아오면 새 컨텍스트 + 배경음 이어서 · iOS 는 다음 터치에서
//   5. watchLifecycle: visibilitychange · blur/focus · pagehide · beforeunload · pageshow 순서와 1회 호출
//   6. 둘을 이어 붙인 흐름 (app.js 와 같은 연결)
//   7. blur · freeze → 즉시 오디오 close + 소켓 disconnect (onHalt) · 돌아오면 다시 (onRestore) · document.hidden 이면 마스터 게인 0 강제
import { SoundEngine } from '../src/ui/soundEngine.js';
import { watchLifecycle } from '../src/ui/lifecycle.js';

const T0 = performance.now();
let pass = 0;
const fails = [];
const ok = (cond, name) => { if (cond) pass += 1; else { fails.push(name); console.log(`  ✗ ${name}`); } };
const eq = (got, want, name) => ok(JSON.stringify(got) === JSON.stringify(want), `${name} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`);

// ───────── 가짜 Web Audio ─────────
class Param {
  constructor(value) { this.value = value; }
  cancelScheduledValues() {}
  setValueAtTime(v) { this.value = v; }
  linearRampToValueAtTime(v) { this.value = v; }
  exponentialRampToValueAtTime(v) { this.value = v; }
  setTargetAtTime(v) { this.value = v; }
}
class Node {
  constructor(ctx, kind) {
    Object.assign(this, { ctx, kind, started: false, killed: false, onended: null });
    this.gain = new Param(1);
    this.frequency = new Param(440);
    this.Q = new Param(1);
    this.playbackRate = new Param(1);
    for (const name of ['threshold', 'knee', 'ratio', 'attack', 'release']) this[name] = new Param(0); // DynamicsCompressorNode
    this.curve = null; // WaveShaperNode
    ctx.nodes.push(this);
  }
  connect(to) { return to; }
  disconnect() {}
  start() { this.started = true; }
  stop(when) {
    if (!this.started) throw new Error('InvalidStateError');
    if (when === undefined) this.killed = true; // 지금 당장 끊김 (예약 종료가 아니라)
  }
}
class FakeAudioContext {
  static made = [];
  static startState = 'running'; // 새 컨텍스트의 처음 상태 (iOS 자동재생 정책 = 'suspended')
  static blockResume = false; // 제스처 없이 resume 이 막히는 브라우저 흉내
  static deferResume = false; // resume 이 바로 끝나지 않음 (경쟁 상태 시험)
  constructor() {
    Object.assign(this, { state: FakeAudioContext.startState, currentTime: 0, sampleRate: 48000, destination: {}, nodes: [], calls: [], pending: [] });
    FakeAudioContext.made.push(this);
  }
  createGain() { return new Node(this, 'gain'); }
  createOscillator() { return new Node(this, 'osc'); }
  createBufferSource() { return new Node(this, 'source'); }
  createBiquadFilter() { return new Node(this, 'filter'); }
  createWaveShaper() { return new Node(this, 'shaper'); }
  createDynamicsCompressor() { return new Node(this, 'compressor'); }
  createBuffer(_ch, length, rate) { return { duration: length / rate, getChannelData: () => new Float32Array(length) }; }
  suspend() { this.calls.push('suspend'); if (this.state !== 'closed') this.state = 'suspended'; return Promise.resolve(); }
  resume() {
    this.calls.push('resume');
    const finish = () => { if (this.state !== 'closed') this.state = FakeAudioContext.blockResume ? 'suspended' : 'running'; };
    if (!FakeAudioContext.deferResume) { finish(); return Promise.resolve(); }
    return new Promise((resolve) => this.pending.push(() => { finish(); resolve(); }));
  }
  close() { this.calls.push('close'); this.state = 'closed'; return Promise.resolve(); }
}
globalThis.AudioContext = FakeAudioContext;

// setInterval 감시: 살아 있는 반복 타이머 수
const intervals = new Set();
const realSetInterval = globalThis.setInterval;
const realClearInterval = globalThis.clearInterval;
globalThis.setInterval = (fn, ms) => { const id = realSetInterval(fn, ms); intervals.add(id); return id; };
globalThis.clearInterval = (id) => { intervals.delete(id); realClearInterval(id); };

const sources = (ctx) => ctx.nodes.filter((n) => n.kind === 'osc' || n.kind === 'source');
const buses = (ctx) => [ctx.nodes[0].gain.value, ctx.nodes[1].gain.value]; // #setup 이 처음 만드는 두 GainNode = 효과음 버스 · 배경음 버스

// ───────── 1~3. suspend / 잠금 / resume ─────────
{
  const sound = new SoundEngine({ volume: 0.8, ambientVolume: 0.6 });
  eq(await sound.unlock(), true, '1 unlock → 오디오 켜짐');
  const ctx = FakeAudioContext.made.at(-1);
  const ambientFrom = ctx.nodes.length;
  sound.startAmbient();
  const ambientSources = ctx.nodes.slice(ambientFrom).filter((n) => n.started && !n.onended); // 배경음 연속 소스 (오실레이터 · 노이즈 루프)
  eq(intervals.size, 1, '1 배경음 예약 타이머 1개');
  ok(sound.playGunshot() > 0 && sound.playHeartbeat() > 0, '1 효과음 재생');
  const ringing = sources(ctx).filter((n) => n.started && n.onended);

  await sound.suspend();
  eq(ctx.state, 'suspended', '1 suspend → 컨텍스트 정지');
  eq(buses(ctx), [0, 0], '1 효과음 · 배경음 버스 즉시 무음');
  ok(ringing.length > 0 && ringing.every((n) => n.killed), `1 울리던 효과음 소스 ${ringing.length}개 즉시 끊김`);
  eq(intervals.size, 0, '1 배경음 예약 타이머 해제');
  eq(sound.inBackground, true, '1 화면 밖 상태');

  const before = ctx.nodes.length;
  eq([sound.playGunshot(), sound.playClick(), sound.playItem(), sound.playDamage()], [0, 0, 0, 0], '2 화면 밖 효과음 요청은 0초 (재생 안 함)');
  sound.duckAmbient();
  eq(ctx.nodes.length, before, '2 화면 밖에서는 노드를 만들지 않는다 (돌아왔을 때 몰아서 터지지 않음)');

  ctx.state = 'interrupted'; // iOS: 백그라운드에서 운영체제가 끊음
  ctx.calls.length = 0;
  sound.playReload();
  sound.playItem();
  eq(ctx.calls, [], '2 iOS interrupted 여도 화면 밖에서는 resume 하지 않는다 (백그라운드 소리 새던 원인)');
  ctx.state = 'suspended';
  eq([await sound.unlock(), ctx.calls], [false, []], '2 화면 밖 unlock() (백그라운드 매칭 시작 등) → 깨우지 않음');
  sound.setVolume(0.5);
  sound.setMuted(false);
  eq(buses(ctx), [0, 0], '2 화면 밖 음량 조절은 무음 유지');

  await sound.resume();
  eq(ctx.state, 'running', '3 resume → 컨텍스트 재가동');
  eq(buses(ctx), [0.5, 0.6], '3 음량 복구 (화면 밖에서 바꾼 효과음 음량 반영)');
  eq(intervals.size, 1, '3 배경음 예약 타이머 재개');
  ok(sound.playClick() > 0 && !sound.inBackground, '3 효과음 다시 재생');

  await sound.suspend();
  await sound.suspend();
  eq([ctx.state, intervals.size], ['suspended', 0], '3 suspend 두 번도 안전');
  await sound.resume();

  // ── 4. close ──
  await sound.close();
  ok(ctx.calls.includes('close') && ctx.state === 'closed', '4 close → 컨텍스트 close()');
  eq(intervals.size, 0, '4 close → 타이머 해제');
  ok(ambientSources.length > 0 && ambientSources.every((n) => n.killed), `4 배경음 소스 ${ambientSources.length}개 모두 정지`);
  eq([sound.playGunshot(), await sound.unlock()], [0, false], '4 닫힌 뒤(페이지 이탈 중)에는 소리도 새 컨텍스트도 없음');

  const made = FakeAudioContext.made.length;
  await sound.resume(); // bfcache 복귀
  const fresh = FakeAudioContext.made.at(-1);
  ok(FakeAudioContext.made.length === made + 1 && fresh.state === 'running', '4 돌아오면 새 컨텍스트로 소리 복구');
  eq(intervals.size, 1, '4 진행 중이던 판의 배경음도 이어서 켜짐');

  sound.stopAmbient({ fade: 0 });
  eq(intervals.size, 0, '3 stopAmbient → 타이머 해제');
  await sound.suspend();
  await sound.resume();
  eq(intervals.size, 0, '3 판이 끝난 뒤에는 돌아와도 배경음을 켜지 않는다');
  await sound.close();
}

// 화면 밖에서 판이 시작됨 (PvP 매칭이 백그라운드에서 잡힘)
{
  const sound = new SoundEngine();
  await sound.unlock(); // 타이틀에서 한 번 켬
  await sound.suspend();
  await sound.unlock(); // startGame(true) — 제스처 밖
  sound.startAmbient();
  eq(intervals.size, 0, '3 화면 밖에서 시작된 판: 배경음 보류');
  await sound.resume();
  eq(intervals.size, 1, '3 돌아오면 그 판의 배경음 켜짐');
  await sound.close();
}

// 경쟁: unlock()의 resume 이 끝나기 전에 화면을 떠남
{
  FakeAudioContext.startState = 'suspended';
  FakeAudioContext.deferResume = true;
  const sound = new SoundEngine();
  const unlocking = sound.unlock();
  const ctx = FakeAudioContext.made.at(-1);
  await sound.suspend();
  FakeAudioContext.deferResume = false;
  for (const done of ctx.pending.splice(0)) done(); // 늦게 끝난 resume → 잠깐 running
  eq([await unlocking, ctx.state], [false, 'suspended'], '2 깨우는 도중 숨김 → 다시 재운다 (경쟁 상태)');
  FakeAudioContext.startState = 'running';
  await sound.close();
}

// iOS: 닫힌 뒤 돌아오면 제스처 전까지는 꺼져 있다가 다음 터치에서 켜짐
{
  const sound = new SoundEngine();
  eq(sound.needsUnlock, false, '4 한 번도 켠 적 없으면 터치로 깨울 필요 없음');
  await sound.unlock();
  await sound.close();
  FakeAudioContext.startState = 'suspended'; // iOS: 제스처 밖에서 만든 컨텍스트는 꺼진 채 시작하고 resume 도 막힌다
  FakeAudioContext.blockResume = true;
  await sound.resume();
  eq([FakeAudioContext.made.at(-1).state, sound.needsUnlock], ['suspended', true], '4 iOS: 돌아와도 제스처 전엔 꺼짐 → 다음 터치 필요');
  FakeAudioContext.startState = 'running';
  FakeAudioContext.blockResume = false;
  eq([await sound.unlock(), sound.needsUnlock], [true, false], '4 다음 터치의 unlock() 으로 켜짐');
  await sound.close();
}

// ───────── 5. watchLifecycle ─────────
const fakePage = ({ hidden = false } = {}) => {
  const win = new EventTarget();
  const doc = new EventTarget();
  const setHidden = (h) => { doc.hidden = h; doc.visibilityState = h ? 'hidden' : 'visible'; };
  setHidden(hidden);
  const fire = (target, type, init = {}) => target.dispatchEvent(Object.assign(new Event(type), init));
  return { win, doc, setHidden, fire };
};
{
  const { win, doc, setHidden, fire } = fakePage();
  const log = [];
  const stop = watchLifecycle({
    onAway: () => log.push('away'),
    onBack: () => log.push('back'),
    onLeave: (i) => log.push(`leave:${i.reason}:${i.persisted}`),
    onReturn: (i) => log.push(`return:${i.persisted}`),
  }, { win, doc });
  const step = (fn) => { log.length = 0; fn(); return [...log]; };

  eq(log, ['back'], '5 시작: 보이는 화면 → back 한 번');
  eq(step(() => { fire(win, 'blur'); setHidden(true); fire(doc, 'visibilitychange'); }), ['away'], '5 앱 전환(blur → 숨김) → away 한 번만');
  eq(step(() => { setHidden(false); fire(doc, 'visibilitychange'); }), [], '5 보이지만 아직 포커스 없음 → 아직 멈춤');
  eq(step(() => fire(win, 'focus')), ['back'], '5 포커스까지 돌아옴 → back');
  eq(step(() => { setHidden(true); fire(doc, 'visibilitychange'); }), ['away'], '5 화면 꺼짐(visibilitychange) → away');
  eq(step(() => { setHidden(false); fire(doc, 'visibilitychange'); }), ['back'], '5 화면 켜짐 → back');
  eq(step(() => fire(win, 'pagehide', { persisted: true })), ['away', 'leave:pagehide:true'], '5 pagehide → away 후 leave');
  eq(step(() => { setHidden(true); fire(doc, 'visibilitychange'); fire(win, 'pagehide'); }), [], '5 이탈 중 추가 이벤트 → 중복 호출 없음');
  setHidden(false);
  eq(step(() => fire(win, 'pageshow', { persisted: true })), ['back', 'return:true'], '5 bfcache 복귀(pageshow.persisted) → back · return');
  eq(step(() => fire(win, 'pageshow', { persisted: false })), [], '5 첫 pageshow(persisted 아님) → 아무것도');
  eq(step(() => fire(win, 'beforeunload')), ['away', 'leave:beforeunload:false'], '5 beforeunload → away 후 leave');
  eq(step(() => fire(win, 'pagehide')), [], '5 beforeunload 뒤 pagehide → leave 한 번만');
  eq(step(() => fire(win, 'pointerdown')), [], '5 pagehide 까지 왔으면 터치로 되살리지 않음');
  fire(win, 'pageshow', { persisted: true });
  fire(win, 'beforeunload');
  eq(step(() => fire(win, 'pointerdown')), ['back', 'return:false'], '5 이동이 취소된 beforeunload → 다음 터치에서 되살림');
  eq(step(() => fire(win, 'pointerdown')), [], '5 되살림은 한 번만');
  stop();
  eq(step(() => { setHidden(true); fire(doc, 'visibilitychange'); fire(win, 'pagehide'); }), [], '5 해제 뒤에는 호출 없음');
}
{
  const { win, doc } = fakePage({ hidden: true });
  const log = [];
  watchLifecycle({ onAway: () => log.push('away'), onBack: () => log.push('back') }, { win, doc });
  eq(log, ['away'], '5 백그라운드 탭에서 열림 → away 부터');
}
{
  const { win, doc, fire } = fakePage();
  const log = [];
  const realError = console.error;
  console.error = () => {};
  watchLifecycle({ onAway: () => { throw new Error('boom'); }, onLeave: () => log.push('leave') }, { win, doc });
  fire(win, 'pagehide');
  console.error = realError;
  eq(log, ['leave'], '5 한 훅이 실패해도 정리는 계속');
}

// ───────── 6. app.js 와 같은 연결 ─────────
{
  const { win, doc, setHidden, fire } = fakePage();
  const sound = new SoundEngine();
  let socketsClosed = 0;
  const settle = () => new Promise((r) => setTimeout(r, 0));
  watchLifecycle({
    onAway: () => sound.suspend(),
    onBack: () => sound.resume(),
    onLeave: () => { sound.close(); socketsClosed += 1; },
  }, { win, doc });
  await sound.unlock();
  const ctx = FakeAudioContext.made.at(-1);
  sound.startAmbient();
  setHidden(true);
  fire(doc, 'visibilitychange');
  await settle();
  eq([ctx.state, intervals.size, sound.playGunshot()], ['suspended', 0, 0], '6 홈 버튼 → 컨텍스트 정지 · 타이머 해제 · 효과음 없음');
  setHidden(false);
  fire(doc, 'visibilitychange');
  await settle();
  eq([ctx.state, intervals.size], ['running', 1], '6 돌아옴 → 소리 · 배경음 이어서');
  fire(win, 'pagehide');
  await settle();
  eq([ctx.state, intervals.size, socketsClosed], ['closed', 0, 1], '6 창 닫기 → 컨텍스트 close · 타이머 해제 · 소켓 정리');
}

// ───────── 7. blur · freeze → 즉시 끊기 / 마스터 게인 강제 음소거 ─────────
{
  const { win, doc, setHidden, fire } = fakePage();
  const log = [];
  watchLifecycle({
    onAway: () => log.push('away'),
    onBack: () => log.push('back'),
    onHalt: (i) => log.push(`halt:${i.reason}`),
    onRestore: () => log.push('restore'),
    onLeave: (i) => log.push(`leave:${i.reason}`),
    onReturn: () => log.push('return'),
  }, { win, doc });
  const step = (fn) => { log.length = 0; fn(); return [...log]; };
  eq(log, ['back'], '7 시작: 끊은 적이 없으니 restore 없이 back 만');
  eq(step(() => fire(win, 'blur')), ['away', 'halt:blur'], '7 blur → 즉시 무음(away) 다음 끊기(halt)');
  eq(step(() => fire(win, 'blur')), [], '7 blur 가 또 와도 한 번만');
  eq(step(() => { setHidden(true); fire(doc, 'visibilitychange'); }), [], '7 이어 숨김이 와도 중복 없음');
  eq(step(() => fire(doc, 'freeze')), [], '7 blur 뒤 freeze: 이미 끊었으니 다시 끊지 않는다');
  eq(step(() => { setHidden(false); fire(doc, 'visibilitychange'); fire(doc, 'resume'); }), [], '7 보이고 풀려도 포커스가 없으면 아직 끊긴 채');
  eq(step(() => fire(win, 'focus')), ['back', 'restore'], '7 포커스까지 돌아오면 back → restore (다시 잇기)');

  eq(step(() => { setHidden(true); fire(doc, 'visibilitychange'); }), ['away'], '7 숨김만 오면 away 까지 — 끊지는 않는다');
  eq(step(() => fire(doc, 'freeze')), ['halt:freeze'], '7 freeze → 즉시 halt (얼기 전에 정리)');
  eq(step(() => { fire(doc, 'resume'); setHidden(false); fire(doc, 'visibilitychange'); }), ['back', 'restore'], '7 resume + 보임 → back · restore');
  eq(step(() => { setHidden(true); fire(doc, 'visibilitychange'); setHidden(false); fire(doc, 'visibilitychange'); }), ['away', 'back'], '7 숨겼다 보이기만 하면 restore 없음 (끊은 적이 없다)');
  eq(step(() => fire(doc, 'freeze')), ['away', 'halt:freeze'], '7 보이는 상태의 freeze → away 후 halt');
  eq(step(() => fire(win, 'pagehide', { persisted: true })), ['leave:pagehide'], '7 끊은 뒤 페이지를 떠나면 leave (away 는 이미 알림)');
  eq(step(() => { fire(doc, 'resume'); fire(win, 'pageshow', { persisted: true }); }), ['back', 'restore', 'return'], '7 bfcache 복귀 → back · restore · return');
  eq(step(() => fire(win, 'blur')), ['away', 'halt:blur'], '7 복귀 뒤 blur 는 다시 한 번 끊는다');
}

// app.js 와 같은 연결: blur · freeze 에서 오디오 컨텍스트 close + 소켓 disconnect, 돌아오면 새 컨텍스트 + 재연결
{
  const { win, doc, fire } = fakePage();
  const sound = new SoundEngine();
  const pvp = { paused: 0, resumed: 0 };
  const settle = () => new Promise((r) => setTimeout(r, 0));
  watchLifecycle({
    onAway: () => sound.suspend(),
    onBack: () => sound.resume(),
    onHalt: () => { sound.close(); pvp.paused += 1; },
    onRestore: () => { pvp.resumed += 1; },
    onLeave: () => sound.close(),
  }, { win, doc });
  await sound.unlock();
  const ctx = FakeAudioContext.made.at(-1);
  sound.startAmbient();
  fire(win, 'blur');
  await settle();
  eq([ctx.state, ctx.calls.includes('close'), intervals.size, pvp.paused, sound.playGunshot()], ['closed', true, 0, 1, 0], '7 blur → 컨텍스트 close · 배경음 타이머 해제 · 소켓 disconnect · 소리 없음');
  fire(win, 'focus');
  await settle();
  const ctx2 = FakeAudioContext.made.at(-1);
  eq([ctx2 !== ctx, ctx2.state, intervals.size, pvp.resumed], [true, 'running', 1, 1], '7 돌아옴 → 새 컨텍스트 · 배경음 이어서 · 소켓 재연결');
  fire(doc, 'freeze');
  await settle();
  eq([ctx2.state, intervals.size, pvp.paused, sound.playClick()], ['closed', 0, 2, 0], '7 freeze → 얼기 전에 컨텍스트 close · 타이머 해제 · 소켓 disconnect');
  fire(doc, 'resume');
  fire(win, 'focus');
  await settle();
  eq([FakeAudioContext.made.at(-1).state, pvp.resumed], ['running', 2], '7 freeze 풀림 → 다시 소리 · 재연결');
  await sound.close();
}

// 마스터 GainNode 하나 — document.hidden 이면 생명주기 훅 없이도 즉시 0
{
  const doc = new EventTarget();
  doc.hidden = false;
  globalThis.document = doc;
  const tick = (hidden) => { doc.hidden = hidden; doc.dispatchEvent(new Event('visibilitychange')); };
  const sound = new SoundEngine({ volume: 0.8, ambientVolume: 0.6 });
  await sound.unlock();
  const ctx = FakeAudioContext.made.at(-1);
  const master = ctx.nodes[0];
  const ambient = ctx.nodes[1];
  eq([master.gain.value, ambient.gain.value], [0.8, 0.6], '7 보이는 탭: 마스터 0.8 · 배경 0.6');
  tick(true);
  eq([master.gain.value, ambient.gain.value], [0, 0], '7 document.hidden → 마스터 게인 즉시 0 (생명주기 훅 없이도)');
  const nodes = ctx.nodes.length;
  eq([sound.playGunshot(), sound.playClick(), ctx.nodes.length], [0, 0, nodes], '7 가려진 탭에서는 효과음을 만들지도 않는다');
  tick(false);
  eq([master.gain.value, ambient.gain.value], [0.8, 0.6], '7 다시 보이면 원래 음량');
  await sound.suspend();
  tick(true);
  tick(false);
  eq(master.gain.value, 0, '7 suspend 중이면 보여도 0 유지 (포커스가 돌아와 resume 할 때까지)');
  await sound.resume();
  eq(master.gain.value, 0.8, '7 resume → 원래 음량');
  sound.setMuted(true);
  tick(true);
  tick(false);
  eq(master.gain.value, 0, '7 음소거면 보여도 0');
  sound.setMuted(false);
  tick(true);
  await sound.close();
  await sound.unlock(); // 가려진 채로 새 컨텍스트가 만들어져도 마스터는 0 에서 시작
  eq(FakeAudioContext.made.at(-1).nodes[0].gain.value, 0, '7 가려진 탭에서 새로 만든 컨텍스트도 마스터 0');
  await sound.close();
  delete globalThis.document;
}

for (const id of intervals) realClearInterval(id);
const ms = Math.round(performance.now() - T0);
console.log(fails.length === 0 ? `PASS  ${pass} checks, 0 failed — ${ms} ms` : `FAIL  ${pass} passed, ${fails.length} failed — ${ms} ms`);
process.exitCode = fails.length === 0 ? 0 : 1;
