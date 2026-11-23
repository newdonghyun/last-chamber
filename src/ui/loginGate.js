/**
 * LAST CHAMBER - 시작 화면 로그인(닉네임 설정) · 계정 창 — src/ui/session.js 의 화면
 *
 *   · 앱을 켜면 가장 먼저 #login-modal 이 뜬다: 닉네임 입력(2~10자 · 공백 없이) + [시작하기]. 회원가입 없이 바로 시작한다.
 *     로그인 전에는 타이틀(게임 시작 · 로비 · 매칭 · 상점)을 누를 수 없다 (모달 + html.needs-login 이 타이틀을 숨긴다).
 *   · 닉네임 + 유저 ID(UUID)는 session.js 가 localStorage 에 저장한다 → 다시 접속하면 이 화면 없이 바로 타이틀(자동 로그인).
 *   · 첫 화면 전에 src/ui/sessionBoot.js 가 html.needs-login 을 붙여 두므로 CSS(loginGate.css)가 처음부터 이 화면을 보여 준다
 *     → 타이틀이 잠깐 비쳤다가 로그인 화면으로 바뀌는 깜빡임이 없다. 이 모듈은 그 판단을 넘겨받아 진짜 모달(showModal)로 바꾼다.
 *   · 타이틀 우상단 #btn-account → #account-modal: 내 닉네임 · 유저 ID 앞 8자리 · [닉네임 변경] · [로그아웃](한 번 더 확인).
 *   · 닉네임이 바뀌면 session.js 가 구독자에게 바로 알린다 — app.js(HUD · 인게임 이름표 · 프로필) · multiplayer.js(로비 · 소켓 hello).
 *   · window 'lastchamber:need-login' 이벤트를 받으면 이 화면을 다시 연다 (로그인 없이 대전을 시작하려 할 때 등).
 */

import { userSession, validateNickname, nicknameErrorText, attachNicknameFilter, NICK_RULE, NICK_HINT, SESSION_KEY } from './session.js';
import { PlayerProfile, NICKNAME } from './storeData.js';

const $ = (id) => document.getElementById(id);
const root = document.documentElement;
const gate = {
  modal: $('login-modal'),
  form: $('login-form'),
  input: $('login-nick'),
  count: $('login-count'),
  msg: $('login-msg'),
};
const acct = {
  button: $('btn-account'),
  modal: $('account-modal'),
  name: $('acct-name'),
  uid: $('acct-uid'),
  form: $('acct-form'),
  input: $('acct-nick'),
  count: $('acct-count'),
  msg: $('acct-msg'),
  logout: $('acct-logout'),
  confirm: $('acct-confirm'),
};
const legacy = new PlayerProfile(); // 이 업데이트 전부터 쓰던 프로필 닉네임 → 첫 로그인 화면의 기본값 (읽기만)

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

// ───────── 로그인 화면 ─────────

/** 기본값: 로그아웃 전에 쓰던 닉네임 → 없으면 예전 프로필 닉네임(기본 '방랑자'가 아니고 새 규칙에 맞을 때만) */
function prefill() {
  const last = userSession.lastNickname;
  if (last) return last;
  legacy.reload();
  const old = legacy.nickname;
  return old !== NICKNAME.default && validateNickname(old).ok ? old : '';
}

function openGate() {
  if (!gate.modal) return;
  closeAccount();
  if (!gate.modal.open) {
    gate.input.value = prefill();
    paintCount(gate.count, gate.input.value);
    note(gate.msg, NICK_HINT);
  }
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

function onGateSubmit(ev) {
  ev.preventDefault(); // method="dialog" 가 창을 닫지 않게 — 닫는 건 로그인이 성공했을 때(onSession)만
  const res = userSession.login(gate.input.value);
  if (res.ok) return;
  note(gate.msg, nicknameErrorText(res.reason), 'bad');
  gate.input.focus();
}

// ───────── 계정 창 (닉네임 변경 · 로그아웃) ─────────

function paintAccountButton(user) {
  if (!acct.button) return;
  acct.button.setAttribute('aria-label', user ? `계정: ${user.nickname} — 닉네임 변경 · 로그아웃` : '로그인');
  acct.button.title = user ? `${user.nickname} · 닉네임 변경 · 로그아웃` : '로그인';
}

function paintAccount(user) {
  if (acct.name) acct.name.textContent = user.nickname;
  if (acct.uid) acct.uid.textContent = user.id.slice(0, 8).toUpperCase(); // 전체 ID 는 서버 기록의 열쇠라 화면에는 앞부분만
}

function showConfirm(on) {
  if (!acct.confirm || !acct.logout) return;
  acct.confirm.hidden = !on;
  acct.logout.hidden = on;
  if (on) acct.confirm.querySelector('[data-acct="confirm-logout"]')?.focus();
}

function openAccount() {
  const user = userSession.user;
  if (!user) {
    openGate();
    return;
  }
  paintAccount(user);
  acct.input.value = user.nickname;
  paintCount(acct.count, acct.input.value);
  note(acct.msg, NICK_HINT);
  showConfirm(false);
  openModal(acct.modal);
}

function closeAccount() {
  showConfirm(false);
  closeModal(acct.modal);
}

function onAccountSubmit(ev) {
  ev.preventDefault();
  const res = userSession.rename(acct.input.value);
  if (!res.ok) {
    note(acct.msg, nicknameErrorText(res.reason), 'bad');
    acct.input.focus();
    return;
  }
  acct.input.value = res.user.nickname;
  paintCount(acct.count, acct.input.value);
  note(acct.msg, res.unchanged ? '지금 쓰고 있는 닉네임이에요' : '닉네임을 바꿨어요 — 대전 상대에게도 이 이름으로 보여요', 'ok');
}

function onAccountClick(ev) {
  if (ev.target === acct.modal) { // 카드 밖 어두운 곳
    closeAccount();
    return;
  }
  const btn = ev.target instanceof Element ? ev.target.closest('[data-acct]') : null;
  switch (btn?.dataset.acct) {
    case 'close': closeAccount(); break;
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
    note(gate.msg, NICK_HINT); // 다시 입력하면 이전 오류 안내는 지운다
  });
  gate.form.addEventListener('submit', onGateSubmit);
  gate.modal.addEventListener('cancel', (ev) => ev.preventDefault()); // Esc 로 건너뛸 수 없다
}
if (acct.modal && acct.form && acct.input) {
  attachNicknameFilter(acct.input, (value) => {
    paintCount(acct.count, value);
    note(acct.msg, NICK_HINT);
  });
  acct.form.addEventListener('submit', onAccountSubmit);
  acct.modal.addEventListener('click', onAccountClick);
  acct.modal.addEventListener('close', () => showConfirm(false));
}
acct.button?.addEventListener('click', openAccount);

userSession.subscribe(onSession);
window.addEventListener('storage', (ev) => { // 다른 탭에서 로그인 · 로그아웃 · 닉네임 변경
  if (ev.key === null || ev.key === SESSION_KEY) userSession.reload();
});
window.addEventListener('lastchamber:need-login', openGate);

// 시작: sessionBoot.js 의 첫 판단을 넘겨받는다 (로그인 중이면 바로 타이틀, 아니면 로그인 화면)
paintAccountButton(userSession.user);
if (userSession.isLoggedIn) closeGate();
else openGate();
