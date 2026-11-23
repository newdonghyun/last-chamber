/**
 * LAST CHAMBER - 대전 모드 선택 & 매칭 로비 (4-2단계)
 *
 * 타이틀의 PLAY(#btn-start)를 가로채 '대전 모드 선택' 모달을 연다. app.js · style.css 를 건드리지 않는 독립 모듈이다
 * (index.html 에 link 한 줄 · script 한 줄만 추가). 모달은 이 파일이 직접 만들어 body 에 붙이고, 스타일은 multiplayer.css.
 *
 *   · AI 딜러 대전    모달을 닫고, 가로챘던 PLAY 클릭을 그대로 다시 흘려보낸다 → app.js 의 기존 싱글플레이 시작 코드가 그대로 돈다.
 *   · 친구 초대 대전   [방 만들기] create_private_room → 4자리 코드 + 복사 버튼 / [코드 입력] 4자리 → join_private_room
 *   · 실시간 매칭     join_queue('free' | 'pro' | 'vip') · 보유 탄피 < 참가비면 버튼 비활성 · 대기 중 취소(leave_queue)
 *   · match_found     로비를 닫고 window 로 'pvp:start' 만 발생시킨다. 인게임 화면 바인딩은 4-3단계.
 *
 * ── 'pvp:start' 의 detail = { match, socket, serverUrl } (4-3단계가 받아 갈 계약) ──
 *   match      서버의 match_found 페이로드 그대로 { code, mode, tier, fee, prize, you, token, opponent, turnMs, graceMs, resume }
 *   socket     이 매칭을 만든 Socket.io 소켓. 이 순간부터 주인은 4-3이다 — 로비는 자기 리스너를 모두 떼고 손을 놓는다
 *              (게임이 끝나면 4-3 이 leave_room 또는 socket.disconnect() 를 할 것. 다음 로비 진입 때는 새 소켓을 만든다).
 *   serverUrl  접속한 서버 주소
 *   · 이벤트는 match_found 핸들러 안에서 동기로 발생한다. 서버가 곧바로 state_update(reason: 'start')를 이어 보내므로,
 *     4-3 은 pvp:start 리스너 안에서 state_update / game_over / opponent_status / receive_emote / room_closed 리스너를 '동기로' 붙여야 첫 상태를 놓치지 않는다.
 *   · 참가비 차감 · 상금 지급은 여기서 하지 않는다 (match.fee / match.prize 를 4-3 이 쓴다). 여기서는 탄피가 부족한 테이블을 막기만 한다.
 *
 * ── 서버 주소 ──  window.LAST_CHAMBER_SERVER (앱/토스 웹뷰처럼 다른 출처에서 쓸 때, 서버 CORS_ORIGIN 도 필요)
 *               → 없으면 페이지를 서빙한 서버(location.origin) → file:// 같은 비 http 에서는 http://localhost:3000.
 *   Socket.io 클라이언트는 서버가 주는 /socket.io/socket.io.js 를 처음 필요할 때 불러온다 → 서버가 꺼져 있어도 AI 딜러 대전은 영향이 없다.
 *
 * ── 로그인 (src/ui/session.js) ──
 *   소켓을 열 때 handshake auth 로 { userId, nickname } 을 보낸다 → 서버가 이 소켓을 그 유저로 기록하고, 상대에게 보이는 닉네임도 이 값으로 맞춘다
 *   (auth 는 함수라서 pvpSession 의 자동 재연결 때도 최신 닉네임이 다시 간다). 연결 직후 hello 로 서버에 기록된 내 대전 전적을 받아 로비에 보여 준다
 *   (예전 서버라 hello 가 없으면 조용히 생략). 로그인 전에는 로비를 열지 않고 로그인 화면을 부른다(window 'lastchamber:need-login').
 */

import { PlayerProfile, getTitle } from './storeData.js';
import { userSession } from './session.js';

const START_BUTTON_ID = 'btn-start';
const DEFAULT_SERVER = 'http://localhost:3000';
const CONNECT_TIMEOUT_MS = 6000;
const ACK_TIMEOUT_MS = 8000;
const CODE_LENGTH = 4;
const COPY_RESET_MS = 1800;

/** 매칭 테이블 — 참가비 · 상금은 server/matchmaker.js 의 QUEUE_TIERS 와 같은 값 (화면 표시와 탄피 부족 판정용, 최종 값은 서버 응답을 따른다) */
const TABLES = Object.freeze([
  Object.freeze({ tier: 'free', name: '일반 테이블', fee: 0, prize: 0 }),
  Object.freeze({ tier: 'pro', name: '프로 테이블', fee: 200, prize: 360 }),
  Object.freeze({ tier: 'vip', name: 'VIP 데스매치', fee: 1000, prize: 1800 }),
]);

const HEADINGS = Object.freeze({
  menu: ['SELECT MODE', '대전 모드 선택'],
  room: ['PRIVATE ROOM', '친구 초대 대전'],
  queue: ['MATCHMAKING', '상대를 찾는 중'],
});

const ERROR_TEXT = Object.freeze({
  CONNECT_FAILED: '서버에 연결할 수 없습니다. 네트워크나 서버 상태를 확인해 주세요.',
  TIMEOUT: '서버 응답이 없습니다. 잠시 후 다시 시도해 주세요.',
  INSUFFICIENT_BRASS: '보유 탄피가 부족합니다.',
  BAD_REQUEST: '요청 형식이 올바르지 않습니다.',
  RATE_LIMITED: '요청이 너무 빠릅니다. 잠시 후 다시 시도해 주세요.',
  ALREADY_IN_ROOM: '이미 다른 방에 참가 중입니다.',
  ROOM_NOT_FOUND: '해당 코드의 방을 찾을 수 없습니다.',
  ROOM_FULL: '이미 가득 찬 방입니다.',
  INVALID_TIER: '알 수 없는 테이블입니다.',
  SERVER_BUSY: '서버가 혼잡합니다. 잠시 후 다시 시도해 주세요.',
  SERVER_ERROR: '서버 오류가 발생했습니다.',
  INVALID_NICKNAME: '닉네임이 규칙에 맞지 않습니다. 타이틀 우상단 계정 메뉴에서 바꿔 주세요.',
});

const fmt = (n) => Number(n).toLocaleString('ko-KR');
const errorText = (code) => ERROR_TEXT[code] ?? (code ? `요청을 처리하지 못했습니다. (${code})` : '알 수 없는 오류가 발생했습니다.');

// ───────── 상태 ─────────

const profile = new PlayerProfile(); // app.js · monetization.js 와 같은 localStorage 키 — 여기서는 읽기만 한다 (열 때마다 reload)

let sock = null; // 이번 로비 세션의 소켓 (매칭이 성사되면 pvp:start 로 넘기고 null 로 돌린다)
let session = 0; // 로비 세션 번호 — 닫히거나 끊길 때마다 올려서, 늦게 도착한 비동기 결과를 버린다
let phase = 'menu'; // 'menu' | 'room'(친구 대기) | 'queue'(매칭 대기)
let busy = false; // 요청이 오가는 동안 버튼 잠금
let passThrough = false; // AI 딜러 대전이 PLAY 클릭을 다시 흘려보내는 동안만 true
let tickTimer = 0;
let tickFrom = 0;
let copyTimer = 0;
let serverRecord = null; // 서버에 기록된 내 전적 { mmr, wins, losses, streak } — hello · get_leaderboard 응답 (이번 방문 동안 기억)
let connecting = null; // { session, promise } — 로비를 열 때의 랭킹 연결과 버튼 동작이 겹쳐도 소켓은 하나만
let helloDone = Promise.resolve(null); // 지금 소켓의 hello(서버 DB upsert) 응답 — 랭킹은 이게 끝난 뒤에 받는다

/** 로비 랭킹 티어 (서버 MMR 기준) */
const RANK_TIERS = Object.freeze([[1500, 'MASTER'], [1300, 'DIAMOND'], [1150, 'GOLD'], [1000, 'SILVER'], [0, 'BRONZE']]);
const rankTier = (mmr) => (RANK_TIERS.find(([min]) => mmr >= min) ?? RANK_TIERS.at(-1))[1];
/** 서버가 준 전적 → { mmr, wins, losses, streak } | null (예전 서버처럼 mmr 이 없으면 null) */
const asRecord = (r) => (r && ['mmr', 'wins', 'losses'].every((k) => Number.isFinite(r[k]))
  ? { mmr: r.mmr, wins: r.wins, losses: r.losses, streak: Number.isFinite(r.streak) ? r.streak : 0 }
  : null);

// ───────── 화면 (모달을 직접 만든다) ─────────

const dialog = document.createElement('dialog');
dialog.className = 'mp-modal';
dialog.id = 'mp-lobby';
dialog.setAttribute('aria-labelledby', 'mp-title');
dialog.innerHTML = `
  <div class="mp-card">
    <header class="mp-head">
      <div>
        <p class="mp-eyebrow" data-ui="eyebrow">SELECT MODE</p>
        <h2 class="mp-title" id="mp-title" data-ui="title">대전 모드 선택</h2>
      </div>
      <button class="mp-close" type="button" data-act="close" aria-label="닫기">&#10005;</button>
    </header>
    <p class="mp-me"><span class="mp-tier" data-ui="me-tier">—</span><b data-ui="me-name"></b><small data-ui="me-record"></small></p>
    <p class="mp-wallet"><span>보유 탄피</span><b data-ui="brass">0</b></p>

    <div class="mp-view" data-ui="menu">
      <section class="mp-sec" aria-labelledby="mp-h-solo">
        <h3 class="mp-sec-title" id="mp-h-solo">AI 딜러 대전 <small>SINGLE</small></h3>
        <button class="mp-btn mp-btn--solo" type="button" data-act="solo" data-ui="solo" autofocus>
          <span class="mp-btn-main">딜러와 승부하기</span><span class="mp-btn-sub">즉시 시작</span>
        </button>
      </section>

      <section class="mp-sec" aria-labelledby="mp-h-friend">
        <h3 class="mp-sec-title" id="mp-h-friend">친구 초대 대전 <small>PRIVATE</small></h3>
        <button class="mp-btn" type="button" data-act="create" data-ui="create">
          <span class="mp-btn-main">방 만들기</span><span class="mp-btn-sub">4자리 코드 발급</span>
        </button>
        <form class="mp-join" data-ui="join-form" autocomplete="off">
          <label class="mp-join-label" for="mp-code">코드 입력</label>
          <div class="mp-join-row">
            <input id="mp-code" class="mp-code-input" data-ui="code-input" type="text" maxlength="${CODE_LENGTH}" inputmode="text" lang="en"
              autocapitalize="characters" autocomplete="off" autocorrect="off" spellcheck="false" enterkeyhint="go" placeholder="A7K9"
              aria-describedby="mp-code-hint" />
            <button class="mp-btn mp-btn--join" type="submit" data-ui="join-btn" disabled>입장</button>
          </div>
          <p class="mp-hint" id="mp-code-hint">영문 대문자 · 숫자 ${CODE_LENGTH}자리</p>
        </form>
      </section>

      <section class="mp-sec" aria-labelledby="mp-h-ranked">
        <h3 class="mp-sec-title" id="mp-h-ranked">실시간 랭크 &amp; 판돈 매칭 <small>RANKED</small></h3>
        <div class="mp-tables">
          ${TABLES.map((t) => `
          <button class="mp-table" type="button" data-act="table" data-tier="${t.tier}">
            <span class="mp-table-name">${t.name}</span>
            <span class="mp-table-fee">${t.fee > 0 ? `${fmt(t.fee)} 탄피` : '무료'}</span>
            <span class="mp-table-note"></span>
          </button>`).join('')}
        </div>
      </section>

      <section class="mp-sec" aria-labelledby="mp-h-board">
        <h3 class="mp-sec-title" id="mp-h-board">TOP 10 랭킹 <small>LEADERBOARD</small></h3>
        <ol class="mp-board" data-ui="board"></ol>
        <p class="mp-hint" data-ui="board-note">랭킹을 불러오는 중…</p>
      </section>
    </div>

    <div class="mp-view mp-wait" data-ui="room" hidden>
      <p class="mp-wait-label">친구에게 이 코드를 알려 주세요</p>
      <p class="mp-room-code" data-ui="room-code">----</p>
      <button class="mp-btn mp-btn--copy" type="button" data-act="copy" data-ui="copy">
        <span class="mp-btn-main" data-ui="copy-label">코드 복사</span>
      </button>
      <p class="mp-wait-note"><span class="mp-pulse" aria-hidden="true"></span>친구가 입장하면 바로 대전이 시작됩니다</p>
      <button class="mp-btn mp-btn--ghost" type="button" data-act="cancel"><span class="mp-btn-main">방 닫기</span></button>
    </div>

    <div class="mp-view mp-wait" data-ui="queue" hidden>
      <div class="mp-radar" aria-hidden="true"><i></i><i></i><i></i></div>
      <p class="mp-wait-label" data-ui="queue-name">매칭 중</p>
      <p class="mp-elapsed" data-ui="elapsed">0:00</p>
      <p class="mp-wait-note" data-ui="queue-meta"></p>
      <button class="mp-btn mp-btn--ghost" type="button" data-act="cancel"><span class="mp-btn-main">매칭 취소</span></button>
    </div>

    <p class="mp-status" data-ui="status" role="status" aria-live="polite"></p>
  </div>`;
document.body.append(dialog);

const q = (name) => dialog.querySelector(`[data-ui="${name}"]`);
const ui = {
  eyebrow: q('eyebrow'),
  title: q('title'),
  meTier: q('me-tier'),
  meName: q('me-name'),
  meRecord: q('me-record'),
  board: q('board'),
  boardNote: q('board-note'),
  brass: q('brass'),
  menu: q('menu'),
  room: q('room'),
  queue: q('queue'),
  solo: q('solo'),
  create: q('create'),
  joinForm: q('join-form'),
  codeInput: q('code-input'),
  joinBtn: q('join-btn'),
  roomCode: q('room-code'),
  copyBtn: q('copy'),
  copyLabel: q('copy-label'),
  queueName: q('queue-name'),
  queueMeta: q('queue-meta'),
  elapsed: q('elapsed'),
  status: q('status'),
  tables: [...dialog.querySelectorAll('[data-tier]')].map((btn) => ({
    btn,
    table: TABLES.find((t) => t.tier === btn.dataset.tier),
    note: btn.querySelector('.mp-table-note'),
  })),
};

function say(text, tone = 'info') {
  ui.status.textContent = text;
  ui.status.dataset.tone = tone;
}

/** 로비 맨 위 내 전적: 티어 · 닉네임 · MMR · 승/패 · 연승 (서버 응답 전에는 안내 문구) */
function paintMe() {
  const r = serverRecord;
  const tier = r ? rankTier(r.mmr) : null;
  ui.meTier.textContent = tier ?? '—';
  ui.meTier.dataset.tier = tier?.toLowerCase() ?? '';
  ui.meName.textContent = userSession.user?.nickname ?? profile.nickname;
  ui.meRecord.textContent = r
    ? `MMR ${fmt(r.mmr)} · ${fmt(r.wins)}승 ${fmt(r.losses)}패 · ${fmt(r.streak)}연승`
    : '대전 서버에 연결되면 서버 전적이 표시돼요';
}

/** TOP 10 리스트 (닉네임은 사용자 입력이라 textContent 로만) */
function paintBoard(top) {
  const cell = (cls, text) => {
    const node = document.createElement('span');
    node.className = cls;
    node.textContent = text;
    return node;
  };
  ui.board.replaceChildren(...top.slice(0, 10).map((r) => {
    const li = document.createElement('li');
    li.className = r.isMe ? 'mp-row is-me' : 'mp-row';
    const tier = rankTier(r.mmr);
    const pill = cell('mp-tier', tier);
    pill.dataset.tier = tier.toLowerCase();
    li.append(cell('mp-row-rank', String(r.rank)), pill, cell('mp-row-name', String(r.nickname ?? '')), cell('mp-row-mmr', fmt(r.mmr)),
      cell('mp-row-wl', `${fmt(r.wins)}승 ${fmt(r.losses)}패 · ${fmt(r.streak ?? 0)}연승`));
    return li;
  }));
  ui.boardNote.textContent = top.length ? '' : '아직 기록이 없어요 — 첫 승리의 주인공이 되어 보세요';
}

/** 로비를 열면 서버에 붙어 TOP 10 · 내 전적을 가져온다 (get_leaderboard). 실패해도 AI 딜러 대전 · 버튼은 그대로 */
async function refreshBoard() {
  const mine = session;
  ui.boardNote.textContent = '랭킹을 불러오는 중…';
  try {
    await ensureSocket();
    await helloDone; // 서버가 players 에 upsert 를 끝낸 뒤 → 방금 만든/고친 내 행까지 반영된 랭킹
    if (mine !== session) return;
    const res = await request('get_leaderboard');
    if (mine !== session) return;
    if (!res.ok || !Array.isArray(res.top)) throw new Error(res.error ?? 'BAD_RESPONSE');
    const me = asRecord(res.me);
    if (me) {
      serverRecord = me;
      paintMe();
    }
    paintBoard(res.top);
  } catch (err) {
    if (mine !== session || err?.message === 'CANCELLED') return;
    ui.board.replaceChildren();
    ui.boardNote.textContent = '랭킹을 불러오지 못했어요 · 서버 연결을 확인해 주세요';
  }
}

/** 요청 중이거나 탄피가 모자란 버튼을 잠근다 (AI 딜러 · 닫기는 언제나 열어 둔다 — 빠져나갈 길) */
function syncControls() {
  const brass = profile.brass;
  ui.brass.textContent = fmt(brass);
  for (const { btn, table, note } of ui.tables) {
    const short = brass < table.fee;
    btn.disabled = busy || short;
    btn.classList.toggle('is-short', short);
    note.textContent = short ? `탄피 ${fmt(table.fee - brass)} 부족` : table.prize > 0 ? `승자 상금 ${fmt(table.prize)}` : '참가비 없음';
  }
  ui.create.disabled = busy;
  ui.codeInput.disabled = busy;
  ui.joinBtn.disabled = busy || ui.codeInput.value.length !== CODE_LENGTH;
}

function setBusy(on) {
  busy = on;
  dialog.classList.toggle('is-busy', on);
  syncControls();
}

function setPhase(next) {
  phase = next;
  ui.menu.hidden = next !== 'menu';
  ui.room.hidden = next !== 'room';
  ui.queue.hidden = next !== 'queue';
  [ui.eyebrow.textContent, ui.title.textContent] = HEADINGS[next];
  if (next !== 'queue') stopTicker();
}

/** 메뉴로 돌아간다 (message 가 있으면 상태줄에 표시) */
function toMenu(message = '', tone = 'info') {
  setPhase('menu');
  busy = false;
  dialog.classList.remove('is-busy');
  profile.reload(); // 그새 바뀐 탄피 반영
  syncControls();
  say(message, tone);
  if (dialog.open) ui.solo.focus();
}

function resetUi() {
  ui.codeInput.value = '';
  ui.copyLabel.textContent = '코드 복사';
  ui.copyBtn.classList.remove('is-done');
  paintMe();
  toMenu();
}

function closeDialog() {
  if (dialog.open) dialog.close();
}

function startTicker() {
  stopTicker();
  tickFrom = Date.now();
  paintElapsed();
  tickTimer = setInterval(paintElapsed, 1000);
}

function stopTicker() {
  if (tickTimer) clearInterval(tickTimer);
  tickTimer = 0;
}

function paintElapsed() {
  const s = Math.floor((Date.now() - tickFrom) / 1000);
  ui.elapsed.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// ───────── 서버 연결 ─────────

function serverUrl() {
  const custom = typeof window.LAST_CHAMBER_SERVER === 'string' ? window.LAST_CHAMBER_SERVER.trim() : '';
  if (custom) return custom.replace(/\/+$/, '');
  return /^https?:$/.test(location.protocol) ? location.origin : DEFAULT_SERVER;
}

let clientLoading = null;
/** 서버가 내주는 Socket.io 클라이언트(전역 io)를 처음 필요할 때 한 번 불러온다 */
function loadSocketIoClient(base) {
  if (typeof window.io === 'function') return Promise.resolve(window.io);
  if (!clientLoading) {
    clientLoading = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = `${base}/socket.io/socket.io.js`;
      script.async = true;
      script.onload = () => (typeof window.io === 'function' ? resolve(window.io) : reject(new Error('NO_IO')));
      script.onerror = () => {
        script.remove();
        reject(new Error('LOAD_FAILED'));
      };
      document.head.append(script);
    }).catch((err) => {
      clientLoading = null; // 다음 시도에서 다시 불러온다
      throw err;
    });
  }
  return clientLoading;
}

/** handshake auth · hello 로 보내는 내 신원 — 로그인 전이면 빈 객체 (서버는 예전처럼 익명 소켓으로 받는다) */
function identity() {
  const user = userSession.user;
  return user ? { userId: user.id, nickname: user.nickname } : {};
}

/**
 * 접속 즉시 user_id · nickname 을 보낸다 → 서버가 players 에 upsert(신규 생성 / 닉네임 갱신)를 끝내고 최신 전적으로 답한다.
 * → Promise<전적 | null> (응답이 없거나 실패해도 대전에는 영향이 없다)
 */
function sayHello(s) {
  const who = identity();
  if (!who.userId) return Promise.resolve(null);
  return new Promise((resolve) => {
    s.timeout(ACK_TIMEOUT_MS).emit('hello', who, (err, res) => {
      const record = err || !res?.ok ? null : asRecord(res.user);
      if (record) {
        serverRecord = record;
        paintMe();
      }
      resolve(record);
    });
  });
}

/** 소켓을 열고 첫 connect 까지 기다린다. 첫 시도가 실패하면 재시도 없이 접는다 (CONNECT_FAILED) */
function openSocket(io, mine) {
  return new Promise((resolve, reject) => {
    // auth 를 함수로 주면 (재)연결할 때마다 다시 읽는다 → 매칭 뒤 pvpSession 이 자동 재연결해도 지금 닉네임으로 다시 인증된다
    const s = io(serverUrl(), { forceNew: true, timeout: CONNECT_TIMEOUT_MS, auth: (cb) => cb(identity()) });
    const onFail = () => {
      s.off('connect', onOk);
      s.disconnect();
      reject(new Error('CONNECT_FAILED'));
    };
    const onOk = () => {
      s.off('connect_error', onFail);
      if (mine !== session) { // 기다리는 사이 로비가 닫혔다
        s.disconnect();
        reject(new Error('CANCELLED'));
        return;
      }
      resolve(s);
    };
    s.once('connect', onOk);
    s.once('connect_error', onFail);
  });
}

/** 이 로비 세션의 소켓 — 연결 중이면 그 연결을 같이 기다린다 (동시에 불려도 소켓을 둘 만들지 않는다) */
function ensureSocket() {
  if (sock) return Promise.resolve(sock);
  if (connecting?.session !== session) {
    const mine = session;
    const promise = connectSocket(mine).finally(() => { if (connecting?.promise === promise) connecting = null; });
    connecting = { session: mine, promise };
  }
  return connecting.promise;
}

async function connectSocket(mine) {
  let io;
  try {
    io = await loadSocketIoClient(serverUrl());
  } catch {
    throw new Error('CONNECT_FAILED');
  }
  if (mine !== session) throw new Error('CANCELLED');
  const s = await openSocket(io, mine);
  sock = s;
  s.on('match_found', onMatchFound);
  s.on('room_closed', onRoomClosed);
  s.on('disconnect', onDisconnect);
  helloDone = sayHello(s); // 연결 즉시 로그인 · DB upsert — 방 만들기 · 매칭 요청은 기다리지 않고 바로 이어서 보낸다
  return s;
}

function detach(s) {
  s.off('match_found', onMatchFound);
  s.off('room_closed', onRoomClosed);
  s.off('disconnect', onDisconnect);
}

/** 로비 세션을 끝낸다 — 소켓을 끊으면 서버가 대기열 · 기다리던 방을 알아서 정리한다 */
function disposeSocket() {
  session += 1;
  const s = sock;
  sock = null;
  if (!s) return;
  detach(s);
  s.disconnect();
}

/** 이벤트 한 번 보내고 ack 를 기다린다. 항상 resolve 한다: { ok: true, ... } | { ok: false, error } */
function request(event, payload) {
  return new Promise((resolve) => {
    if (!sock) {
      resolve({ ok: false, error: 'CONNECT_FAILED' });
      return;
    }
    const args = payload === undefined ? [] : [payload];
    sock.timeout(ACK_TIMEOUT_MS).emit(event, ...args, (err, res) => {
      resolve(err ? { ok: false, error: 'TIMEOUT' } : (res ?? { ok: false, error: 'SERVER_ERROR' }));
    });
  });
}

/**
 * 서버에 보내는 내 프로필 (서버가 같은 모양으로 다시 걸러 낸다 — cleanProfile). 코스메틱은 지금 화면에 적용되는 조합이다.
 * 닉네임은 로그인한 닉네임 — 서버도 handshake auth 로 인증한 닉네임으로 덮어쓰므로, 상대 화면의 이름표와 서버 기록이 같은 이름이 된다.
 */
function buildProfile() {
  profile.reload();
  const loadout = profile.activeLoadout();
  return {
    nickname: userSession.user?.nickname ?? profile.nickname,
    mmr: profile.mmr,
    tier: profile.tier.id,
    title: getTitle(profile.equippedTitle)?.name,
    cosmetics: { gun: loadout.gun, table: loadout.table, flame: loadout.flame, taunt: profile.equippedTaunt },
  };
}

// ───────── 서버 이벤트 ─────────

function onMatchFound(match) {
  const s = sock;
  if (!s || !match || typeof match !== 'object') return;
  // 화면이 어느 단계였든 서버가 매칭을 확정했으면 따른다 (취소를 누른 바로 그 순간에 성사된 경우 포함)
  detach(s);
  sock = null;
  session += 1;
  stopTicker();
  closeDialog();
  window.dispatchEvent(new CustomEvent('pvp:start', { detail: { match, socket: s, serverUrl: serverUrl() } }));
}

function onRoomClosed(info) {
  if (phase !== 'room') return;
  toMenu(info?.reason === 'EXPIRED' ? '방이 만료되어 닫혔습니다. 다시 만들어 주세요.' : '방이 닫혔습니다.', 'error');
}

function onDisconnect(reason) {
  if (reason === 'io client disconnect') return; // 우리가 끊은 것
  disposeSocket(); // 끊긴 사이 서버가 대기열 · 방을 이미 정리했다 → 처음부터
  toMenu('서버와 연결이 끊어졌습니다. 다시 시도해 주세요.', 'error');
}

// ───────── 동작 ─────────

/**
 * 서버가 필요한 동작을 한 번에 하나씩 돌린다 (연결 → action). action 이 true 를 돌려주면 버튼 잠금을 유지한다.
 * 로비가 도중에 닫히면(session 변경) 결과는 화면에 반영하지 않는다.
 */
async function run(action) {
  if (busy) return;
  const mine = session;
  let keepBusy = false;
  setBusy(true);
  if (!sock) say('서버에 연결하는 중…');
  try {
    await ensureSocket();
    if (mine !== session) return;
    keepBusy = (await action()) === true;
  } catch (err) {
    if (mine === session) say(errorText(err instanceof Error ? err.message : ''), 'error');
  } finally {
    if (mine === session && !keepBusy) setBusy(false);
  }
}

function startSolo() {
  closeDialog();
  disposeSocket();
  passThrough = true; // 우리가 가로챈 PLAY 를 그대로 다시 누른다 → app.js 의 기존 시작 코드
  try {
    document.getElementById(START_BUTTON_ID)?.click();
  } finally {
    passThrough = false;
  }
}

function createRoom() {
  run(async () => {
    say('방을 만드는 중…');
    const res = await request('create_private_room', { profile: buildProfile() });
    if (!res.ok) throw new Error(res.error);
    ui.roomCode.textContent = res.code;
    ui.copyLabel.textContent = '코드 복사';
    ui.copyBtn.classList.remove('is-done');
    setPhase('room');
    say('');
    ui.copyBtn.focus();
  });
}

function joinRoom(code) {
  run(async () => {
    say('방에 입장하는 중…');
    const res = await request('join_private_room', { code, profile: buildProfile() });
    if (!res.ok) throw new Error(res.error);
    say('입장했습니다. 대전을 시작합니다…', 'ok');
    return true; // match_found 가 곧 도착해 로비가 닫힌다 — 그때까지 잠금 유지
  });
}

function startQueue(table) {
  profile.reload();
  if (profile.brass < table.fee) {
    syncControls();
    say(errorText('INSUFFICIENT_BRASS'), 'error');
    return;
  }
  run(async () => {
    say(`${table.name} 매칭을 요청하는 중…`);
    const res = await request('join_queue', { tier: table.tier, profile: buildProfile() });
    if (!res.ok) throw new Error(res.error);
    const fee = Number.isFinite(res.fee) ? res.fee : table.fee;
    const prize = Number.isFinite(res.prize) ? res.prize : table.prize;
    if (fee > profile.brass) { // 서버의 참가비가 화면 표보다 커졌다면 되돌린다
      request('leave_queue');
      throw new Error('INSUFFICIENT_BRASS');
    }
    ui.queueName.textContent = `${table.name} · ${fee > 0 ? `${fmt(fee)} 탄피` : '무료'}`;
    ui.queueMeta.textContent = prize > 0 ? `승자 상금 ${fmt(prize)} 탄피` : '참가비 · 상금 없음';
    setPhase('queue');
    startTicker();
    say('');
    ui.queue.querySelector('[data-act="cancel"]').focus();
  });
}

/** 대기 중 취소 — 응답은 기다리지 않는다 (같은 소켓의 이벤트는 순서대로 처리되므로 바로 다음 요청을 해도 안전) */
function cancelWait() {
  const inQueue = phase === 'queue';
  request(inQueue ? 'leave_queue' : 'leave_room');
  toMenu(inQueue ? '매칭을 취소했습니다.' : '방을 닫았습니다.');
}

/** 클립보드에 복사. 비보안 컨텍스트(http · file)에서는 구식 방식으로 한 번 더 시도한다 */
async function copyText(text) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* 권한 없음 · 비보안 컨텍스트 → 아래 방식으로 */
  }
  const prev = document.activeElement;
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.className = 'mp-copy-buffer';
  dialog.append(area); // 모달이 열려 있는 동안 바깥 요소는 inert 라서 모달 안에 둬야 select · copy 가 먹는다
  area.select();
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  area.remove();
  if (prev instanceof HTMLElement) prev.focus();
  return ok;
}

async function onCopy() {
  const ok = await copyText(ui.roomCode.textContent.trim());
  ui.copyLabel.textContent = ok ? '복사됨 ✓' : '복사 실패 · 코드를 직접 알려 주세요';
  ui.copyBtn.classList.toggle('is-done', ok);
  clearTimeout(copyTimer);
  copyTimer = setTimeout(() => {
    ui.copyLabel.textContent = '코드 복사';
    ui.copyBtn.classList.remove('is-done');
  }, COPY_RESET_MS);
}

// ───────── 이벤트 연결 ─────────

dialog.addEventListener('click', (e) => {
  const el = e.target instanceof Element ? e.target.closest('[data-act]') : null;
  if (!el || el.disabled) return;
  switch (el.dataset.act) {
    case 'close': closeDialog(); break;
    case 'solo': startSolo(); break;
    case 'create': createRoom(); break;
    case 'copy': onCopy(); break;
    case 'cancel': cancelWait(); break;
    case 'table': {
      const table = TABLES.find((t) => t.tier === el.dataset.tier);
      if (table) startQueue(table);
      break;
    }
    default: break;
  }
});

// 코드 입력: 영문 대문자 · 숫자만, 4자리까지 (한글 조합 중에는 건드리지 않고 조합이 끝나면 정리)
function cleanCode() {
  const v = ui.codeInput.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, CODE_LENGTH);
  if (v !== ui.codeInput.value) ui.codeInput.value = v;
  syncControls();
}
ui.codeInput.addEventListener('input', (e) => { if (!e.isComposing) cleanCode(); });
ui.codeInput.addEventListener('compositionend', cleanCode);
ui.joinForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const code = ui.codeInput.value;
  if (!busy && code.length === CODE_LENGTH) joinRoom(code);
});

// 닫히는 모든 경로(✕ · Esc · AI 딜러 · 매칭 성사)에서: 소켓 정리 + 화면 초기화. 소켓을 끊으면 서버가 대기열 · 대기 방을 정리한다
dialog.addEventListener('close', () => {
  disposeSocket();
  resetUi();
});

// PLAY 가로채기: document 캡처 단계라 app.js 의 클릭 핸들러(타깃/버블 단계)보다 항상 먼저 돌고, 로드 순서에도 영향받지 않는다
document.addEventListener('click', (e) => {
  if (passThrough) return;
  const btn = e.target instanceof Element ? e.target.closest(`#${START_BUTTON_ID}`) : null;
  if (!btn) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  if (!userSession.isLoggedIn) { // 로그인 전에는 로비 · 매칭으로 가지 않는다 (보통은 시작 화면이 이미 가리고 있다)
    window.dispatchEvent(new CustomEvent('lastchamber:need-login'));
    return;
  }
  if (dialog.open) return;
  resetUi();
  dialog.showModal();
  refreshBoard();
}, true);

// 로그인 · 닉네임 변경 · 로그아웃: 로비의 내 이름을 바로 고치고, 연결 중이면 서버에도 새 닉네임을 알린다. 로그아웃이면 로비를 닫는다(소켓도 정리)
userSession.subscribe((user) => {
  if (!user) {
    serverRecord = null;
    closeDialog();
  } else if (sock?.connected) {
    helloDone = sayHello(sock);
  }
  paintMe();
});
