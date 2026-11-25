/**
 * LAST CHAMBER - 시작 화면(로그인 · 회원가입 · 둘러보기) · 계정 창 — src/ui/session.js · src/ui/accountApi.js 의 화면
 *
 *   · 로그인 기록이 없으면 #login-modal 이 뜬다: [로그인] 아이디 · 비밀번호 / [회원가입] 아이디 · 비밀번호(확인) · 닉네임.
 *     성공하면 서버가 준 로그인 토큰을 session.js 가 localStorage 에 저장 → 다시 접속하면 이 화면 없이 바로 타이틀(자동 로그인).
 *     [로그인 없이 둘러보기] = 손님: AI 딜러 연습만 (로비의 온라인 대전은 잠겨 있고, 누르면 이 화면이 다시 뜬다).
 *     로그인 전에는 타이틀을 누를 수 없다 (모달 + html.needs-login 이 타이틀을 숨긴다).
 *   · 첫 화면 전에 src/ui/sessionBoot.js 가 html.needs-login 을 붙여 두므로 CSS(loginGate.css)가 처음부터 이 화면을 보여 준다
 *     → 타이틀이 잠깐 비쳤다가 로그인 화면으로 바뀌는 깜빡임이 없다. 이 모듈은 그 판단을 넘겨받아 진짜 모달(showModal)로 바꾼다.
 *   · 타이틀 우상단 #btn-account → #account-modal: 닉네임 [변경](누를 때만 변경 칸이 열린다 — 서버가 바로 UPDATE · 중복 차단) · 아이디 · [로그아웃](한 번 더 확인).
 *     손님이면 계정 버튼이 로그인 화면을 연다.
 *   · window 'lastchamber:need-login' 이벤트를 받으면 이 화면을 다시 연다 (detail.message 가 있으면 그 안내와 함께 — 예: 토큰 만료 · 손님이 온라인 대전을 누름).
 *     window 'lastchamber:open-account' 이벤트를 받으면 계정 창을 연다 (detail.edit 이면 닉네임 변경 칸까지).
 */

import {
  userSession, validateNickname, validateUsername, validatePassword, nicknameErrorText, attachNicknameFilter,
  NICK_RULE, NICK_HINT, USERNAME_HINT, PASSWORD_HINT, SESSION_KEY,
} from './session.js';
import { logIn, signUp, changeNickname } from './accountApi.js';
import { PlayerProfile, NICKNAME } from './storeData.js';

const $ = (id) => document.getElementById(id);
const root = document.documentElement;
const gate = {
  modal: $('login-modal'),
  form: $('login-form'),
  tabs: [$('tab-login'), $('tab-signup')].filter(Boolean),
  user: $('login-user'),
  pass: $('login-pass'),
  pass2: $('login-pass2'),
  nick: $('login-nick'),
  count: $('login-count'),
  msg: $('login-msg'),
  submit: $('login-submit'),
  submitMain: $('login-submit-main'),
  submitSub: $('login-submit-sub'),
  guest: $('login-guest'),
};
const acct = {
  button: $('btn-account'),
  modal: $('account-modal'),
  name: $('acct-name'),
  username: $('acct-username'),
  edit: $('acct-edit'),
  form: $('acct-form'),
  input: $('acct-nick'),
  count: $('acct-count'),
  msg: $('acct-msg'),
  logout: $('acct-logout'),
  confirm: $('acct-confirm'),
};
const legacy = new PlayerProfile(); // 이 업데이트 전부터 쓰던 프로필 닉네임 → 가입 화면 닉네임 칸의 기본값 (읽기만)
const MODE = {
  login: { main: '로그인', sub: 'LOG IN', hint: '아이디와 비밀번호로 로그인하세요', pass: 'current-password' },
  signup: { main: '회원가입', sub: 'SIGN UP', hint: `아이디: ${USERNAME_HINT} · 비밀번호: ${PASSWORD_HINT} · 닉네임: ${NICK_HINT}`, pass: 'new-password' },
};
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

/** 잠깐 떠오르는 알림 띠 (가입 · 로그인 결과) */
function toast(text) {
  const node = document.createElement('p');
  node.className = 'acct-toast';
  node.setAttribute('role', 'status');
  node.textContent = text;
  document.body.append(node);
  setTimeout(() => node.remove(), 3400);
}

const recordText = (me) => (me && me.wins + me.losses > 0 ? ` — 랭킹전 ${me.wins}승 ${me.losses}패 · MMR ${me.mmr}` : '');

// ───────── 시작 화면: 로그인 · 회원가입 · 둘러보기 ─────────

let mode = 'login';
function setMode(next, { focus = true } = {}) {
  mode = next === 'signup' ? 'signup' : 'login';
  gate.form.dataset.mode = mode;
  for (const tab of gate.tabs) {
    const on = tab.dataset.mode === mode;
    tab.setAttribute('aria-selected', String(on));
    tab.tabIndex = on ? 0 : -1;
  }
  const m = MODE[mode];
  if (gate.submitMain) gate.submitMain.textContent = m.main;
  if (gate.submitSub) gate.submitSub.textContent = m.sub;
  gate.pass.autocomplete = m.pass;
  gate.pass2.required = mode === 'signup';
  gate.nick.required = mode === 'signup';
  note(gate.msg, m.hint);
  if (focus) (gate.user.value ? gate.pass : gate.user).focus();
}

/** 가입 화면 닉네임 기본값: 마지막 닉네임 → 예전 프로필 닉네임(기본 '방랑자'가 아니고 규칙에 맞을 때만) */
function nicknameDefault() {
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
    gate.user.value = userSession.lastUsername ?? '';
    gate.pass.value = '';
    gate.pass2.value = '';
    gate.nick.value = nicknameDefault();
    paintCount(gate.count, gate.nick.value);
    setMode(userSession.lastUsername ? 'login' : mode, { focus: false });
  }
  if (message) note(gate.msg, message, 'bad');
  setNeedsLogin(true);
  openModal(gate.modal);
  (gate.user.value ? gate.pass : gate.user).focus();
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
  gate.form.classList.toggle('is-busy', on);
  gate.submit.disabled = on;
  gate.form.setAttribute('aria-busy', String(on));
}

/** 제출 전 화면에서 먼저 검사 → 문제 있으면 { node, message } */
function precheck() {
  const u = validateUsername(gate.user.value);
  if (!u.ok) return { node: gate.user, message: nicknameErrorText(u.reason) };
  if (mode === 'login') return gate.pass.value ? null : { node: gate.pass, message: '비밀번호를 입력해 주세요' };
  const p = validatePassword(gate.pass.value);
  if (!p.ok) return { node: gate.pass, message: nicknameErrorText(p.reason) };
  if (gate.pass2.value !== gate.pass.value) return { node: gate.pass2, message: '비밀번호 확인이 맞지 않아요' };
  const n = validateNickname(gate.nick.value);
  if (!n.ok) return { node: gate.nick, message: nicknameErrorText(n.reason) };
  return null;
}

const FOCUS_ON_ERROR = { USERNAME_TAKEN: 'user', INVALID_USERNAME: 'user', NICKNAME_TAKEN: 'nick', INVALID_NICKNAME: 'nick', BAD_CREDENTIALS: 'pass', INVALID_PASSWORD: 'pass' };

let gateBusy = false;
async function onGateSubmit(ev) {
  ev.preventDefault(); // method="dialog" 가 창을 닫지 않게 — 닫는 건 로그인이 성공했을 때(onSession)만
  if (gateBusy) return;
  const problem = precheck();
  if (problem) {
    note(gate.msg, problem.message, 'bad');
    problem.node.focus();
    return;
  }
  gateBusy = true;
  setGateBusy(true);
  note(gate.msg, mode === 'login' ? '로그인하는 중…' : '계정을 만드는 중…');
  const slow = setTimeout(() => note(gate.msg, '서버를 깨우는 중이에요 — 처음 접속이면 최대 1분쯤 걸릴 수 있어요'), SLOW_HINT_MS);
  const signing = mode;
  const res = signing === 'login'
    ? await logIn({ username: gate.user.value, password: gate.pass.value })
    : await signUp({ username: gate.user.value, password: gate.pass.value, nickname: gate.nick.value });
  clearTimeout(slow);
  gateBusy = false;
  setGateBusy(false);
  if (!res.ok) {
    note(gate.msg, res.message, 'bad');
    const field = FOCUS_ON_ERROR[res.error];
    if (field === 'pass') gate.pass.value = '';
    gate[field]?.focus();
    return;
  }
  // 성공 → session.signIn 이 구독자(onSession)에게 알려 로그인 화면이 닫힌다
  gate.pass.value = '';
  gate.pass2.value = '';
  toast(signing === 'login'
    ? `${res.user.nickname}, 다시 오셨군요${recordText(res.me)}`
    : `${res.user.nickname} 계정을 만들었어요 — 다른 기기에서도 같은 아이디로 이어서 플레이`);
}

function onGuest() {
  userSession.continueAsGuest(); // → onSession(null) · isGuest → 로그인 화면이 닫힌다
  toast('둘러보기 — AI 딜러 연습만 할 수 있어요. 온라인 대전은 로그인 후에');
}

// ───────── 계정 창 (닉네임 변경 · 로그아웃) ─────────

function paintAccountButton(user) {
  if (!acct.button) return;
  acct.button.setAttribute('aria-label', user ? `계정: ${user.nickname} — 닉네임 변경 · 로그아웃` : '로그인 · 회원가입');
  acct.button.title = user ? `${user.nickname} · 닉네임 변경 · 로그아웃` : '로그인 · 회원가입';
  acct.button.classList.toggle('is-guest', !user);
}

function paintAccount(user) {
  if (acct.name) acct.name.textContent = user.nickname;
  if (acct.username) acct.username.textContent = user.username;
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
    if (res.error !== 'AUTH_REQUIRED') acct.input.focus();
    return;
  }
  acct.input.value = res.user.nickname;
  paintCount(acct.count, acct.input.value);
  note(acct.msg, res.unchanged ? '지금 쓰고 있는 닉네임이에요' : '닉네임을 바꿨어요 — 랭킹 · 대전 상대에게도 이 이름으로 보여요', 'ok');
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
  if (!user && !userSession.isGuest) {
    openGate();
    return;
  }
  if (gate.modal?.open || root.classList.contains('needs-login')) {
    closeGate();
    $('btn-start')?.focus({ preventScroll: true });
  }
  if (user && acct.modal?.open) paintAccount(user);
}

// ───────── 연결 ─────────

if (gate.modal && gate.form && gate.user && gate.pass) {
  for (const tab of gate.tabs) tab.addEventListener('click', () => setMode(tab.dataset.mode));
  gate.tabs[0]?.parentElement?.addEventListener('keydown', (ev) => { // ← → 로 탭 전환
    if (ev.key !== 'ArrowLeft' && ev.key !== 'ArrowRight') return;
    ev.preventDefault();
    setMode(mode === 'login' ? 'signup' : 'login', { focus: false });
    gate.tabs.find((t) => t.dataset.mode === mode)?.focus();
  });
  gate.user.addEventListener('input', () => {
    const lower = gate.user.value.toLowerCase().replace(/\s+/g, '');
    if (lower !== gate.user.value) gate.user.value = lower; // 아이디는 소문자 · 공백 없이
    if (gate.msg.classList.contains('is-bad')) note(gate.msg, MODE[mode].hint);
  });
  attachNicknameFilter(gate.nick, (value) => {
    paintCount(gate.count, value);
    if (gate.msg.classList.contains('is-bad')) note(gate.msg, MODE[mode].hint);
  });
  gate.form.addEventListener('submit', onGateSubmit);
  gate.modal.addEventListener('cancel', (ev) => ev.preventDefault()); // Esc 로 건너뛸 수 없다 (둘러보기 버튼으로만)
  gate.guest?.addEventListener('click', onGuest);
  setMode('login', { focus: false });
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
acct.button?.addEventListener('click', () => openAccount());

userSession.subscribe(onSession);
window.addEventListener('storage', (ev) => { // 다른 탭에서 로그인 · 로그아웃 · 닉네임 변경
  if (ev.key === null || ev.key === SESSION_KEY) userSession.reload();
});
window.addEventListener('lastchamber:need-login', (ev) => openGate(ev?.detail?.message ?? ''));
window.addEventListener('lastchamber:open-account', (ev) => openAccount({ edit: Boolean(ev?.detail?.edit) }));

// 시작: sessionBoot.js 의 첫 판단을 넘겨받는다 (로그인 중 · 손님이면 바로 타이틀, 아니면 로그인 화면)
paintAccountButton(userSession.user);
if (userSession.isLoggedIn || userSession.isGuest) closeGate();
else openGate();
