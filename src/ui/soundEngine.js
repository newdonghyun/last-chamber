/**
 * LAST CHAMBER - 효과음 엔진 (Web Audio API)
 *
 *   const sound = new SoundEngine();
 *   startButton.addEventListener('click', () => sound.unlock()); // 첫 사용자 클릭에서 오디오 활성화 (총성 녹음도 이때 불러옴)
 *   sound.playHeartbeat();                                         // play*()는 소리 길이(초) 반환, 활성화 전이면 0
 *
 * - 총성(playGunshot)만 실제 녹음(assets/audio/gunshot.wav)을 재생하고, 나머지 효과음은 외부 파일 없이 실시간 합성한다.
 * - 녹음을 아직 못 불러왔거나 불러오기에 실패하면 합성 총성으로 대신 재생한다 (소리가 비지 않음).
 * - 배경 앰비언트(startAmbient)는 음악이 아니라 저음 드론·실내 소음·전등 험·드문 먼 소리를 합성해 까는 소리 바닥이다.
 *   setTension(0~1)으로 긴장도에 따라 서서히 커지고, duckAmbient()는 총성 때 잠깐 낮춘다.
 *   효과음 음량(volume)·배경음 음량(ambientVolume)·음소거(muted)는 따로 조절한다.
 * - 생명주기 (src/ui/lifecycle.js 가 부른다):
 *   suspend()  화면을 떠남 → 즉시 무음 · 울리던 효과음 끊기 · 배경음 예약 타이머 정지 · 컨텍스트 정지. resume() 전까지는
 *              효과음 요청을 버리고(돌아왔을 때 몰아서 터지지 않게) 무엇도 컨텍스트를 다시 깨우지 못한다 (unlock() · iOS 'interrupted' 복구 포함).
 *   resume()   화면으로 돌아옴 → 컨텍스트 재가동 · 음량 복구 · 배경음 예약 재개 (close() 뒤라면 새 컨텍스트를 만들고 배경음도 이어서 켠다)
 *   close()    페이지 이탈 → 모든 소스 정지 · 타이머 해제 · 컨텍스트 close()
 * - 총성 출처: Freesound "Small pistol gunshot indoors" by acidsnowflake (#402789), CC0 1.0 (저작자 표시 불필요).
 *   미리듣기 MP3에서 한 발(4ms 앞부터 1.5초)을 잘라 25Hz 하이패스 → 피크 −1dBFS 정규화 → 모노 16비트 WAV.
 *   다른 총성으로 바꾸려면 같은 이름으로 파일만 교체하면 된다.
 *
 * 사용 노드: OscillatorNode, 화이트 노이즈·총성 AudioBuffer(AudioBufferSourceNode), BiquadFilterNode, GainNode
 */

const NOISE_SECONDS = 2;
const GUNSHOT_URL = new URL('../../assets/audio/gunshot.wav', import.meta.url);
const GUNSHOT_GAIN = 0.8; // 녹음은 피크 −1dBFS라, 피격음 등과 겹쳐도 넘치지 않게 낮춰 재생

// 앰비언트 층별 기본 음량 (효과음이 늘 앞에 서도록 아주 낮게)
const AMBIENT = { room: 0.2, air: 0.03, drone: 0.05, hum: 0.014, tension: 0.07, event: 0.06 };
const AMBIENT_FADE_IN = 3; // 초
const DRONE_PARTIALS = [['sine', 55, 0.5], ['sawtooth', 55.35, 0.16], ['sine', 82.4, 0.16], ['triangle', 110.1, 0.1], ['sine', 36.7, 0.2]]; // A1 + 약간 어긋난 톱니파(맥놀이) + 완전5도 + 서브
const SILENT = 0.0001; // 지수 램프는 0으로 갈 수 없어 -80dB를 무음으로 사용
const BAR_MODES = [1, 2.756, 5.404, 8.933]; // 금속 막대 고유 진동 비율(비정수배) → 황동/쇠 질감
const clamp01 = (v) => Math.min(1, Math.max(0, Number(v) || 0));
const vary = (value, spread = 0.04) => value * (1 + (Math.random() * 2 - 1) * spread); // 매번 미세하게 다른 소리

// 금속 부품이 맞물리는 '철컥' 한 번: 짧은 쇳소리 + 금속 울림 + 낮은 몸통음
const clank = (at, click, body, peak) => [
  { at, filters: [['bandpass', vary(click), 2.5]], peak, attack: 0.0006, decay: 0.03 },
  { at, osc: 'sine', freq: vary(click * 0.67), peak: peak * 0.1, attack: 0.001, decay: 0.1 },
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
  #gunshot = null; // 실제 총성 녹음 (디코드된 AudioBuffer)
  #gunshotUrl;
  #loading = null;
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
  #unlockedOnce = false; // 사용자가 한 번이라도 오디오를 켰는가 (close() 뒤 돌아오면 새 컨텍스트를 만들어도 되는가)
  #tension = 0;

  /**
   * @param {{ volume?: number, ambientVolume?: number, muted?: boolean, context?: BaseAudioContext, gunshotUrl?: string | URL | null }} [options]
   *   volume: 효과음 0~1 (기본 0.8) / ambientVolume: 배경음 0~1 (기본 0.6) / muted: 전체 음소거
   *   context: 이미 있는 AudioContext나 OfflineAudioContext를 쓸 때 / gunshotUrl: 총성 녹음 파일 (null이면 항상 합성 총성)
   */
  constructor({ volume = 0.8, ambientVolume = 0.6, muted = false, context = null, gunshotUrl = GUNSHOT_URL } = {}) {
    this.#volume = clamp01(volume);
    this.#ambientVolume = clamp01(ambientVolume);
    this.#muted = Boolean(muted);
    this.#gunshotUrl = gunshotUrl;
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
    this.#ctx = this.#master = this.#ambientBus = this.#duck = this.#noise = null;
    this.#gunshot = null;
    this.#loading = null;
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
      this.preload(); // 총성 녹음은 백그라운드로 불러온다 (끝나기 전엔 합성 총성으로 대신)
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

  /** 총성 녹음을 불러와 디코드한다 (여러 번 불러도 한 번만). 성공하면 true, 실패하면 false → 합성 총성으로 대신한다. */
  preload() {
    this.#loading ??= this.#loadGunshot();
    return this.#loading;
  }

  /** 지금 총성이 실제 녹음인가 (아직 불러오는 중이거나 실패했으면 false) */
  get hasRecordedGunshot() {
    return this.#gunshot !== null;
  }

  /** 1) 공포탄: 해머가 빈 약실을 때리는 차갑고 짧은 '찰칵' */
  playClick() {
    return this.#play([
      // 찰: 날카로운 쇳소리 트랜지언트
      { filters: [['highpass', 1800], ['bandpass', vary(4800), 2.5]], peak: 0.9, attack: 0.0005, decay: 0.014 },
      // 쇳조각 울림 (비정수배 고음 → 차가운 금속)
      { osc: 'sine', freq: vary(3150), peak: 0.1, attack: 0.0008, decay: 0.06 },
      { osc: 'sine', freq: vary(4730), peak: 0.07, attack: 0.0008, decay: 0.045 },
      { osc: 'sine', freq: vary(7090), peak: 0.04, attack: 0.0008, decay: 0.03 },
      // 칵: 공이가 되튕기는 두 번째 클릭
      { at: 0.021, filters: [['bandpass', vary(3200), 3]], peak: 0.6, attack: 0.0005, decay: 0.018 },
      // 아주 작은 기계 몸통음
      { osc: 'triangle', freq: 260, to: 140, glide: 0.03, peak: 0.12, attack: 0.001, decay: 0.035 },
    ]);
  }

  /** 2) 실탄: 실제 녹음한 실내 총성 (매번 음높이 ±3%·음량 ±8%로 미세하게 다르게). 녹음이 없으면 합성 총성 */
  playGunshot() {
    if (!this.#gunshot) return this.#synthGunshot();
    return this.#playSample(this.#gunshot, vary(GUNSHOT_GAIN, 0.08), vary(1, 0.03));
  }

  // 합성 총성 (녹음을 못 불러왔을 때의 대체): 저음 펀치 + 노이즈 폭음 + 반사음/잔향이 섞인 묵직한 총성
  #synthGunshot() {
    return this.#play([
      // 파열음: 고역 크랙
      { filters: [['highpass', 1000]], peak: 0.34, attack: 0.0005, decay: 0.04 },
      // 폭음 본체: 밝게 터진 뒤 빠르게 어두워지는 노이즈
      { filters: [['lowpass', 6000, 1, 320, 0.35]], peak: 0.38, attack: 0.001, decay: 0.5 },
      // 저음 펀치 + 서브 '쿵'
      { osc: 'sine', freq: 150, to: 42, glide: 0.18, peak: 0.42, attack: 0.003, decay: 0.38 },
      { osc: 'triangle', freq: 75, to: 32, glide: 0.35, peak: 0.2, attack: 0.006, decay: 0.55 },
      // 초기 반사음 (좁은 방)
      { at: 0.085, filters: [['bandpass', 900, 0.8]], peak: 0.16, attack: 0.004, decay: 0.14 },
      { at: 0.19, filters: [['lowpass', 700]], peak: 0.1, attack: 0.006, decay: 0.2 },
      // 잔향 꼬리
      { at: 0.012, filters: [['highpass', 120], ['lowpass', 1600, 1, 240, 1.6]], peak: 0.24, attack: 0.05, decay: 1.9 },
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
      // 금속 막대 고유 진동
      ...BAR_MODES.map((ratio, i) => ({
        at: 0.008, osc: 'sine', freq: base * ratio, peak: 0.15 / (i + 1) ** 0.9, attack: 0.001, decay: 0.45 / (i + 1) ** 0.6,
      })),
      // 손끝 금속 접촉음
      { at: 0.09, filters: [['bandpass', vary(3400), 5]], peak: 0.25, attack: 0.0005, decay: 0.015 },
    ]);
  }

  /** 6) 피격: 낮은 타격음 + 어둡게 깎은 하강 경고음(붉은 경고) + 옅은 귀울림 */
  playDamage() {
    const alarm = [[0.08, 330], [0.27, 277]].flatMap(([at, f]) => [f, f * 1.012].map((freq) => ({
      at, osc: 'sawtooth', freq, to: freq * 0.94, glide: 0.15, filters: [['lowpass', 1500, 6]],
      peak: 0.08, attack: 0.012, hold: 0.09, decay: 0.07,
    })));
    return this.#play([
      // 몸에 꽂히는 저음 타격 (총성과 동시에 재생해도 펀치가 포개지지 않게 50ms 뒤)
      { at: 0.05, osc: 'sine', freq: 95, to: 34, glide: 0.22, peak: 0.5, attack: 0.003, decay: 0.32 },
      { at: 0.05, filters: [['lowpass', 700, 1, 150, 0.15]], peak: 0.42, attack: 0.002, decay: 0.18 },
      { at: 0.05, filters: [['bandpass', 1200, 1]], peak: 0.18, attack: 0.0006, decay: 0.03 },
      ...alarm,
      // 귀울림
      { at: 0.08, osc: 'sine', freq: 2900, peak: 0.02, attack: 0.06, decay: 0.6 },
    ]);
  }

  /**
   * 배경 앰비언트 시작: 저음 드론 + 실내 소음 + 전등 험 + 드문 먼 소리(잔 부딪힘·배관·둔탁한 쿵). 이미 켜져 있으면 무시.
   * preschedule: 처음에 미리 깔아 둘 '드문 소리'의 길이(초). 실시간에서는 4초마다 이어서 예약한다.
   */
  startAmbient({ preschedule = 12 } = {}) {
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
    const off = this.#muted || this.#held; // 화면 밖에서 음량을 바꿔도 무음은 그대로 (돌아올 때 resume()이 올린다)
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

  // 아주 작고 먼 소리 하나: 잔 부딪힘 / 배관 삐걱 / 둔탁한 쿵
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
    if (kind === 0) { // 먼 잔 부딪힘 (비정수배 배음 → 유리/금속)
      const f = 2300 + Math.random() * 900;
      tone(f, 0, 0.5, 0.001, 0.55);
      tone(f * 1.505, 0, 0.28, 0.001, 0.4);
      tone(f * 2.31, 0, 0.15, 0.001, 0.25);
      tone(f * 0.94, 0, 0.3, 0.001, 0.35, 0.17); // 살짝 뒤늦은 두 번째 '챙'
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
    this.#master.gain.value = this.#muted ? 0 : this.#volume;
    this.#master.connect(ctx.destination);
    this.#ambientBus = ctx.createGain(); // 배경음 버스
    this.#ambientBus.gain.value = this.#muted ? 0 : this.#ambientVolume;
    this.#ambientBus.connect(ctx.destination);
    this.#duck = ctx.createGain();
    this.#duck.connect(this.#ambientBus);
    const length = Math.floor(ctx.sampleRate * NOISE_SECONDS);
    this.#noise = ctx.createBuffer(1, length, ctx.sampleRate);
    const data = this.#noise.getChannelData(0);
    for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
  }

  // 소리를 낼 수 있는 상태의 컨텍스트 (화면 밖 · 닫힘 · 아직 없음이면 null, iOS에서 interrupted면 되살리고 null)
  // 화면 밖에서는 iOS 'interrupted' 복구도 하지 않는다 — 백그라운드에서 들어온 효과음 요청이 컨텍스트를 깨워 소리가 새던 원인
  #ready() {
    const ctx = this.#ctx;
    if (this.#held || !ctx || ctx.state === 'closed') return null;
    if (ctx.state === 'interrupted') {
      ctx.resume().catch(() => {});
      return null;
    }
    return ctx;
  }

  async #loadGunshot() {
    const ctx = this.#ctx;
    if (!ctx || !this.#gunshotUrl || typeof fetch !== 'function') return false;
    try {
      const res = await fetch(this.#gunshotUrl);
      if (!res.ok) return false;
      const data = await res.arrayBuffer();
      // 구형 Safari는 decodeAudioData가 Promise를 돌려주지 않아 콜백과 Promise를 함께 받는다
      const buffer = await new Promise((resolve, reject) => {
        const decoding = ctx.decodeAudioData(data, resolve, reject);
        if (typeof decoding?.then === 'function') decoding.then(resolve, reject);
      });
      if (this.#ctx !== ctx) return false; // 불러오는 사이 close() 됨 — 새 컨텍스트가 다시 불러온다
      this.#gunshot = buffer;
      return true;
    } catch {
      return false; // 파일이 없거나 디코드에 실패 → 합성 총성으로 대신
    }
  }

  // 녹음된 AudioBuffer를 한 번 재생하고, 끝날 때까지의 시간(초)을 반환
  #playSample(buffer, gain, rate) {
    const ctx = this.#ready();
    if (!ctx) return 0;
    const t = ctx.currentTime + 0.01;
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.playbackRate.value = rate;
    const amp = ctx.createGain();
    amp.gain.value = gain;
    src.connect(amp);
    amp.connect(this.#master);
    src.start(t);
    this.#track(src);
    return t - ctx.currentTime + buffer.duration / rate;
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
   * 소리 한 겹: 오실레이터(osc 지정 시) 또는 화이트 노이즈 → 필터 체인 → 엔벌로프 GainNode → 마스터
   * filters: [type, freq, Q = 1, 목표 freq?, 스윕 시간?][]   반환: 끝나는 절대 시각
   */
  #layer(ctx, t0, { at = 0, osc, freq, to, glide, filters = [], peak, attack = 0.002, hold = 0, decay }) {
    const t = t0 + at;
    const end = t + attack + hold + decay;
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
    if (hold) amp.gain.setValueAtTime(peak, t + attack + hold);
    amp.gain.exponentialRampToValueAtTime(SILENT, end);
    node.connect(amp);
    amp.connect(this.#master);
    if (osc) src.start(t);
    else src.start(t, Math.random() * (NOISE_SECONDS - 0.5)); // 노이즈 버퍼의 임의 지점부터 → 매번 다른 질감
    src.stop(end + 0.02);
    this.#track(src);
    return end + 0.02;
  }
}
