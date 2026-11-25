/**
 * LAST CHAMBER - 대전 모드 선택 & 매칭 로비
 *
 * 타이틀의 PLAY(#btn-start)를 가로채 '대전 모드 선택' 모달을 연다. 모달은 이 파일이 직접 만들어 body 에 붙이고, 스타일은 multiplayer.css.
 *
 *   · AI 딜러 대전 (연습)   모달을 닫고, 가로챘던 PLAY 클릭을 그대로 다시 흘려보낸다 → app.js 의 기존 싱글플레이 시작 코드. 로그인 없이도 된다(손님).
 *   · 온라인 랭킹전 (MMR)   로그인한 계정만 — 승 +25 · 패 −20
 *       공개 방     로비 목록(watch_rooms → room_list)에 상대를 기다리는 방이 실시간으로 보인다 (방장 닉네임 · MMR · 1/2명).
 *                   목록에서 누르면 바로 1:1 시작(join_public_room) · [공개 방 만들기](create_public_room) → 목록에 즉시 보이고 누가 들어오면 시작
 *       빠른 매칭   join_queue('free' | 'pro' | 'vip') · 보유 탄피 < 참가비면 버튼 비활성 · 대기 중 취소(leave_queue)
 *   · 친선 비밀방 (방 코드) 로그인한 계정만 — [친선 방 만들기] create_private_room → 4자리 코드 + 복사 / [방 코드로 입장] → join_private_room
 *                          목록에 보이지 않고 MMR · 전적에 반영되지 않는다 (어뷰징 방지)
 *   · match_found     로비를 닫고 window 로 'pvp:start' 만 발생시킨다. 인게임은 pvpSession.js.
 *   손님(로그인 안 함)은 랭킹전 · 친선방 칸이 잠겨 있고, 누르면 로그인 화면(window 'lastchamber:need-login')이 뜬다.
 *
 * ── 'pvp:start' 의 detail = { match, socket, serverUrl } ──
 *   match      서버의 match_found 페이로드 그대로 { code, mode, ranked, tier, fee, prize, you, token, opponent, turnMs, graceMs, resume }
 *   socket     이 매칭을 만든 Socket.io 소켓. 이 순간부터 주인은 pvpSession 이다 — 로비는 자기 리스너를 모두 떼고 손을 놓는다
 *   serverUrl  접속한 서버 주소
 *   · 이벤트는 match_found 핸들러 안에서 동기로 발생한다 (서버가 곧바로 state_update 를 이어 보내므로 pvpSession 은 리스너를 동기로 붙인다).
 *   · 참가비 차감 · 상금 지급은 여기서 하지 않는다 (match.fee / match.prize 를 pvpSession 이 쓴다). 여기서는 탄피가 부족한 테이블을 막기만 한다.
 *
 * ── 서버 주소 ──  window.LAST_CHAMBER_SERVER → 없으면 페이지를 서빙한 서버(location.origin) → file:// 같은 비 http 에서는 Render 서버(DEFAULT_SERVER).
 *   Socket.io 클라이언트는 서버가 주는 /socket.io/socket.io.js 를 처음 필요할 때 불러온다 → 서버가 꺼져 있어도 AI 딜러 대전은 영향이 없다.
 *
 * ── 로그인 (src/ui/session.js) ──
 *   소켓을 열 때 handshake auth 로 { token } (로그인 토큰)을 보낸다 → 서버가 확인해 이 소켓을 그 계정으로 기록한다
 *   (auth 는 함수라서 pvpSession 의 자동 재연결 때도 다시 간다). 연결 직후 register_player { token } → 내 전적 + TOP 10.
 *   서버가 토큰을 거절하면(AUTH_REQUIRED · 만료 등) 로그아웃하고 로그인 화면을 다시 연다.
 */

import { PlayerProfile, getTitle, MMR as RANKED_MMR } from './storeData.js';
import { userSession } from './session.js';
import { requireLogin } from './accountApi.js';

const START_BUTTON_ID = 'btn-start';
// 예비 주소 — 보통은 serverConfig.js 가 먼저 window.LAST_CHAMBER_SERVER 를 정한다 (웹 = 지금 도메인 · 앱 = 같은 Render 주소). localhost 로 고정하지 않는다
const DEFAULT_SERVER = 'https://last-chamber-aaz9.onrender.com';
const CONNECT_TIMEOUT_MS = 6000;
const ACK_TIMEOUT_MS = 8000;
const CODE_LENGTH = 4;
const COPY_RESET_MS = 1800;

/** 빠른 매칭 테이블 — 참가비 · 상금은 server/matchmaker.js 의 QUEUE_TIERS 와 같은 값 (화면 표시와 탄피 부족 판정용, 최종 값은 서버 응답을 따른다) */
const TABLES = Object.freeze([
  Object.freeze({ tier: 'free', name: '일반 테이블', fee: 0, prize: 0 }),
  Object.freeze({ tier: 'pro', name: '프로 테이블', fee: 200, prize: 360 }),
  Object.freeze({ tier: 'vip', name: 'VIP 데스매치', fee: 1000, prize: 1800 }),
]);

const HEADINGS = Object.freeze({
  menu: ['SELECT MODE', '대전 모드 선택'],
  public: ['PUBLIC ROOM', '공개 방 — 상대를 기다리는 중'],
  room: ['FRIENDLY ROOM', '친선 비밀방 (랭킹 MMR 미반영)'],
  queue: ['RANKED MATCH', '빠른 매칭 — 상대를 찾는 중'],
});

const ERROR_TEXT = Object.freeze({
  CONNECT_FAILED: '서버에 연결할 수 없습니다. 네트워크나 서버 상태를 확인해 주세요.',
  TIMEOUT: '서버 응답이 없습니다. 잠시 후 다시 시도해 주세요.',
  INSUFFICIENT_BRASS: '보유 탄피가 부족합니다.',
  BAD_REQUEST: '요청 형식이 올바르지 않습니다.',
  RATE_LIMITED: '요청이 너무 빠릅니다. 잠시 후 다시 시도해 주세요.',
  AUTH_REQUIRED: '로그인한 계정만 참여할 수 있어요.',
  ALREADY_IN_ROOM: '이미 다른 방에 참가 중입니다.',
  ROOM_NOT_FOUND: '방을 찾을 수 없어요 — 이미 시작됐거나 닫혔을 수 있어요.',
  ROOM_FULL: '이미 가득 찬 방이에요.',
  OWN_ROOM: '내가 만든 방이에요.',
  INVALID_TIER: '알 수 없는 테이블입니다.',
  SERVER_BUSY: '서버가 혼잡합니다. 잠시 후 다시 시도해 주세요.',
  SERVER_ERROR: '서버 오류가 발생했습니다.',
});

const fmt = (n) => Number(n).toLocaleString('ko-KR');
const errorText = (code) => ERROR_TEXT[code] ?? (code ? `요청을 처리하지 못했습니다. (${code})` : '알 수 없는 오류가 발생했습니다.');

// ───────── 상태 ─────────

const profile = new PlayerProfile(); // app.js · monetization.js 와 같은 localStorage 키 — 탄피 표시 · 서버 랭킹 기록으로 랭킹 전적을 맞출 때(syncRanked)만 쓴다
const PROFILE_CHANGED = 'lastchamber:profile-changed'; // monetization.js 의 PROFILE_CHANGED 와 같은 이름 — app.js 가 미니 카드 · 프로필을 다시 그린다

let sock = null; // 이번 로비 세션의 소켓 (매칭이 성사되면 pvp:start 로 넘기고 null 로 돌린다)
let session = 0; // 로비 세션 번호 — 닫히거나 끊길 때마다 올려서, 늦게 도착한 비동기 결과를 버린다
let phase = 'menu'; // 'menu' | 'public'(공개 방 대기) | 'room'(비밀방 대기) | 'queue'(빠른 매칭 대기)
let busy = false; // 요청이 오가는 동안 버튼 잠금
let passThrough = false; // AI 딜러 대전이 PLAY 클릭을 다시 흘려보내는 동안만 true
let tickTimer = 0;
let tickFrom = 0;
let copyTimer = 0;
let serverRecord = null; // 서버에 기록된 내 전적 { mmr, wins, losses, streak } — register_player · get_leaderboard 응답 (이번 방문 동안 기억)
let connecting = null; // { session, promise } — 로비를 열 때의 연결과 버튼 동작이 겹쳐도 소켓은 하나만
let registered = Promise.resolve(null); // 지금 소켓의 register_player 응답 { ok, user, me, top }
let myPublicCode = null; // 내가 열어 둔 공개 방 코드 (목록에서 '내 방' 표시)
let lastRooms = []; // 마지막으로 받은 공개 방 목록

/** 로비 랭킹 티어 (서버 MMR 기준) */
const RANK_TIERS = Object.freeze([[1500, 'MASTER'], [1300, 'DIAMOND'], [1150, 'GOLD'], [1000, 'SILVER'], [0, 'BRONZE']]);
const rankTier = (mmr) => (RANK_TIERS.find(([min]) => mmr >= min) ?? RANK_TIERS.at(-1))[1];
/** 서버가 준 전적 → { mmr, wins, losses, streak, maxStreak } | null */
const asRecord = (r) => (r && ['mmr', 'wins', 'losses'].every((k) => Number.isFinite(r[k]))
  ? { mmr: r.mmr, wins: r.wins, losses: r.losses, streak: Number.isFinite(r.streak) ? r.streak : 0, maxStreak: Number.isFinite(r.maxStreak) ? r.maxStreak : 0 }
  : null);

/** 서버(Supabase players)의 내 랭킹 기록을 받았다 → 로비에 그리고, 이 기기의 랭킹 기록(티어 · 미니 카드 · 프로필)도 서버 값으로 맞춘다 */
function takeServerRecord(record) {
  serverRecord = record;
  paintMe();
  if (profile.syncRanked(record)) document.dispatchEvent(new CustomEvent(PROFILE_CHANGED));
}

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
    <p class="mp-me"><span class="mp-tier" data-ui="me-tier">—</span><b data-ui="me-name"></b><button class="mp-edit" type="button" data-act="edit-nick" data-ui="me-btn" aria-label="닉네임 변경">변경</button><small data-ui="me-record"></small></p>
    <p class="mp-wallet"><span>보유 탄피</span><b data-ui="brass">0</b></p>

    <div class="mp-view" data-ui="menu">
      <!-- 모드: AI 딜러 대전(연습 · 손님도) · 온라인 랭킹전(공개 방 · 빠른 매칭 — MMR) · 친선 비밀방(방 코드 — MMR 미반영) -->
      <section class="mp-sec" aria-labelledby="mp-h-solo">
        <h3 class="mp-sec-title" id="mp-h-solo">AI 딜러 대전 (연습) <small>PRACTICE</small></h3>
        <button class="mp-btn mp-btn--solo" type="button" data-act="solo" data-ui="solo" autofocus>
          <span class="mp-btn-main">딜러와 승부하기</span><span class="mp-btn-sub">즉시 시작 · 랭킹 MMR 미반영</span>
        </button>
      </section>

      <section class="mp-sec" aria-labelledby="mp-h-ranked">
        <h3 class="mp-sec-title" id="mp-h-ranked">온라인 랭킹전 (MMR) <small>RANKED</small></h3>
        <p class="mp-hint">공개 방 · 빠른 매칭 결과가 랭킹에 반영돼요 — 승리 MMR +${RANKED_MMR.win} · 패배 −${RANKED_MMR.loss}</p>
        <div class="mp-lock" data-ui="lock-ranked" hidden>
          <span>로그인한 계정만 참여할 수 있어요</span>
          <button class="mp-btn mp-btn--login" type="button" data-act="login">로그인 · 회원가입</button>
        </div>
        <h4 class="mp-sub">공개 방 <small data-ui="rooms-count">대기 중 0</small></h4>
        <ul class="mp-rooms" data-ui="rooms" aria-live="polite"></ul>
        <p class="mp-hint" data-ui="rooms-note">방 목록을 불러오는 중…</p>
        <button class="mp-btn" type="button" data-act="create-public" data-ui="create-public" data-online>
          <span class="mp-btn-main">공개 방 만들기</span><span class="mp-btn-sub">목록에 바로 보여요</span>
        </button>
        <h4 class="mp-sub">빠른 매칭 <small>RANDOM</small></h4>
        <div class="mp-tables">
          ${TABLES.map((t) => `
          <button class="mp-table" type="button" data-act="table" data-tier="${t.tier}" data-online>
            <span class="mp-table-name">${t.name}</span>
            <span class="mp-table-fee">${t.fee > 0 ? `${fmt(t.fee)} 탄피` : '무료'}</span>
            <span class="mp-table-note"></span>
          </button>`).join('')}
        </div>
      </section>

      <section class="mp-sec" aria-labelledby="mp-h-friend">
        <h3 class="mp-sec-title" id="mp-h-friend">친선 비밀방 (방 코드) <small>FRIENDLY</small></h3>
        <p class="mp-hint">목록에 보이지 않는 방 — 친구에게 코드를 알려 주세요 · 랭킹 MMR · 전적에 반영되지 않아요</p>
        <div class="mp-lock" data-ui="lock-friend" hidden>
          <span>로그인한 계정만 참여할 수 있어요</span>
          <button class="mp-btn mp-btn--login" type="button" data-act="login">로그인 · 회원가입</button>
        </div>
        <button class="mp-btn" type="button" data-act="create" data-ui="create" data-online>
          <span class="mp-btn-main">친선 방 만들기 (비밀방)</span><span class="mp-btn-sub">4자리 코드 발급</span>
        </button>
        <form class="mp-join" data-ui="join-form" autocomplete="off">
          <label class="mp-join-label" for="mp-code">방 코드로 입장</label>
          <div class="mp-join-row">
            <input id="mp-code" class="mp-code-input" data-ui="code-input" type="text" maxlength="${CODE_LENGTH}" inputmode="text" lang="en"
              autocapitalize="characters" autocomplete="off" autocorrect="off" spellcheck="false" enterkeyhint="go" placeholder="A7K9"
              aria-describedby="mp-code-hint" />
            <button class="mp-btn mp-btn--join" type="submit" data-ui="join-btn" disabled>입장</button>
          </div>
          <p class="mp-hint" id="mp-code-hint">영문 대문자 · 숫자 ${CODE_LENGTH}자리</p>
        </form>
      </section>

      <section class="mp-sec" aria-labelledby="mp-h-board">
        <h3 class="mp-sec-title" id="mp-h-board">TOP 10 랭킹 <small>LEADERBOARD</small></h3>
        <ol class="mp-board" data-ui="board"></ol>
        <p class="mp-hint" data-ui="board-note">랭킹을 불러오는 중…</p>
        <p class="mp-hint">온라인 랭킹전을 1판 이상 둔 계정만 순위에 올라요</p>
      </section>
    </div>

    <div class="mp-view mp-wait" data-ui="public" hidden>
      <div class="mp-radar" aria-hidden="true"><i></i><i></i><i></i></div>
      <p class="mp-wait-label">공개 방을 열었어요</p>
      <p class="mp-elapsed" data-ui="public-elapsed">0:00</p>
      <p class="mp-wait-note"><span class="mp-pulse" aria-hidden="true"></span>로비 목록에서 상대가 누르면 바로 랭킹전이 시작됩니다</p>
      <button class="mp-btn mp-btn--ghost" type="button" data-act="cancel"><span class="mp-btn-main">방 닫기</span></button>
    </div>

    <div class="mp-view mp-wait" data-ui="room" hidden>
      <p class="mp-wait-label">친구에게 이 코드를 알려 주세요</p>
      <p class="mp-room-code" data-ui="room-code">----</p>
      <button class="mp-btn mp-btn--copy" type="button" data-act="copy" data-ui="copy">
        <span class="mp-btn-main" data-ui="copy-label">코드 복사</span>
      </button>
      <p class="mp-wait-note"><span class="mp-pulse" aria-hidden="true"></span>친구가 코드로 입장하면 바로 친선전이 시작됩니다 (랭킹 MMR 미반영)</p>
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
  meBtn: q('me-btn'),
  meRecord: q('me-record'),
  board: q('board'),
  boardNote: q('board-note'),
  brass: q('brass'),
  menu: q('menu'),
  public: q('public'),
  room: q('room'),
  queue: q('queue'),
  solo: q('solo'),
  lockRanked: q('lock-ranked'),
  lockFriend: q('lock-friend'),
  rooms: q('rooms'),
  roomsCount: q('rooms-count'),
  roomsNote: q('rooms-note'),
  createPublic: q('create-public'),
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
  publicElapsed: q('public-elapsed'),
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

const loggedIn = () => userSession.isLoggedIn;

/** 로비 맨 위 내 전적: 티어 · 닉네임 · MMR · 승/패 · 연승 (손님이면 로그인 안내) */
function paintMe() {
  const user = userSession.user;
  const r = user ? serverRecord : null;
  const tier = r ? rankTier(r.mmr) : null;
  ui.meTier.textContent = tier ?? '—';
  ui.meTier.dataset.tier = tier?.toLowerCase() ?? '';
  ui.meName.textContent = user?.nickname ?? '손님';
  ui.meBtn.textContent = user ? '변경' : '로그인';
  ui.meBtn.dataset.act = user ? 'edit-nick' : 'login';
  ui.meBtn.setAttribute('aria-label', user ? '닉네임 변경' : '로그인 · 회원가입');
  ui.meRecord.textContent = !user ? '로그인하면 랭킹전 · 공개 방 · 친선 비밀방에 참여할 수 있어요 (AI 딜러 연습은 그대로)'
    : !r ? '대전 서버에 연결되면 랭킹전 전적이 표시돼요'
      : r.wins + r.losses > 0 ? `랭킹 MMR ${fmt(r.mmr)} · ${fmt(r.wins)}승 ${fmt(r.losses)}패 · ${fmt(r.streak)}연승`
        : `랭킹 MMR ${fmt(r.mmr)} · 아직 랭킹전 기록이 없어요`;
}

/** 손님이면 온라인 칸을 잠근다 (누르면 로그인 화면) */
function paintAccess() {
  const guest = !loggedIn();
  dialog.classList.toggle('is-guest', guest);
  ui.lockRanked.hidden = !guest;
  ui.lockFriend.hidden = !guest;
  syncControls();
}

const cell = (tag, cls, text) => {
  const node = document.createElement(tag);
  node.className = cls;
  node.textContent = text;
  return node;
};

/** TOP 10 리스트 (닉네임은 사용자 입력이라 textContent 로만) */
function paintBoard(top) {
  ui.board.replaceChildren(...top.slice(0, 10).map((r) => {
    const li = document.createElement('li');
    li.className = r.isMe ? 'mp-row is-me' : 'mp-row';
    const tier = rankTier(r.mmr);
    const pill = cell('span', 'mp-tier', tier);
    pill.dataset.tier = tier.toLowerCase();
    li.append(cell('span', 'mp-row-rank', String(r.rank)), pill, cell('span', 'mp-row-name', String(r.nickname ?? '')), cell('span', 'mp-row-mmr', fmt(r.mmr)),
      cell('span', 'mp-row-wl', `${fmt(r.wins)}승 ${fmt(r.losses)}패 · ${fmt(r.streak ?? 0)}연승`));
    return li;
  }));
  ui.boardNote.textContent = top.length ? '' : '아직 랭킹전 기록이 없어요 — 첫 승리의 주인공이 되어 보세요';
}

/** 공개 방 목록: 방장 닉네임 · 티어 · MMR · 1/2명 · [입장] — 누르면 바로 시작 (닉네임은 textContent 로만) */
function paintRooms(rooms) {
  lastRooms = Array.isArray(rooms) ? rooms.filter((r) => r && typeof r.code === 'string') : [];
  ui.roomsCount.textContent = `대기 중 ${lastRooms.length}`;
  ui.rooms.replaceChildren(...lastRooms.map((r) => {
    const mine = r.code === myPublicCode;
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = mine ? 'mp-room is-mine' : 'mp-room';
    btn.dataset.act = 'join-public';
    btn.dataset.code = r.code;
    btn.dataset.online = '';
    const mmr = Number.isFinite(r.mmr) ? r.mmr : 1000;
    const tier = rankTier(mmr);
    const pill = cell('span', 'mp-tier', tier);
    pill.dataset.tier = tier.toLowerCase();
    btn.append(
      pill,
      cell('span', 'mp-room-host', String(r.host ?? '')),
      cell('span', 'mp-room-mmr', `MMR ${fmt(mmr)}`),
      cell('span', 'mp-room-count', `${r.players ?? 1}/${r.capacity ?? 2}명 대기 중`),
      cell('span', 'mp-room-go', mine ? '내 방' : '입장'),
    );
    btn.setAttribute('aria-label', `${r.host} 님의 공개 방 · MMR ${fmt(mmr)} · ${r.players ?? 1}/${r.capacity ?? 2}명 — ${mine ? '내 방' : '눌러서 입장'}`);
    li.append(btn);
    return li;
  }));
  ui.roomsNote.textContent = lastRooms.length ? '' : '기다리는 공개 방이 없어요 — 직접 만들어 보세요';
  syncControls();
}

/** 로비를 열면 서버에 붙어 공개 방 목록 · TOP 10 · 내 전적을 가져온다. 실패해도 AI 딜러 대전은 그대로 */
async function refreshLobby() {
  const mine = session;
  ui.boardNote.textContent = '랭킹을 불러오는 중…';
  ui.roomsNote.textContent = '방 목록을 불러오는 중…';
  try {
    await ensureSocket();
    if (mine !== session) return;
    const watched = await request('watch_rooms'); // 이 소켓을 로비 채널에 — 이후 room_list 가 바뀔 때마다 온다
    if (mine !== session) return;
    if (watched.ok) paintRooms(watched.rooms);
    let res = await registered; // 연결 즉시 보낸 register_player 의 응답 = 내 전적 + TOP 10
    if (mine !== session) return;
    if (!res?.top) res = await request('get_leaderboard'); // 손님이거나 등록이 실패했으면 랭킹만
    if (mine !== session) return;
    if (!res.ok || !Array.isArray(res.top)) throw new Error(res.error ?? 'BAD_RESPONSE');
    const me = asRecord(res.me);
    if (me && loggedIn()) takeServerRecord(me);
    paintBoard(res.top);
  } catch (err) {
    if (mine !== session || err?.message === 'CANCELLED') return;
    ui.board.replaceChildren();
    ui.boardNote.textContent = '랭킹을 불러오지 못했어요 · 서버 연결을 확인해 주세요';
    ui.roomsNote.textContent = '방 목록을 불러오지 못했어요 · 서버 연결을 확인해 주세요';
  }
}

/** 요청 중이거나 탄피가 모자란 버튼을 잠근다 (AI 딜러 · 닫기는 언제나 열어 둔다 — 빠져나갈 길). 손님이면 온라인 버튼은 눌러도 로그인 화면으로 */
function syncControls() {
  const brass = profile.brass;
  ui.brass.textContent = fmt(brass);
  for (const { btn, table, note } of ui.tables) {
    const short = brass < table.fee;
    btn.disabled = busy || (loggedIn() && short);
    btn.classList.toggle('is-short', short);
    note.textContent = short ? `탄피 ${fmt(table.fee - brass)} 부족` : table.prize > 0 ? `승자 상금 ${fmt(table.prize)}` : '참가비 없음';
  }
  ui.createPublic.disabled = busy;
  ui.create.disabled = busy;
  ui.codeInput.disabled = busy || !loggedIn();
  ui.joinBtn.disabled = busy || !loggedIn() || ui.codeInput.value.length !== CODE_LENGTH;
  for (const btn of ui.rooms.querySelectorAll('button')) btn.disabled = busy || btn.classList.contains('is-mine');
}

function setBusy(on) {
  busy = on;
  dialog.classList.toggle('is-busy', on);
  syncControls();
}

function setPhase(next) {
  phase = next;
  ui.menu.hidden = next !== 'menu';
  ui.public.hidden = next !== 'public';
  ui.room.hidden = next !== 'room';
  ui.queue.hidden = next !== 'queue';
  [ui.eyebrow.textContent, ui.title.textContent] = HEADINGS[next];
  if (next !== 'queue' && next !== 'public') stopTicker();
  if (next !== 'public') myPublicCode = null;
}

/** 메뉴로 돌아간다 (message 가 있으면 상태줄에 표시) */
function toMenu(message = '', tone = 'info') {
  setPhase('menu');
  busy = false;
  dialog.classList.remove('is-busy');
  profile.reload(); // 그새 바뀐 탄피 반영
  paintRooms(lastRooms);
  syncControls();
  say(message, tone);
  if (dialog.open) ui.solo.focus();
}

function resetUi() {
  ui.codeInput.value = '';
  ui.copyLabel.textContent = '코드 복사';
  ui.copyBtn.classList.remove('is-done');
  lastRooms = [];
  paintMe();
  paintAccess();
  toMenu();
}

function closeDialog() {
  if (dialog.open) dialog.close();
}

function startTicker(node) {
  stopTicker();
  tickFrom = Date.now();
  const paint = () => {
    const s = Math.floor((Date.now() - tickFrom) / 1000);
    node.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  };
  paint();
  tickTimer = setInterval(paint, 1000);
}

function stopTicker() {
  if (tickTimer) clearInterval(tickTimer);
  tickTimer = 0;
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

/** handshake auth 로 보내는 로그인 토큰 — 손님이면 빈 객체 (서버는 손님 소켓으로 받는다: 목록 · 랭킹만) */
function identity() {
  const token = userSession.token;
  return token ? { token } : {};
}

/** 접속 즉시 register_player { token } → 내 전적 + TOP 10. 토큰이 거절되면 로그아웃하고 로그인 화면으로. 손님 · 실패 → null */
function registerPlayer(s) {
  const token = userSession.token;
  if (!token) return Promise.resolve(null);
  return new Promise((resolve) => {
    s.timeout(ACK_TIMEOUT_MS).emit('register_player', { token }, (err, res) => {
      if (!err && res?.error === 'AUTH_REQUIRED') { // 토큰 만료 · 서버 비밀 변경 등 → 다시 로그인
        resolve(null);
        closeDialog();
        requireLogin(userSession, '로그인이 만료됐어요. 다시 로그인해 주세요.');
        return;
      }
      if (err || !res?.ok) {
        console.warn('[LAST CHAMBER] register_player 실패', err?.message ?? res?.error);
        resolve(null);
        return;
      }
      const record = asRecord(res.me ?? res.user);
      if (record) takeServerRecord(record);
      resolve(res);
    });
  });
}

/** 소켓을 열고 첫 connect 까지 기다린다. 첫 시도가 실패하면 재시도 없이 접는다 (CONNECT_FAILED) */
function openSocket(io, mine) {
  return new Promise((resolve, reject) => {
    // auth 를 함수로 주면 (재)연결할 때마다 다시 읽는다 → 매칭 뒤 pvpSession 이 자동 재연결해도 지금 토큰으로 다시 인증된다
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
  s.on('room_list', onRoomList);
  s.on('disconnect', onDisconnect);
  registered = registerPlayer(s); // 연결 즉시 로그인 확인 — 방 만들기 · 매칭 요청은 서버가 토큰 확인을 기다렸다 처리한다
  return s;
}

function detach(s) {
  s.off('match_found', onMatchFound);
  s.off('room_closed', onRoomClosed);
  s.off('room_list', onRoomList);
  s.off('disconnect', onDisconnect);
}

/** 로비 세션을 끝낸다 — 소켓을 끊으면 서버가 대기열 · 기다리던 방(공개 방은 목록에서도)을 알아서 정리한다 */
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
 * 닉네임 · MMR 은 서버가 계정 값으로 덮어쓴다 → 상대 화면의 이름표와 서버 기록이 같은 이름 · 점수가 된다.
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

function onRoomList(payload) {
  if (dialog.open) paintRooms(payload?.rooms);
}

function onRoomClosed(info) {
  if (phase !== 'room' && phase !== 'public') return;
  toMenu(info?.reason === 'EXPIRED' ? '방이 만료되어 닫혔습니다. 다시 만들어 주세요.' : '방이 닫혔습니다.', 'error');
}

function onDisconnect(reason) {
  if (reason === 'io client disconnect') return; // 우리가 끊은 것
  disposeSocket(); // 끊긴 사이 서버가 대기열 · 방을 이미 정리했다 → 처음부터
  toMenu('서버와 연결이 끊어졌습니다. 다시 시도해 주세요.', 'error');
}

// ───────── 동작 ─────────

/** 온라인 대전은 로그인한 계정만 — 손님이면 로그인 화면을 부르고 false */
function needLogin() {
  if (loggedIn()) return false;
  window.dispatchEvent(new CustomEvent('lastchamber:need-login', { detail: { message: '랭킹전 · 공개 방 · 친선 비밀방은 로그인한 계정으로 참여할 수 있어요' } }));
  return true;
}

/**
 * 서버가 필요한 동작을 한 번에 하나씩 돌린다 (연결 → action). action 이 true 를 돌려주면 버튼 잠금을 유지한다.
 * 로비가 도중에 닫히면(session 변경) 결과는 화면에 반영하지 않는다.
 */
async function run(action) {
  if (busy || needLogin()) return;
  const mine = session;
  let keepBusy = false;
  setBusy(true);
  if (!sock) say('서버에 연결하는 중…');
  try {
    await ensureSocket();
    if (mine !== session) return;
    keepBusy = (await action()) === true;
  } catch (err) {
    if (mine !== session) return;
    const code = err instanceof Error ? err.message : '';
    if (code === 'AUTH_REQUIRED') { // 토큰이 서버에서 거절됐다 → 다시 로그인
      closeDialog();
      requireLogin(userSession, '로그인이 만료됐어요. 다시 로그인해 주세요.');
      return;
    }
    say(errorText(code), 'error');
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

/** [공개 방 만들기] → 로비 목록에 즉시 보이고, 누가 들어오면 match_found 로 시작 */
function createPublicRoom() {
  run(async () => {
    say('공개 방을 여는 중…');
    const res = await request('create_public_room', { profile: buildProfile() });
    if (!res.ok) throw new Error(res.error);
    setPhase('public');
    myPublicCode = res.code;
    startTicker(ui.publicElapsed);
    say('');
    ui.public.querySelector('[data-act="cancel"]').focus();
  });
}

/** 목록에서 공개 방을 눌렀다 → 바로 1:1 시작 */
function joinPublicRoom(code) {
  run(async () => {
    say('공개 방에 입장하는 중…');
    const res = await request('join_public_room', { code, profile: buildProfile() });
    if (!res.ok) {
      if (res.error === 'ROOM_NOT_FOUND' || res.error === 'ROOM_FULL') paintRooms(lastRooms.filter((r) => r.code !== code)); // 그새 시작됐거나 닫힌 방
      throw new Error(res.error);
    }
    say('입장했습니다. 랭킹전을 시작합니다…', 'ok');
    return true; // match_found 가 곧 도착해 로비가 닫힌다 — 그때까지 잠금 유지
  });
}

/** [친선 방 만들기 (비밀방)] → 4자리 코드 (목록에 안 보임) */
function createFriendlyRoom() {
  run(async () => {
    say('비밀방을 만드는 중…');
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

/** [방 코드로 입장] → 친선전 바로 시작 */
function joinFriendlyRoom(code) {
  run(async () => {
    say('방에 입장하는 중…');
    const res = await request('join_private_room', { code, profile: buildProfile() });
    if (!res.ok) throw new Error(res.error);
    say('입장했습니다. 친선전을 시작합니다…', 'ok');
    return true; // match_found 가 곧 도착해 로비가 닫힌다 — 그때까지 잠금 유지
  });
}

function startQueue(table) {
  if (needLogin()) return;
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
    ui.queueMeta.textContent = `${prize > 0 ? `승자 상금 ${fmt(prize)} 탄피` : '참가비 · 상금 없음'} · 랭킹 MMR 승 +${RANKED_MMR.win} / 패 −${RANKED_MMR.loss}`;
    setPhase('queue');
    startTicker(ui.elapsed);
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
    case 'edit-nick': window.dispatchEvent(new CustomEvent('lastchamber:open-account', { detail: { edit: true } })); break; // 닉네임 옆 [변경] → 계정 창의 변경 칸
    case 'login': needLogin(); break;
    case 'solo': startSolo(); break;
    case 'create-public': createPublicRoom(); break;
    case 'join-public': joinPublicRoom(el.dataset.code); break;
    case 'create': createFriendlyRoom(); break;
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
  if (!busy && code.length === CODE_LENGTH) joinFriendlyRoom(code);
});

// 닫히는 모든 경로(✕ · Esc · AI 딜러 · 매칭 성사)에서: 소켓 정리 + 화면 초기화. 소켓을 끊으면 서버가 대기열 · 대기 방 · 로비 채널을 정리한다
dialog.addEventListener('close', () => {
  disposeSocket();
  resetUi();
});

// 페이지를 떠날 때(창 닫기 · 뒤로 가기 · 새로고침): 로비를 닫아 소켓 리스너를 떼고 연결을 끊는다 (대기 경과 시간 타이머는 resetUi → 메뉴 전환에서 멈춘다)
function leavePage() {
  clearTimeout(copyTimer);
  if (dialog.open) dialog.close(); // → close 이벤트에서 disposeSocket + resetUi
  else disposeSocket(); // 열려 있지 않아도 연결 중이던 소켓(랭킹 조회 등)이 있으면 정리
}
window.addEventListener('pagehide', leavePage);
window.addEventListener('beforeunload', leavePage);

// PLAY 가로채기: document 캡처 단계라 app.js 의 클릭 핸들러(타깃/버블 단계)보다 항상 먼저 돌고, 로드 순서에도 영향받지 않는다
// 손님도 로비는 연다 (AI 딜러 연습 · 방 목록 · TOP 10 보기) — 온라인 대전 버튼만 로그인 화면으로
document.addEventListener('click', (e) => {
  if (passThrough) return;
  const btn = e.target instanceof Element ? e.target.closest(`#${START_BUTTON_ID}`) : null;
  if (!btn) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  if (!loggedIn() && !userSession.isGuest) { // 로그인도 둘러보기도 안 했다 (보통은 시작 화면이 이미 가리고 있다)
    window.dispatchEvent(new CustomEvent('lastchamber:need-login'));
    return;
  }
  if (dialog.open) return;
  resetUi();
  dialog.showModal();
  refreshLobby();
}, true);

// 로그인 · 닉네임 변경 · 로그아웃: 로비의 내 이름 · 잠금을 바로 고치고, 연결 중이면 새 토큰으로 다시 확인한다. 로그아웃이면 로비를 닫는다(소켓도 정리)
userSession.subscribe((user) => {
  if (!user) {
    serverRecord = null;
    if (!userSession.isGuest) closeDialog();
  } else if (sock?.connected) {
    registered = registerPlayer(sock);
    registered.then((res) => { if (res?.top && dialog.open) paintBoard(res.top); });
  }
  paintMe();
  paintAccess();
});
