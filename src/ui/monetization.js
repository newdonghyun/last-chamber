/**
 * LAST CHAMBER - 유료 상품 2종 UI : VIP 광고 스킵 패스(₩3,900) · 초보자 스타터 팩(₩1,900 · 1회)
 *
 *   app.js · style.css 를 고치지 않는 독립 모듈 — index.html 의 <link>(monetization.css) 와 <script type="module"> 두 줄로만 붙는다.
 *   저장·지급은 storeData.js(PlayerProfile), 결제는 platformBridge.purchaseProduct 하나만 쓴다.
 *
 *   ① 광고 INSTANT 훅 — installAdSkip(bridge, profile)
 *      app.js 는 보상형 광고를 platformBridge.showRewardedAd(placementId) 로만 부른다:
 *        double_reward(결과 화면 '보상 2배') · streak_protect('연승 기록 보호') · skin_trial(상점 '1판 체험')
 *      같은 싱글턴의 이 메서드를 감싸서
 *        · VIP 패스 보유            → 세 자리 모두 광고 화면·대기 없이 곧바로 { rewarded: true }  (INSTANT)
 *        · 연승 보호권 보유(스타터 팩) → streak_protect 만 보호권 1회를 쓰고 곧바로 { rewarded: true }
 *        · 그 밖에는 원래 광고 흐름 그대로
 *   ② 타이틀 화면 — [게임 시작] 아래에 황금빛 [스타터 팩 80% 할인](미구매자만) · [VIP 광고 스킵 패스](미보유자만). 결과 화면(.is-result)에서는 숨긴다.
 *      결과 화면의 광고 버튼 위에는 '광고 없이 즉시' 안내 한 줄 (패스·보호권 보유자에게만).
 *   ③ 결제 팝업 — <dialog class="mz-dialog">: 상품 안내 → [결제하기] → platformBridge.purchaseProduct → 성공해야만 지급 → 영수증.
 *   ④ 화면 동기화 — 지급 뒤 app.js 가 이미 듣고 있는 visibilitychange 를 한 번 태운다 (app.js 는 그 핸들러에서 profile.reload() 후 지갑 · 스킨 · 타이틀을 다시 그린다).
 *      같은 시점에 document 로 CustomEvent('lastchamber:profile-changed') 도 내보낸다 → 나중에 app.js 가 이 이벤트를 직접 듣게 바꾸면 visibilitychange 우회는 지워도 된다.
 *
 *   ⚠ 실제 SDK 결제 드라이버(platformBridge.registerDriver)가 붙기 전에는 결제가 '모의 결제'(무료 성공)로 동작한다.
 *   ⚠ 구매 여부는 localStorage 에만 저장된다 — 정식 출시 전에는 서버에서 영수증을 검증하고 지급 상태를 서버가 들고 있어야 한다.
 *
 *   installAdSkip · buyProduct 는 DOM 을 쓰지 않아 Node 에서도 import·테스트할 수 있다 (화면은 브라우저에서만 만든다).
 */

import { platformBridge } from '../platform/platformBridge.js';
import { KIND, PlayerProfile, NO_ADS_PASS, STARTER_PACK, STARTER_DISCOUNT_PCT, getItem } from './storeData.js';

/** VIP 패스가 광고 없이 즉시 처리하는 보상형 광고 자리 (app.js watchAd 의 placementId) */
export const INSTANT_PLACEMENTS = Object.freeze(['double_reward', 'streak_protect', 'skin_trial']);
/** 연승 보호권이 광고를 대신하는 자리 */
export const SHIELD_PLACEMENT = 'streak_protect';
export const PROFILE_CHANGED = 'lastchamber:profile-changed';

const HOOK = Symbol.for('lastchamber.adSkipHook');
const fmt = (n) => Math.round(n).toLocaleString('ko-KR');
const won = (n) => `₩${fmt(n)}`;

// ───────── ① 광고 INSTANT 훅 ─────────

/**
 * bridge.showRewardedAd 를 감싼다 (이미 감싸져 있으면 그 핸들을 그대로 돌려준다).
 *   onUse({ kind: 'vip' | 'shield', placementId, left? }) — 광고를 건너뛰고 지급했을 때 화면을 갱신하라고 알린다.
 *   패스·보호권 상태는 호출할 때마다 저장소에서 다시 읽는다 (다른 탭에서 산 패스도 바로 먹는다).
 * → { uninstall() }
 */
export function installAdSkip(bridge, profile, { onUse } = {}) {
  if (bridge[HOOK]) return bridge[HOOK];
  const hadOwn = Object.prototype.hasOwnProperty.call(bridge, 'showRewardedAd');
  const previous = bridge.showRewardedAd;
  const notify = (info) => {
    try { onUse?.(info); } catch { /* 화면 갱신 실패는 지급과 무관 */ }
  };

  bridge.showRewardedAd = async function showRewardedAdWithSkip(placementId) {
    if (INSTANT_PLACEMENTS.includes(placementId)) {
      try {
        profile.reload();
        if (profile.hasNoAdsPass) { // VIP: 광고 화면도 대기도 없다
          notify({ kind: 'vip', placementId });
          return { rewarded: true };
        }
        if (placementId === SHIELD_PLACEMENT) { // 보호권: 광고 대신 1회 소모 (소모는 저장소 한 번의 변경으로 끝난다)
          const used = profile.useStreakShield();
          if (used.ok) {
            notify({ kind: 'shield', placementId, left: used.left });
            return { rewarded: true };
          }
        }
      } catch {
        // 저장소 오류로 광고 자체를 막지 않는다 → 아래 원래 광고 흐름
      }
    }
    return previous.call(bridge, placementId);
  };

  const handle = {
    uninstall() {
      if (hadOwn) bridge.showRewardedAd = previous;
      else delete bridge.showRewardedAd;
      delete bridge[HOOK];
    },
  };
  Object.defineProperty(bridge, HOOK, { value: handle, configurable: true }); // 열거되지 않게
  return handle;
}

// ───────── ② 결제 → 지급 ─────────

const PRODUCTS = Object.freeze({ starter: STARTER_PACK, vip: NO_ADS_PASS });
const productOf = (kind) => (Object.prototype.hasOwnProperty.call(PRODUCTS, kind) ? PRODUCTS[kind] : null);
const ownedOf = (profile, kind) => (kind === 'starter' ? profile.starterPurchased : profile.hasNoAdsPass);

/**
 * 결제 한 건: platformBridge.purchaseProduct 가 성공해야만 지급한다. 취소·실패·이미 보유면 아무것도 바꾸지 않는다.
 *   kind: 'starter' | 'vip'      profile: PlayerProfile      bridge: 결제창구 (기본 platformBridge)
 * → { ok: true, kind, ...지급 결과 } | { ok: false, reason }   (예외는 던지지 않는다)
 *   reason: 'owned'(이미 보유 — 결제창을 띄우지 않음) · 'paid_but_owned'(결제 중 다른 탭이 먼저 지급) · 'cancelled' · 'busy' · 'unsupported' · 'error' · 'failed' · 'unknown_product'
 */
export async function buyProduct(kind, { profile, bridge = platformBridge }) {
  const product = productOf(kind);
  if (!product) return { ok: false, reason: 'unknown_product' };
  profile.reload(); // 다른 탭에서 이미 샀다면 결제창을 띄우지 않는다
  if (ownedOf(profile, kind)) return { ok: false, reason: 'owned' };
  let pay;
  try {
    pay = await bridge.purchaseProduct(product.productId, product.krw, { title: `${product.name} (${product.en})` });
  } catch {
    return { ok: false, reason: 'error' };
  }
  if (pay?.success !== true) return { ok: false, reason: pay?.reason ?? 'failed' };
  const granted = kind === 'starter' ? profile.grantStarterPack() : profile.grantNoAdsPass();
  return granted.ok ? { ...granted, kind } : { ok: false, reason: 'paid_but_owned' }; // 지급은 한 번만
}

const FAIL_TEXT = new Map([
  ['cancelled', '결제를 취소했어요'],
  ['busy', '다른 광고·결제가 진행 중이에요. 잠시 후 다시 시도해 주세요'],
  ['unsupported', '이 기기에서는 결제를 지원하지 않아요'],
  ['owned', '이미 보유한 상품이에요'],
  ['paid_but_owned', '이미 지급된 상품이에요 — 지급은 한 번만 이뤄져요'],
]);
const failText = (reason) => FAIL_TEXT.get(reason) ?? '결제하지 못했어요. 잠시 후 다시 시도해 주세요';

// ───────── ③ 화면 (브라우저 전용) ─────────

const SVG_NS = 'http://www.w3.org/2000/svg';
const ICONS = {
  star: '<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>',
  crown: '<path d="M3.6 18.4h16.8"/><path d="M4.4 16.6 3 7.4l5 3.9L12 4.6l4 6.7 5-3.9-1.4 9.2z"/>',
  noads: '<rect x="3" y="4.6" width="18" height="12.4" rx="2.2"/><path d="m10.3 8.3 4.6 2.5-4.6 2.5z"/><path d="M8 20.2h8M12 17v3.2"/><path d="M3.4 3.4 20.6 20.6"/>',
  shield: '<path d="M12 2.8 19.4 5.6v5.7c0 4.5-3 8.2-7.4 9.9-4.4-1.7-7.4-5.4-7.4-9.9V5.6z"/><path d="m8.8 11.9 2.2 2.2 4.2-4.6"/>',
  brass: '<path d="M9.3 8.4V6.5c0-1.9 1.1-3.4 2.7-4.2 1.6.8 2.7 2.3 2.7 4.2v1.9"/><path d="M8.4 8.4h7.2l.8 10.8H7.6z"/><path d="M8.7 11.6h6.6"/><path d="M6.2 19.2h11.6v2.3H6.2z"/>',
  gem: '<path d="M6.5 4h11l3.2 5L12 20.5 3.3 9z"/><path d="M3.3 9h17.4M9 4 7.4 9 12 20.5 16.6 9 15 4"/>',
  check: '<path d="m5.6 12.6 4.2 4.2 8.6-9.4"/>',
};

function mountUi({ profile, bridge = platformBridge, doc = document }) {
  const byId = (id) => doc.getElementById(id);
  const actions = doc.querySelector('#start-modal .title-actions');
  const btnStart = byId('btn-start');
  if (!actions || !btnStart) return null; // 화면 구조가 바뀌었다면 조용히 포기한다 (광고 훅은 그대로 동작)

  const h = (tag, className = '', text) => {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const icon = (name) => {
    const svg = doc.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('class', 'mz-ico');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    svg.innerHTML = ICONS[name];
    return svg;
  };
  const button = (className, label) => {
    const btn = h('button', className, label);
    btn.type = 'button';
    return btn;
  };

  // ── 타이틀 화면: [게임 시작] 아래 상품 버튼 (결과 화면에서는 CSS 가 숨긴다) ──
  const starterBtn = button('mz-starter');
  starterBtn.setAttribute('aria-haspopup', 'dialog');
  starterBtn.setAttribute('aria-label', `${STARTER_PACK.name} ${STARTER_DISCOUNT_PCT}% 할인 — ${won(STARTER_PACK.krw)} (정가 ${won(STARTER_PACK.listKrw)}), 계정당 1회`);
  const starterMain = h('span', 'mz-starter-main');
  starterMain.append(icon('star'), `스타터 팩 ${STARTER_DISCOUNT_PCT}% 할인`);
  const starterSub = h('span', 'mz-starter-sub');
  starterSub.append(h('s', '', won(STARTER_PACK.listKrw)), h('b', '', won(STARTER_PACK.krw)), h('em', '', '1회 한정'));
  starterBtn.append(h('span', 'mz-badge', `-${STARTER_DISCOUNT_PCT}%`), starterMain, starterSub);

  const vipBtn = button('mz-vip');
  vipBtn.setAttribute('aria-haspopup', 'dialog');
  vipBtn.setAttribute('aria-label', `${NO_ADS_PASS.name} — ${won(NO_ADS_PASS.krw)}, 보상형 광고를 건너뜁니다`);
  vipBtn.append(icon('crown'), h('span', 'mz-vip-main', NO_ADS_PASS.name), h('b', '', won(NO_ADS_PASS.krw)));

  const status = h('p', 'mz-status'); // 보유 현황: VIP 활성 · 연승 보호권 N회
  const offers = h('div', 'mz-offers');
  offers.append(starterBtn, vipBtn, status);
  btnStart.after(offers);

  // ── 결과 화면: 광고 버튼 위 안내 한 줄 ──
  const rewardActions = byId('reward-actions');
  const btnProtect = byId('btn-protect');
  const caption = h('p', 'mz-caption');
  caption.setAttribute('role', 'status');
  caption.hidden = true;
  rewardActions?.prepend(caption);

  function syncCaption() {
    profile.reload();
    let text = '';
    if (profile.hasNoAdsPass) text = 'VIP 패스 · 아래 보상은 광고 없이 바로 지급돼요';
    else if (profile.streakShields > 0 && btnProtect && !btnProtect.hidden) text = `연승 보호권 ${profile.streakShields}회 · 연승 보호는 광고 대신 보호권 1회를 써요`;
    caption.textContent = text;
    caption.hidden = text === '';
  }

  function syncOffers() {
    profile.reload();
    starterBtn.hidden = profile.starterPurchased;
    vipBtn.hidden = profile.hasNoAdsPass;
    const parts = [];
    if (profile.hasNoAdsPass) parts.push('VIP 광고 스킵 활성');
    if (profile.streakShields > 0) parts.push(`연승 보호권 ${profile.streakShields}회`);
    status.textContent = parts.join(' · ');
    status.hidden = parts.length === 0;
    offers.hidden = starterBtn.hidden && vipBtn.hidden && status.hidden;
    syncCaption();
  }

  // app.js 가 결과 화면 버튼을 보이거나 숨길 때마다 안내 문구를 다시 맞춘다 (보호 버튼은 연승이 끊긴 판에만 나온다)
  const watcher = new MutationObserver(syncCaption);
  for (const node of [rewardActions, btnProtect]) if (node) watcher.observe(node, { attributes: true, attributeFilter: ['hidden'] });
  doc.addEventListener('visibilitychange', () => { if (!doc.hidden) syncOffers(); }); // 다른 탭에서 산 상품도 탭에 돌아오면 반영

  // 지급 직후 app.js 화면(지갑 · 스킨 · 타이틀)을 저장소 기준으로 다시 그리게 한다 — 파일 머리말 ④
  function syncApp(detail = {}) {
    try { doc.dispatchEvent(new CustomEvent(PROFILE_CHANGED, { detail })); } catch { /* 이벤트 미지원 환경 */ }
    doc.dispatchEvent(new Event('visibilitychange'));
    syncOffers();
  }

  // ── 결제 팝업 ──
  const dlg = h('dialog', 'mz-dialog');
  dlg.setAttribute('aria-labelledby', 'mz-title');
  const card = h('div', 'mz-card');
  dlg.append(card);
  doc.body.append(dlg);

  let busy = false;
  let opener = null;
  let msgEl = null;
  let payBtn = null;
  let laterBtn = null;
  let payLabel = '';

  const say = (text, bad = false) => {
    if (!msgEl) return;
    msgEl.textContent = text;
    msgEl.classList.toggle('is-bad', bad);
  };
  function setBusy(on) {
    busy = on;
    dlg.classList.toggle('is-busy', on);
    dlg.setAttribute('aria-busy', String(on));
    if (payBtn) {
      payBtn.disabled = on;
      payBtn.textContent = on ? '결제 진행 중…' : payLabel;
    }
    if (laterBtn) laterBtn.disabled = on;
  }
  dlg.addEventListener('cancel', (ev) => { if (busy) ev.preventDefault(); }); // 결제 중에는 Esc 로 닫히지 않게
  dlg.addEventListener('click', (ev) => { if (ev.target === dlg && !busy) dlg.close(); }); // 카드 밖(배경)을 누르면 닫힘
  dlg.addEventListener('close', () => {
    busy = false;
    const back = opener && opener.isConnected && !opener.hidden ? opener : btnStart; // 산 상품의 버튼은 사라지므로 [게임 시작]으로
    opener = null;
    back.focus?.({ preventScroll: true });
  });

  const head = (kicker, title) => {
    const wrap = h('header', 'mz-head');
    const heading = h('h2', 'mz-title', title);
    heading.id = 'mz-title';
    wrap.append(h('p', 'mz-kicker', kicker), heading);
    return wrap;
  };
  const itemList = (items) => {
    const list = h('ul', 'mz-items');
    for (const { ico, main, sub, chips } of items) {
      const li = h('li');
      const badge = h('span', 'mz-item-ico');
      badge.append(icon(ico));
      const text = h('span', 'mz-item-text');
      text.append(h('b', '', main), h('small', '', sub));
      li.append(badge, text);
      if (chips?.length) {
        const dots = h('span', 'mz-chips');
        dots.setAttribute('aria-hidden', 'true');
        for (const color of chips) {
          const dot = h('i');
          dot.style.background = color;
          dots.append(dot);
        }
        li.append(dots);
      }
      list.append(li);
    }
    return list;
  };

  const skinOf = () => getItem(KIND.GUN, STARTER_PACK.skinId) ?? { name: '한정 스킨', chips: [] };
  const SPECS = {
    starter: {
      cls: 'is-starter',
      kicker: `STARTER PACK · ${STARTER_DISCOUNT_PCT}% OFF`,
      product: STARTER_PACK,
      items: () => [
        { ico: 'brass', main: `탄피 ${fmt(STARTER_PACK.brass)}개`, sub: '상점에서 바로 쓸 수 있어요' },
        { ico: 'gem', main: `한정 스킨 · ${skinOf().name}`, sub: '스타터 팩으로만 얻는 총기 스킨', chips: skinOf().chips },
        { ico: 'shield', main: `연승 보호권 ${STARTER_PACK.shields}회`, sub: '연승이 끊겨도 광고 없이 기록을 지켜요' },
      ],
      fine: '계정당 1회만 살 수 있어요 · 결제 즉시 지급',
    },
    vip: {
      cls: 'is-vip',
      kicker: 'VIP PASS · 한 번 결제하면 영구',
      product: NO_ADS_PASS,
      items: () => [
        { ico: 'brass', main: '보상 2배', sub: '결과 화면에서 광고 없이 바로 두 배' },
        { ico: 'shield', main: '연승 기록 보호', sub: '광고 없이 바로 연승을 지켜요' },
        { ico: 'gem', main: '스킨 1판 체험', sub: '광고 없이 바로 체험을 예약해요' },
      ],
      fine: '광고 대기 시간 없이 즉시 발동 · 결제 즉시 적용',
    },
  };

  function renderOffer(kind) {
    const spec = SPECS[kind];
    const { product } = spec;
    dlg.className = `mz-dialog ${spec.cls}`;
    dlg.setAttribute('aria-busy', 'false');

    const price = h('div', 'mz-price');
    if (kind === 'starter') price.append(h('s', '', won(product.listKrw)));
    price.append(h('b', '', won(product.krw)));
    if (kind === 'starter') price.append(h('em', '', `${STARTER_DISCOUNT_PCT}% 할인`));

    msgEl = h('p', 'mz-msg');
    msgEl.setAttribute('role', 'status');
    msgEl.setAttribute('aria-live', 'polite');
    payLabel = `${won(product.krw)} 결제하기`;
    payBtn = button('mz-pay', payLabel);
    laterBtn = button('mz-later', '나중에');
    payBtn.addEventListener('click', () => { onPay(kind).catch((err) => console.error('[LAST CHAMBER]', err)); });
    laterBtn.addEventListener('click', () => dlg.close());
    const row = h('div', 'mz-actions');
    row.append(payBtn, laterBtn);

    card.replaceChildren(head(spec.kicker, product.name), itemList(spec.items()), price, h('p', 'mz-fine', spec.fine), msgEl, row);
  }

  function renderReceipt(kind, res) {
    dlg.classList.add('is-receipt');
    const mark = h('span', 'mz-seal');
    mark.append(icon('check'));
    const row = h('div', 'mz-actions');
    const done = button('mz-pay', '확인');
    done.addEventListener('click', () => dlg.close());
    msgEl = h('p', 'mz-msg');
    msgEl.setAttribute('role', 'status');
    msgEl.setAttribute('aria-live', 'polite');

    let items;
    if (kind === 'starter') {
      items = [
        { ico: 'brass', main: `탄피 +${fmt(STARTER_PACK.brass)}`, sub: `지금 보유 ${fmt(res.brass)}개` },
        { ico: 'gem', main: `${skinOf().name} 획득`, sub: '상점 · 총기에서도 장착할 수 있어요', chips: skinOf().chips },
        { ico: 'shield', main: `연승 보호권 ${res.shields}회 보유`, sub: '연승이 끊기면 광고 없이 기록을 지켜요' },
      ];
      const equip = button('mz-pay', '지금 장착하기');
      equip.addEventListener('click', () => {
        const r = profile.equip(KIND.GUN, STARTER_PACK.skinId);
        if (!r.ok) return say('장착하지 못했어요. 상점 · 총기에서 다시 시도해 주세요', true);
        syncApp({ kind, equipped: STARTER_PACK.skinId });
        equip.disabled = true;
        equip.textContent = '장착 완료';
        say('다음 판부터 이 총을 써요');
      });
      done.className = 'mz-later';
      row.append(equip, done);
    } else {
      items = [
        { ico: 'brass', main: '보상 2배', sub: '광고 없이 바로 지급' },
        { ico: 'shield', main: '연승 기록 보호', sub: '광고 없이 바로 발동' },
        { ico: 'gem', main: '스킨 1판 체험', sub: '광고 없이 바로 예약' },
      ];
      row.append(done);
    }
    card.replaceChildren(mark, head('PURCHASE COMPLETE', kind === 'starter' ? '스타터 팩이 도착했어요' : 'VIP 패스가 켜졌어요'), itemList(items), msgEl, row);
    (row.firstElementChild ?? done).focus?.({ preventScroll: true });
  }

  async function onPay(kind) {
    if (busy) return;
    say('');
    setBusy(true);
    const res = await buyProduct(kind, { profile, bridge }); // 예외를 던지지 않는다
    setBusy(false);
    if (!res.ok) {
      if (res.reason === 'owned' || res.reason === 'paid_but_owned') { // 다른 탭에서 이미 지급됨 → 다시 결제할 수 없게 잠그고 화면만 맞춘다
        payBtn.disabled = true;
        syncApp();
      }
      say(failText(res.reason), res.reason !== 'cancelled');
      return;
    }
    syncApp({ kind });
    renderReceipt(kind, res);
  }

  function openOffer(kind, from) {
    profile.reload();
    if (ownedOf(profile, kind)) { // 다른 탭에서 이미 샀다면 팝업 대신 화면만 맞춘다
      syncOffers();
      return;
    }
    if (dlg.open) return;
    opener = from;
    renderOffer(kind);
    try {
      dlg.showModal();
    } catch {
      dlg.setAttribute('open', ''); // showModal 미지원 WebView 대비
    }
    payBtn.focus?.({ preventScroll: true });
  }

  starterBtn.addEventListener('click', () => openOffer('starter', starterBtn));
  vipBtn.addEventListener('click', () => openOffer('vip', vipBtn));
  syncOffers();
  return { sync: syncOffers };
}

// ───────── 시작 ─────────

function boot() {
  const profile = new PlayerProfile(); // app.js 의 프로필과 같은 localStorage 키 — 모든 변경이 저장 직전에 reload 하므로 서로 덮어쓰지 않는다
  let ui = null;
  installAdSkip(platformBridge, profile, { onUse: () => ui?.sync() }); // 화면이 실패해도 광고 훅은 먼저 붙는다
  try {
    ui = mountUi({ profile });
  } catch (err) {
    console.error('[LAST CHAMBER] monetization UI', err);
  }
}

if (typeof document !== 'undefined') { // Node(단위 테스트)에서는 import 만 하고 아무것도 붙이지 않는다
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();
}
