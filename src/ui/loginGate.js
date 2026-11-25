/**
 * LAST CHAMBER - 시작 화면 로그인(닉네임 + 4자리 PIN) · 계정 창 — src/ui/session.js · src/ui/accountApi.js 의 화면
 *
 *   · 로그인 기록이 없으면 #login-modal 이 뜬다: 닉네임(2~10자 · 공백 없이) + PIN(숫자 4자리) + [시작하기]. 회원가입은 없다.
 *     서버(POST /api/login)가 닉네임 + PIN 으로 계정을 만들거나(처음 보는 닉네임) 불러온다(같은 닉네임 + 맞는 PIN — 다른 기기 · 브라우저에서도).
 *     로그인 전에는 타이틀(게임 시작 · 로비 · 매칭 · 상점)을 누를 수 없다 (모달 + html.needs-login 이 타이틀을 숨긴다).
 *   · user_id · 닉네임 · PIN 은 session.js 가 localStorage 에 저장한다 → 다시 접속하면 이 화면 없이 바로 타이틀(자동 로그인).
 *   · 첫 화면 전에 src/ui/sessionBoot.js 가 html.needs-login 을 붙여 두므로 CSS(loginGate.css)가 처음부터 이 화면을 보여 준다
 *     → 타이틀이 잠깐 비쳤다가 로그인 화면으로 바뀌는 깜빡임이 없다. 이 모듈은 그 판단을 넘겨받아 진짜 모달(showModal)로 바꾼다.
 *   · 타이틀 우상단 #btn-account → #account-modal: 내 닉네임 [변경](누를 때만 변경 칸이 열린다) · 유저 ID 앞 8자리 ·
 *     복구 PIN(가려 두고 [보기]) 또는 PIN 이 없는 예전 계정이면 [PIN 설정] · [로그아웃](한 번 더 확인).
 *   · window 'lastchamber:need-login' 이벤트를 받으면 이 화면을 다시 연다 (detail.message 가 있으면 그 안내와 함께 — 예: 닉네임을 다른 계정이 PIN 으로 등록함).
 *     window 'lastchamber:open-account' 이벤트를 받으면 계정 창을 연다 (detail.edit 이면 닉네임 변경 칸까지).
 */

import { userSession, validateNickname, nicknameErrorText, attachNicknameFilter, NICK_RULE, NICK_HINT, PIN_HINT, SESSION_KEY } from './session.js';
import { loginWithPin, changeNickname } from './accountApi.js';
import { PlayerProfile, NICKNAME } from './storeData.js';

const $ = (id) => document.getElementById(id);
const root = document.documentElement;
const gate = {
  modal: $('login-modal'),
  form: $('login-form'),
  input: $('login-nick'),
  pin: $('login-pin'),
  submit: $('login-submit'),
  count: $('login-count'),
  msg: $('login-msg'),
};
const acct = {
  button: $('btn-account'),
  modal: $('account-modal'),
  name: $('acct-name'),
  uid: $('acct-uid'),
  edit: $('acct-edit'),
  form: $('acct-form'),
  input: $('acct-nick'),
  count: $('acct-count'),
  msg: $('acct-msg'),
  pinShow: $('acct-pin-show'),
  pinValue: $('acct-pin-value'),
  pinForm: $('acct-pin-form'),
  pinInput: $('acct-pin-input'),
  pinMsg: $('acct-pin-msg'),
  logout: $('acct-logout'),
  confirm: $('acct-confirm'),
  confirmText: $('acct-confirm-text'),
};
const legacy = new PlayerProfile(); // 이 업데이트 전부터 쓰던 프로필 닉네임 → 첫 로그인 화면의 기본값 (읽기만)
const GATE_HINT = `${NICK_HINT} · PIN ${PIN_HINT}`;
const SLOW_HINT_MS = 4000; // 서버가 잠들어 있으면 깨어나는 데 시간이 걸린다 → 이만큼 지나면 안내를 바꾼다

const glyphs = (text) => [...text].length;

function note(node, text, tone = '') {
  if (!node) return;
  node.textContent = text;
  node.classList.toggle('is-bad', tone === 'bad');
  node.classList.toggle('is-ok', tone === 'ok');
}

function paintCount(node, value) {
  if (node) node.textContent = `${glyphs(value)}/${NICK_RULE.max}`;
}

function openModal(dlg) {
  if (!dlg || dlg.open) return;
  try {
    dlg.showModal();
  } catch {
    dlg.setAttribute('open', ''); // showModal 미지원 WebView 대비
  }
}

function closeModal(dlg) {
  if (!dlg?.open) return;
  try {
    dlg.close();
  } catch {
    dlg.removeAttribute('open');
  }
}

/** PIN 입력칸: 숫자만 · 4자리까지 (붙여 넣은 글자 · 전각 숫자 등은 지운다) */
function attachPinFilter(input, onChange) {
  if (!input) return;
  input.addEventListener('input', () => {
    const digits = input.value.replace(/\D+/g, '').slice(0, 4);
    if (digits !== input.value) input.value = digits;
    onChange?.(digits);
  });
}

/** 잠깐 떠오르는 알림 띠 (기존 계정을 불러왔을 때 등) */
function toast(text) {
  const node = document.createElement('p');
  node.className = 'acct-toast';
  node.setAttribute('role', 'status');
  node.textContent = text;
  document.body.append(node);
  setTimeout(() => node.remove(), 3400);
}

const recordText = (me) => (me && me.wins + me.losses > 0 ? ` — 랭킹전 ${me.wins}승 ${me.losses}패 · MMR ${me.mmr}` : '');

// ───────── 로그인 화면 ─────────

/** 기본값: 로그아웃 전에 쓰던 닉네임 → 없으면 예전 프로필 닉네임(기본 '방랑자'가 아니고 새 규칙에 맞을 때만) */
function prefill() {
  const last = userSession.lastNickname;
  if (last) return last;
  legacy.reload();
  const old = legacy.nickname;
  return old !== NICKNAME.default && validateNickname(old).ok ? old : '';
}

function openGate(message = '') {
  if (!gate.modal) return;
  closeAccount();
  if (!gate.modal.open) {
    gate.input.value = prefill();
    if (gate.pin) gate.pin.value = '';
    paintCount(gate.count, gate.input.value);
    note(gate.msg, GATE_HINT);
  }
  if (message) note(gate.msg, message, 'bad');
  setNeedsLogin(true);
  openModal(gate.modal); // 첫 포커스 = 닉네임 입력칸
}

function closeGate() {
  setNeedsLogin(false);
  closeModal(gate.modal);
}

// 이미 그 상태면 쓰지 않는다 — 있는 클래스를 다시 add 해도 class 속성이 다시 써진다 (sessionBoot.js 가 첫 화면 전에 이미 붙여 둔 경우)
function setNeedsLogin(on) {
  if (root.classList.contains('needs-login') !== on) root.classList.toggle('needs-login', on);
}

function setGateBusy(on) {
  gate.form?.classList.toggle('is-busy', on);
  if (gate.submit) gate.submit.disabled = on;
  gate.form?.setAttribute('aria-busy', String(on));
}

let gateBusy = false;
async function onGateSubmit(ev) {
  ev.preventDefault(); // method="dialog" 가 창을 닫지 않게 — 닫는 건 로그인이 성공했을 때(onSession)만
  if (gateBusy) return;
  const nick = validateNickname(gate.input.value);
  if (!nick.ok) {
    note(gate.msg, nicknameErrorText(nick.reason), 'bad');
    gate.input.focus();
    return;
  }
  if (!/^\d{4}$/.test(gate.pin?.value ?? '')) {
    note(gate.msg, 'PIN은 숫자 4자리로 입력해 주세요', 'bad');
    gate.pin?.focus();
    return;
  }
  gateBusy = true;
  setGateBusy(true);
  note(gate.msg, '계정을 확인하는 중…');
  const slow = setTimeout(() => note(gate.msg, '서버를 깨우는 중이에요 — 처음 접속이면 최대 1분쯤 걸릴 수 있어요'), SLOW_HINT_MS);
  const res = await loginWithPin(nick.nickname, gate.pin.value);
  clearTimeout(slow);
  gateBusy = false;
  setGateBusy(false);
  if (!res.ok) {
    note(gate.msg, res.message, 'bad');
    if (res.error === 'NICKNAME_TAKEN' || res.error === 'INVALID_PIN') {
      gate.pin.value = '';
      gate.pin.focus();
    } else if (res.error === 'NICKNAME_IN_USE' || res.error === 'INVALID_NICKNAME') {
      gate.input.focus();
    }
    return;
  }
  // 성공 → session.signIn 이 구독자(onSession)에게 알려 로그인 화면이 닫힌다
  if (res.recovered) toast(`${res.user.nickname} 계정을 불러왔어요${recordText(res.me)}`);
  else if (res.created) toast(`${res.user.nickname} 계정을 만들었어요 — 다른 기기에서도 닉네임 + PIN 으로 이어서 플레이`);
}

// ───────── 계정 창 (닉네임 변경 · PIN · 로그아웃) ─────────

function paintAccountButton(user) {
  if (!acct.button) return;
  acct.button.setAttribute('aria-label', user ? `계정: ${user.nickname} — 닉네임 변경 · PIN · 로그아웃` : '로그인');
  acct.button.title = user ? `${user.nickname} · 닉네임 변경 · PIN · 로그아웃` : '로그인';
}

let pinVisible = false;
function paintPin() {
  const pin = userSession.pin;
  if (acct.pinShow) acct.pinShow.hidden = !pin;
  if (acct.pinForm) acct.pinForm.hidden = Boolean(pin);
  if (acct.pinValue) acct.pinValue.textContent = pin ? (pinVisible ? pin : '••••') : '';
  const toggle = acct.pinShow?.querySelector('[data-acct="toggle-pin"]');
  if (toggle) {
    toggle.textContent = pinVisible ? '숨기기' : '보기';
    toggle.setAttribute('aria-pressed', String(pinVisible));
  }
  if (!pin && acct.pinMsg && !acct.pinMsg.classList.contains('is-bad') && !acct.pinMsg.classList.contains('is-ok')) {
    note(acct.pinMsg, 'PIN이 아직 없어요 — 정해 두면 다른 기기 · 브라우저에서도 닉네임 + PIN으로 이 계정을 불러올 수 있어요');
  }
  if (acct.confirmText) {
    acct.confirmText.textContent = pin
      ? '로그아웃하면 다음에 닉네임과 PIN을 다시 입력해야 해요. 탄피 · 스킨 · 전적은 이 기기에 그대로 남아요.'
      : 'PIN을 아직 정하지 않았어요. 로그아웃하기 전에 위에서 PIN을 정해 두면 어느 기기에서든 이 계정을 다시 불러올 수 있어요.';
  }
}

function paintAccount(user) {
  if (acct.name) acct.name.textContent = user.nickname;
  if (acct.uid) acct.uid.textContent = user.id.slice(0, 8).toUpperCase(); // 전체 ID 는 서버 기록의 열쇠라 화면에는 앞부분만
  paintPin();
}

function showConfirm(on) {
  if (!acct.confirm || !acct.logout) return;
  acct.confirm.hidden = !on;
  acct.logout.hidden = on;
  if (on) acct.confirm.querySelector('[data-acct="confirm-logout"]')?.focus();
}

/** 닉네임 변경 칸 열기/닫기 — [변경]을 누를 때만 열린다 */
function showEdit(on) {
  if (!acct.form) return;
  acct.form.hidden = !on;
  acct.edit?.setAttribute('aria-expanded', String(on));
  if (!on) return;
  acct.input.value = userSession.user?.nickname ?? '';
  paintCount(acct.count, acct.input.value);
  note(acct.msg, NICK_HINT);
  acct.input.focus();
  acct.input.select?.();
}

function openAccount({ edit = false } = {}) {
  const user = userSession.user;
  if (!user) {
    openGate();
    return;
  }
  pinVisible = false;
  note(acct.pinMsg, '');
  if (acct.pinInput) acct.pinInput.value = '';
  paintAccount(user);
  showEdit(false);
  showConfirm(false);
  openModal(acct.modal);
  if (edit) showEdit(true);
}

function closeAccount() {
  showConfirm(false);
  closeModal(acct.modal);
}

let renameBusy = false;
async function onAccountSubmit(ev) {
  ev.preventDefault();
  if (renameBusy) return;
  renameBusy = true;
  note(acct.msg, '서버에서 확인하는 중…');
  const res = await changeNickname(acct.input.value);
  renameBusy = false;
  if (!res.ok) {
    note(acct.msg, res.message, 'bad');
    acct.input.focus();
    return;
  }
  acct.input.value = res.user.nickname;
  paintCount(acct.count, acct.input.value);
  note(acct.msg, res.unchanged ? '지금 쓰고 있는 닉네임이에요' : '닉네임을 바꿨어요 — 대전 상대에게도 이 이름으로 보여요', 'ok');
}

let pinBusy = false;
async function onPinSubmit(ev) {
  ev.preventDefault();
  const user = userSession.user;
  if (pinBusy || !user) return;
  if (!/^\d{4}$/.test(acct.pinInput.value)) {
    note(acct.pinMsg, 'PIN은 숫자 4자리로 입력해 주세요', 'bad');
    acct.pinInput.focus();
    return;
  }
  pinBusy = true;
  note(acct.pinMsg, '서버에 PIN을 등록하는 중…');
  const res = await loginWithPin(user.nickname, acct.pinInput.value); // 같은 닉네임 + 이 기기의 user_id → 이 계정에 PIN 을 붙인다
  pinBusy = false;
  acct.pinInput.value = '';
  if (!res.ok) {
    note(acct.pinMsg, res.message, 'bad');
    return;
  }
  // 이 계정에 PIN 을 붙였거나(secured) · 서버에 아직 없던 계정이라 이 닉네임으로 새로 만들었으면(created) '정했다', 같은 닉네임 + PIN 의 다른 계정을 찾았으면 '불러왔다'
  const switched = res.recovered && !res.secured && res.user.id !== user.id;
  note(acct.pinMsg, switched ? `이 닉네임 + PIN의 계정을 불러왔어요${recordText(res.me)}` : 'PIN을 정했어요 — 다른 기기에서도 닉네임 + PIN으로 이 계정을 불러올 수 있어요', 'ok');
  paintPin();
}

function onAccountClick(ev) {
  if (ev.target === acct.modal) { // 카드 밖 어두운 곳
    closeAccount();
    return;
  }
  const btn = ev.target instanceof Element ? ev.target.closest('[data-acct]') : null;
  switch (btn?.dataset.acct) {
    case 'close': closeAccount(); break;
    case 'edit': showEdit(acct.form?.hidden !== false); break;
    case 'toggle-pin':
      pinVisible = !pinVisible;
      paintPin();
      break;
    case 'logout': showConfirm(true); break;
    case 'cancel-logout':
      showConfirm(false);
      acct.logout?.focus();
      break;
    case 'confirm-logout':
      closeAccount();
      userSession.logout(); // → onSession(null) 이 로그인 화면을 연다
      break;
    default: break;
  }
}

// ───────── 세션 변화 → 화면 ─────────

function onSession(user) {
  paintAccountButton(user);
  if (!user) {
    openGate();
    return;
  }
  if (gate.modal?.open || root.classList.contains('needs-login')) {
    closeGate();
    $('btn-start')?.focus({ preventScroll: true });
  }
  if (acct.modal?.open) paintAccount(user);
}

// ───────── 연결 ─────────

if (gate.modal && gate.form && gate.input) {
  attachNicknameFilter(gate.input, (value) => {
    paintCount(gate.count, value);
    note(gate.msg, GATE_HINT); // 다시 입력하면 이전 오류 안내는 지운다
  });
  attachPinFilter(gate.pin, () => { if (gate.msg.classList.contains('is-bad')) note(gate.msg, GATE_HINT); });
  gate.form.addEventListener('submit', onGateSubmit);
  gate.modal.addEventListener('cancel', (ev) => ev.preventDefault()); // Esc 로 건너뛸 수 없다
}
if (acct.modal && acct.form && acct.input) {
  attachNicknameFilter(acct.input, (value) => {
    paintCount(acct.count, value);
    note(acct.msg, NICK_HINT);
  });
  attachPinFilter(acct.pinInput, () => note(acct.pinMsg, ''));
  acct.form.addEventListener('submit', onAccountSubmit);
  acct.pinForm?.addEventListener('submit', onPinSubmit);
  acct.modal.addEventListener('click', onAccountClick);
  acct.modal.addEventListener('close', () => {
    showConfirm(false);
    pinVisible = false;
  });
}
acct.button?.addEventListener('click', () => openAccount());

userSession.subscribe(onSession);
window.addEventListener('storage', (ev) => { // 다른 탭에서 로그인 · 로그아웃 · 닉네임 변경
  if (ev.key === null || ev.key === SESSION_KEY) userSession.reload();
});
window.addEventListener('lastchamber:need-login', (ev) => openGate(ev?.detail?.message ?? ''));
window.addEventListener('lastchamber:open-account', (ev) => openAccount({ edit: Boolean(ev?.detail?.edit) }));

// 시작: sessionBoot.js 의 첫 판단을 넘겨받는다 (로그인 중이면 바로 타이틀, 아니면 로그인 화면)
paintAccountButton(userSession.user);
if (userSession.isLoggedIn) closeGate();
else openGate();
