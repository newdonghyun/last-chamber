/**
 * ODD ROULETTE - 효과음 엔진 (Web Audio API)
 *
 *   const sound = new SoundEngine();
 *   startButton.addEventListener('click', () => sound.unlock()); // 첫 사용자 클릭에서 오디오 활성화
 *   sound.playHeartbeat();                                         // play*()는 소리 길이(초) 반환, 활성화 전이면 0
 *
 * - 모든 효과음은 외부 파일 없이 실시간 합성한다.
 * - 격발음 설계 — 총성 뒤에 '띠딩' 하는 음정이 남지 않는 것이 원칙이다:
 *   실탄(playGunshot)  스마트폰 작은 스피커에서도 꽂히도록 700Hz~3kHz 대역에 힘을 싣는다. 세 겹을 동시에 터뜨리고 0.45초 안에 전부 끝난다.
 *                      ① 뇌관 파열음(0~0.03초, 2200→400Hz 급강하 '땅!') ② 중저음 바디(280→65Hz 0.18초 사각 · 삼각파 + WaveShaper 포화로 배음 증폭)
 *                      ③ 화약 폭발 노이즈(로우패스 2500→350Hz 0.45초). 총성 전용 버스(GUN_BOOST)로 밀어 올리고 마스터 뒤 DynamicsCompressor 가 피크만 눌러 클리핑을 막는다.
 *   피격(playDamage)   둔탁한 저음 '퍽' 하나뿐 (예전의 하강 경고음 · 귀울림은 총성 직후 '띠딩'으로 들려 없앴다).
 *   공포탄(playClick)  800~2500Hz 로 깎은 노이즈 '딸' + 금속 틱 '깍' — 0.06초에 끝나고 음정 있는 소리는 없다.
 *   그 밖의 소리도 길게 울리는 고음은 없다: 배경 소리는 1kHz 미만, 장전 '철컥'의 금속 울림은 0.06초 이하, 총성의 2.2kHz 소리는 0.03초뿐 (tests/sound.test.mjs 가 지킨다).
 * - 배경 앰비언트(startAmbient)는 음악이 아니라 저음 드론·실내 소음·전등 험·드문 먼 소리를 합성해 까는 소리 바닥이다.
 *   setTension(0~1)으로 긴장도에 따라 서서히 커지고, duckAmbient()는 총성 때 잠깐 낮춘다.
 *   효과음 음량(volume)·배경음 음량(ambientVolume)·음소거(muted)는 따로 조절한다.
 * - 소리 이중 잠금 (실시간 컨텍스트에만 — OfflineAudioContext 는 스피커로 나가지 않으므로 대상이 아니다):
 *   잠금 1  모든 소리: 탭이 보이고(document.hidden 아님) · 창에 포커스가 있고(document.hasFocus()) · suspend() 중이 아닐 때만. 가려지거나 포커스를 잃는 순간(visibilitychange · blur)
 *           마스터 · 배경 게인을 곧바로 0 으로 만들고, 그동안의 효과음 요청은 소리를 만들지도 않는다 (돌아와 focus 가 오면 원래 음량).
 *   잠금 2  게임 전용 소리(총성 · 피격 · 심박 · 배경음): 앱이 '실제 인게임 화면'일 때만 setInGame(true) 로 열어 준다. 앱 쪽 호출 가드가 빠져도 판 밖(타이틀 · 결과 · 로비)에서는 울리지 않는다.
 *           (장전 · 아이템 · 클릭은 상점 · 상자 · 설정의 메뉴 효과음과 같이 쓰므로 잠금 1 만 건다. 단독으로 쓸 때(테스트 · 측정)의 기본값은 열림 — new SoundEngine({ inGame: false }) 로 잠그고 시작.)
 * - 마스터 GainNode(#master)는 하나뿐이다 — 모든 효과음(총성 체인 포함)이 지나가는 문. document.hidden === true 이면 생명주기 훅이 늦거나 빠져도
 *   gain 을 0 으로 강제하고(visibilitychange 로 즉시 · 새 소리 요청도 차단), 보이게 돼도 suspend() 중이거나 음소거면 0 을 유지한다.
 * - 생명주기 (src/ui/lifecycle.js 가 부른다):
 *   suspend()  화면을 떠남 → 즉시 무음 · 울리던 효과음 끊기 · 배경음 예약 타이머 정지 · 컨텍스트 정지. resume() 전까지는
 *              효과음 요청을 버리고(돌아왔을 때 몰아서 터지지 않게) 무엇도 컨텍스트를 다시 깨우지 못한다 (unlock() · iOS 'interrupted' 복구 포함).
 *   resume()   화면으로 돌아옴 → 컨텍스트 재가동 · 음량 복구 · 배경음 예약 재개 (close() 뒤라면 새 컨텍스트를 만들고 배경음도 이어서 켠다)
 *   close()    페이지 이탈 → 모든 소스 정지 · 타이머 해제 · 컨텍스트 close()
 *
 * 사용 노드: OscillatorNode, 화이트 노이즈 AudioBuffer(AudioBufferSourceNode), BiquadFilterNode, GainNode, WaveShaperNode, DynamicsCompressorNode
 */

const NOISE_SECONDS = 2;
const GUN_BOOST = 2.2; // 총성 전용 버스의 증폭 — 합이 1 을 넘어도 바로 뒤의 컴프레서 · 소프트클립이 받아 준다
const GUN_COMP = { threshold: -12, knee: 10, ratio: 6, attack: 0.001, release: 0.1 }; // 총성 전용 컴프레서: 피크를 눌러 평균 음량(음압)을 키운다
const GUN_CLIP_DRIVE = 1.4; // 컴프레서 뒤의 소프트클립(tanh) — 어떤 경우에도 ±1 을 넘지 않게 마지막으로 둥글게 눌러 클리핑(찢어지는 소리)을 막는다
const SATURATE_DRIVE = 5; // 바디 파형 포화 정도 (tanh) — 클수록 배음이 많다

// 앰비언트 층별 기본 음량 (효과음이 늘 앞에 서도록 아주 낮게)
const AMBIENT = { room: 0.2, air: 0.03, drone: 0.05, hum: 0.014, tension: 0.07, event: 0.06 };
const AMBIENT_FADE_IN = 3; // 초
const DRONE_PARTIALS = [['sine', 55, 0.5], ['sawtooth', 55.35, 0.16], ['sine', 82.4, 0.16], ['triangle', 110.1, 0.1], ['sine', 36.7, 0.2]]; // A1 + 약간 어긋난 톱니파(맥놀이) + 완전5도 + 서브
const SILENT = 0.0001; // 지수 램프는 0으로 갈 수 없어 -80dB를 무음으로 사용
const BAR_MODES = [1, 2.756]; // 금속 막대 고유 진동 비율(비정수배) → 황동/쇠 질감. 더 높은 배음은 유리잔 '띠딩'처럼 들려 두지 않는다
const curveOf = (fn, n = 1024) => Float32Array.from({ length: n }, (_, i) => fn((i / (n - 1)) * 2 - 1)); // 입력 −1~1 → 출력 (WaveShaper 곡선)
const softClipCurve = () => curveOf((x) => Math.tanh(GUN_CLIP_DRIVE * x) / Math.tanh(GUN_CLIP_DRIVE));
const pageHidden = () => globalThis.document?.hidden === true; // 탭이 가려졌다 (화면 잠금 · 탭 내림 · 다른 앱) — 브라우저가 알려 주는 값
const pageUnfocused = () => typeof globalThis.document?.hasFocus === 'function' && globalThis.document.hasFocus() === false; // 창이 포커스를 잃었다 (다른 창 · 앱 전환 · 닫는 중) — hasFocus 를 모르는 환경은 포커스 있음으로 본다
const clamp01 = (v) => Math.min(1, Math.max(0, Number(v) || 0));
const vary = (value, spread = 0.04) => value * (1 + (Math.random() * 2 - 1) * spread); // 매번 미세하게 다른 소리

// 금속 부품이 맞물리는 '철컥' 한 번: 짧은 쇳소리 + 금속 울림 + 낮은 몸통음
const clank = (at, click, body, peak) => [
  { at, filters: [['bandpass', vary(click), 2.5]], peak, attack: 0.0006, decay: 0.03 },
  { at, osc: 'sine', freq: vary(click * 0.67), peak: peak * 0.1, attack: 0.001, decay: 0.05 }, // 금속 울림은 짧게 — 길면 '띠링' 알림음처럼 들린다
  { at, osc: 'sine', freq: body, to: body * 0.62, glide: 0.05, peak: peak * 0.45, attack: 0.002, decay: 0.08 },
];

// 심장박동 한 번: 저음 사인 + 작은 스피커용 2배음 + 저역 노이즈 '퍽'
const beat = (at, freq, peak) => [
  { at, osc: 'sine', freq, to: freq * 0.62, glide: 0.12, peak, attack: 0.012, decay: 0.16 },
  { at, osc: 'sine', freq: freq * 2, to: freq * 1.22, glide: 0.1, peak: peak * 0.28, attack: 0.01, decay: 0.1 },
  { at, filters: [['lowpass', freq * 3]], peak: peak * 0.6, attack: 0.004, decay: 0.07 },
];

export class SoundEngine {
  #ctx = null;
  #master = null;
  #noise = null;
  #gunBus = null; // 총성 전용 증폭 버스 → 총성 컴프레서 → 소프트클립 → #master (음량 · 음소거 · 화면 밖 무음은 그대로 받는다)
  #gunComp = null;
  #gunClip = null;
  #curve = null; // 포화(WaveShaper) 곡선
  #volume; // 효과음 음량
  #ambientVolume; // 배경음 음량
  #muted;
  #ambientBus = null; // 배경음 전체 음량 → destination
  #duck = null; // 배경음 순간 낮추기 (총성 때)
  #ambient = null; // 켜져 있는 앰비언트 { out, nodes, droneLp, droneBus, hum, tensionGain, nextEvent }
  #ambientTimer = 0; // 드문 먼 소리를 4초마다 이어서 예약하는 setInterval (화면 밖에서는 해제)
  #ambientWanted = false; // 판이 진행 중이라 배경음이 깔려 있어야 하는가 (컨텍스트를 새로 만들면 이어서 켠다)
  #voices = new Set(); // 지금 울리고 있는 효과음 소스 — 화면을 떠나면 한꺼번에 끊는다
  #held = false; // 화면 밖(백그라운드 · 페이지 이탈): 소리를 만들지도, 컨텍스트를 깨우지도 않는다
  #visBound = false; // visibilitychange · window blur/focus 리스너를 이 엔진이 한 번만 달았는가
  #inGame; // 잠금 2: 실제 인게임 화면인가 (게임 전용 소리가 이것을 본다)
  #unlockedOnce = false; // 사용자가 한 번이라도 오디오를 켰는가 (close() 뒤 돌아오면 새 컨텍스트를 만들어도 되는가)
  #tension = 0;

  /**
   * @param {{ volume?: number, ambientVolume?: number, muted?: boolean, context?: BaseAudioContext, inGame?: boolean }} [options]
   *   volume: 효과음 0~1 (기본 0.8) / ambientVolume: 배경음 0~1 (기본 0.6) / muted: 전체 음소거
   *   context: 이미 있는 AudioContext나 OfflineAudioContext를 쓸 때 / inGame: 게임 전용 소리의 잠금 2 (기본 true = 열림, 앱은 false 로 시작해 판이 열릴 때 setInGame(true))
   */
  constructor({ volume = 0.8, ambientVolume = 0.6, muted = false, context = null, inGame = true } = {}) {
    this.#inGame = Boolean(inGame);
    this.#volume = clamp01(volume);
    this.#ambientVolume = clamp01(ambientVolume);
    this.#muted = Boolean(muted);
    if (context) this.#setup(context);
  }

  /** 효과음 음량 */
  get volume() {
    return this.#volume;
  }

  setVolume(volume) {
    this.#volume = clamp01(volume);
    this.#applyVolumes();
  }

  get ambientVolume() {
    return this.#ambientVolume;
  }

  setAmbientVolume(volume) {
    this.#ambientVolume = clamp01(volume);
    this.#applyVolumes();
  }

  get muted() {
    return this.#muted;
  }

  setMuted(muted) {
    this.#muted = Boolean(muted);
    this.#applyVolumes();
  }

  /** 잠금 2 — 앱이 실제 인게임 화면이면 true. false 가 되면 켜져 있던 배경음도 곧바로 접는다 (총성 · 피격 · 심박 · 배경음은 true 일 때만 난다) */
  setInGame(on) {
    this.#inGame = Boolean(on);
    if (!this.#inGame) this.stopAmbient({ fade: 0.4 }); // 이미 접는 중이면(fade 가 더 긴 호출이 먼저 왔다면) 그대로 둔다
  }

  get inGame() {
    return this.#inGame;
  }

  /** 화면 밖(백그라운드 · 화면 꺼짐 · 다른 앱)에 있는 동안 true — 이때는 아무 소리도 나지 않는다 */
  get inBackground() {
    return this.#held;
  }

  /** 다음 사용자 터치에서 unlock()을 불러야 소리가 나는 상태인가 (화면 안 · 한 번 켠 적 있음 · 지금 꺼져 있음) */
  get needsUnlock() {
    return !this.#held && this.#unlockedOnce && this.#ctx?.state !== 'running';
  }

  /**
   * 화면을 떠났을 때: 즉시 무음 → 울리던 효과음 끊기 → 배경음 예약 타이머 정지 → 컨텍스트 정지.
   * resume() 전까지는 새 효과음을 만들지 않고 컨텍스트를 깨우는 모든 경로를 막는다 (여러 번 불러도 안전).
   */
  async suspend() {
    this.#held = true;
    this.#disarmAmbientTimer();
    this.#silence();
    this.#stopVoices();
    await this.#suspendContext();
  }

  /** 화면으로 돌아왔을 때: 컨텍스트 재가동 · 음량 복구 · 배경음 예약 재개. close() 뒤라면 새 컨텍스트를 만든다 (판이 진행 중이면 배경음도) */
  async resume() {
    this.#held = false;
    const ctx = this.#ctx;
    if (!ctx) {
      if (this.#unlockedOnce) await this.unlock(); // 제스처가 필요한 브라우저(iOS)에선 다음 터치의 unlock()에서 켜진다
      return;
    }
    if ('startRendering' in ctx || ctx.state === 'closed') return;
    this.#applyVolumes(); // 무음(0)에서 원래 음량으로 30ms 램프
    if (this.#ambient) this.#armAmbientTimer();
    else if (this.#ambientWanted) this.startAmbient();
    if (ctx.state !== 'running') {
      try {
        await ctx.resume();
      } catch {
        // 자동재생 정책 등으로 실패 - 다음 터치의 unlock()에서 다시
      }
    }
    if (this.#held) await this.#suspendContext(); // 깨우는 사이 다시 화면을 떠났다
  }

  /** 페이지를 떠날 때(창 닫기 · 뒤로 가기 · 새로고침): 모든 소스와 타이머를 멈추고 컨텍스트를 닫는다. bfcache 로 돌아오면 resume()이 새로 만든다 */
  async close() {
    this.#held = true;
    this.#disarmAmbientTimer();
    this.#silence();
    this.#stopVoices();
    const ambient = this.#ambient;
    this.#ambient = null; // #ambientWanted 는 남긴다 → 돌아와 새 컨텍스트를 만들면 배경음을 이어서 켠다
    for (const n of ambient?.nodes ?? []) {
      try {
        n.stop();
      } catch {
        // 이미 멈춤 - 무시
      }
    }
    const ctx = this.#ctx;
    this.#ctx = this.#master = this.#ambientBus = this.#duck = this.#noise = this.#gunBus = this.#gunComp = this.#gunClip = this.#curve = null;
    if (!ctx || 'startRendering' in ctx || ctx.state === 'closed') return;
    try {
      await ctx.close();
    } catch {
      // 이미 닫힘 - 무시
    }
  }

  /** 첫 사용자 클릭/터치 핸들러 안에서 호출한다. 오디오 출력이 켜지면 true. 여러 번 불러도 안전하다. 화면 밖에서는 아무것도 하지 않는다. */
  async unlock() {
    if (this.#held) return false; // 백그라운드에서 매칭이 잡히는 등 제스처 밖 호출이 화면 밖 소리를 깨우지 않게
    if (!this.#ctx) {
      const AudioCtx = globalThis.AudioContext ?? globalThis.webkitAudioContext;
      if (!AudioCtx) return false;
      this.#setup(new AudioCtx());
      this.#unlockedOnce = true;
      // iOS Safari: 사용자 제스처 안에서 무음 버퍼를 한 번 재생해야 출력이 열린다
      const silence = this.#ctx.createBufferSource();
      silence.buffer = this.#ctx.createBuffer(1, 1, this.#ctx.sampleRate);
      silence.connect(this.#ctx.destination);
      silence.start();
      if (this.#ambientWanted) this.startAmbient(); // close() 뒤 새 컨텍스트: 진행 중이던 판의 배경음을 이어서
    }
    const ctx = this.#ctx;
    if (ctx.state !== 'running' && ctx.state !== 'closed') {
      try {
        await ctx.resume();
      } catch {
        // OfflineAudioContext는 렌더링 전에 resume할 수 없다 - 무시
      }
    }
    if (this.#held) { // 깨우는 사이 화면을 떠났다 → 다시 재운다
      await this.#suspendContext();
      return false;
    }
    return ctx.state === 'running';
  }

  /**
   * 1) 공포탄: 건조하고 날카로운 금속 공이 타격음 '딸깍!' — 0.06초에 깔끔하게 끝난다.
   *    800~2500Hz 로 깎은 노이즈(딸) + 좁은 대역 노이즈의 금속 틱(깍). 음정이 남는 오실레이터는 쓰지 않는다 (실탄과 확실히 다른 소리).
   */
  playClick() {
    return this.#play([
      // (좁게 깎은 노이즈는 필터를 지나며 에너지가 크게 줄어, 게인을 1 이상으로 잡아야 실탄과 비슷한 체감 음량이 된다)
      { filters: [['highpass', 800, 0.7], ['lowpass', 2500, 0.7]], peak: 1.7, attack: 0.0004, decay: 0.03 },
      { at: 0.026, filters: [['bandpass', vary(2200, 0.06), 3.5]], peak: 2.6, attack: 0.0004, decay: 0.034 },
    ]);
  }

  /**
   * 2) 실탄: 스마트폰 작은 스피커에서도 '땅!' 하고 꽂히는 묵직한 총성 — 세 겹을 동시에 터뜨리고 0.45초 안에 전부 끝낸다.
   *    저음(100Hz 이하)은 폰 스피커에서 거의 안 나오므로, 힘을 700Hz~3kHz 에 싣는다 (뇌관 파열음 · 포화시킨 바디의 배음 · 노이즈).
   *    세 겹은 총성 전용 버스(GUN_BOOST)로 보내 마스터 음량보다 크게 밀어 올리고, 넘치는 피크는 마스터 뒤 컴프레서가 눌러 준다.
   *    모든 겹이 지수 감쇠(exponentialRamp)로 −80dB 까지 떨어지므로 뒤에 멜로디 · '띠딩' 같은 꼬리가 남지 않는다 (2.2kHz 소리는 0.03초뿐).
   */
  playGunshot() {
    if (!this.#inGame) return 0; // 잠금 2
    return this.#play([
      // ① 초기 뇌관 파열음: 0~0.03초에 2200Hz → 400Hz 로 급강하하는 날카로운 어택 펀치 (귀에 '땅!' 하고 꽂히는 핵심 타격감)
      { bus: 'gun', osc: 'triangle', freq: 2200, to: 400, glide: 0.03, peak: 0.6, attack: 0.0005, decay: 0.0295 },
      // ② 중저음 총성 바디: 280Hz → 65Hz 로 0.18초 떨어지는 사각파 · 삼각파를 포화(WaveShaper)시켜 배음을 두껍게
      { bus: 'gun', osc: 'square', freq: 280, to: 65, glide: 0.18, shape: true, peak: 0.45, attack: 0.001, decay: 0.22 },
      { bus: 'gun', osc: 'triangle', freq: 280, to: 65, glide: 0.18, shape: true, peak: 0.5, attack: 0.001, decay: 0.2 },
      // ③ 화약 폭발: 2500Hz 로우패스가 0.45초 동안 350Hz 로 닫히는 거친 화이트 노이즈 (예전 0.55 → 1.1, 2배 출력)
      { bus: 'gun', filters: [['lowpass', 2500, 1, 350, 0.45]], peak: 1.1, attack: 0.0008, decay: 0.4492 },
    ]);
  }

  /** 3) 장전: '철컥'(탄 삽입·래치) + '드르륵'(점점 느려지는 실린더 래칫) + 고정 클릭 */
  playReload() {
    const layers = [
      ...clank(0, 2800, 190, 0.8), // 철
      ...clank(0.075, 1700, 150, 0.9), // 컥
      { at: 0.22, filters: [['bandpass', 1100, 1.5]], peak: 0.06, attack: 0.03, decay: 0.55 }, // 회전 마찰음
    ];
    let at = 0.22;
    let gap = 0.034;
    for (let i = 0; i < 11; i++) {
      layers.push({ at, filters: [['bandpass', vary(3600, 0.12), 4]], peak: 0.5 * 0.94 ** i, attack: 0.0005, decay: 0.012 });
      at += gap;
      gap *= 1.11;
    }
    layers.push(...clank(at + 0.04, 2200, 170, 0.7)); // 실린더 고정
    return this.#play(layers);
  }

  /** 4) 격발 직전 정적(0.4초) 안에 끝나는 낮고 묵직한 '두-근' */
  playHeartbeat() {
    if (!this.#inGame) return 0; // 잠금 2
    return this.#play([...beat(0, 62, 0.8), ...beat(0.17, 72, 0.62)]);
  }

  /** 5) 테이블 위 황동/철제 소품을 집어 드는 묵직한 소리 */
  playItem() {
    const base = vary(420, 0.06);
    return this.#play([
      // 펠트/나무와 스치는 마찰
      { filters: [['bandpass', 1800, 1.5, 2600, 0.06]], peak: 0.22, attack: 0.008, decay: 0.07 },
      // 묵직한 몸통 '툭'
      { osc: 'sine', freq: 150, to: 92, glide: 0.07, peak: 0.5, attack: 0.003, decay: 0.13 },
      { filters: [['lowpass', 600]], peak: 0.5, attack: 0.002, decay: 0.05 },
      // 금속 막대 고유 진동 (짧게 — 길게 울리면 '띠딩' 알림음처럼 들린다)
      ...BAR_MODES.map((ratio, i) => ({
        at: 0.008, osc: 'sine', freq: base * ratio, peak: 0.15 / (i + 1) ** 0.9, attack: 0.001, decay: 0.2 / (i + 1) ** 0.6,
      })),
      // 손끝 금속 접촉음
      { at: 0.09, filters: [['bandpass', vary(3400), 5]], peak: 0.25, attack: 0.0005, decay: 0.015 },
    ]);
  }

  /**
   * 6) 피격: 몸에 꽂히는 둔탁한 저음 '퍽' 하나. 총성과 동시에 불러도 펀치가 포개지지 않게 50ms 뒤에 깔린다.
   *    (예전의 하강 경고음 두 음 · 2900Hz 귀울림은 총성 직후 '띠딩'으로 들려서 없앴다 — 이 소리에는 음정이 없다)
   */
  playDamage() {
    if (!this.#inGame) return 0; // 잠금 2
    return this.#play([
      { at: 0.05, osc: 'sine', freq: 90, to: 34, glide: 0.14, peak: 0.4, attack: 0.003, decay: 0.2 },
      { at: 0.05, filters: [['lowpass', 520, 1, 140, 0.12]], peak: 0.34, attack: 0.002, decay: 0.14 },
    ]);
  }

  /**
   * 배경 앰비언트 시작: 저음 드론 + 실내 소음 + 전등 험 + 드문 먼 소리(잔 부딪힘·배관·둔탁한 쿵). 이미 켜져 있으면 무시.
   * preschedule: 처음에 미리 깔아 둘 '드문 소리'의 길이(초). 실시간에서는 4초마다 이어서 예약한다.
   */
  startAmbient({ preschedule = 12 } = {}) {
    if (!this.#inGame) return; // 잠금 2 — 판 밖에서는 배경음을 켜지도, 켜 달라고 기억해 두지도 않는다
    this.#ambientWanted = true; // 지금 켤 수 없으면(화면 밖 · 컨텍스트 없음) 돌아와서 켠다
    const ctx = this.#ready();
    if (!ctx || this.#ambient) return;
    const t0 = ctx.currentTime;
    this.#duck.gain.cancelScheduledValues(t0); // 이전에 낮춰 둔 흔적이 남지 않게
    this.#duck.gain.setValueAtTime(1, t0);
    const out = ctx.createGain();
    out.gain.setValueAtTime(0, t0);
    out.gain.linearRampToValueAtTime(1, t0 + AMBIENT_FADE_IN);
    out.connect(this.#duck);

    const nodes = []; // 멈춰야 하는 소스들
    const osc = (type, freq) => {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.value = freq;
      o.start(t0);
      nodes.push(o);
      return o;
    };
    const noiseSource = () => {
      const n = ctx.createBufferSource();
      n.buffer = this.#noise;
      n.loop = true;
      n.start(t0, Math.random() * (NOISE_SECONDS - 0.5));
      nodes.push(n);
      return n;
    };
    const gain = (value, to) => {
      const g = ctx.createGain();
      g.gain.value = value;
      if (to) g.connect(to);
      return g;
    };
    const filter = (type, freq, Q = 0.7) => {
      const f = ctx.createBiquadFilter();
      f.type = type;
      f.frequency.value = freq;
      f.Q.value = Q;
      return f;
    };
    const chain = (...list) => list.reduce((a, b) => { a.connect(b); return b; });
    const wobble = (freq, depth, param) => osc('sine', freq).connect(gain(depth, param)); // 느린 LFO: 파라미터를 ±depth만큼 천천히 흔든다

    // 실내 소음: 환기구 같은 저역 노이즈 + 아주 작은 공기 스치는 소리
    const room = gain(AMBIENT.room, out);
    chain(noiseSource(), filter('highpass', 45), filter('lowpass', 360, 0.6), room);
    wobble(0.07, AMBIENT.room * 0.25, room.gain);
    const air = gain(AMBIENT.air, out);
    chain(noiseSource(), filter('bandpass', 1100, 0.45), air);
    wobble(0.043, AMBIENT.air * 0.4, air.gain);

    // 저음 드론: 천천히 열렸다 닫히는 필터 + 숨 쉬는 음량
    const droneLp = filter('lowpass', 170);
    const droneBus = gain(AMBIENT.drone, out);
    droneLp.connect(droneBus);
    for (const [type, freq, level] of DRONE_PARTIALS) osc(type, freq).connect(gain(level, droneLp));
    wobble(0.031, 55, droneLp.frequency);
    wobble(0.047, AMBIENT.drone * 0.12, droneBus.gain);

    // 전등 험 (60Hz 계열)
    const hum = gain(AMBIENT.hum, out);
    for (const [freq, level] of [[60, 1], [120, 0.62], [180, 0.22], [240, 0.08]]) osc('sine', freq).connect(gain(level, hum));
    wobble(5.3, AMBIENT.hum * 0.05, hum.gain);

    // 긴장 층: 반음으로 부딪히는 음(E4–F4 맥놀이 ≈ 20Hz) + 느린 떨림. 평소엔 무음이고 setTension으로만 커진다
    const tensionGain = gain(0, out);
    const tremolo = gain(0.65, tensionGain);
    wobble(0.6, 0.35, tremolo.gain);
    const tensionLp = filter('lowpass', 1300, 0.6);
    tensionLp.connect(tremolo);
    for (const f of [233.1, 329.6, 349.2]) osc('sine', f).connect(gain(0.33, tensionLp));

    this.#ambient = {
      out, nodes, droneLp, droneBus, hum, tensionGain,
      nextEvent: t0 + 7 + Math.random() * 6,
    };
    this.#armAmbientTimer();
    this.#applyTension(true);
    this.#scheduleAmbientEvents(t0 + preschedule);
  }

  /** 앰비언트를 fade초에 걸쳐 끄고 소스를 정리한다 */
  stopAmbient({ fade = 2 } = {}) {
    this.#ambientWanted = false;
    this.#disarmAmbientTimer();
    const a = this.#ambient;
    const ctx = this.#ctx;
    if (!a || !ctx) return;
    this.#ambient = null;
    const t = ctx.currentTime;
    const end = t + Math.max(0.05, fade);
    a.out.gain.cancelScheduledValues(t);
    a.out.gain.setValueAtTime(a.out.gain.value, t);
    a.out.gain.linearRampToValueAtTime(0, end);
    for (const n of a.nodes) {
      try {
        n.stop(end + 0.05);
      } catch {
        // 이미 멈춤 - 무시
      }
    }
  }

  get ambientPlaying() {
    return this.#ambient !== null;
  }

  /** 긴장도 0~1: 클수록 드론이 밝고 커지고 긴장 층이 깔린다 (서서히 변함) */
  setTension(level) {
    this.#tension = clamp01(level);
    this.#applyTension(false);
  }

  get tension() {
    return this.#tension;
  }

  /** 배경음을 순간 depth까지 낮췄다가 seconds에 걸쳐 되돌린다 — 총성 같은 큰 소리를 살린다 */
  duckAmbient(depth = 0.3, seconds = 1.5) {
    const ctx = this.#ready();
    if (!ctx || !this.#duck || !this.#ambient) return;
    const t = ctx.currentTime;
    const g = this.#duck.gain;
    g.cancelScheduledValues(t);
    g.setValueAtTime(g.value, t);
    g.setTargetAtTime(depth, t, 0.02);
    g.setTargetAtTime(1, t + 0.18, seconds / 3);
  }

  // 음량·음소거를 30ms 램프로 바꾼다. setTargetAtTime은 소리가 끊긴 사이에 쉬던 버스에서 복귀가 늦게 시작돼
  // (음소거 중 총성 → 해제 → 첫 총성이 작게 들림) 쓰지 않고, 현재 값을 붙잡은 뒤 선형으로 옮긴다.
  #applyVolumes() {
    const ctx = this.#ctx;
    if (!ctx || !this.#master) return;
    const t = ctx.currentTime;
    const ramp = (param, value) => {
      param.cancelScheduledValues(t);
      param.setValueAtTime(param.value, t);
      param.linearRampToValueAtTime(value, t + 0.03);
    };
    const off = this.#muted || this.#held || this.#away(ctx); // 화면 밖에서 음량을 바꿔도 무음은 그대로 (돌아올 때 resume()이 올린다)
    ramp(this.#master.gain, off ? 0 : this.#volume);
    ramp(this.#ambientBus.gain, off ? 0 : this.#ambientVolume);
  }

  #applyTension(instant) {
    const a = this.#ambient;
    if (!a || !this.#ctx) return;
    const k = this.#tension;
    const t = this.#ctx.currentTime;
    const tc = instant ? 0.01 : 1.6; // 변화는 천천히
    a.tensionGain.gain.setTargetAtTime(AMBIENT.tension * k, t, tc);
    a.droneLp.frequency.setTargetAtTime(170 + 110 * k, t, tc);
    a.droneBus.gain.setTargetAtTime(AMBIENT.drone * (1 + 0.45 * k), t, tc);
    a.hum.gain.setTargetAtTime(AMBIENT.hum * (1 + 0.5 * k), t, tc);
  }

  // 드문 먼 소리를 4초마다 14초 앞까지 이어서 예약한다 (화면 밖에서는 해제 → 돌아오면 다시)
  #armAmbientTimer() {
    if (this.#ambientTimer || !this.#ambient) return;
    this.#ambientTimer = setInterval(() => {
      const ctx = this.#ctx;
      if (ctx && !this.#held) this.#scheduleAmbientEvents(ctx.currentTime + 14);
    }, 4000);
  }

  #disarmAmbientTimer() {
    if (!this.#ambientTimer) return;
    clearInterval(this.#ambientTimer);
    this.#ambientTimer = 0;
  }

  // 효과음 · 배경음 버스를 지금 바로 0으로 (컨텍스트 suspend 는 비동기라 그사이 새는 소리를 막는다)
  #silence() {
    const ctx = this.#ctx;
    if (!ctx || !this.#master) return;
    const t = ctx.currentTime;
    for (const param of [this.#master.gain, this.#ambientBus.gain]) {
      param.cancelScheduledValues(t);
      param.setValueAtTime(0, t);
    }
  }

  // 울리는 중인 효과음 소스를 기억한다 (끝나면 스스로 빠진다)
  #track(src, onEnd) {
    this.#voices.add(src);
    src.onended = () => {
      this.#voices.delete(src);
      onEnd?.();
    };
  }

  #stopVoices() {
    for (const src of this.#voices) {
      try {
        src.stop();
      } catch {
        // 아직 시작 전이거나 이미 멈춤 - 무시
      }
    }
    this.#voices.clear();
  }

  async #suspendContext() {
    const ctx = this.#ctx;
    if (!ctx || 'startRendering' in ctx || ctx.state === 'closed') return; // 'suspended'여도 부른다 — 진행 중인 resume()을 뒤에서 덮는다
    try {
      await ctx.suspend();
    } catch {
      // 이미 닫힘 - 무시
    }
  }

  #scheduleAmbientEvents(until) {
    const a = this.#ambient;
    if (!a) return;
    while (a.nextEvent < until) {
      this.#ambientEvent(a.out, a.nextEvent);
      a.nextEvent += 9 + Math.random() * 16;
    }
  }

  // 아주 작고 먼 소리 하나: 나무 두드림 / 배관 삐걱 / 둔탁한 쿵 (전부 낮고 음정 없는 소리 — 격발 사이에 '띠딩'이 끼지 않게)
  #ambientEvent(out, at) {
    const ctx = this.#ctx;
    const bus = ctx.createGain();
    bus.gain.value = AMBIENT.event;
    bus.connect(out);
    let live = 0; // 모든 소스가 끝나면 버스를 정리
    const finish = (src) => {
      live += 1;
      this.#track(src, () => {
        live -= 1;
        if (live === 0) bus.disconnect();
      });
    };
    const shape = (g, start, peak, attack, decay) => {
      g.gain.setValueAtTime(SILENT, start);
      g.gain.exponentialRampToValueAtTime(peak, start + attack);
      g.gain.exponentialRampToValueAtTime(SILENT, start + attack + decay);
    };
    const tone = (freq, to, peak, attack, decay, delay = 0) => {
      const s = at + delay;
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.frequency.setValueAtTime(freq, s);
      if (to) o.frequency.exponentialRampToValueAtTime(to, s + decay);
      shape(g, s, peak, attack, decay);
      o.connect(g);
      g.connect(bus);
      o.start(s);
      o.stop(s + attack + decay + 0.05);
      finish(o);
    };
    const hiss = (type, f0, f1, Q, peak, attack, decay) => {
      const n = ctx.createBufferSource();
      const f = ctx.createBiquadFilter();
      const g = ctx.createGain();
      n.buffer = this.#noise;
      n.loop = true;
      f.type = type;
      f.Q.value = Q;
      f.frequency.setValueAtTime(f0, at);
      if (f1) f.frequency.exponentialRampToValueAtTime(f1, at + attack + decay);
      shape(g, at, peak, attack, decay);
      n.connect(f);
      f.connect(g);
      g.connect(bus);
      n.start(at, Math.random() * (NOISE_SECONDS - 0.5));
      n.stop(at + attack + decay + 0.05);
      finish(n);
    };
    const kind = Math.floor(Math.random() * 3);
    if (kind === 0) { // 멀리서 나무 탁자를 두 번 두드리는 둔탁한 소리 (예전의 유리잔 '챙' 은 고음이 길게 울려 없앴다)
      hiss('lowpass', 420, 140, 0.8, 0.8, 0.002, 0.07);
      tone(150, 80, 0.4, 0.003, 0.09);
      tone(130, 70, 0.3, 0.003, 0.08, 0.16);
    } else if (kind === 1) { // 배관 삐걱
      hiss('bandpass', 460, 250, 7, 0.7, 0.5, 1.2);
    } else { // 둔탁한 쿵
      tone(64, 38, 0.9, 0.004, 0.4);
      hiss('lowpass', 180, 0, 0.7, 0.4, 0.004, 0.18);
    }
  }

  #setup(ctx) {
    this.#ctx = ctx;
    this.#master = ctx.createGain(); // 효과음 버스
    this.#master.gain.value = this.#muted || this.#away(ctx) ? 0 : this.#volume;
    this.#ambientBus = ctx.createGain(); // 배경음 버스
    this.#ambientBus.gain.value = this.#muted || this.#away(ctx) ? 0 : this.#ambientVolume;
    this.#ambientBus.connect(ctx.destination);
    this.#duck = ctx.createGain();
    this.#duck.connect(this.#ambientBus);
    this.#master.connect(ctx.destination);
    // 총성 체인: 총성 버스(증폭) → 컴프레서(피크를 눌러 음압을 키움) → 소프트클립(±1 보장) → 마스터. 마스터로 들어가므로 음량 · 음소거 · 화면 밖 무음을 그대로 따른다
    this.#gunClip = ctx.createWaveShaper();
    this.#gunClip.curve = softClipCurve();
    this.#gunClip.connect(this.#master);
    this.#gunComp = ctx.createDynamicsCompressor();
    for (const [name, value] of Object.entries(GUN_COMP)) this.#gunComp[name].value = value;
    this.#gunComp.connect(this.#gunClip);
    this.#gunBus = ctx.createGain();
    this.#gunBus.gain.value = GUN_BOOST;
    this.#gunBus.connect(this.#gunComp);
    if (!this.#visBound && typeof globalThis.document?.addEventListener === 'function') { // 가려지거나 포커스를 잃는 순간 곧바로 마스터를 0 으로 (돌아오면 원래 음량으로 — suspend 중이면 0 유지)
      this.#visBound = true;
      const onAway = () => (this.#away() ? this.#silence() : this.#applyVolumes());
      globalThis.document.addEventListener('visibilitychange', onAway);
      for (const type of ['blur', 'focus']) globalThis.window?.addEventListener?.(type, (e) => { if (e.target === globalThis.window) onAway(); }); // 입력칸 같은 요소의 blur 는 무시
    }
    const length = Math.floor(ctx.sampleRate * NOISE_SECONDS);
    this.#noise = ctx.createBuffer(1, length, ctx.sampleRate);
    const data = this.#noise.getChannelData(0);
    for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
  }

  // 잠금 1: 탭이 가려졌거나 창이 포커스를 잃었다. 스피커로 나가지 않는 OfflineAudioContext(테스트 · 측정)는 대상이 아니다
  #away(ctx = this.#ctx) {
    if (!ctx || 'startRendering' in ctx) return false;
    return pageHidden() || pageUnfocused();
  }

  // 바디 포화 곡선 (tanh 로 둥글게 눌린 출력). 컨텍스트마다 한 번만 만든다
  #saturation() {
    this.#curve ??= curveOf((x) => Math.tanh(SATURATE_DRIVE * x) / Math.tanh(SATURATE_DRIVE));
    return this.#curve;
  }

  // 소리를 낼 수 있는 상태의 컨텍스트 (화면 밖 · 닫힘 · 아직 없음이면 null, iOS에서 interrupted면 되살리고 null)
  // 화면 밖에서는 iOS 'interrupted' 복구도 하지 않는다 — 백그라운드에서 들어온 효과음 요청이 컨텍스트를 깨워 소리가 새던 원인
  #ready() {
    const ctx = this.#ctx;
    if (this.#held || !ctx || ctx.state === 'closed' || this.#away(ctx)) return null; // 가려지거나 포커스를 잃은 탭에서는 효과음을 만들지도 않는다 (잠금 1)
    if (ctx.state === 'interrupted') {
      ctx.resume().catch(() => {});
      return null;
    }
    return ctx;
  }

  // 레이어들을 한 번에 예약하고, 지금부터 소리가 끝날 때까지의 시간(초)을 반환
  #play(layers) {
    const ctx = this.#ready();
    if (!ctx) return 0;
    const t0 = ctx.currentTime + 0.01;
    let end = t0;
    for (const layer of layers) end = Math.max(end, this.#layer(ctx, t0, layer));
    return end - ctx.currentTime;
  }

  /**
   * 소리 한 겹: 오실레이터(osc 지정 시) 또는 화이트 노이즈 → (shape 면 포화) → 필터 체인 → 엔벌로프 GainNode → 마스터 (bus: 'gun' 이면 총성 버스 → 마스터)
   * filters: [type, freq, Q = 1, 목표 freq?, 스윕 시간?][]   shape: 파형을 WaveShaper 로 포화시켜 배음을 늘린다   반환: 끝나는 절대 시각
   */
  #layer(ctx, t0, { at = 0, bus, osc, freq, to, glide, shape = false, filters = [], peak, attack = 0.002, decay }) {
    const t = t0 + at;
    const end = t + attack + decay;
    let src;
    if (osc) {
      src = ctx.createOscillator();
      src.type = osc;
      src.frequency.setValueAtTime(freq, t);
      if (to) src.frequency.exponentialRampToValueAtTime(to, t + (glide ?? decay));
    } else {
      src = ctx.createBufferSource();
      src.buffer = this.#noise;
      src.loop = true;
    }
    let node = src;
    if (shape) { // 포화는 엔벌로프 앞에서 — 일정한 크기의 파형을 깎아야 배음이 고르게 늘고, 소리가 줄어드는 동안에도 두께가 유지된다
      const shaper = ctx.createWaveShaper();
      shaper.curve = this.#saturation();
      shaper.oversample = '2x'; // 포화로 생긴 고배음이 접혀 들어와 지직거리는(aliasing) 것을 줄인다
      node.connect(shaper);
      node = shaper;
    }
    for (const [type, f, Q = 1, fTo, fGlide] of filters) {
      const biquad = ctx.createBiquadFilter();
      biquad.type = type;
      biquad.Q.value = Q;
      biquad.frequency.setValueAtTime(f, t);
      if (fTo) biquad.frequency.exponentialRampToValueAtTime(fTo, t + (fGlide ?? decay));
      node.connect(biquad); // 구형 Safari는 connect()가 노드를 반환하지 않아 체이닝하지 않음
      node = biquad;
    }
    const amp = ctx.createGain();
    amp.gain.setValueAtTime(SILENT, t);
    amp.gain.exponentialRampToValueAtTime(peak, t + attack);
    amp.gain.exponentialRampToValueAtTime(SILENT, end);
    node.connect(amp);
    amp.connect(bus === 'gun' ? this.#gunBus : this.#master);
    if (osc) src.start(t);
    else src.start(t, Math.random() * (NOISE_SECONDS - 0.5)); // 노이즈 버퍼의 임의 지점부터 → 매번 다른 질감
    src.stop(end + 0.02);
    this.#track(src);
    return end + 0.02;
  }
}
