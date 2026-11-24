/**
 * LAST CHAMBER - 멀티 플랫폼 어댑터 (web · app(Capacitor) · toss(앱인토스))
 *
 *   UI(app.js)는 플랫폼별 SDK를 직접 부르지 않고, 아래 표준 메서드만 호출한다.
 *     getPlatform()                              'web' | 'app' | 'toss'
 *     showRewardedAd(placementId)                → Promise<{ rewarded: boolean, reason?: string }>
 *     purchaseProduct(productId, priceKRW, meta) → Promise<{ success: boolean, reason?: string }>   (meta.title: 결제창에 보일 상품명)
 *     triggerHaptic('shot' | 'hit' | 'win' | 'lose')     결정적인 순간에만 짧은 진동 1회 — 실탄 발사 / 피격 / 승리 확정 / 패배 확정 (→ true: 울림, false: 무시)
 *                   ('medium' | 'heavy' 로 세기를 직접 지정할 수도 있다. 그 밖의 이름 · 300ms 쿨타임 안의 요청 · 미지원 기기는 조용히 무시)
 *
 *   실제 SDK가 연결되기 전에는
 *     · 개발 PC(localhost 웹)에서만 시뮬레이션: 광고 = 1.5초 오버레이 뒤 { rewarded: true } · 결제 = '모의 결제' 모달에서 [결제하기] → { success: true }
 *     · 그 밖(공개 웹 · 앱 · 토스)에서는 { rewarded/success: false, reason: 'unavailable' } — 화면은 isAvailable('ads' | 'purchase') 로 '준비 중'을 그린다
 *   실제 SDK 드라이버가 연결된 플랫폼에서는 SDK가 실패하면 절대 보상·결제를 성공으로 만들지 않는다.
 *
 * ┌─ ★ 실제 SDK 연결 지점 ──────────────────────────────────────────────────────────────
 * │ ① Capacitor(app)  : createCapacitorDriver() — 진동(Haptics)은 연결됨. 보상형 광고(AdMob)·인앱결제는 [HOOK] 두 곳을 채우면 된다.
 * │ ② 앱인토스(toss)  : createTossDriver(sdk, config) — 광고(GoogleAdMob)·결제(IAP)·햅틱이 이미 구현돼 있다.
 * │                     토스 빌드의 번들 진입점에서 SDK를 넘겨 등록만 하면 끝:
 * │                       import * as sdk from '@apps-in-toss/web-framework';
 * │                       platformBridge.registerDriver('toss', createTossDriver(sdk, { adGroupIds: {...}, skus: {...} }));
 * │ ③ 그 밖의 SDK     : platformBridge.registerDriver(platform, { showRewardedAd, purchase, haptic }) — 필요한 메서드만 넘겨도 된다.
 * └──────────────────────────────────────────────────────────────────────────────────────
 *
 *   드라이버 규약: showRewardedAd(placementId) → Promise<{ rewarded }> · purchase(productId, priceKRW, meta) → Promise<{ success }>
 *                  haptic(type) → false를 돌려주면 '처리 못 함'으로 보고 navigator.vibrate로 대체한다.
 *   메서드를 안 넘기면 그 기능만 시뮬레이션(광고·결제)/웹 진동(햅틱)으로 동작한다.
 *   ⚠ 앱·토스 정식 빌드를 내기 전에 광고·결제 드라이버를 반드시 연결할 것 — 미연결이면 시뮬레이션(무료 지급)으로 동작한다.
 *   ⚠ 클라이언트만으로는 결제 검증이 안 된다. 실서비스에서는 서버에서 영수증/주문을 검증한 뒤 지급해야 한다.
 */

export const PLATFORM = Object.freeze({ WEB: 'web', APP: 'app', TOSS: 'toss' });
export const SIM_AD_MS = 1500; // 광고 시청 시뮬레이션 시간
const DEV_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']); // 시뮬레이션을 허용하는 개발 PC 주소
// 진동은 결정적인 순간에만, 짧게 한 번씩 (연타 · 패턴 없음). 이벤트 → 세기 — 이벤트별 진동을 바꾸려면 이 표만 고치면 된다.
//   shot  실탄 발사 (상대가 맞음)     ImpactStyle.Medium
//   hit   피격 (내가 데미지를 입음)   ImpactStyle.Heavy
//   win   게임 승리 확정              ImpactStyle.Medium
//   lose  게임 패배 확정              ImpactStyle.Heavy
// 일반 버튼 · 턴 전환 · 대기 · 아이템 · 장전 · 공포탄 · 상점 연출 같은 사소한 이벤트는 표에 없다 → 이름을 넘겨도 울리지 않는다
// (예전 이름 'light' · 'item' · 'shot_blank' · 'shot_live' 도 마찬가지로 무시된다).
const HAPTIC_EVENTS = Object.freeze({ shot: 'medium', hit: 'heavy', win: 'medium', lose: 'heavy', medium: 'medium', heavy: 'heavy' });
/** 진동 쿨타임 — 이 간격 안에 다시 오는 진동 요청은 버린다 (같은 순간에 겹친 이벤트 · 중복 수신으로 두 번 울리지 않게) */
export const HAPTIC_COOLDOWN_MS = 300;

/** 요청한 이름 → 'medium' | 'heavy' | null(무시). 'toString' 같은 객체 속성 이름도 null */
function hapticStrength(type) {
  return Object.prototype.hasOwnProperty.call(HAPTIC_EVENTS, type) ? HAPTIC_EVENTS[type] : null;
}

// ───────── 1. 실행 환경 감지 ─────────

/**
 * 우선순위: URL ?platform=toss → Capacitor 네이티브 셸 → 토스 웹뷰 브릿지 → web
 *
 * 토스 웹뷰 판별은 @apps-in-toss/web-bridge 소스 조사 결과 기준이다.
 *   - __CONSTANT_HANDLER_MAP    : 브릿지가 읽기만 하는 값 → 토스 앱이 주입하는 것으로 보임 (실기기 확인 필요)
 *   - ReactNativeWebView        : 토스 앱 웹뷰의 메시지 통로. 일반 RN 웹뷰에도 있어 단독으로는 쓰지 않는다.
 *   - __GRANITE_NATIVE_EMITTER  : 브릿지 패키지가 어떤 브라우저에서든 스스로 만드는 값 → ReactNativeWebView와 함께일 때만 신호로 쓴다.
 *   - 문서화된 User-Agent 표식은 없다.
 * 실제 토스 환경에서 다르게 보이면 이 함수의 조건만 고치면 된다.
 */
export function detectPlatform(env = globalThis) {
  try {
    if (new URLSearchParams(env.location?.search ?? '').get('platform') === 'toss') return PLATFORM.TOSS;
    const cap = env.Capacitor;
    // 웹에 @capacitor/core만 올라간 경우(isNativePlatform() === false)는 앱으로 보지 않는다
    if (cap && (typeof cap.isNativePlatform !== 'function' || cap.isNativePlatform())) return PLATFORM.APP;
    if (env.__CONSTANT_HANDLER_MAP || (env.ReactNativeWebView && env.__GRANITE_NATIVE_EMITTER)) return PLATFORM.TOSS;
  } catch {
    // 감지 중 예외 → 가장 안전한 web
  }
  return PLATFORM.WEB;
}

// ───────── 2. 진동 ─────────

// navigator.vibrate (ms) — 패턴 없이 짧은 한 번
const VIBRATE_PATTERN = { medium: 20, heavy: 35 };
// @capacitor/haptics 의 ImpactStyle 값 (Medium = 'MEDIUM' · Heavy = 'HEAVY'). 번들러 없이는 패키지를 import 할 수 없어서 같은 문자열을 직접 쓴다.
const CAP_IMPACT = { medium: 'MEDIUM', heavy: 'HEAVY' };
// 앱인토스 generateHapticFeedback type — 실기기에서 강도를 느껴 보고 이 표만 조정하면 된다
const TOSS_HAPTIC = { medium: 'tickMedium', heavy: 'basicMedium' };

function webVibrate(env, type) {
  const nav = env.navigator;
  if (!nav || typeof nav.vibrate !== 'function') return; // 데스크톱·iOS 등 미지원
  if (nav.userActivation && nav.userActivation.hasBeenActive === false) return; // 첫 터치 전에는 브라우저가 막고 경고를 남긴다
  try {
    nav.vibrate(VIBRATE_PATTERN[type]);
  } catch {
    // 지원하지 않는 환경 → 무시
  }
}

// ───────── 3. 개발용 시뮬레이션 화면 (style.css .sim-dialog 계열) ─────────

const EMBLEM_SVG = `
<svg viewBox="0 0 100 100" aria-hidden="true" focusable="false">
  <defs>
    <radialGradient id="sim-steel" cx=".36" cy=".28" r=".85"><stop offset="0" stop-color="#96a1b3"/><stop offset=".35" stop-color="#3b424e"/><stop offset="1" stop-color="#07080a"/></radialGradient>
    <radialGradient id="sim-case" cx=".38" cy=".32" r=".75"><stop offset="0" stop-color="#fff1c8"/><stop offset=".45" stop-color="#c9a35b"/><stop offset="1" stop-color="#5a4216"/></radialGradient>
  </defs>
  <circle cx="50" cy="50" r="46" fill="url(#sim-steel)"/>
  <circle cx="50" cy="50" r="45" fill="none" stroke="#b6c1d2" stroke-opacity=".35"/>
  <g fill="#050608" stroke="#69737f" stroke-opacity=".6">
    <circle cx="50" cy="24" r="9.5"/><circle cx="72.5" cy="37" r="9.5"/><circle cx="72.5" cy="63" r="9.5"/>
    <circle cx="50" cy="76" r="9.5"/><circle cx="27.5" cy="63" r="9.5"/><circle cx="27.5" cy="37" r="9.5"/>
  </g>
  <circle cx="50" cy="24" r="8" fill="url(#sim-case)"/>
  <circle cx="50" cy="50" r="8.5" fill="url(#sim-case)"/>
</svg>`;

function buildDialog(doc, kind, markup) {
  const dlg = doc.createElement('dialog');
  dlg.className = `sim-dialog sim-${kind}`;
  dlg.innerHTML = markup;
  return dlg;
}

function openModal(doc, dlg) {
  doc.body.append(dlg);
  try {
    dlg.showModal();
  } catch {
    dlg.setAttribute('open', ''); // showModal 미지원 WebView 대비
  }
}

function closeDialog(dlg) {
  try {
    dlg.close();
  } catch {
    dlg.removeAttribute('open');
  }
  dlg.remove();
}

/** 광고 시청 시뮬레이션: 느와르 오버레이를 ms 동안 보여 주고 { rewarded: true } (Esc로 닫으면 보상 없음) */
function simulateAd(env, placementId, ms) {
  const doc = env.document;
  if (!doc?.body || typeof doc.createElement !== 'function') return Promise.resolve({ rewarded: true }); // DOM 없는 환경
  return new Promise((resolve) => {
    const dlg = buildDialog(doc, 'ad', `
      <div class="sim-bar sim-bar-top" aria-hidden="true"></div>
      <div class="sim-bar sim-bar-bottom" aria-hidden="true"></div>
      <div class="sim-card">
        <p class="sim-tag"><i></i>ADVERTISEMENT · 시뮬레이션</p>
        <div class="sim-emblem" aria-hidden="true">${EMBLEM_SVG}</div>
        <h2 class="sim-title">광고 시청 중</h2>
        <p class="sim-desc">실제 광고 SDK가 연결되기 전의 개발용 화면입니다</p>
        <div class="sim-progress" aria-hidden="true"><i></i></div>
        <p class="sim-count" aria-hidden="true"><b data-sim="remain"></b>초 뒤 보상이 지급됩니다</p>
        <p class="sim-meta">placement · <code data-sim="placement"></code></p>
      </div>`);
    dlg.setAttribute('aria-label', '광고 시청 시뮬레이션');
    dlg.style.setProperty('--sim-ms', `${ms}ms`);
    dlg.querySelector('[data-sim="placement"]').textContent = placementId;
    const remain = dlg.querySelector('[data-sim="remain"]');
    const startedAt = performance.now();
    const paint = () => { remain.textContent = (Math.max(0, ms - (performance.now() - startedAt)) / 1000).toFixed(1); };
    paint();

    let finished = false;
    let tick = 0;
    let timer = 0;
    const finish = (result) => {
      if (finished) return;
      finished = true;
      clearInterval(tick);
      clearTimeout(timer);
      closeDialog(dlg);
      resolve(result);
    };
    dlg.addEventListener('cancel', (ev) => { // Esc = 광고를 중간에 닫음 → 보상 없음
      ev.preventDefault();
      finish({ rewarded: false, reason: 'dismissed' });
    });
    tick = setInterval(paint, 100);
    timer = setTimeout(() => finish({ rewarded: true }), ms);
    openModal(doc, dlg);
    dlg.focus?.();
  });
}

/** 모의 결제: 확인 모달에서 [결제하기]면 { success: true }, 취소·Esc면 { success: false, reason: 'cancelled' } */
function simulatePurchase(env, productId, priceKRW, meta) {
  const doc = env.document;
  if (!doc?.body || typeof doc.createElement !== 'function') return Promise.resolve({ success: true });
  return new Promise((resolve) => {
    const price = `₩${Number(priceKRW).toLocaleString('ko-KR')}`;
    const dlg = buildDialog(doc, 'pay', `
      <form method="dialog" class="sim-card">
        <p class="sim-tag"><i></i>PAYMENT · 시뮬레이션</p>
        <h2 class="sim-title">결제 확인</h2>
        <dl class="sim-receipt">
          <div><dt>상품</dt><dd data-sim="title"></dd></div>
          <div><dt>상품 ID</dt><dd><code data-sim="id"></code></dd></div>
          <div class="is-total"><dt>결제 금액</dt><dd data-sim="price"></dd></div>
        </dl>
        <p class="sim-desc">개발용 모의 결제입니다. 실제로 결제되지 않아요</p>
        <div class="sim-actions">
          <button class="sim-btn" type="submit" value="cancel" formnovalidate>취소</button>
          <button class="sim-btn is-primary" type="submit" value="ok" data-sim="ok">결제하기</button>
        </div>
      </form>`);
    dlg.setAttribute('aria-label', '모의 결제 확인');
    dlg.querySelector('[data-sim="title"]').textContent = meta?.title || productId;
    dlg.querySelector('[data-sim="id"]').textContent = productId;
    dlg.querySelector('[data-sim="price"]').textContent = price;
    dlg.querySelector('[data-sim="ok"]').textContent = `${price} 결제하기`;

    let finished = false;
    dlg.addEventListener('close', () => { // 버튼(returnValue) 또는 Esc(returnValue '')로 닫힘
      if (finished) return;
      finished = true;
      const ok = dlg.returnValue === 'ok';
      dlg.remove();
      resolve(ok ? { success: true } : { success: false, reason: 'cancelled' });
    });
    openModal(doc, dlg);
    dlg.querySelector('[data-sim="ok"]').focus();
  });
}

// ───────── 4. 플랫폼 드라이버 (★ 실제 SDK 연결 지점) ─────────

/**
 * ① Capacitor 드라이버. 번들러 없이도 쓸 수 있도록 window.Capacitor.Plugins.* 에서 플러그인을 늦게 찾는다.
 *   - haptic : @capacitor/haptics (연결됨) — 앱에서는 네이티브가 window.Capacitor.Plugins.Haptics 를 만들어 주므로 import 가 필요 없다 (cap sync 로 플러그인이 등록돼 있어야 한다)
 *   - 광고·결제는 아래 [HOOK]을 채우면 된다. 비워 두면 시뮬레이션으로 동작한다.
 */
export function createCapacitorDriver(cap) {
  const plugin = (name) => cap?.Plugins?.[name];
  return {
    haptic(type) {
      const haptics = plugin('Haptics');
      if (typeof haptics?.impact !== 'function') return false; // 플러그인 미설치 → 웹 진동으로 대체
      Promise.resolve(haptics.impact({ style: CAP_IMPACT[type] })).catch(() => {});
      return true;
    },

    // [HOOK ①-a] 보상형 광고 — @capacitor-community/admob 예 (버전마다 API가 달라 설치한 버전의 README를 확인할 것):
    //   async showRewardedAd(placementId) {
    //     const AdMob = plugin('AdMob');
    //     let earned = false;
    //     const rewarded = await AdMob.addListener('onRewardedVideoAdReward', () => { earned = true; }); // RewardAdPluginEvents.Rewarded
    //     try {
    //       await AdMob.prepareRewardVideoAd({ adId: AD_UNIT_IDS[placementId] }); // 개발 중에는 구글 테스트 광고 단위 ID 사용
    //       await AdMob.showRewardVideoAd();                                       // 닫힐 때까지 기다린 뒤
    //     } finally { await rewarded.remove(); }
    //     return { rewarded: earned };                                              // 끝까지 봐야만 true
    //   },
    showRewardedAd: undefined,

    // [HOOK ①-b] 인앱 결제 — 쓰는 결제 플러그인(RevenueCat · cordova-plugin-purchase · native-purchases 등)에 맞춰 구현:
    //   async purchase(productId, priceKRW, meta) { ...결제 성공 시 { success: true } / 취소 시 { success: false, reason: 'cancelled' } },
    purchase: undefined,
  };
}

/**
 * ② 앱인토스 드라이버. SDK(@apps-in-toss/web-framework)는 번들러가 필요하므로 이 파일이 직접 import하지 않고, 호출하는 쪽이 넘겨준다.
 *   config.adGroupIds : { double_reward, streak_protect, skin_trial, default } → 토스 콘솔의 광고 그룹 ID
 *   config.skus       : { productId → 토스 콘솔의 상품 sku }  (없으면 productId를 그대로 sku로 사용)
 *   config.grant      : (productId, orderId) => boolean | Promise<boolean> — 서버 지급 처리 (생략하면 지급 완료로 응답)
 *   보상은 'userEarnedReward' 이벤트가 온 경우에만 true — 'dismissed'만으로는 끝까지 봤는지 알 수 없다.
 */
export function createTossDriver(sdk, config = {}) {
  const ads = sdk?.GoogleAdMob;
  const iap = sdk?.IAP;
  const loadTimeoutMs = config.loadTimeoutMs ?? 15000;
  const driver = {};

  if (typeof ads?.loadAppsInTossAdMob === 'function' && typeof ads?.showAppsInTossAdMob === 'function') {
    driver.showRewardedAd = (placementId) => new Promise((resolve) => {
      const adGroupId = config.adGroupIds?.[placementId] ?? config.adGroupIds?.default;
      if (!adGroupId) return resolve({ rewarded: false, reason: 'no_ad_group' });
      try {
        if (ads.loadAppsInTossAdMob.isSupported?.() === false || ads.showAppsInTossAdMob.isSupported?.() === false) {
          return resolve({ rewarded: false, reason: 'unsupported' });
        }
      } catch {
        return resolve({ rewarded: false, reason: 'unsupported' }); // 토스 앱 밖에서는 isSupported()가 예외를 던진다
      }

      let settled = false;
      let earned = false;
      let unregister = null;
      let loadTimer = 0;
      const done = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(loadTimer);
        try { unregister?.(); } catch { /* 이미 해제됨 */ } // 광고가 닫힌 뒤에는 콜백을 반드시 해제해야 한다
        resolve(result);
      };

      loadTimer = setTimeout(() => done({ rewarded: false, reason: 'timeout' }), loadTimeoutMs);
      ads.loadAppsInTossAdMob({
        options: { adGroupId },
        onEvent: (event) => {
          if (event?.type !== 'loaded' || settled) return;
          clearTimeout(loadTimer);
          unregister = ads.showAppsInTossAdMob({
            options: { adGroupId },
            onEvent: (e) => {
              if (e?.type === 'userEarnedReward') earned = true;
              else if (e?.type === 'dismissed') done(earned ? { rewarded: true } : { rewarded: false, reason: 'dismissed' });
              else if (e?.type === 'failedToShow') done({ rewarded: false, reason: 'failed_to_show' });
            },
            onError: () => done({ rewarded: false, reason: 'error' }),
          });
          if (settled) { try { unregister?.(); } catch { /* noop */ } }
        },
        onError: () => done({ rewarded: false, reason: 'load_failed' }),
      });
    });
  }

  if (typeof iap?.createOneTimePurchaseOrder === 'function') {
    driver.purchase = (productId) => new Promise((resolve) => {
      // 토스 앱이 너무 낮은 버전이면 createOneTimePurchaseOrder가 아무 일도 없이 끝나므로 먼저 막는다
      if (typeof sdk.isMinVersionSupported === 'function'
        && !sdk.isMinVersionSupported({ android: '5.219.0', ios: '5.219.0' })) {
        return resolve({ success: false, reason: 'unsupported' });
      }
      let settled = false;
      let cleanup = null;
      const done = (result) => {
        if (settled) return;
        settled = true;
        try { cleanup?.(); } catch { /* noop */ }
        resolve(result);
      };
      cleanup = iap.createOneTimePurchaseOrder({
        options: {
          sku: config.skus?.[productId] ?? productId,
          processProductGrant: async ({ orderId } = {}) => (config.grant ? config.grant(productId, orderId) : true),
        },
        onEvent: (event) => { if (event?.type === 'success') done({ success: true }); },
        onError: (err) => done({ success: false, reason: err?.code === 'USER_CANCELED' ? 'cancelled' : 'error' }),
      });
      if (settled) { try { cleanup?.(); } catch { /* noop */ } }
    });
  }

  if (typeof sdk?.generateHapticFeedback === 'function') {
    driver.haptic = (type) => sdk.generateHapticFeedback({ type: TOSS_HAPTIC[type] });
  }
  return driver;
}

// ───────── 5. PlatformBridge — UI가 쓰는 유일한 창구 ─────────

export class PlatformBridge {
  #env;
  #platform;
  #simMs;
  #drivers = new Map();
  #busy = false; // 광고·결제 화면은 한 번에 하나만
  #noted = new Set();
  #hapticCooldownMs;
  #now;
  #lastHapticAt = -Infinity;

  /** hapticCooldownMs · now(ms 시계)는 테스트용 — 기본은 300ms · performance.now() */
  constructor({ env = globalThis, platform = null, simulationMs = SIM_AD_MS, hapticCooldownMs = HAPTIC_COOLDOWN_MS, now = null } = {}) {
    this.#env = env;
    this.#platform = platform ?? detectPlatform(env);
    this.#simMs = simulationMs;
    this.#hapticCooldownMs = hapticCooldownMs;
    this.#now = now ?? (() => (typeof env.performance?.now === 'function' ? env.performance.now() : Date.now()));
    if (this.#platform === PLATFORM.APP) this.#drivers.set(PLATFORM.APP, createCapacitorDriver(env.Capacitor));
  }

  /** 'web' | 'app' | 'toss' */
  getPlatform() {
    return this.#platform;
  }

  /** 실제 SDK 드라이버를 연결한다. 이미 있는 드라이버 위에 덮어쓰므로 필요한 메서드만 넘겨도 된다. */
  registerDriver(platform, driver) {
    this.#drivers.set(platform, { ...this.#drivers.get(platform), ...driver });
    return this;
  }

  /** 보상형 광고. 끝까지 시청해야 { rewarded: true }. 실패·중도 이탈이면 { rewarded: false, reason } */
  async showRewardedAd(placementId) {
    if (typeof placementId !== 'string' || !placementId) return { rewarded: false, reason: 'invalid_placement' };
    if (this.#busy) return { rewarded: false, reason: 'busy' };
    this.#busy = true;
    try {
      const run = this.#driver()?.showRewardedAd;
      if (typeof run === 'function') {
        const res = await run(placementId);
        return res?.rewarded === true ? { rewarded: true } : { rewarded: false, reason: res?.reason ?? 'not_rewarded' };
      }
      if (!this.#simulationAllowed()) return { rewarded: false, reason: 'unavailable' }; // 공개 웹 · 앱: 광고 SDK 연결 전 → '준비 중'
      this.#noteSimulated('광고');
      return await simulateAd(this.#env, placementId, this.#simMs); // ← 개발 PC 에서만: 실제 SDK 연결 전 시뮬레이션
    } catch {
      return { rewarded: false, reason: 'error' };
    } finally {
      this.#busy = false;
    }
  }

  /** 유료 상품 결제. 성공해야 { success: true } — 지급은 호출한 쪽에서 한다. */
  async purchaseProduct(productId, priceKRW, meta = {}) {
    if (typeof productId !== 'string' || !productId) return { success: false, reason: 'invalid_product' };
    if (!Number.isFinite(priceKRW) || priceKRW < 0) return { success: false, reason: 'invalid_price' };
    if (this.#busy) return { success: false, reason: 'busy' };
    this.#busy = true;
    try {
      const run = this.#driver()?.purchase;
      if (typeof run === 'function') {
        const res = await run(productId, priceKRW, meta);
        return res?.success === true ? { success: true } : { success: false, reason: res?.reason ?? 'failed' };
      }
      if (!this.#simulationAllowed()) return { success: false, reason: 'unavailable' }; // 공개 웹 · 앱: 결제 연결 전 → '준비 중' (무료 지급 방지)
      this.#noteSimulated('결제');
      return await simulatePurchase(this.#env, productId, priceKRW, meta); // ← 개발 PC 에서만: 실제 결제 연결 전 모의 결제
    } catch {
      return { success: false, reason: 'error' };
    } finally {
      this.#busy = false;
    }
  }

  /**
   * 진동 1회. 'shot'(실탄 발사) | 'hit'(피격) | 'win'(승리 확정) | 'lose'(패배 확정) 또는 'medium' | 'heavy'.
   *   · 그 밖의 이름(사소한 이벤트)은 무시하고, 마지막 진동에서 HAPTIC_COOLDOWN_MS(300ms)가 지나기 전에 온 요청도 버린다.
   *   · 어떤 환경에서도 예외를 던지지 않고, 지원하지 않으면 아무 일도 하지 않는다 (웹 브라우저 · 데스크톱 포함).
   * → 진동을 요청했으면 true, 무시했으면 false
   */
  triggerHaptic(type) {
    const kind = hapticStrength(type);
    if (!kind) return false;
    const now = this.#now();
    if (now - this.#lastHapticAt < this.#hapticCooldownMs) return false; // 쿨타임 — 중복 이벤트로 연달아 두 번 울리지 않게
    this.#lastHapticAt = now;
    try {
      if (!this.#pulse(kind)) webVibrate(this.#env, kind); // 드라이버가 없거나 못 하면 웹 진동으로
    } catch {
      // 진동 실패는 게임에 영향 없음
    }
    return true;
  }

  /** 드라이버로 충격 한 번. 처리했으면 true — 드라이버가 없거나 false 를 돌려주거나 예외를 던지면 false (부른 쪽이 웹 진동으로 대체) */
  #pulse(kind) {
    try {
      const haptic = this.#driver()?.haptic;
      if (typeof haptic !== 'function') return false;
      const handled = haptic(kind);
      if (handled && typeof handled.catch === 'function') handled.catch(() => {});
      return handled !== false;
    } catch {
      return false;
    }
  }

  /** 'ads' | 'purchase' 를 지금 쓸 수 있는가 — 실제 SDK 드라이버가 연결됐거나, 개발 PC(localhost) 의 시뮬레이션. 아니면 화면은 '준비 중' */
  isAvailable(kind) {
    const method = kind === 'ads' ? 'showRewardedAd' : 'purchase';
    return typeof this.#driver()?.[method] === 'function' || this.#simulationAllowed();
  }

  /** 무료 광고 · 모의 결제 시뮬레이션은 내 PC 에서 띄운 웹(localhost)에서만 — 공개 웹 · 앱 · 토스에서 공짜로 지급되지 않게 */
  #simulationAllowed() {
    return this.#platform === PLATFORM.WEB && DEV_HOSTS.has(this.#env.location?.hostname ?? '');
  }

  #driver() {
    return this.#drivers.get(this.#platform);
  }

  // 앱·토스 환경에서 SDK 없이 시뮬레이션으로 도는 경우, 개발자가 알 수 있게 한 번만 알린다 (웹은 원래 이렇게 동작)
  #noteSimulated(what) {
    if (this.#platform === PLATFORM.WEB || this.#noted.has(what)) return;
    this.#noted.add(what);
    console.info(`[PlatformBridge] ${this.#platform}: ${what} SDK 드라이버가 연결되지 않아 시뮬레이션으로 동작합니다.`);
  }
}

export const platformBridge = new PlatformBridge();
