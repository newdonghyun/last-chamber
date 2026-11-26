/**
 * ODD ROULETTE - 일일 출석 보상 팝업 (모바일 게임식 출석 모달)
 *
 *   · 로그인(자동 로그인 포함)이 끝나고 서버 지갑을 불러왔을 때, 오늘 보상을 아직 안 받았으면 화면 중앙에 자동으로 띄운다 (그날 한 번).
 *     이미 받은 사람에게는 띄우지 않는다. 게임 중 · 매칭 대기 · 결과 화면 · 다른 창이 떠 있을 때 · 초대 링크로 입장하는 중에는 끼어들지 않는다.
 *   · [출석 보상 받기] → 서버가 지급 (wallet.checkIn) → 획득 안내를 잠깐 보이고 저절로 닫힌다.
 *   · [출석] 버튼(타이틀 우상단 #btn-daily · 대전 모드 선택 창 머리줄)을 누르면 받은 뒤에도 언제든 다시 열어 볼 수 있다.
 *   · 서버 지갑을 못 불러오면 오류 코드와 [다시 불러오기] 를 보인다.
 *
 * 출석의 원본 · 검증은 서버다 (server/wallet.js). 판단 규칙은 attendanceRules.js, 그림은 attendanceArt.js, 모양은 attendance.css.
 */

import { userSession } from './session.js';
import { sharedWallet, WALLET_CHANGED } from './walletClient.js';
import { peekInvite } from './invite.js';
import { autoOpenKey, claimedDays, claimFeedback, rewardName } from './attendanceRules.js';
import { ART_DEFS, artFor, STAMP } from './attendanceArt.js';

const OPEN_DAILY = 'lastchamber:open-daily';
const CLOSE_AFTER_MS = 1600; // 획득 안내를 보여 주고 저절로 닫히기까지

const wallet = sharedWallet();

const dialog = document.createElement('dialog');
dialog.id = 'daily-modal';
dialog.className = 'daily-modal';
dialog.setAttribute('aria-labelledby', 'daily-title');
dialog.innerHTML = `
  ${ART_DEFS}
  <div class="daily-card">
    <button class="daily-x" type="button" data-daily="close" aria-label="닫기">&#10005;</button>
    <p class="daily-eyebrow">DAILY CHECK-IN</p>
    <h2 id="daily-title">일일 출석 보상</h2>
    <p class="daily-sub">매일 출석해 7일 보상을 모두 받으세요 · 한국 시간 자정에 갱신</p>
    <ol class="daily-grid" data-daily="grid" aria-label="7일 출석 보상"></ol>
    <p class="daily-feedback" data-daily="feedback" role="status" aria-live="polite"></p>
    <button class="daily-claim" type="button" data-daily="claim">출석 보상 받기</button>
    <button class="daily-retry" type="button" data-daily="retry" hidden>다시 불러오기</button>
  </div>`;
document.body.append(dialog);

const part = (name) => dialog.querySelector(`[data-daily="${name}"]`);
const grid = part('grid');
const feedback = part('feedback');
const claimButton = part('claim');
const retryButton = part('retry');
const titleScreen = document.getElementById('start-modal');
const lobby = document.getElementById('mp-lobby'); // multiplayer.js 가 만든다 (index.html 에서 이 모듈보다 먼저 실행)

let busy = false;
let message = '';
let justClaimed = 0; // 방금 받은 칸 (도장 찍는 연출)
let closeTimer = 0;
let shownKey = null; // 이번 접속에서 이미 띄운 '계정|날짜' — 닫은 뒤 다시 끼어들지 않는다

const entryButtons = () => [document.getElementById('btn-daily'), lobby?.querySelector('[data-act="open-daily"]')].filter(Boolean);

function slot(reward, done, att) {
  const li = document.createElement('li');
  const claimed = reward.day <= done;
  const today = reward.day === att.todayDay;
  li.className = `daily-slot${claimed ? ' is-claimed' : ''}${today ? ' is-today' : ''}${reward.day === att.rewards.length ? ' is-special' : ''}${reward.day === justClaimed ? ' is-fresh' : ''}`;
  li.dataset.day = String(reward.day);
  const name = rewardName(reward);
  li.setAttribute('aria-label', `${reward.day}일차 ${name}${claimed ? ' · 수령 완료' : today ? ' · 오늘' : ''}`);
  const day = document.createElement('b');
  day.textContent = `${reward.day}일차`;
  const picture = document.createElement('span');
  picture.className = 'daily-art';
  picture.innerHTML = artFor(reward.day); // 이 파일들이 만든 고정 SVG
  const label = document.createElement('span');
  label.className = 'daily-name';
  label.textContent = name;
  li.append(day, picture, label);
  if (claimed) li.insertAdjacentHTML('beforeend', STAMP);
  return li;
}

function render() {
  const loggedIn = userSession.isLoggedIn;
  const state = loggedIn ? wallet.state : null;
  const error = loggedIn && !state ? wallet.lastError : null;
  const gift = Boolean(state && !state.attendance.claimedToday);
  for (const button of entryButtons()) {
    button.hidden = !loggedIn;
    button.classList.toggle('has-gift', gift);
    button.classList.toggle('has-error', Boolean(error));
    button.setAttribute('aria-label', gift ? '출석 보상 — 오늘 받을 보상이 있어요' : '출석 보상');
  }
  if (!dialog.open) return;
  grid.hidden = !state;
  claimButton.hidden = !state;
  retryButton.hidden = !error;
  if (!state) {
    feedback.textContent = error ? `출석 정보를 불러오지 못했어요 (${error}) — 잠시 뒤에 다시 불러와 주세요` : '출석 정보를 불러오는 중…';
    return;
  }
  const att = state.attendance;
  const done = claimedDays(att);
  grid.replaceChildren(...att.rewards.map((reward) => slot(reward, done, att)));
  claimButton.disabled = busy || att.claimedToday;
  claimButton.textContent = busy ? '받는 중…' : att.claimedToday ? '오늘 출석 완료 · 내일 또 만나요' : '출석 보상 받기';
  feedback.textContent = message;
}

function open() {
  if (dialog.open || !userSession.isLoggedIn) return;
  message = '';
  justClaimed = 0;
  shownKey = autoOpenKey(userSession.user?.id, wallet.state) ?? shownKey;
  dialog.showModal();
  render();
  if (!claimButton.hidden && !claimButton.disabled) claimButton.focus({ preventScroll: true });
}

function close() {
  clearTimeout(closeTimer);
  if (dialog.open) dialog.close();
}

async function claim() {
  if (busy) return;
  busy = true;
  message = '';
  render();
  const res = await wallet.checkIn();
  busy = false;
  if (res.ok) {
    justClaimed = res.day;
    message = claimFeedback(res);
    render();
    closeTimer = setTimeout(close, CLOSE_AFTER_MS);
    return;
  }
  message = res.error === 'ALREADY_CHECKED_IN'
    ? '오늘은 이미 출석했어요 — 한국 시간 자정이 지나면 다시 받을 수 있어요'
    : '서버에 연결할 수 없어요. 잠시 뒤에 다시 시도해 주세요';
  render();
}

/** 지금 팝업이 끼어들면 안 되는가 */
function blocked() {
  if (peekInvite()) return true; // 초대 링크로 입장하기 직전
  if (!titleScreen?.open && !lobby?.open) return true; // 게임 중
  if (lobby?.open) {
    if (lobby.classList.contains('is-busy') || lobby.querySelector('[data-ui="menu"]')?.hidden) return true; // 입장 · 대기 · 매칭 중
  } else if (titleScreen.classList.contains('is-result')) {
    return true; // 결과 화면 (보상 연출을 가리지 않는다)
  }
  return [...document.querySelectorAll('dialog[open]')].some((d) => d !== titleScreen && d !== lobby && d !== dialog); // 로그인 · 상점 · 계정 창 등
}

function maybeAutoOpen() {
  if (dialog.open) {
    if (!titleScreen?.open && !lobby?.open) close(); // 그새 게임이 시작됐다
    return;
  }
  if (!userSession.isLoggedIn) return;
  const key = autoOpenKey(userSession.user?.id, wallet.state);
  if (!key || key === shownKey || blocked()) return;
  open();
}

let scheduled = false;
/** 같은 순간의 여러 변화(창 닫힘 → 다른 창 열림)가 끝난 뒤에 한 번만 판단한다 */
function schedule() {
  if (scheduled) return;
  scheduled = true;
  setTimeout(() => {
    scheduled = false;
    maybeAutoOpen();
  }, 0);
}

dialog.addEventListener('click', (e) => {
  if (e.target === dialog) { close(); return; } // 바깥 어두운 곳
  const act = e.target.closest?.('[data-daily]')?.dataset.daily;
  if (act === 'close') close();
  else if (act === 'claim') claim();
  else if (act === 'retry') wallet.sync().then(render);
});
dialog.addEventListener('close', () => clearTimeout(closeTimer));

function openAndRefresh() {
  open();
  if (userSession.isLoggedIn) wallet.sync().then(render); // 날이 바뀌었을 수 있다
}
document.getElementById('btn-daily')?.addEventListener('click', openAndRefresh);
window.addEventListener(OPEN_DAILY, openAndRefresh);
window.addEventListener('pvp:start', close);
document.addEventListener(WALLET_CHANGED, () => { render(); schedule(); });
userSession.subscribe((user) => {
  if (!user) close();
  render();
  schedule();
});
// 창이 열리고 닫힐 때(로그인 화면이 닫힘 · 게임이 시작됨 · 타이틀로 돌아옴) 다시 판단
new MutationObserver(schedule).observe(document.body, { subtree: true, attributes: true, attributeFilter: ['open'] });
if (lobby) new MutationObserver(schedule).observe(lobby, { attributes: true, attributeFilter: ['class'] });

render();
schedule();
