/**
 * LAST CHAMBER - 게임 화면 컨트롤러 (모든 모듈 조립)
 *
 *   GameEngine(규칙) · AIDealer(딜러 AI) · SoundEngine(효과음)을 index.html 화면에 연결한다.
 *   ES Module이라 index.html을 파일로 직접 열면(file://) 동작하지 않는다 → 로컬 서버로 열 것.
 *
 * 흐름: 타이틀 → 게임 시작 → 엔진 로그를 순서대로 연출(present) → 내 턴(20초) ↔ 딜러 턴 → 결과 화면
 * 도감(#rules-modal)을 보는 동안, 또는 다른 탭·창에 나가 있는 동안에는 타이머와 딜러 진행이 멈추고 소리도 멈춘다.
 * 분위기: 앰비언트 배경음(긴장하면 커짐) · 위기 비네팅(마지막 1발 / 내 체력 1) · 실탄 격발 슬로모션 · 소리 설정(#sound-panel, 설정은 기억)
 * 단축키(PC): ↑ 상대에게 격발 · ↓ 나에게 격발 · 1~6 아이템 · M 음소거 · ? 도감
 *
 * 모드별 정산: AI 딜러 대전 = 연습(연습 전적 · 탄피만, 랭킹 MMR 미반영) · 온라인 랭킹전(무작위 매칭) = 서버 랭킹 기록(MMR +25 / −20 · 전적 · 연승) · 친선 방 코드 = 탄피만.
 * 프로필·티어: 랭킹전이 끝나면 랭킹 전적(승·패·최대 연승)과 MMR 이 서버 기록으로 갱신되고, 티어(브론즈 칩 ~ 마피아)는 MMR에서 바로 계산된다.
 *   타이틀 좌상단 미니 카드(티어 · 닉네임 · 승률)를 누르면 프로필 & 랭킹 모달: [내 기록] 닉네임 · 전적 · 칭호 / [순위표] 가상 라이벌 15명 + 내 실시간 순위.
 *   순위 데이터는 storeData.js 의 leaderboard 소스가 준다 (Step B 서버 연동 시 leaderboard.useSource() 로 교체).
 *
 * 수익화·커스터마이징: 경기가 끝나면 탄피(BRASS)를 지급하고(승리 150 + 연승×30 · 패배 40), 결과 화면에서 보상형 광고로
 *   '보상 2배'·'연승 보호'를 받는다. 상점(#store-modal)에서 총기 스킨·테이블 테마를 탄피/결제/광고로 얻어 장착하면
 *   style.css 의 CSS 변수가 바뀌어 인게임 총기·테이블 색이 달라진다. (카탈로그·저장은 storeData.js)
 *   광고·결제·진동은 플랫폼별 SDK를 직접 부르지 않고 platformBridge 의 표준 메서드(showRewardedAd · purchaseProduct · triggerHaptic)만 쓴다.
 *   진동은 결정적인 순간에만 1회: 실탄 발사('shot') · 피격('hit') · 승패 확정('win' | 'lose') — 버튼 · 턴 전환 · 아이템 · 장전 · 공포탄에는 울리지 않는다 (300ms 쿨타임은 platformBridge).
 *
 * 로그인: 시작 화면(src/ui/loginGate.js)에서 정한 닉네임 · 유저 ID 는 src/ui/session.js 가 갖고 있다. 여기서는 구독만 해서
 *   프로필 닉네임 · 타이틀 HUD · 인게임 내 이름표(#zone-player .nameplate-name)를 그 닉네임으로 맞춘다 (프로필 모달의 닉네임 변경도 session 을 거친다).
 *
 * 렌더링(모바일 WebView 깜빡임 방지): 같은 값이면 DOM 을 쓰지 않고(setText · setAttr · setHidden), 아이템 줄은 아이템이 바뀔 때만 새로 만든다
 *   (사용 가능 여부 · 설명은 버튼을 그대로 두고 속성만 고친다). 애니메이션 재시작은 강제 리플로우를 한 번으로 묶는다(restartClasses).
 *
 * 암시장(상점 탭 3 · 4): [낡은 탄약 상자] 300 탄피 → 실린더가 돈 뒤 한정 총구 화염 3종 · 칭호 4종 중 하나. 이미 가진 것이면 120 탄피 환급 + 천장 게이지 +1, 5가 되면 다음 상자는
 *   미보유 희귀 확정 (규칙·확률표는 storeData.js CHEST / chestOdds · 화면에도 그대로 공개). 장착한 화염은 인게임 총구 화염의 CSS 변수(--muzzle-*)를 바꾼다.
 *   [도발 액션] 450 탄피씩 → 장착하면 테이블 우상단에 작은 도발 버튼이 생기고, 누르면 테이블 중앙에 네온 글자 + 이펙트 + 효과음, 딜러가 한마디 받아친다.
 *   온라인 대전(Step B) 연결 지점: 도발을 쓰면 document 에 CustomEvent('lastchamber:taunt-out', { detail: { type: 'TAUNT', id } }) 를 내보내고,
 *   상대가 보낸 도발은 같은 형태를 CustomEvent('lastchamber:taunt-in') 로 넘기면 같은 연출로 재생된다 (받는 쪽은 storeData.js validateTauntEvent 로 검증).
 */
import { GameEngine, ITEM, SHELL } from '../engine/gameEngine.js';
import { AIDealer } from '../engine/aiDealer.js';
import { SoundEngine } from './soundEngine.js';
import { watchLifecycle } from './lifecycle.js';
import { GuideState, RULE_LINES, COACH_STEPS, GUIDED_TURN_MS } from './guide.js'; // 첫 판 3줄 룰 카드 · 4단계 코치마크 · 넉넉한 턴 제한
import { platformBridge as platform } from '../platform/platformBridge.js';
import {
  KIND, CATALOG, SKIN_VAR_KEYS, REWARD, MMR, LEADERBOARD, TITLES, PlayerProfile, getItem, getTitle, loadoutVars, adGoalOf, leaderboard,
  CHEST, CHEST_ITEMS, RARITY, DEFAULT_FLAME_ID, TAUNTS, chestOdds, getFlame, getTaunt, makeTauntEvent, validateTauntEvent,
} from './storeData.js';
import { initPvp, pvpEngine, pvpOpponent, pvpLoadoutFor, pvpRemainingMs, pvpSettle, pvpEnd, pvpPause, pvpResume, pvpSurrender, pvpMode, pvpOver } from './pvpSession.js'; // 실시간 PvP: 소켓 · 상태 동기화는 전부 여기 (4-3단계)
import { userSession, attachNicknameFilter, NICK_HINT } from './session.js';
import { changeNickname } from './accountApi.js'; // 닉네임 변경은 서버가 players 를 바로 UPDATE (다른 계정이 쓰는 닉네임이면 거절)

const PLAYER = 'player';
const AI = 'ai';
const TURN_MS = 20000; // 내 턴 제한 시간
const URGENT_MS = 5000; // 이 이하부터 타이머 경고 점멸
const TENSION_MS = 400; // 격발 직전 심장박동 + 줌인
const AFTERMATH_MS = 600; // 격발 후 연출 유지
const SLOWMO_MS = 420; // 실탄이 나가는 순간의 슬로모션 (화염·반동·연기가 느리게, 화면은 총구 쪽으로 당겨짐)
const SOUND_KEY = 'lastchamber.sound'; // 소리 설정 저장 키 (localStorage)
const AI_STEP_MS = 900; // 딜러 행동 간격
const REVEAL_MS = 1500; // 장전 공개 오버레이 표시 시간
const TYPE_MS = 26; // 자막 한 글자 타이핑 간격
const TYPE_RUSH = 3; // 밀린 자막이 있으면 한 틱에 3글자씩 (최신 상황을 빨리 따라잡기)
const LINE_GAP_MS = 700; // 다음 자막 전 읽을 시간
const LINE_GAP_RUSH_MS = 250; // 2줄 이상 밀렸을 때
const SHATTER_MS = 650; // 탄제거로 아이템이 부서지는 연출 (style.css .is-shattered)
const SVG_NS = 'http://www.w3.org/2000/svg';
const CHEST_SPIN_MS = 1300; // 상자 실린더가 도는 시간 (style.css .chest-stage.is-spinning)
const TAUNT_COOLDOWN_MS = 6000; // 도발 버튼 쿨타임 — 연타로 딜러 대사·화면 연출이 쌓이지 않게
const TAUNT_FX_MS = 1700; // 도발 네온 연출 길이 (style.css --tfx-ms)
const TAUNT_IN_MIN_GAP_MS = 1000; // 상대가 보낸 도발을 이 간격보다 촘촘하게는 재생하지 않는다 (Step B 스팸 방지)
const TAUNT_OUT = 'lastchamber:taunt-out'; // 내가 도발을 썼다 → Step B 가 상대에게 전송 (detail = { type: 'TAUNT', id })
const TAUNT_IN = 'lastchamber:taunt-in'; // 상대의 도발이 도착했다 → 같은 연출 재생 (detail 은 validateTauntEvent 로 검증)

const ITEM_INFO = {
  [ITEM.SCOPE]: { name: '투시경', tag: '약실 확인', icon: 'i-scope', desc: '현재 약실의 탄을 나만 몰래 확인 (턴당 1회, 같은 턴 더블샷 불가)' },
  [ITEM.DOUBLE]: { name: '더블샷', tag: '데미지 ×2', icon: 'i-double', desc: '이번 한 발의 피해 2배 (같은 턴 투시경·섬광탄 불가)' },
  [ITEM.FLASH]: { name: '섬광탄', tag: '상대 턴 스킵', icon: 'i-flash', desc: '상대의 다음 턴을 건너뜀 (드물게 지급 · 한 번에 1개만 보유)' },
  [ITEM.EJECT]: { name: '탄제거', tag: '탄 배출·템 파괴', icon: 'i-eject', desc: '현재 약실의 탄을 빼내 공개하고, 상대 아이템 1개를 무작위로 파괴' },
  [ITEM.DRINK]: { name: '위스키 한잔', tag: '체력 +1', icon: 'i-drink', desc: '체력 1칸 회복 (단두대에서도 가능 · 드물게 지급)' },
  [ITEM.PICKPOCKET]: { name: '소매치기', tag: '상대 템 강탈', icon: 'i-pickpocket', desc: '상대 아이템 하나를 무작위로 훔쳐 즉시 사용' },
  [ITEM.CONVERT]: { name: '탄종변환', tag: '실탄↔공포탄', icon: 'i-convert', desc: '현재 약실 탄을 실탄↔공포탄으로 바꿈 (결과 비공개, 이번 장전 탄종 개수 가려짐)' },
};
const SHELL_NAME = { [SHELL.LIVE]: '실탄', [SHELL.BLANK]: '공포탄' };
const flip = (shell) => (shell === SHELL.LIVE ? SHELL.BLANK : SHELL.LIVE);

const LINES = {
  start: ['“앉지. 오늘 밤 마지막 약실의 주인을 정해 보자고.”', '“규칙은 간단해. 살아남는 쪽이 이기는 거지.”'],
  round: ['“다음 판이다. 칩을 다시 쌓지.”', '“아직 끝나지 않았어.”'],
  thinking: ['“어디 보자…”', '“흠…”', '“서두를 것 없지.”'],
  hitDealer: ['“…크윽. 제법이군.”', '“피는 테이블에 흘리지 않는 게 예의인데.”'],
  hitPlayer: ['“미안하게 됐군.”', '“운이 다한 모양이군.”'],
  missDealer: ['“빗나갔군. 이제 내 차례다.”', '“운은 아직 내 편이야.”'],
  missPlayer: ['“운 좋은 녀석.”', '“다음엔 어림없지.”'],
  selfBlankPlayer: ['“배짱 하나는 인정하지.”', '“간이 크군.”'],
  selfLivePlayer: ['“어리석긴.”'],
  selfBlankDealer: ['“후… 신은 아직 날 버리지 않았군.”'],
  selfLiveDealer: ['“…계산 착오군.”'],
  dealerItem: ['“이걸 쓸 때가 됐군.”', '“잠깐, 준비할 게 있어.”'],
  convert: ['“운명을 조금 비틀어 볼까.”', '“이제 아무도 모르지. 나 말고는.”'],
  ejectBreak: ['“탄 하나 빼는 김에, 네 물건도 치워 주지.”', '“걸리적거리는 건 치우는 게 내 방식이야.”'], // 딜러가 내 아이템을 부쉈을 때
  itemBroken: ['“…내 물건에 무슨 짓이지.”', '“그거, 꽤 비싼 건데 말이야.”'], // 내가 딜러 아이템을 부쉈을 때
  roundWon: ['“이번 판은 네가 가져가라.”'],
  roundLost: ['“이 테이블은 원래 내 거야.”'],
  gameWon: ['“…훌륭하군. 이 자리는 이제 네 거다.”'],
  gameLost: ['“마지막 약실은 늘 내 몫이지.”'],
  // 내 도발에 딜러가 받아치는 한마디 (도발 id 별, storeData.js TAUNTS 와 같은 키)
  taunt: {
    knock: ['“두드린다고 약실이 열리진 않아.”', '“초조한가? 손끝이 떨리는군.”', '“그 소리… 꼭 심장 박동 같군.”'],
    smoke: ['“연기로 가려도 총알은 널 찾아내지.”', '“여유로운 척은 내가 먼저 배웠어.”', '“…내 시가 연기가 더 진한데 말이야.”'],
    flick: ['“탄피 한 알로 날 비웃겠다?”', '“그 탄피, 네 묘비에 달아 주지.”', '“건방진 손가락이군.”'],
  },
};

const $ = (id) => document.getElementById(id);
const el = {
  app: $('app'),
  zoneDealer: $('zone-dealer'),
  zonePlayer: $('zone-player'),
  pips: [...$('round-pips').children],
  scoreDealer: $('score-dealer'),
  scorePlayer: $('score-player'),
  speech: $('dealer-speech'),
  line: $('dealer-line'),
  dealerHp: $('dealer-hp'),
  playerHp: $('player-hp'),
  dealerItems: $('dealer-items'),
  playerItems: $('player-items'),
  table: $('table'),
  shells: $('shells'),
  liveRack: $('live-rack'),
  blankRack: $('blank-rack'),
  unknownRack: $('unknown-rack'),
  liveIcons: $('live-icons'),
  liveCount: $('live-count'),
  blankIcons: $('blank-icons'),
  blankCount: $('blank-count'),
  unknownIcons: $('unknown-icons'),
  totalCount: $('total-count'),
  turnLabel: $('turn-label'),
  timer: $('turn-timer'),
  timerText: $('timer-text'),
  gun: $('gun'),
  sparks: $('sparks'),
  headline: $('headline'),
  subtitle: $('subtitle'),
  subGhost: $('sub-ghost'),
  subTyped: $('sub-typed'),
  srLog: $('sr-log'),
  reveal: $('reveal'),
  revealShells: $('reveal-shells'),
  revealCount: $('reveal-count'),
  scope: $('scope-popup'),
  scopeKicker: $('scope-kicker'),
  scopeResult: $('scope-result'),
  btnOpponent: $('btn-shoot-opponent'),
  btnSelf: $('btn-shoot-self'),
  flash: $('fx-flash'),
  crisis: $('crisis'),
  btnSound: $('btn-sound'),
  soundIcon: $('sound-icon'),
  soundPanel: $('sound-panel'),
  btnMute: $('btn-mute'),
  muteState: $('mute-state'),
  sfxRange: $('range-sfx'),
  ambRange: $('range-ambient'),
  sfxValue: $('val-sfx'),
  ambValue: $('val-ambient'),
  title: $('start-modal'),
  titleInner: document.querySelector('#start-modal .title-inner'),
  titleHeading: $('title-heading'),
  titleSub: $('title-sub'),
  titleResult: $('title-result'),
  btnStart: $('btn-start'),
  btnHowto: $('btn-howto'),
  rules: $('rules-modal'),
  btnHelp: $('btn-help'),
  btnRulesClose: $('btn-rules-close'),
  tabs: [$('tab-rules'), $('tab-items')],
  wallet: $('wallet'),
  walletAmount: $('wallet-amount'),
  walletStreak: $('wallet-streak'),
  btnArmory: $('btn-armory'),
  trialNote: $('trial-note'),
  reward: $('reward'),
  rewardTotal: $('reward-total'),
  rewardLines: $('reward-lines'),
  rewardStreak: $('reward-streak'),
  rewardMode: $('reward-mode'),
  rewardActions: $('reward-actions'),
  rewardNote: $('reward-note'),
  btnDouble: $('btn-double'),
  doubleSub: $('double-sub'),
  btnProtect: $('btn-protect'),
  protectSub: $('protect-sub'),
  store: $('store-modal'),
  btnStoreClose: $('btn-store-close'),
  storeBrass: $('store-brass'),
  storeTabs: [$('tab-guns'), $('tab-tables'), $('tab-chest'), $('tab-taunts')],
  storeLists: { [KIND.GUN]: $('list-guns'), [KIND.TABLE]: $('list-tables') },
  storeToast: $('store-toast'),
  chestStage: $('chest-stage'),
  btnChest: $('btn-chest'),
  chestDrawLabel: $('chest-draw-label'),
  chestPrice: $('chest-price'),
  chestPity: $('chest-pity'),
  pityCount: $('pity-count'),
  pityPips: [...$('pity-pips').children],
  pityNote: $('pity-note'),
  chestResult: $('chest-result'),
  oddsBody: $('odds-body'),
  chestProgress: $('chest-progress'),
  chestList: $('list-chest'),
  tauntList: $('list-taunts'),
  btnLeave: $('btn-leave'),
  leaveLabel: $('leave-label'),
  leave: $('leave-modal'),
  leaveTitle: $('leave-title'),
  leaveText: $('leave-text'),
  leaveConfirm: $('leave-confirm'),
  ruleCard: $('first-rules'),
  ruleCardList: $('first-rules-list'),
  coach: $('coach'),
  coachSpot: $('coach-spot'),
  coachBubble: $('coach-bubble'),
  coachStep: $('coach-step'),
  coachTitle: $('coach-title'),
  coachText: $('coach-text'),
  coachNext: $('coach-next'),
  coachSkip: $('coach-skip'),
  btnTaunt: $('btn-taunt'),
  tauntIcon: $('taunt-icon'),
  tauntFx: $('taunt-fx'),
  tauntText: $('taunt-text'),
  playerCard: $('player-card'),
  pcBadge: $('pc-badge'),
  pcTier: $('pc-tier'),
  pcName: $('pc-name'),
  pcRate: $('pc-rate'),
  rewardRank: $('reward-rank'),
  profile: $('profile-modal'),
  btnProfileClose: $('btn-profile-close'),
  profileTabs: [$('tab-record'), $('tab-board')],
  pfHero: $('pf-hero'),
  nickForm: $('nick-form'),
  nickInput: $('nick-input'),
  nickMsg: $('nick-msg'),
  pfStats: $('pf-stats'),
  pfTitleNow: $('pf-title-now'),
  pfTitleList: $('pf-title-list'),
  boardSummary: $('board-summary'),
  boardList: $('board-list'),
  boardNote: $('board-note'),
  login: $('login-modal'),
  account: $('account-modal'),
  myName: document.querySelector('#zone-player .nameplate-name'),
};

// ── 같은 값이면 DOM 을 건드리지 않는 쓰기 ──
// 모바일 WebView 에서는 같은 글자 · 속성을 다시 써도 스타일 재계산 · 레이아웃 · 다시 그리기가 일어날 수 있어(엔진 버전마다 다름) 렌더가 잦을수록 깜빡인다.
const setText = (node, text) => { if (node && node.textContent !== text) node.textContent = text; };
const setAttr = (node, name, value) => { if (node && node.getAttribute(name) !== value) node.setAttribute(name, value); };
const setHidden = (node, hidden) => { if (node && node.hidden !== hidden) node.hidden = hidden; };
const setDisabled = (node, disabled) => { if (node && node.disabled !== disabled) node.disabled = disabled; };
const htmlCache = new WeakMap(); // 노드 → 마지막으로 넣은 innerHTML (같은 마크업이면 다시 파싱 · 교체하지 않는다)
const setHtml = (node, html) => {
  if (!node || htmlCache.get(node) === html) return;
  htmlCache.set(node, html);
  node.innerHTML = html;
};

// 소리 설정: 효과음·배경음 음량(0~1)과 음소거. 저장된 값을 쓰고, 저장소를 못 쓰면(비공개 창 등) 기본값으로 동작한다.
const soundPrefs = { sfx: 0.8, ambient: 0.6, muted: false };
try {
  const saved = JSON.parse(localStorage.getItem(SOUND_KEY) ?? 'null');
  const level = (v, fallback) => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : fallback);
  if (saved && typeof saved === 'object') {
    soundPrefs.sfx = level(saved.sfx, soundPrefs.sfx);
    soundPrefs.ambient = level(saved.ambient, soundPrefs.ambient);
    soundPrefs.muted = saved.muted === true;
  }
} catch {
  // 저장소 접근 불가·손상된 값 → 기본값
}
const sound = new SoundEngine({ volume: soundPrefs.sfx, ambientVolume: soundPrefs.ambient, muted: soundPrefs.muted, inGame: false }); // 잠금 2 는 잠근 채 시작 — startGame 이 열고, 결과 · 나가기가 다시 잠근다
let engine = null;
let online = false; // 실시간 PvP 판인가 — true 면 engine 은 pvpSession.js 의 원격 엔진이고 딜러 AI · 로컬 규칙은 돌지 않는다
let animatedIdx = -1; // PvP: 총 연출(격발)을 이미 보여 준 마지막 SHOT 로그 위치 — 내 격발은 입력 때, 상대 격발은 로그 연출 때 보여 주므로 겹치지 않게
let dealer = null;
let memory = null;
let lastLogIndex = 0; // getLog('player', lastLogIndex)로 아직 연출하지 않은 로그만 읽는다
let aiLogIndex = 0; // 딜러에게 아직 알려 주지 않은 로그 위치 (딜러 시점)
let gameId = 0; // 재시작 시 이전 게임의 비동기 흐름을 끊는 토큰
let busy = true; // 연출 중 입력 잠금 (게임 시작 전에도 잠김)
let myKnown = null; // 내가 아는 현재 약실 탄 (투시경으로 봄, 탄종변환으로 바뀌면 같이 바뀜)
let roundResults = []; // 라운드별 'won' | 'lost' → 상단 램프
let dealBuffer = {}; // 장전 시 양쪽 지급 아이템을 한 줄 자막으로 묶기
const fresh = { [PLAYER]: new Set(), [AI]: new Set() }; // 방금 지급된 슬롯 → .is-new 연출
const timer = { remaining: TURN_MS, handle: 0, last: 0, shown: -1 };
const subs = { queue: [], running: false, typeTimer: 0, hideTimer: 0, current: null, skip: false, gen: 0 };
let headlineTimer = 0;
let sparkTimer = 0;
let tabHidden = document.hidden; // 다른 탭·창에 나가 있는 동안 게임 일시정지
let crisisLevel = ''; // '' | 'tense'(마지막 1발) | 'danger'(내 체력 1) → #crisis 위기 비네팅
let lastTension = -1; // 배경음 긴장도 (바뀔 때만 엔진에 전달)
const slotKeys = { [PLAYER]: null, [AI]: null }; // 지금 화면에 그려진 아이템 줄 ('SCOPE|DOUBLE|…') — 같으면 슬롯을 다시 만들지 않는다
let inMatch = false; // 판이 진행 중인가 (인게임 [항복] / [나가기] 버튼을 보이는 동안) — 결과가 나오거나 나가면 false
let leaving = false; // 항복 요청을 서버에 보내고 답을 기다리는 중 (중복 클릭 방지)
let audioUnlockArmed = false; // PvP 시작 때 붙이는 '첫 터치에 오디오 깨우기' 리스너가 이미 대기 중인가 (판마다 쌓이지 않게)

const profile = new PlayerProfile(); // 탄피 · 해금/장착 · 체험 · 연승 (localStorage에 영구 저장)
// 첫 판 가이드: 이미 게임을 해 본 프로필이면 처음부터 '봤음'. 3줄 룰 카드는 첫 게임(어느 모드든), 코치마크 · 넉넉한 턴 제한은 첫 AI 판에서만 (온라인은 서버 시계라 멈출 수 없다)
const guide = new GuideState({ hadPlayed: profile.games + profile.practice.games > 0 });
const RULE_CARD_MS = 9000; // 카드가 떠 있는 시간 (탭하면 바로 닫힘)
const RULE_CARD_MIN_MS = 5000; // 코치마크가 카드를 밀어내기 전에 최소한 보여 주는 시간
let guidedGame = false; // 이번 판이 첫 AI 판인가 → 턴 제한 GUIDED_TURN_MS
let coaching = false; // 코치마크 진행 중 (advance 가 다시 불려도 한 번만)
let ruleCardTimer = 0;
let ruleCardAt = 0;
let adBusy = false; // 광고·결제 화면이 떠 있는 동안 중복 요청과 단축키를 막는다
let lastOutcome = null; // 이번 경기 결과 { won, base, bonus, total, streak, prevStreak, canProtect, doubled, protectedStreak }
let recordedGame = 0; // 결과를 기록한 gameId — 한 판에 한 번만 지급
let toastTimer = 0;
const tweens = new WeakMap(); // 숫자 카운트업 (노드별 진행 중인 애니메이션)
let walletShown = null; // 지금 배지에 보이는 탄피 수 (카운트업 시작점)
let previewSeq = 0; // 상점 미리보기 SVG의 id 접미사
let chestBusy = false; // 상자 실린더가 도는 동안 중복 뽑기·상점 구매를 막는다
let tauntReadyAt = 0; // 도발 쿨타임이 끝나는 시각 (performance.now 기준)
let tauntCooldownTimer = 0;
let tauntFxTimer = 0;
let lastTauntInAt = -Infinity; // 마지막으로 재생한 '상대의 도발' 시각
let boardGen = 0; // 순위표 요청 번호 — 늦게 도착한 이전 응답이 최신 화면을 덮지 않게
const skinDefaults = readSkinDefaults(); // style.css :root 의 기본 스킨 값 — 기본 스킨 카드 미리보기에 쓴다 (인라인 덮어쓰기 전에 읽어 둠)

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// 연출 단계 대기: 정해진 시간이 지난 뒤에도 일시정지(도감 · 탭 이탈) 중이면 풀릴 때까지 다음 단계로 넘어가지 않는다
const wait = async (ms) => {
  await sleep(ms);
  while (isPaused()) await sleep(120);
};
const reducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
const pick = (list) => list[Math.floor(Math.random() * list.length)];
// 받침 유무에 맞는 조사: josa('딜러', '이', '가') → '딜러가'
const josa = (word, withFinal, withoutFinal) => {
  const code = word.charCodeAt(word.length - 1) - 0xac00;
  return word + (code >= 0 && code < 11172 && code % 28 !== 0 ? withFinal : withoutFinal);
};
const say = (line) => { if (!online) setText(el.line, line); }; // PvP 에서는 이 칸에 딜러(AI) 대사를 쓰지 않는다
const vsFoe = (text) => (online ? text.replaceAll('딜러', '상대') : text); // PvP: 딜러 → 상대 ('상대'도 받침이 없어 이/가 · 을/를 조사가 그대로 맞는다)
const thinking = (on) => el.speech.classList.toggle('is-thinking', on);
// 인게임 연출 가드: 지금 판(token)이고 실제 게임 화면일 때만 — 타이틀 · 결과 화면 · 대전 로비가 떠 있으면 인게임 효과음 · 진동 · 서버 로그 연출을 하지 않는다
// (지난 판의 늦은 연출 · 끝난 PvP 판의 늦은 이벤트가 로비나 결과 화면에서 소리를 내지 않게. 다른 방 이벤트는 pvpSession.js 가 방 코드로 먼저 걸러 낸다)
const lobbyOpen = () => document.getElementById('mp-lobby')?.open === true;
const onGameScreen = (token = gameId) => token === gameId && Boolean(engine) && !el.title.open && !lobbyOpen();
// 이중 잠금 ① 앱: 지금 판(token)의 실제 게임 화면이고 창에 포커스가 있을 때만 (② 엔진: 가려짐 · 포커스 · 인게임 플래그 — soundEngine.js)
const documentFocused = () => typeof document.hasFocus !== 'function' || document.hasFocus();
const gameSoundOk = (token = gameId) => onGameScreen(token) && documentFocused();
const gameSfx = (play, token = gameId) => { if (gameSoundOk(token)) play(); };
const isPaused = () => !online && (el.rules.open || el.leave.open || el.coach.open || tabHidden); // 도감을 보거나 다른 탭·창에 가 있는 동안 게임 일시정지 (실시간 PvP 는 서버 시계가 흐르므로 멈추지 않는다)

function guard(promise) {
  promise.catch((err) => {
    console.error('[LAST CHAMBER]', err);
    busy = false;
    render();
  });
}

// ───────── 소리 설정 · 분위기(위기 비네팅 · 배경음 긴장도) ─────────

const pct = (v) => Math.round(v * 100);
const saveSoundPrefs = () => {
  try {
    localStorage.setItem(SOUND_KEY, JSON.stringify(soundPrefs));
  } catch {
    // 저장소 접근 불가 - 이번 방문에서만 유지
  }
};

function syncSoundUi() {
  const on = !soundPrefs.muted;
  el.sfxRange.value = String(pct(soundPrefs.sfx));
  el.ambRange.value = String(pct(soundPrefs.ambient));
  el.sfxValue.textContent = String(pct(soundPrefs.sfx));
  el.ambValue.textContent = String(pct(soundPrefs.ambient));
  el.btnMute.setAttribute('aria-checked', String(on));
  el.muteState.textContent = on ? '켬' : '끔';
  el.soundIcon.setAttribute('href', on ? '#i-sound' : '#i-mute');
  el.btnSound.classList.toggle('is-muted', !on);
  el.soundPanel.classList.toggle('is-muted', !on);
}

function setMuted(muted, announce = false) {
  soundPrefs.muted = muted;
  sound.setMuted(muted);
  saveSoundPrefs();
  syncSoundUi();
  if (announce && engine) subtitle(muted ? '소리를 껐다' : '소리를 켰다', 'info', { filler: true });
}

function onVolumeInput(kind) { // 'sfx' | 'ambient'
  const value = Number((kind === 'sfx' ? el.sfxRange : el.ambRange).value) / 100;
  soundPrefs[kind] = value;
  if (kind === 'sfx') sound.setVolume(value);
  else sound.setAmbientVolume(value);
  if (soundPrefs.muted && value > 0) { // 음소거 중에 슬라이더를 올리면 소리를 켠다
    soundPrefs.muted = false;
    sound.setMuted(false);
  }
  saveSoundPrefs();
  syncSoundUi();
}

function setSoundPanel(open) {
  el.soundPanel.hidden = !open;
  el.btnSound.setAttribute('aria-expanded', String(open));
}

function setCrisis(level) {
  if (level === crisisLevel) return;
  crisisLevel = level;
  el.crisis.classList.toggle('is-tense', level === 'tense');
  el.crisis.classList.toggle('is-danger', level === 'danger');
}

// 상황이 위태로울수록 화면 가장자리가 어두워지고(마지막 1발) 붉게 맥동하며(내 체력 1), 배경음이 서서히 커진다
function syncMood(s) {
  const live = !s.winner;
  const danger = live && s.me.hp === 1;
  const last = live && s.total === 1;
  setCrisis(danger ? 'danger' : last ? 'tense' : '');
  const tension = live ? Math.min(1, (danger ? 0.7 : 0) + (last ? 0.3 : 0) + (s.opponent.hp === 1 ? 0.15 : 0)) : 0;
  if (tension !== lastTension) {
    lastTension = tension;
    sound.setTension(tension);
  }
}

// 다른 탭·창으로 나가면 게임을 일시정지, 돌아오면 이어서 진행 (소리는 아래 watchLifecycle 이 따로 끄고 켠다)
function onVisibilityChange() {
  tabHidden = document.hidden;
  if (tabHidden) return;
  timer.last = performance.now(); // 숨겨 둔 시간이 턴 타이머에서 깎이지 않게
  profile.reload(); // 다른 탭에서 탄피·스킨·전적이 바뀌었을 수 있다
  syncWallet();
  syncPlayerCard();
  if (el.title.open) { // 판이 진행 중일 때는 스킨을 바꾸지 않는다
    applyLoadout(profile.activeLoadout());
    syncTitleExtras();
    if (el.store.open) renderStore();
    if (el.profile.open) {
      renderRecord();
      renderBoard();
    }
  }
  if (engine && !engine.getPublicState(PLAYER).winner) subtitle('이어서 진행한다', 'info', { filler: true });
}

// ───────── 탄피(BRASS) · 스킨 적용 · 경기 결과 보상 ─────────

const fmt = (n) => Math.round(n).toLocaleString('ko-KR');
const guardUi = (promise) => promise.catch((err) => console.error('[LAST CHAMBER]', err)); // 상점·보상 화면의 비동기 오류 (게임 진행 상태는 건드리지 않음)

function h(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

// style.css :root 의 기본 스킨 값 (기본 스킨 카드의 미리보기용). 스킨을 인라인으로 덮어쓰기 전에 한 번만 읽는다.
function readSkinDefaults() {
  const style = getComputedStyle(document.documentElement);
  const read = (keys) => Object.fromEntries(keys.map((key) => [key, style.getPropertyValue(key).trim()]).filter(([, value]) => value));
  return { [KIND.GUN]: read(SKIN_VAR_KEYS[KIND.GUN]), [KIND.TABLE]: read(SKIN_VAR_KEYS[KIND.TABLE]) };
}

// 장착(또는 체험) 중인 스킨 + 총구 화염을 CSS 변수로 적용한다: 이전 변수를 모두 지워 style.css 기본값으로 되돌린 뒤 새 값만 덮어쓴다 (화염은 총기 스킨 위에 한 번 더)
// 이미 같은 조합이면 아무것도 하지 않는다 — :root 의 변수 수십 개를 지웠다 다시 쓰면 문서 전체의 스타일을 다시 계산해서 (앱 복귀 · 상점 · 턴마다) 화면이 한 번 덜컹인다
function applyLoadout({ gun, table, flame = DEFAULT_FLAME_ID }) {
  const root = document.documentElement;
  const now = root.dataset;
  if (now.gun === gun && now.table === table && now.flame === flame) return;
  for (const key of [...SKIN_VAR_KEYS[KIND.GUN], ...SKIN_VAR_KEYS[KIND.TABLE], ...SKIN_VAR_KEYS.flame]) root.style.removeProperty(key);
  for (const [key, value] of Object.entries(loadoutVars(gun, table, flame))) root.style.setProperty(key, value);
  root.dataset.gun = gun;
  root.dataset.table = table;
  root.dataset.flame = flame;
}

// 숫자가 from → to 로 올라가는(내려가는) 연출. 모션 줄이기·탭 숨김에서는 바로 최종값.
function tweenNumber(node, from, to, { ms = 650, prefix = '' } = {}) {
  const prev = tweens.get(node);
  if (prev) {
    cancelAnimationFrame(prev.raf);
    clearTimeout(prev.timer);
    tweens.delete(node);
  }
  const settle = () => setText(node, prefix + fmt(to));
  if (from === to || reducedMotion() || document.hidden) {
    settle();
    return;
  }
  const t0 = performance.now();
  const state = { raf: 0, timer: 0 };
  state.timer = setTimeout(() => { // rAF가 멈춰도 최종값은 반드시 표시
    cancelAnimationFrame(state.raf);
    tweens.delete(node);
    settle();
  }, ms + 150);
  const step = (now) => {
    const k = Math.min(1, (now - t0) / ms);
    node.textContent = prefix + fmt(from + (to - from) * (1 - (1 - k) ** 3));
    if (k < 1) state.raf = requestAnimationFrame(step);
  };
  state.raf = requestAnimationFrame(step);
  tweens.set(node, state);
}

// 타이틀 우상단 보유 탄피 · 연승 배지 + 상점 머리글의 탄피. animate면 지금 보이는 값에서 새 값으로 굴러간다.
// value: 실제 보유량 대신 보여 줄 숫자 (상자를 여는 동안 '300 차감'만 먼저 보여 주고 환급은 결과 공개 때 올리려고)
function syncWallet({ animate = false, value } = {}) {
  const to = value ?? profile.brass;
  const from = animate && walletShown !== null ? walletShown : to;
  walletShown = to;
  const chip = el.storeBrass.parentElement;
  tweenNumber(el.walletAmount, from, to);
  tweenNumber(el.storeBrass, from, to);
  setAttr(el.wallet, 'aria-label', `보유 탄피 ${fmt(to)}${profile.streak ? ` · ${profile.streak}연승` : ''}`);
  setAttr(chip, 'aria-label', `보유 탄피 ${fmt(to)}`);
  setHidden(el.walletStreak, profile.streak < 1);
  setText(el.walletStreak, `${profile.streak}연승`);
  if (animate && to > from) {
    restartClasses([[el.wallet, 'is-gain'], [chip, 'is-gain']]);
  }
}

// 광고로 예약해 둔 '다음 1판 체험' 스킨을 시작 버튼 위에 알려 준다
function syncTitleExtras() {
  const names = [KIND.GUN, KIND.TABLE].map((kind) => getItem(kind, profile.trialId(kind))?.name).filter(Boolean);
  setHidden(el.trialNote, names.length === 0);
  setText(el.trialNote, names.length ? `다음 1판 체험 · ${names.join(' · ')}` : '');
}

function resetRewardUi() {
  lastOutcome = null;
  el.title.classList.remove('is-result');
  el.reward.hidden = true;
  el.rewardActions.hidden = true;
  el.btnProtect.hidden = true;
  el.btnDouble.hidden = false;
  el.rewardRank.hidden = true;
  el.rewardRank.replaceChildren();
  el.rewardMode.textContent = '';
  rewardNote('');
  for (const btn of [el.btnDouble, el.btnProtect]) {
    btn.disabled = false;
    btn.classList.remove('is-busy', 'is-done', 'is-soon');
  }
}

function rewardNote(text, bad = false) {
  el.rewardNote.textContent = text;
  el.rewardNote.classList.toggle('is-bad', bad);
}

function addRewardLine(label, amount, { ad = false } = {}) {
  const li = h('li', ad ? 'is-ad' : '');
  li.append(h('span', '', label), h('b', '', `+${fmt(amount)}`));
  el.rewardLines.append(li);
}

// 경기 결과 화면: 획득 탄피 내역 + [광고 보고 보상 2배] (+ 2연승 이상에서 졌다면 [광고 보고 연승 기록 보호])
function showReward(outcome) {
  resetRewardUi();
  lastOutcome = { ...outcome, doubled: false, protectedStreak: false };
  el.title.classList.add('is-result');
  el.rewardLines.replaceChildren();
  const stakes = (outcome.pvp?.fee ?? 0) > 0; // PvP 판돈 테이블: 탄피 보상은 서버 상금뿐 (광고 2배 없음)
  if (outcome.base > 0) addRewardLine(stakes ? '판돈 상금' : outcome.won ? '승리 보상' : '위로 보상', outcome.base);
  if (outcome.bonus) addRewardLine(`${outcome.mode === 'practice' ? '연습 ' : ''}${outcome.streak}연승 보너스 (×${REWARD.streakStep})`, outcome.bonus);
  el.rewardStreak.textContent = streakText(outcome);
  el.rewardMode.dataset.mode = outcome.mode;
  el.rewardMode.textContent = modeText(outcome); // 랭킹전: MMR 증감 / 연습 · 친선전: 'MMR 미반영' 배지
  // 티어가 바뀌었거나(랭킹전만) 새 칭호를 얻었을 때 · 모드별 기록 한 줄
  const notes = [];
  if (outcome.tierChange) notes.push(h('p', outcome.tierChange === 'up' ? 'is-up' : 'is-down', `${outcome.tierChange === 'up' ? '▲ 승급' : '▼ 강등'} — ${outcome.tier.label}`));
  const gained = outcome.newTitles.map((id) => getTitle(id)?.name).filter(Boolean);
  if (gained.length) notes.push(h('p', 'is-title', `새 칭호 — ${gained.join(', ')}`));
  if (outcome.mode === 'ranked') notes.push(h('p', '', `랭킹전 전적 ${fmt(outcome.wins)}승 ${fmt(outcome.losses)}패`));
  else if (outcome.mode === 'practice') notes.push(h('p', '', `AI 연습 전적 ${fmt(outcome.practice.wins)}승 ${fmt(outcome.practice.losses)}패`));
  el.rewardRank.replaceChildren(...notes);
  el.rewardRank.hidden = notes.length === 0;
  el.doubleSub.textContent = `+${fmt(outcome.total)} 탄피 추가 지급`;
  el.btnProtect.hidden = !outcome.canProtect;
  el.btnDouble.hidden = stakes;
  el.protectSub.textContent = `${outcome.prevStreak}연승 기록 유지`;
  // 광고 SDK 가 아직 없는 곳(공개 웹 등): 버튼은 보이되 '준비 중' — VIP 패스 · 연승 보호권은 광고 없이 되므로 그대로 쓸 수 있다
  const adsReady = platform.isAvailable('ads') || profile.hasNoAdsPass;
  comingSoon(el.btnDouble, el.doubleSub, !adsReady);
  comingSoon(el.btnProtect, el.protectSub, !adsReady && profile.streakShields < 1);
  el.reward.hidden = false;
  el.rewardActions.hidden = false;
  tweenNumber(el.rewardTotal, 0, outcome.total, { prefix: '+', ms: 750 });
  el.srLog.textContent = `탄피 ${outcome.total}개를 얻었다. ${modeText(outcome)}.${outcome.tierChange ? ` ${outcome.tierChange === 'up' ? '승급' : '강등'}: ${outcome.tier.label}.` : ''} ${gained.length ? `새 칭호: ${gained.join(', ')}.` : ''} ${outcome.won ? `${outcome.streak}연승 중.` : outcome.canProtect ? '광고를 보면 연승 기록을 지킬 수 있다.' : ''}`.replace(/\s+/g, ' ').trim();
}

function comingSoon(btn, sub, on) { // 결과 화면 광고 버튼을 '준비 중'으로 잠근다 (resetRewardUi 가 판마다 되돌린다)
  btn.classList.toggle('is-soon', on);
  if (!on) return;
  btn.disabled = true;
  sub.textContent = '준비 중 — 곧 열려요';
}

function adFailText(reason) {
  switch (reason) {
    case 'unavailable': return '광고 보상은 준비 중이에요';
    case 'dismissed': return '광고를 끝까지 보지 않아 보상이 지급되지 않았어요';
    case 'busy': return '이미 광고가 진행 중이에요';
    case 'unsupported': return '이 기기에서는 광고를 볼 수 없어요';
    default: return '광고를 불러오지 못했어요. 잠시 후 다시 시도해 주세요';
  }
}

// 보상형 광고 한 번. 진행 중에는 중복 요청·도감 단축키를 막고 { rewarded, reason } 을 돌려준다.
async function watchAd(placementId, ...buttons) {
  adBusy = true;
  buttons.forEach((btn) => btn.classList.add('is-busy'));
  try {
    return await platform.showRewardedAd(placementId);
  } finally {
    adBusy = false;
    buttons.forEach((btn) => btn.classList.remove('is-busy'));
  }
}

function markDone(btn, title, sub) { // 광고 버튼을 '완료' 상태로 (다시 누를 수 없음)
  const hadFocus = document.activeElement === btn;
  btn.disabled = true;
  btn.classList.add('is-done');
  btn.querySelector('b').textContent = title;
  btn.querySelector('small').textContent = sub;
  btn.querySelector('use').setAttribute('href', '#i-check');
  if (hadFocus) el.btnStart.focus({ preventScroll: true });
}

async function onDouble() { // [광고 보고 보상 2배 받기] → 방금 얻은 탄피만큼 즉시 추가 지급
  const outcome = lastOutcome;
  if (adBusy || !outcome || outcome.doubled) return;
  rewardNote('');
  const res = await watchAd('double_reward', el.btnDouble);
  if (!res.rewarded) {
    if (outcome === lastOutcome) rewardNote(adFailText(res.reason), true);
    return;
  }
  profile.grantBrass(outcome.total);
  outcome.doubled = true;
  sound.playItem(); // 탄피가 찰랑거리는 소리
  syncWallet({ animate: true });
  if (outcome !== lastOutcome) return;
  addRewardLine('광고 보상 2배', outcome.total, { ad: true });
  tweenNumber(el.rewardTotal, outcome.total, outcome.total * 2, { prefix: '+' });
  markDone(el.btnDouble, '보상 2배 지급 완료', `+${fmt(outcome.total)} 탄피가 추가됐다`);
}

async function onProtect() { // [광고 보고 연승 기록 보호하기] → 패배로 끊긴 연승을 되돌린다
  const outcome = lastOutcome;
  if (adBusy || !outcome?.canProtect || outcome.protectedStreak) return;
  rewardNote('');
  const res = await watchAd('streak_protect', el.btnProtect);
  if (!res.rewarded) {
    if (outcome === lastOutcome) rewardNote(adFailText(res.reason), true);
    return;
  }
  profile.restoreStreak(outcome.prevStreak);
  outcome.protectedStreak = true;
  sound.playItem();
  syncWallet();
  if (outcome !== lastOutcome) return;
  el.rewardStreak.textContent = `AI 연습 ${outcome.prevStreak}연승 기록이 보호됐다 · 최대 ${profile.practice.maxStreak}연승`;
  markDone(el.btnProtect, '연승 기록 보호 완료', `${outcome.prevStreak}연승 유지`);
}

// ───────── 프로필 · 티어 · 순위표 ─────────

// 결과 화면의 모드 배지: 랭킹전만 MMR 증감(서버가 기록한 값), 연습 · 친선전은 랭킹에 반영되지 않는다는 표시
const MODE_BADGE = { practice: '연습 모드 (랭킹 MMR 미반영)', friendly: '친선전 (랭킹 MMR 미반영)' };
const modeText = (outcome) => (outcome.mode === 'ranked'
  ? `랭킹전 · MMR ${outcome.mmrDelta > 0 ? '+' : outcome.mmrDelta < 0 ? '−' : '±'}${Math.abs(outcome.mmrDelta)} → ${fmt(outcome.mmr)}`
  : MODE_BADGE[outcome.mode] ?? MODE_BADGE.friendly);
const streakText = (outcome) => {
  if (outcome.mode === 'friendly') return '친선전 — 전적 · 연승에 넣지 않는다';
  const label = outcome.mode === 'practice' ? 'AI 연습 ' : '랭킹 ';
  if (outcome.won) return `${label}${outcome.streak}연승 중 · 최대 ${outcome.maxStreak}연승`;
  return outcome.prevStreak > 0 ? `${label}${outcome.prevStreak}연승이 끊겼다` : '다음 판엔 이길 수 있다';
};

// 티어 색을 CSS 변수로 칠한다 (뱃지 · 진행 바 · 빛무리가 이 값을 쓴다)
function paintTier(node, tier) {
  node.style.setProperty('--tier-hi', tier.hi);
  node.style.setProperty('--tier-main', tier.main);
  node.style.setProperty('--tier-lo', tier.lo);
  node.style.setProperty('--tier-glow', tier.glow);
}

function tierBadge(tier, size = '') {
  const badge = h('span', size ? `tier-badge ${size}` : 'tier-badge');
  badge.dataset.tier = tier.id;
  badge.title = tier.label;
  paintTier(badge, tier);
  badge.append(h('b', '', tier.roman));
  return badge;
}

// 타이틀 좌상단 미니 카드: 티어 뱃지 + 티어 이름 + `닉네임 · 승률` (누르면 프로필 & 랭킹)
function syncPlayerCard() {
  const tier = profile.tier;
  paintTier(el.playerCard, tier);
  setAttr(el.playerCard, 'data-tier', tier.id);
  setText(el.pcBadge.firstElementChild, tier.roman);
  setText(el.pcTier, tier.ko);
  setText(el.pcName, profile.nickname);
  setText(el.pcRate, profile.games ? `랭킹 ${profile.winRateText}` : '랭킹전 기록 없음'); // 짧게 — 닉네임이 말줄임되지 않게 (전체 뜻은 aria-label)
  setAttr(el.playerCard, 'aria-label', `프로필 & 랭킹 열기 — ${profile.nickname}, ${tier.label}, 랭킹 MMR ${fmt(profile.mmr)}, 랭킹 승률 ${profile.winRateText}`);
}

// 인게임 내 이름표(하단): 로그인한 닉네임 + 작은 'YOU' — 사람 상대(PvP)든 딜러든 같은 이름표 (상대 이름표는 paintFoe)
function paintMe() {
  const node = el.myName;
  if (!node) return;
  const name = userSession.user?.nickname ?? profile.nickname;
  if (node.dataset.name === name) return;
  node.dataset.name = name;
  node.classList.add('is-human'); // 긴 닉네임은 말줄임 (style.css .nameplate-name.is-human)
  node.replaceChildren(name, h('small', 'np-meta', 'YOU'));
}

// 로그인 · 닉네임 변경 · 로그아웃 (session.js 구독): 프로필 닉네임을 로그인한 닉네임으로 맞추고, 닉네임이 보이는 곳을 바로 고친다
function syncFromSession(user = userSession.user) {
  if (user && profile.reload().nickname !== user.nickname) profile.setNickname(user.nickname);
  syncPlayerCard();
  paintMe();
  if (el.profile.open) {
    if (document.activeElement !== el.nickInput) el.nickInput.value = profile.nickname; // 입력 중인 글자는 지우지 않는다
    renderBoard(); // 순위표 내 줄의 이름
  }
}

function openProfile(tab = 'record') {
  profile.reload();
  setSoundPanel(false);
  sound.unlock().catch(() => {}); // 클릭음 등을 위해 첫 클릭에서 오디오를 깨워 둔다
  el.nickInput.value = profile.nickname;
  nickMessage('');
  renderRecord();
  selectTab(tab, el.profileTabs);
  renderBoard();
  if (!el.profile.open) el.profile.showModal();
}

function closeProfile() {
  if (el.profile.open) el.profile.close();
}

function nickMessage(text, tone = '') {
  el.nickMsg.textContent = text || NICK_HINT; // 닉네임 규칙(2~10자 · 공백 없이)은 session.js 와 서버가 같다
  el.nickMsg.classList.toggle('is-bad', tone === 'bad');
  el.nickMsg.classList.toggle('is-ok', tone === 'ok');
}

// [내 기록]: 티어 카드 · 전적 · 칭호 (닉네임 입력창은 건드리지 않는다 — 입력 중인 글자를 지우지 않게)
function renderRecord() {
  const tier = profile.tier;
  paintTier(el.pfHero, tier);
  const text = h('div', 'pf-hero-text');
  text.append(h('small', '', 'RANKED TIER · 온라인 랭킹전'), h('b', '', tier.ko), h('span', '', tier.en));
  const mmr = h('div', 'pf-mmr');
  mmr.append(h('b', '', fmt(profile.mmr)), h('small', '', 'RANKED MMR'));
  const progress = h('div', 'pf-progress');
  const bar = h('div', 'pf-bar');
  const fill = h('i');
  fill.style.setProperty('--p', String(tier.progress));
  bar.append(fill);
  progress.append(bar, h('p', '', tier.next ? `다음 티어 ${tier.next.ko} (${tier.next.en}) · ${fmt(tier.toNext)} MMR 남음` : '최고 티어에 올랐다'));
  el.pfHero.replaceChildren(tierBadge(tier, 'is-xl'), text, mmr, progress);

  const practice = profile.practice;
  const stats = [ // 랭킹전(서버 기록)과 AI 연습을 따로 — 섞어서 보여 주지 않는다
    ['랭킹전 전적', `${profile.wins}승 ${profile.losses}패`],
    ['랭킹 승률', profile.winRateText],
    ['랭킹 연승', `${profile.streak}연승 · 최대 ${profile.maxStreak}`],
    ['AI 연습 전적', `${practice.wins}승 ${practice.losses}패`],
    ['연습 승률', practice.winRateText],
    ['연습 연승', `${practice.streak}연승 · 최대 ${practice.maxStreak}`],
  ];
  el.pfStats.replaceChildren(...stats.map(([name, value]) => {
    const box = h('div', 'pf-stat');
    box.append(h('dt', '', name), h('dd', '', value));
    return box;
  }));

  const now = getTitle(profile.equippedTitle) ?? TITLES[0];
  el.pfTitleNow.replaceChildren(h('small', '', 'EQUIPPED TITLE'), h('b', '', now.name), h('span', '', now.desc));
  el.pfTitleList.replaceChildren(...TITLES.map((title) => {
    const owned = profile.hasTitle(title.id);
    const chip = h('button', title.chest ? 'title-chip is-chest' : 'title-chip');
    chip.type = 'button';
    chip.dataset.id = title.id;
    chip.disabled = !owned;
    chip.setAttribute('aria-pressed', String(title.id === now.id));
    chip.append(h('b', '', title.name), h('small', '', owned ? title.desc : `잠김 · ${title.hint ?? title.desc}`)); // 상자 한정 칭호는 잠겨 있으면 얻는 방법을 보여 준다
    return chip;
  }));
}

function lbRow(entry) {
  const li = h('li', entry.isMe ? 'lb-row is-me' : 'lb-row');
  li.dataset.rank = String(entry.rank);
  const name = h('span', 'lb-name');
  name.append(h('span', '', entry.isMe ? `${entry.nickname} (나)` : entry.nickname));
  if (entry.isMe && entry.title) name.append(h('small', '', entry.title));
  li.append(h('span', 'lb-rank', `#${entry.rank}`), tierBadge(entry.tier, 'is-sm'), name, h('b', 'lb-mmr', fmt(entry.mmr)));
  return li;
}

// [순위표]: 내 MMR 기준 실시간 순위 — 소스는 storeData.js 의 leaderboard (지금은 가상 라이벌, Step B에서 서버)
async function renderBoard() {
  const gen = ++boardGen;
  let standings;
  try {
    standings = await leaderboard.getStandings(profile.forLeaderboard(), { top: LEADERBOARD.top });
  } catch (err) {
    console.error('[LAST CHAMBER] 순위표', err);
    if (gen !== boardGen) return;
    el.boardSummary.replaceChildren(h('small', '', 'LIVE RANK'), h('p', 'lb-me-line', '순위를 불러오지 못했어요. 잠시 뒤에 다시 열어 주세요'));
    el.boardList.replaceChildren();
    el.boardNote.textContent = '';
    return;
  }
  if (gen !== boardGen) return;
  const { me, above, entries, total, source, meInList } = standings;

  paintTier(el.boardSummary, me.tier);
  const line = h('div', 'lb-rank-line');
  line.append(h('b', '', `#${me.rank}위`), ' ', h('span', '', `/ 상위 ${me.percentile}%`));
  const next = above
    ? `한 칸 위 #${above.rank} ${above.nickname} (${fmt(above.mmr)}) — ${fmt(above.gap)} MMR 차이 · 승리 ${Math.ceil(above.gap / MMR.win)}번이면 역전`
    : '정상에 올랐다 — 지금 이 순위표의 1위';
  el.boardSummary.setAttribute('aria-label', `내 순위 ${me.rank}위, 상위 ${me.percentile}퍼센트`);
  el.boardSummary.replaceChildren(h('small', '', 'LIVE RANK'), line, h('p', 'lb-me-line', `${me.nickname} · MMR ${fmt(me.mmr)} · ${me.tier.label}`), h('p', 'lb-next', next));

  const rows = entries.map(lbRow);
  if (!meInList) { // 상위권 밖이면 구분선 아래에 내 줄
    const gap = h('li', 'lb-gap', '· · ·');
    gap.setAttribute('aria-hidden', 'true');
    rows.push(gap, lbRow(me));
  }
  el.boardList.replaceChildren(...rows);
  el.boardNote.textContent = source === 'virtual' ? `가상 라이벌 ${fmt(total - 1)}명 기준 순위예요 · 서버가 연결되면 실제 유저 순위로 바뀝니다` : '';
}

// 프로필 모달의 닉네임 저장도 로그인 세션을 거친다 (계정 창과 같은 규칙 · 같은 저장소 — 서버로 가는 닉네임이 어긋나지 않게)
let nickBusy = false;
async function onNickSubmit(ev) {
  ev.preventDefault();
  if (nickBusy) return;
  nickBusy = true;
  nickMessage('서버에서 확인하는 중…');
  const res = await changeNickname(el.nickInput.value);
  nickBusy = false;
  if (!res.ok) {
    nickMessage(res.message, 'bad');
    return;
  }
  el.nickInput.value = res.user.nickname;
  nickMessage(res.unchanged ? '지금 쓰고 있는 닉네임이에요' : '닉네임을 저장했어요', 'ok');
  sound.playClick();
  // HUD · 이름표 · 순위표 내 줄은 세션 구독(syncFromSession)이 바로 바꾼다
}

function onTitleClick(ev) {
  const chip = ev.target.closest('button.title-chip');
  if (!chip || chip.disabled) return;
  const id = chip.dataset.id;
  if (!profile.equipTitle(id).ok) return;
  sound.playClick();
  renderRecord();
  renderBoard();
  el.pfTitleList.querySelector(`.title-chip[data-id="${id}"]`)?.focus({ preventScroll: true });
}

// ───────── 상점 & 무기고 ─────────

function openStore() {
  profile.reload();
  setSoundPanel(false);
  sound.unlock().catch(() => {}); // 상점 효과음을 위해 첫 클릭에서 오디오를 깨워 둔다
  syncWallet();
  if (!chestBusy) { // 지난 뽑기 결과는 접어 두고 상자 무대를 처음 상태로
    el.chestResult.hidden = true;
    el.chestStage.classList.remove('is-spinning', 'is-open', 'is-rare');
  }
  renderStore();
  if (!el.store.open) el.store.showModal();
}

function closeStore() {
  if (el.store.open) el.store.close();
}

function renderStore() {
  for (const kind of [KIND.GUN, KIND.TABLE]) {
    el.storeLists[kind].replaceChildren(...CATALOG[kind].map((item) => skinCard(kind, item)));
  }
  renderChest();
  el.tauntList.replaceChildren(...TAUNTS.map(tauntCard));
}

function toast(message, bad = false) {
  el.storeToast.textContent = message;
  el.storeToast.classList.toggle('is-bad', bad);
  el.storeToast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.storeToast.hidden = true; }, 2800);
}

function skinButton(className, act, label, { icon, strong, small, disabled = false, aria } = {}) {
  const btn = h('button', className);
  btn.type = 'button';
  btn.dataset.act = act;
  btn.disabled = disabled;
  if (icon) btn.append(svgUse('', icon));
  if (strong !== undefined) btn.append(h('b', '', strong));
  btn.append(h('span', '', label));
  if (small) btn.append(h('small', '', small));
  if (aria) btn.setAttribute('aria-label', aria);
  return btn;
}

function skinCard(kind, item) {
  const owned = profile.owns(kind, item.id);
  const equipped = owned && profile.equippedId(kind) === item.id;
  const trialing = !owned && profile.trialId(kind) === item.id;
  const goal = adGoalOf(item);
  const li = h('li', equipped ? 'skin-card is-equipped' : 'skin-card');
  li.dataset.kind = kind;
  li.dataset.id = item.id;
  li.append(skinPreview(kind, item));

  const head = h('div', 'skin-head');
  const name = h('h3', 'skin-name', item.name);
  name.append(h('small', '', item.en));
  head.append(name);
  const pill = equipped ? ['is-on', '장착 중'] : trialing ? ['is-trial', '다음 1판 체험'] : owned ? ['', item.price.free ? '기본' : '보유'] : null;
  if (pill) head.append(h('span', `skin-pill ${pill[0]}`.trim(), pill[1]));

  const chips = h('div', 'skin-chips');
  chips.setAttribute('aria-hidden', 'true');
  for (const color of item.chips) {
    const chip = h('i');
    chip.style.background = color;
    chips.append(chip);
  }

  const actions = h('div', 'skin-actions');
  if (owned) {
    actions.append(equipped
      ? skinButton('sk-btn sk-equipped', 'noop', '장착 중', { icon: 'i-check', disabled: true })
      : skinButton('sk-btn sk-equip', 'equip', '장착하기', { aria: `${item.name} 장착하기` }));
  } else {
    if (item.price.brass) {
      const short = profile.brass < item.price.brass;
      actions.append(skinButton(short ? 'sk-btn sk-buy is-short' : 'sk-btn sk-buy', 'buy', '구매', {
        icon: 'i-brass',
        strong: fmt(item.price.brass),
        aria: `${item.name} 구매 — 탄피 ${fmt(item.price.brass)}${short ? ` (${fmt(item.price.brass - profile.brass)} 부족)` : ''}`,
      }));
    }
    // 결제 · 광고 SDK 가 아직 없는 곳(공개 웹 등)에서는 버튼을 '준비 중'으로 잠근다 (VIP 패스는 광고 없이 체험이 되므로 그대로)
    if (item.price.krw) {
      actions.append(platform.isAvailable('purchase')
        ? skinButton('sk-btn sk-krw', 'buy-krw', '구매', { strong: `₩${fmt(item.price.krw)}`, aria: `${item.name} 구매 — ${fmt(item.price.krw)}원` })
        : skinButton('sk-btn sk-krw is-soon', 'noop', '준비 중', { strong: `₩${fmt(item.price.krw)}`, disabled: true, aria: `${item.name} 결제 — 준비 중` }));
    }
    const views = profile.adViews(item.id);
    actions.append(platform.isAvailable('ads') || profile.hasNoAdsPass
      ? skinButton('sk-btn sk-trial', 'trial', trialing && !goal ? '체험 예약됨' : '1판 무료 체험(광고)', {
        icon: 'i-ad',
        small: goal ? `${views}/${goal}` : undefined,
        disabled: trialing && !goal,
        aria: `${item.name} 1판 무료 체험, 보상형 광고 시청${goal ? ` — 누적 ${views}/${goal}회, ${goal}회 시청하면 영구 해금` : ''}`,
      })
      : skinButton('sk-btn sk-trial is-soon', 'noop', '광고 체험 준비 중', { icon: 'i-ad', disabled: true, aria: `${item.name} 1판 무료 체험 — 준비 중` }));
  }

  const body = h('div', 'skin-body');
  body.append(head, h('p', 'skin-blurb', item.blurb), chips);
  if (!owned && goal) body.append(h('p', 'skin-goal', `광고 ${goal}회 누적 시청하면 영구 해금 · 현재 ${profile.adViews(item.id)}/${goal}`));
  body.append(actions);
  li.append(body);
  return li;
}

// 미리보기: 총기는 인게임 총 SVG를 그대로 복제(그라데이션 id만 바꿈) + 스킨 변수를 이 카드에만 적용 → 인게임과 똑같은 모습
function skinPreview(kind, item) {
  const box = h('div', 'skin-preview');
  box.setAttribute('aria-hidden', 'true');
  for (const [key, value] of Object.entries({ ...skinDefaults[kind], ...item.vars })) box.style.setProperty(key, value);
  if (kind === KIND.GUN) {
    const id = ++previewSeq;
    const html = el.gun.querySelector('svg').outerHTML
      .replace(/\bid="(gv-[\w-]+)"/g, `id="$1-p${id}"`)
      .replace(/url\(#(gv-[\w-]+)\)/g, `url(#$1-p${id})`);
    const tpl = document.createElement('template');
    tpl.innerHTML = html;
    const svg = tpl.content.firstElementChild;
    svg.setAttribute('viewBox', '34 72 308 172');
    svg.removeAttribute('role');
    svg.removeAttribute('aria-label');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    const wrap = h('div', 'pv-gun');
    wrap.append(svg);
    box.append(wrap);
  } else {
    const rim = h('div', 'pv-table');
    rim.append(h('div', 'pv-table-surface'));
    box.append(rim);
  }
  return box;
}

async function onStoreAction(act, kind, id) {
  const item = getItem(kind, id);
  if (!item || adBusy) return;
  let next = null; // 처리 뒤 포커스를 옮길 버튼
  switch (act) {
    case 'buy': { // 탄피로 구매 (장착은 따로)
      const r = profile.buyWithBrass(kind, id);
      if (r.ok) {
        sound.playItem();
        toast(`${item.name} 구매 완료 — '장착하기'를 눌러 적용하세요`);
        next = 'equip';
      } else if (r.reason === 'insufficient') {
        sound.playClick();
        toast(`탄피가 ${fmt(r.short)} 부족해요`, true);
      } else {
        toast('구매할 수 없는 스킨이에요', true);
      }
      break;
    }
    case 'buy-krw': { // 유료 결제 (platformBridge → 앱 결제 / 토스페이 / 개발용 모의 결제)
      adBusy = true;
      let res;
      try {
        res = await platform.purchaseProduct(item.price.productId, item.price.krw, { title: `${item.name} (${item.en})` });
      } finally {
        adBusy = false;
      }
      if (res.success) {
        profile.unlock(kind, id);
        sound.playItem();
        toast(`${item.name} 해금 완료 — '장착하기'를 눌러 적용하세요`);
        next = 'equip';
      } else if (res.reason === 'cancelled') {
        toast('결제를 취소했어요');
      } else if (res.reason === 'unavailable') {
        toast('결제는 준비 중이에요');
      } else {
        toast('결제에 실패했어요. 잠시 후 다시 시도해 주세요', true);
      }
      break;
    }
    case 'equip':
      profile.equip(kind, id);
      sound.playClick();
      toast(`${item.name} 장착`);
      break;
    case 'trial': { // 보상형 광고 1회 → 다음 1판 체험 예약 (+ 광고 누적 해금 항목은 횟수 적립)
      const res = await watchAd('skin_trial');
      if (!res.rewarded) {
        toast(adFailText(res.reason), true);
        break;
      }
      const r = profile.recordAdView(kind, id);
      if (!r.ok) {
        toast('체험할 수 없는 스킨이에요', true);
        break;
      }
      sound.playItem();
      if (r.unlocked) {
        toast(`광고 ${r.goal}회 시청 완료 — ${item.name} 영구 해금!`);
        next = 'equip';
      } else {
        toast(r.goal ? `다음 1판 체험 예약 · 광고 누적 ${r.views}/${r.goal}` : '다음 1판 체험 예약 — 게임을 시작하면 적용돼요');
      }
      break;
    }
    default:
      return;
  }
  applyLoadout(profile.activeLoadout());
  syncWallet({ animate: true });
  syncTitleExtras();
  renderStore();
  const card = el.storeLists[kind].querySelector(`.skin-card[data-id="${id}"]`);
  if (!card) return;
  restartClass(card, 'is-flash');
  (card.querySelector(`button[data-act="${next}"]`) ?? card.querySelector('button:not(:disabled)'))?.focus({ preventScroll: true });
}

// ───────── 암시장: 낡은 탄약 상자 · 총구 화염 · 도발 액션 (상점 탭 3 · 4) ─────────

const rarityPill = (rarity) => h('span', `skin-pill ${rarity === 'rare' ? 'is-rare' : 'is-common'}`, RARITY[rarity].ko);
const cardClass = ({ equipped = false, rare = false, locked = false } = {}) => ['skin-card', equipped && 'is-equipped', rare && 'is-rare', locked && 'is-locked'].filter(Boolean).join(' ');
// 상자 결과를 비추는 빛: 화염은 그 화염의 불꽃 색, 칭호는 황동 금빛 (희귀는 더 밝게)
const glowOf = (item) => (item.type === 'flame' ? item.vars['--muzzle-hot'] : item.rarity === 'rare' ? '#ffd36a' : '#f4dda2');

// 확률표 · 규칙 — 정적이라 시작할 때 한 번만 그린다. 숫자는 전부 storeData.js 의 CHEST · CHEST_ITEMS 에서 가져온다.
function renderOdds() {
  const rows = chestOdds().map(({ rarity, percent, items }) => {
    const row = h('div', 'odds-row');
    row.append(h('span', `skin-pill ${rarity.id === 'rare' ? 'is-rare' : 'is-common'}`, `${rarity.ko} ${percent}%`), h('span', '', items.map((it) => `${it.name} ${it.percent}%`).join(' · ')));
    return row;
  });
  const rules = h('ul', 'odds-rules');
  for (const text of [
    `상자 한 번에 탄피 ${fmt(CHEST.price)}`,
    `이미 가진 아이템이 나오면 탄피 ${fmt(CHEST.payback)}을 돌려받고 천장 게이지 +1`,
    `천장 게이지가 ${CHEST.pity}가 되면 다음 상자는 안 가진 희귀 아이템이 확정으로 나와요 (희귀를 다 모았다면 안 가진 아이템) — 확정 상자를 열면 게이지는 0으로`,
    `${CHEST_ITEMS.length}종을 모두 모으면 상자는 더 열 수 없어요`,
  ]) rules.append(h('li', '', text));
  el.oddsBody.replaceChildren(...rows, rules);
}

// 탭 3: 뽑기 버튼 · 천장 게이지 · 수집 현황. 뽑는 동안(chestBusy)에는 결과가 새지 않게 다시 그리지 않는다.
function renderChest() {
  if (chestBusy) return; // 도는 동안 다른 경로(탭 복귀 등)가 다시 그려도 결과가 미리 새지 않게 — 끝나면 onChestOpen 이 그린다
  const owned = CHEST_ITEMS.filter((it) => profile.ownsChestItem(it)).length;
  const all = owned === CHEST_ITEMS.length;
  const short = profile.brass < CHEST.price;
  const pity = profile.chestPity;
  const full = pity >= CHEST.pity && !all;
  el.btnChest.disabled = all || chestBusy;
  el.btnChest.classList.toggle('is-short', !all && short);
  el.btnChest.classList.toggle('is-busy', chestBusy);
  el.btnChest.setAttribute('aria-label', all ? '모든 아이템을 모았어요' : `낡은 탄약 상자 열기 — 탄피 ${fmt(CHEST.price)}${short ? ` (${fmt(CHEST.price - profile.brass)} 부족)` : ''}`);
  el.chestDrawLabel.textContent = all ? '모두 수집 완료' : '낡은 탄약 상자 열기';
  el.chestPrice.textContent = all ? '더 열 상자가 없어요' : `${fmt(CHEST.price)} 탄피`;
  el.pityPips.forEach((pip, i) => pip.classList.toggle('is-on', i < pity));
  el.pityCount.textContent = `${pity}/${CHEST.pity}`;
  el.chestPity.classList.toggle('is-full', full);
  el.pityNote.textContent = all
    ? '모든 아이템을 모았어요 — 천장 게이지는 더 쌓이지 않아요'
    : full ? '천장 도달 — 다음 상자는 안 가진 희귀 아이템이 확정으로 나와요'
      : `이미 가진 아이템이 나오면 +1 · ${CHEST.pity}가 되면 다음 상자는 안 가진 희귀 아이템 확정`;
  el.chestProgress.textContent = `${owned} / ${CHEST_ITEMS.length}`;
  el.chestList.replaceChildren(flameCard(getFlame(DEFAULT_FLAME_ID)), ...CHEST_ITEMS.map((it) => (it.type === 'flame' ? flameCard(it) : titleCard(it))));
}

function chipRow(colors) {
  const chips = h('div', 'skin-chips');
  chips.setAttribute('aria-hidden', 'true');
  for (const color of colors) {
    const chip = h('i');
    chip.style.background = color;
    chips.append(chip);
  }
  return chips;
}

// 총구 화염 카드: 미리보기 = 내가 장착한 총기에 이 화염을 끼운 모습 (기본 카드는 그 총기 본래의 화염)
function flameCard(flame) {
  const native = flame.id === DEFAULT_FLAME_ID;
  const owned = native || profile.ownsFlame(flame.id);
  const equipped = owned && profile.equippedFlame === flame.id;
  const li = h('li', cardClass({ equipped, rare: flame.rarity === 'rare', locked: !owned }));
  li.dataset.kind = 'flame';
  li.dataset.id = flame.id;
  const gunVars = getItem(KIND.GUN, profile.equippedId(KIND.GUN))?.vars ?? {};
  li.append(skinPreview(KIND.GUN, { vars: { ...gunVars, ...flame.vars } }));

  const head = h('div', 'skin-head');
  const name = h('h3', 'skin-name', flame.name);
  name.append(h('small', '', flame.en ?? 'DEFAULT'));
  head.append(name, flame.rarity ? rarityPill(flame.rarity) : h('span', 'skin-pill', '기본'));

  const actions = h('div', 'skin-actions');
  if (!owned) actions.append(skinButton('sk-btn sk-locked', 'noop', '상자에서 얻을 수 있어요', { disabled: true }));
  else if (equipped) actions.append(skinButton('sk-btn sk-equipped', 'noop', '장착 중', { icon: 'i-check', disabled: true }));
  else actions.append(skinButton('sk-btn sk-equip', 'equip', '장착하기', { aria: `${flame.name} 장착하기` }));

  const body = h('div', 'skin-body');
  body.append(head, h('p', 'skin-blurb', native ? flame.blurb : `${flame.tone} — ${flame.blurb}`));
  if (flame.chips.length) body.append(chipRow(flame.chips));
  body.append(actions);
  li.append(body);
  return li;
}

// 한정 칭호 카드: 장착은 프로필 › 내 기록에서 (여기서는 보유 여부만 보여 준다)
function titleCard(item) {
  const owned = profile.ownsChestItem(item);
  const equipped = owned && profile.equippedTitle === item.id;
  const li = h('li', cardClass({ equipped, rare: item.rarity === 'rare', locked: !owned }));
  li.dataset.kind = 'title';
  li.dataset.id = item.id;
  const box = h('div', 'skin-preview');
  box.setAttribute('aria-hidden', 'true');
  const plate = h('div', 'pv-title');
  plate.append(h('small', '', 'TITLE'), h('b', '', item.name));
  box.append(plate);
  li.append(box);

  const head = h('div', 'skin-head');
  const name = h('h3', 'skin-name', item.name);
  name.append(h('small', '', '프로필 칭호'));
  head.append(name, rarityPill(item.rarity));

  const actions = h('div', 'skin-actions');
  if (!owned) actions.append(skinButton('sk-btn sk-locked', 'noop', '상자에서 얻을 수 있어요', { disabled: true }));
  else if (equipped) actions.append(skinButton('sk-btn sk-equipped', 'noop', '장착 중', { icon: 'i-check', disabled: true }));
  else actions.append(skinButton('sk-btn sk-owned', 'noop', '보유 · 프로필 › 내 기록에서 장착', { disabled: true }));

  const body = h('div', 'skin-body');
  body.append(head, h('p', 'skin-blurb', item.blurb), actions);
  li.append(body);
  return li;
}

// 탭 4: 도발 카드 — 미리보기는 그 도발의 네온 글자
function tauntCard(taunt) {
  const owned = profile.ownsTaunt(taunt.id);
  const equipped = owned && profile.equippedTaunt === taunt.id;
  const li = h('li', equipped ? 'skin-card is-equipped' : 'skin-card');
  li.dataset.kind = 'taunt';
  li.dataset.id = taunt.id;
  const box = h('div', 'skin-preview');
  box.setAttribute('aria-hidden', 'true');
  box.style.setProperty('--tn-hi', taunt.chips[0]);
  box.style.setProperty('--tn-main', taunt.chips[1]);
  const pv = h('div', 'pv-taunt');
  pv.append(svgUse('', taunt.icon), h('b', '', taunt.text));
  box.append(pv);
  li.append(box);

  const head = h('div', 'skin-head');
  const name = h('h3', 'skin-name', taunt.name);
  name.append(h('small', '', taunt.en));
  head.append(name);
  const pill = equipped ? ['is-on', '장착 중'] : owned ? ['', '보유'] : null;
  if (pill) head.append(h('span', `skin-pill ${pill[0]}`.trim(), pill[1]));

  const actions = h('div', 'skin-actions');
  if (!owned) {
    const short = profile.brass < taunt.price;
    actions.append(skinButton(short ? 'sk-btn sk-buy is-short' : 'sk-btn sk-buy', 'buy', '구매', {
      icon: 'i-brass',
      strong: fmt(taunt.price),
      aria: `${taunt.name} 구매 — 탄피 ${fmt(taunt.price)}${short ? ` (${fmt(taunt.price - profile.brass)} 부족)` : ''}`,
    }));
  } else if (equipped) {
    actions.append(skinButton('sk-btn sk-equipped', 'noop', '장착 중', { icon: 'i-check', disabled: true }), skinButton('sk-btn', 'unequip', '해제', { aria: `${taunt.name} 해제` }));
  } else {
    actions.append(skinButton('sk-btn sk-equip', 'equip', '장착하기', { aria: `${taunt.name} 장착하기` }));
  }

  const body = h('div', 'skin-body');
  body.append(head, h('p', 'skin-blurb', taunt.blurb), chipRow(taunt.chips), actions);
  li.append(body);
  return li;
}

// 처리 뒤 그 카드를 번쩍이고 포커스를 옮긴다 (다시 그린 뒤라 새 노드를 찾는다)
function refocusCard(list, id, act) {
  const card = list.querySelector(`.skin-card[data-id="${id}"]`);
  if (!card) return;
  restartClass(card, 'is-flash');
  (card.querySelector(`button[data-act="${act}"]`) ?? card.querySelector('button:not(:disabled)'))?.focus({ preventScroll: true });
}

async function onFlameAction(act, _kind, id) {
  if (act !== 'equip') return;
  const flame = getFlame(id);
  if (!flame) return;
  if (!profile.equipFlame(id).ok) {
    toast('장착할 수 없는 화염이에요', true);
    return;
  }
  sound.playClick();
  toast(id === DEFAULT_FLAME_ID ? '총기 스킨 고유 화염으로 되돌렸어요' : `${flame.name} 장착 — 다음 격발부터 총구 화염 색이 바뀝니다`);
  applyLoadout(profile.activeLoadout());
  renderStore();
  refocusCard(el.chestList, id, null);
}

async function onTauntAction(act, _kind, id) {
  const taunt = getTaunt(id);
  if (!taunt) return;
  let next = null;
  switch (act) {
    case 'buy': { // 탄피로 구매 (장착은 따로)
      const r = profile.buyTaunt(id);
      if (r.ok) {
        sound.playItem();
        toast(`${taunt.name} 구매 완료 — '장착하기'를 눌러 게임 화면에 도발 버튼을 만드세요`);
        next = 'equip';
      } else if (r.reason === 'insufficient') {
        sound.playClick();
        toast(`탄피가 ${fmt(r.short)} 부족해요`, true);
      } else {
        toast('구매할 수 없는 도발이에요', true);
      }
      break;
    }
    case 'equip':
      if (!profile.equipTaunt(id).ok) {
        toast('장착할 수 없는 도발이에요', true);
        break;
      }
      sound.playClick();
      toast(`${taunt.name} 장착 — 게임 화면 구석에 도발 버튼이 나타나요`);
      break;
    case 'unequip':
      profile.equipTaunt(null);
      sound.playClick();
      toast('도발을 해제했어요');
      break;
    default:
      return;
  }
  syncWallet({ animate: true });
  renderStore();
  refocusCard(el.tauntList, id, next);
}

// 낡은 탄약 상자 열기: 추첨·차감·저장을 먼저 끝내고(연출 도중 창을 닫거나 새로고침해도 결과가 남는다) 실린더를 돌린 뒤 결과를 공개한다.
async function onChestOpen() {
  if (chestBusy || adBusy) return;
  profile.reload();
  if (CHEST_ITEMS.every((it) => profile.ownsChestItem(it))) {
    toast('모든 아이템을 이미 모았어요');
    renderChest();
    return;
  }
  if (profile.brass < CHEST.price) {
    sound.playClick();
    toast(`탄피가 ${fmt(CHEST.price - profile.brass)} 부족해요`, true);
    return;
  }
  const before = profile.brass;
  const r = profile.openChest();
  if (!r.ok) { // 그 사이 다른 탭에서 탄피를 썼거나 다 모은 경우
    toast(r.reason === 'insufficient' ? `탄피가 ${fmt(r.short)} 부족해요` : '모든 아이템을 이미 모았어요', true);
    syncWallet();
    renderChest();
    return;
  }
  chestBusy = true;
  el.btnChest.disabled = true;
  el.btnChest.classList.add('is-busy');
  try {
    const stage = el.chestStage;
    const { item } = r;
    el.chestResult.hidden = true;
    stage.classList.remove('is-open', 'is-rare');
    stage.style.setProperty('--chest-glow', glowOf(item));
    stage.style.setProperty('--spin-ms', `${CHEST_SPIN_MS}ms`);
    stage.style.setProperty('--spin-to', `${1080 + 60 * Math.floor(Math.random() * 6)}deg`); // 6칸 중 한 칸이 맨 위(포인터)에 멈춘다
    syncWallet({ animate: true, value: before - CHEST.price }); // 차감만 먼저 — 환급이 있어도 결과를 공개하기 전에는 보이지 않는다
    sound.playReload(); // 드르륵 — 실린더가 돈다
    if (reducedMotion() || document.hidden) {
      await sleep(180);
    } else {
      restartClass(stage, 'is-spinning');
      await sleep(CHEST_SPIN_MS + 100);
    }
    stage.classList.toggle('is-rare', item.rarity === 'rare');
    restartClass(stage, 'is-open');
    sound.playItem();
    if (item.rarity === 'rare') setTimeout(() => sound.playItem(), 150); // 상자 연출은 소리만 (진동은 게임의 결정적인 순간에만)
    showChestResult(r);
    syncWallet({ animate: true }); // 환급이 있으면 지금 올라간다
  } finally {
    chestBusy = false;
    renderChest(); // 천장 게이지 · 수집 현황 · 버튼 상태를 결과에 맞게
  }
}

// 뽑기 결과 카드: 새 아이템 / 중복(환급 + 천장 +1) / 천장 확정
function showChestResult(r) {
  const { item } = r;
  const box = el.chestResult;
  box.className = ['chest-result', r.duplicate ? 'is-dup' : 'is-new', item.rarity === 'rare' && 'is-rare'].filter(Boolean).join(' ');
  const name = h('p', 'cr-name');
  name.append(h('b', '', item.name), rarityPill(item.rarity));
  const lines = [];
  if (r.duplicate) lines.push(`이미 가진 아이템이에요 — 탄피 ${fmt(r.payback)}을 돌려받았어요 · 천장 게이지 +1 (${r.pity}/${CHEST.pity})`);
  else if (item.type === 'flame') lines.push('장착하면 다음 격발부터 총구 화염 색이 바뀝니다');
  else lines.push('프로필 › 내 기록에서 장착할 수 있어요');
  if (r.pityTriggered) lines.push('천장 확정으로 나왔어요 — 게이지는 0으로 돌아갔어요');
  box.replaceChildren(
    h('p', 'cr-kicker', r.duplicate ? 'DUPLICATE · 중복' : r.pityTriggered ? 'PITY · 천장 확정' : 'NEW · 새 아이템'),
    name,
    h('p', 'cr-kind', item.type === 'flame' ? `총구 화염 · ${item.tone}` : '프로필 칭호'),
    ...lines.map((text) => h('p', 'cr-text', text)),
  );
  if (!r.duplicate && item.type === 'flame') {
    const equip = h('button', 'sk-btn sk-equip', '지금 장착');
    equip.type = 'button';
    equip.dataset.flame = item.id;
    box.append(equip);
  }
  box.hidden = false;
}

// ───────── 도발 (인게임 버튼 · 연출 · 효과음 · Step B 이벤트) ─────────

// 효과음은 soundEngine.js 의 기존 소리만 조합한다 (두드리기 = 묵직한 '툭' ×3 · 연기 = 라이터 '찰칵' + 내려놓는 '툭' · 탄피 = 손끝 '딸깍' + 황동 '팅')
const TAUNT_SFX = {
  knock: [['item', 0], ['item', 170], ['item', 340]],
  smoke: [['click', 0], ['item', 260]],
  flick: [['click', 0], ['item', 110]],
};

function playTauntSound(id) { // 예약한 소리는 울리는 시점에도 같은 판의 게임 화면 · 포커스일 때만 (판이 끝나거나 창을 떠난 뒤에 새지 않게)
  const token = gameId;
  for (const [kind, at] of TAUNT_SFX[id] ?? []) setTimeout(() => gameSfx(() => (kind === 'item' ? sound.playItem() : sound.playClick()), token), at);
}

// 도발 연출 한 번 (내 도발 · 상대 도발 공통): 테이블 중앙 네온 글자 + 도발별 이펙트 + 효과음. from = 'me' | 'opponent' (상대의 도발은 붉은 네온)
function playTaunt(event, { from = 'me' } = {}) {
  const taunt = getTaunt(event.id);
  if (!taunt) return;
  const [hi, main] = from === 'me' ? taunt.chips : ['#ffe0e0', '#ff4d4d'];
  const fx = el.tauntFx;
  fx.className = `taunt-fx is-${taunt.id} from-${from}`;
  fx.style.setProperty('--tn-hi', hi);
  fx.style.setProperty('--tn-main', main);
  fx.style.setProperty('--tfx-ms', `${TAUNT_FX_MS}ms`);
  el.tauntText.textContent = taunt.text;
  restartClass(fx, 'is-playing');
  clearTimeout(tauntFxTimer);
  tauntFxTimer = setTimeout(() => fx.classList.remove('is-playing'), TAUNT_FX_MS + 60);
  playTauntSound(taunt.id); // 도발은 소리 · 연출만 (진동 없음)
  el.srLog.textContent = from === 'me' ? `도발 — ${taunt.name}` : `상대의 도발 — ${taunt.name}`;
}

function startTauntCooldown() {
  tauntReadyAt = performance.now() + TAUNT_COOLDOWN_MS;
  el.btnTaunt.style.setProperty('--cd-ms', `${TAUNT_COOLDOWN_MS}ms`);
  el.btnTaunt.setAttribute('aria-disabled', 'true');
  restartClass(el.btnTaunt, 'is-cooling');
  clearTimeout(tauntCooldownTimer);
  tauntCooldownTimer = setTimeout(() => {
    el.btnTaunt.classList.remove('is-cooling');
    el.btnTaunt.removeAttribute('aria-disabled');
  }, TAUNT_COOLDOWN_MS);
}

function resetTaunt() { // 새 판: 쿨타임 · 진행 중인 연출 초기화
  clearTimeout(tauntCooldownTimer);
  clearTimeout(tauntFxTimer);
  tauntReadyAt = 0;
  el.btnTaunt.classList.remove('is-cooling');
  el.btnTaunt.removeAttribute('aria-disabled');
  el.tauntFx.classList.remove('is-playing');
}

// 장착한 도발이 있고 판이 진행 중일 때만 도발 버튼을 보인다 (게임 시작 · 종료 · 상점에서 장착을 바꾼 뒤)
function syncTauntButton() {
  const taunt = getTaunt(profile.equippedTaunt);
  setHidden(el.btnTaunt, !taunt || !engine || Boolean(engine.getPublicState(PLAYER).winner));
  if (!taunt) return;
  setAttr(el.tauntIcon, 'href', `#${taunt.icon}`);
  setAttr(el.btnTaunt, 'aria-label', `도발: ${taunt.name}`);
  el.btnTaunt.title = `도발: ${taunt.name}`;
  el.btnTaunt.style.setProperty('--tn-hi', taunt.chips[0]);
  el.btnTaunt.style.setProperty('--tn-main', taunt.chips[1]);
}

function onTauntClick() {
  const id = profile.equippedTaunt;
  if (!id || !engine || adBusy || isPaused() || engine.getPublicState(PLAYER).winner) return;
  if (performance.now() < tauntReadyAt) return; // 쿨타임 중
  const event = makeTauntEvent(id);
  startTauntCooldown();
  document.dispatchEvent(new CustomEvent(TAUNT_OUT, { detail: event })); // Step B: 이 이벤트를 상대에게 전송한다
  playTaunt(event, { from: 'me' });
  const lines = LINES.taunt[id];
  if (lines) say(pick(lines)); // 딜러(AI)의 받아치기 — 사람 상대일 때는 상대 화면이 이 이벤트를 받아 재생한다
}

// ───────── 게임 시작 / 재시작 ─────────

const foeNameNode = document.querySelector('#zone-dealer .nameplate-name');
const DEALER_NAME = foeNameNode?.textContent ?? 'THE DEALER';
const scoreFoeLabel = document.querySelector('#zone-dealer .scoreboard span'); // 점수판 왼쪽 'DEALER'
const fireFoeSub = document.querySelector('#btn-shoot-opponent .trigger-sub'); // 격발 버튼 아래 'FIRE · DEALER'

// 상대(딜러) 이름 칸: PvP 면 상대 닉네임 + 티어 · MMR (딜러 대사 칸에는 칭호), 아니면 원래 딜러 이름
function paintFoe() {
  const word = online ? 'OPPONENT' : 'DEALER'; // PvP 의 상대는 딜러가 아니라 사람 — 점수판 · 격발 버튼의 고정 문구도 맞춘다 (차례 표시 · 결과 화면은 이미 OPPONENT)
  setText(scoreFoeLabel, word);
  if (fireFoeSub) {
    setText(fireFoeSub, `FIRE · ${word}`);
    fireFoeSub.classList.toggle('is-long', online); // 더 긴 문구라 자간을 좁힌다 (style.css .trigger-sub.is-long)
  }
  if (!foeNameNode) return;
  const foe = online ? pvpOpponent() : null;
  foeNameNode.classList.toggle('is-human', Boolean(foe)); // 사람 상대의 긴 닉네임은 말줄임 (style.css .nameplate-name.is-human)
  if (!foe) {
    foeNameNode.textContent = DEALER_NAME;
    return;
  }
  const meta = h('small', '', `${foe.tier.roman} ${foe.tier.ko} · MMR ${fmt(foe.mmr)}`);
  meta.style.cssText = 'margin-left:.55em;font-size:.72em;font-weight:500;letter-spacing:.04em;opacity:.85;white-space:nowrap';
  meta.style.color = foe.tier.hi;
  foeNameNode.replaceChildren(foe.name, meta);
  el.line.textContent = foe.title ? `“${foe.title}”` : '';
}

// PvP: 지금 차례인 사람의 총기 스킨 · 총구 화염을 테이블 중앙 리볼버에 적용한다 (테이블 테마는 각자 본인 것). 이미 같은 조합이면 건드리지 않는다
function applyTurnSkin(id) {
  const next = pvpLoadoutFor(id);
  const now = document.documentElement.dataset;
  if (next && !(now.gun === next.gun && now.table === next.table && now.flame === next.flame)) applyLoadout(next);
}

// 서버(PvP)에서 새 상태/결과가 왔다 — 연출 중이면 그 연출이 끝나는 advance 가 아직 못 보여 준 로그를 이어서 처리한다
function onPvpUpdate() {
  if (online && !busy && gameId && onGameScreen()) advance(gameId); // 게임 화면이 아니면(결과 · 로비) 서버 로그를 연출하지 않는다
}

function startGame(pvp = false) { // pvp: 실시간 PvP 판 (pvpSession.js 가 첫 상태를 받은 뒤 부른다) — 아니면 AI 딜러 대전
  sound.unlock().catch(() => {}); // 사용자 클릭 안에서 오디오 활성화 (자동재생 정책, 총성 녹음도 이때 불러옴)
  if (pvp && !audioUnlockArmed) { // PvP 는 소켓 이벤트로 시작해 제스처 밖일 수 있다 → 첫 터치에서 한 번 더 (터치 없이 판이 이어져도 리스너가 쌓이지 않게 하나만)
    audioUnlockArmed = true;
    document.addEventListener('pointerdown', () => {
      audioUnlockArmed = false;
      sound.unlock().catch(() => {});
    }, { once: true });
  }
  sound.setInGame(true); // 잠금 2 열기 — 실제 판이 시작됐다
  sound.setTension(0);
  sound.startAmbient(); // 앰비언트 배경음 (다시 하기로 재시작해도 한 번만 켜짐)
  const token = ++gameId;
  online = pvp;
  animatedIdx = -1;
  if (el.title.open) el.title.close();
  setSoundPanel(false);
  stopTimer();
  applyLoadout(profile.beginGame()); // 이번 판의 총기·테이블 스킨 (광고로 예약한 체험 스킨은 이 판으로 소모)
  resetRewardUi();
  syncTitleExtras();

  if (online) { // 서버가 판을 진행한다: 화면은 원격 엔진(서버 상태)을 그대로 읽는다
    engine = pvpEngine();
    dealer = null;
    memory = null;
  } else {
    pvpEnd(); // 지난 PvP 소켓이 남아 있으면 정리
    engine = new GameEngine({ players: [PLAYER, AI] });
    dealer = new AIDealer(AI);
    memory = { knownShell: null };
  }
  paintFoe();
  paintMe();
  resetTaunt();
  syncTauntButton(); // 장착한 도발이 있으면 이번 판 구석에 도발 버튼
  lastLogIndex = 0;
  aiLogIndex = 0;
  busy = true;
  roundResults = [];
  dealBuffer = {};
  fresh[PLAYER].clear();
  fresh[AI].clear();
  slotKeys[PLAYER] = null; // 새 판의 첫 render 는 아이템 줄을 새로 그린다 (지난 판의 부서지던 슬롯 등이 남지 않게)
  slotKeys[AI] = null;

  clearSubtitles();
  forget();
  clearTimeout(headlineTimer);
  clearTimeout(sparkTimer);
  el.headline.classList.remove('is-visible');
  el.reveal.classList.remove('is-visible');
  el.sparks.classList.remove('is-active');
  el.gun.classList.remove('aim-up', 'aim-down', 'fire', 'barrel-spin', 'is-doubled', 'shock');
  el.app.classList.remove('shake-hard');
  el.flash.classList.remove('flash-red');
  el.table.classList.remove('zoom-tension', 'zoom-hit');
  document.body.classList.remove('slowmo');
  lastTension = -1;
  setCrisis('');
  thinking(false);
  idleTimer();
  say(pick(LINES.start));
  render();
  setInMatch(true); // [항복] / [나가기] 버튼
  guidedGame = guide.shouldCoach({ online }); // 첫 AI 판: 턴 제한을 넉넉하게 + 내 첫 턴에 코치마크
  if (guide.shouldShowRuleCard) showRuleCard(); // 첫 게임: 장전 연출과 함께 핵심 3줄 룰

  guard((async () => {
    await present(token); // ROUND_START → LOAD(장전 연출) → DEAL → TURN
    if (token !== gameId) return;
    busy = false;
    advance(token);
  })());
}

// 연출이 끝난 뒤 다음 차례로 넘긴다
function advance(token) {
  if (token !== gameId) return;
  if (online && engine.getLog(PLAYER, lastLogIndex).length) { // 연출하는 사이 서버가 보내 온 로그(상대의 행동 · 시간 초과 격발 · 재접속)부터
    guard(catchUp(token));
    return;
  }
  const s = engine.getPublicState(PLAYER);
  render();
  if (s.winner) guard(endGame(s, token));
  else if (s.turn.isMine) {
    if (guide.shouldCoach({ online }) && !coaching) { // 첫 AI 판의 내 첫 턴: 코치마크가 끝난 뒤에 타이머를 시작한다
      guard(runCoach(token));
      return;
    }
    startTimer(token);
  }
  else if (online) { // 상대 차례: 서버가 진행한다 — 다음 state_update 를 기다린다
    idleTimer();
    thinking(true);
  } else guard(runAITurn(token));
}

// PvP: 아직 연출하지 못한 서버 로그를 차례로 보여 준다 (딜러 AI 턴(runAITurn) 자리). 격발은 presentEntry 가 총 연출까지 붙인다
async function catchUp(token) {
  if (busy) return;
  busy = true;
  stopTimer();
  idleTimer();
  thinking(false);
  render();
  await present(token);
  if (token !== gameId) return;
  if (engine.getPublicState(PLAYER).turn?.isMine) resetTimer();
  busy = false;
  advance(token);
}

async function endGame(s, token) {
  const won = s.winner === PLAYER;
  const surrendered = online && pvpOver()?.reason === 'surrender'; // 서버가 항복으로 끝낸 판 (won = 상대가 항복) — 문구만 다르고 정산은 같은 경로
  setInMatch(false); // 결과가 나왔다 — 항복 버튼과 확인 모달은 치운다
  closeLeave();
  hideRuleCard();
  stopTimer();
  idleTimer();
  busy = true;
  thinking(false);
  render(); // 위기 비네팅·긴장도도 여기서 해제
  syncTauntButton(); // 승패가 갈렸으니 도발 버튼은 접는다
  sound.stopAmbient({ fade: 3 }); // 결과 화면에서는 배경음이 서서히 잦아든다
  sound.setInGame(false); // 잠금 2 닫기 — 결과 화면부터는 게임 전용 소리가 나지 않는다 (위 페이드는 이미 걸려 있어 그대로)
  // 승패가 가려지는 순간 결과를 저장한다 (연출 도중 창을 닫아도 탄피·연승이 남도록). 한 판에 한 번만.
  let outcome = null;
  if (recordedGame !== token) {
    recordedGame = token;
    outcome = online ? await pvpSettle(won) : profile.recordPractice(won); // PvP: 랭킹전/친선전별 정산 + 소켓 정리 · AI 딜러: 연습 기록만 (랭킹 MMR 미반영)
  }
  say(pick(won ? LINES.gameWon : LINES.gameLost));
  subtitle(surrendered ? (won ? '상대가 항복했다 — 당신의 승리' : '당신은 항복했다 — 상대의 승리') : won ? '딜러가 쓰러졌다 — 당신의 승리' : '당신이 쓰러졌다 — 딜러의 승리', won ? 'info' : 'danger');
  if (token === gameId) platform.triggerHaptic(won ? 'win' : 'lose'); // 승패 확정: 진동 1회 (승리 Medium · 패배 Heavy)
  await headline(surrendered && !won ? 'SURRENDER' : won ? 'VICTORY' : 'DEFEAT', won ? 'info' : 'danger', 1900);
  if (token !== gameId) return;
  setHtml(el.titleHeading, won ? 'YOU<span>SURVIVED</span>' : 'GAME<span>OVER</span>'); // 같은 결과가 이어지면 다시 파싱하지 않는다
  el.titleSub.textContent = surrendered ? (won ? '상대가 테이블을 떠났다. 오늘 밤 마지막 약실은 당신의 것.' : '당신은 테이블을 떠났다. 다시 앉겠는가?') : vsFoe(won ? '딜러가 테이블 위에 쓰러졌다. 오늘 밤 마지막 약실은 당신의 것.' : '마지막 약실은 딜러의 것이었다. 다시 앉겠는가?');
  el.titleResult.textContent = `${online ? 'OPPONENT' : 'DEALER'} ${s.opponent.wins} : ${s.me.wins} YOU${surrendered ? (won ? ' · 상대 항복' : ' · 항복') : ''}`;
  el.titleResult.hidden = false;
  el.btnStart.querySelector('.title-btn-main').textContent = '다시 하기';
  el.btnStart.querySelector('.title-btn-sub').textContent = 'PLAY AGAIN';
  if (outcome) showReward(outcome);
  applyLoadout(profile.activeLoadout()); // 1판 체험이 끝났으면 장착해 둔 스킨으로 복귀
  syncTitleExtras();
  if (!el.title.open) el.title.showModal();
  el.titleInner.scrollTop = 0; // 첫 포커스(광고 버튼)가 화면을 밀어 제목이 잘리지 않게
  syncWallet({ animate: true }); // 획득한 탄피가 배지로 굴러 들어간다
  syncPlayerCard(); // 전적·티어가 바뀌었으니 좌상단 미니 카드도
}

// ───────── 첫 판 가이드: 3줄 룰 카드 · 4단계 코치마크 ─────────

function showRuleCard() {
  if (!el.ruleCard || !el.ruleCardList) return;
  el.ruleCardList.replaceChildren(...RULE_LINES.map((line) => h('li', '', line)));
  el.ruleCard.hidden = false;
  ruleCardAt = performance.now();
  guide.markRuleCard(); // 보여 준 순간 기록 — 새로고침해도 두 번째 판부터는 생략
  clearTimeout(ruleCardTimer);
  ruleCardTimer = setTimeout(hideRuleCard, RULE_CARD_MS);
}

function hideRuleCard() {
  clearTimeout(ruleCardTimer);
  if (el.ruleCard && !el.ruleCard.hidden) el.ruleCard.hidden = true;
}

// 코치마크 한 단계: 요소 위치에 구멍을 내고 말풍선을 위/아래 중 자리가 넉넉한 쪽에 놓는다
function placeCoach(index) {
  const step = COACH_STEPS[index];
  setText(el.coachStep, `${index + 1} / ${COACH_STEPS.length}`);
  setText(el.coachTitle, step.title);
  setText(el.coachText, step.text);
  setText(el.coachNext, index === COACH_STEPS.length - 1 ? '시작하기' : '다음');
  const rect = document.getElementById(step.target)?.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const bubble = el.coachBubble.getBoundingClientRect();
  const gap = 12;
  const pad = 6;
  if (!rect || rect.width === 0) { // 짚을 요소가 없으면 가운데에
    el.coachSpot.style.cssText = 'top:50%;left:50%;width:0;height:0';
    el.coachBubble.style.top = `${Math.max(12, (vh - bubble.height) / 2)}px`;
    el.coachBubble.style.left = `${Math.max(12, (vw - bubble.width) / 2)}px`;
    return;
  }
  el.coachSpot.style.top = `${rect.top - pad}px`;
  el.coachSpot.style.left = `${rect.left - pad}px`;
  el.coachSpot.style.width = `${rect.width + pad * 2}px`;
  el.coachSpot.style.height = `${rect.height + pad * 2}px`;
  const below = rect.bottom + pad + gap + bubble.height <= vh - 8;
  const top = below ? rect.bottom + pad + gap : Math.max(8, rect.top - pad - gap - bubble.height);
  const left = Math.min(Math.max(12, rect.left + rect.width / 2 - bubble.width / 2), Math.max(12, vw - bubble.width - 12));
  el.coachBubble.style.top = `${top}px`;
  el.coachBubble.style.left = `${left}px`;
}

/** 4단계를 차례로 보여 준다 → 끝(또는 건너뛰기)까지 기다린다. 열려 있는 동안 AI 연습의 시간은 멈춘다 (isPaused) */
function showCoachSteps() {
  return new Promise((resolve) => {
    let index = 0;
    const reposition = () => placeCoach(index);
    const finish = () => {
      window.removeEventListener('resize', reposition);
      el.coachNext.onclick = null;
      el.coachSkip.onclick = null;
      el.coach.oncancel = null;
      if (el.coach.open) el.coach.close();
      resolve();
    };
    el.coachNext.onclick = () => {
      index += 1;
      if (index >= COACH_STEPS.length) finish();
      else placeCoach(index);
    };
    el.coachSkip.onclick = finish;
    el.coach.oncancel = (ev) => { ev.preventDefault(); finish(); }; // Esc = 건너뛰기
    window.addEventListener('resize', reposition);
    el.coach.showModal();
    placeCoach(0);
    el.coachNext.focus({ preventScroll: true });
  });
}

// 첫 AI 판의 내 첫 턴: (3줄 카드를 최소 시간 보여 준 뒤) 코치마크 → 끝나면 완료로 기록하고 이어서 타이머 시작
async function runCoach(token) {
  coaching = true;
  busy = true; // 코치마크가 떠 있는 동안 입력 · 타이머 잠금
  stopTimer();
  idleTimer();
  render();
  const shown = performance.now() - ruleCardAt;
  if (!el.ruleCard.hidden && shown < RULE_CARD_MIN_MS) await sleep(RULE_CARD_MIN_MS - shown);
  hideRuleCard();
  if (token === gameId) await showCoachSteps();
  coaching = false;
  guide.markCoachDone(); // 건너뛰어도 완료 — 2번째 판부터는 생략
  if (token !== gameId) return;
  busy = false;
  render();
  advance(token); // 이제 guide.shouldCoach 가 false → 타이머 시작
}

// ───────── 항복 · 나가기 ─────────
// 온라인 대전([항복]): 확인 → 서버에 surrender → 서버가 판을 끝내고 정산(랭킹전 항복자 −20 · 상대 +25 · 친선전은 기록 없음)한 뒤 양쪽에 game_over 를 보낸다.
//   결과 화면은 그 game_over 가 열어 준다(endGame) — 클라이언트는 전적 · MMR 을 직접 바꾸지 않는다.
// AI 연습([나가기]): 확인 → 판을 그 자리에서 버리고 타이틀(로비로 가는 화면)로. 전적 · MMR · 탄피는 건드리지 않는다 (recordPractice 를 부르지 않는다).

function setInMatch(on) {
  inMatch = on;
  setHidden(el.btnLeave, !on);
  if (!on) return;
  setText(el.leaveLabel, online ? '항복' : '나가기');
  el.btnLeave.classList.toggle('is-quit', !online);
  el.btnLeave.setAttribute('aria-label', online ? '항복하고 판을 끝내기' : '연습 게임 나가기');
}

function openLeave() {
  if (!inMatch || el.leave.open || leaving || adBusy) return;
  const ranked = online && pvpMode() === 'ranked';
  if (!online) {
    el.leaveTitle.textContent = '연습 게임을 나갈까요?';
    el.leaveText.textContent = '연습 게임을 종료하고 로비로 돌아갑니다.\n전적과 MMR은 변하지 않아요.';
    el.leaveConfirm.textContent = '나가기';
  } else {
    el.leaveTitle.textContent = '정말 항복하시겠습니까?';
    el.leaveText.textContent = ranked ? '랭킹전은 패배로 기록됩니다.\nMMR −20 · 상대는 +25 를 받아요.' : '친선전은 전적과 MMR에 기록되지 않아요.\n상대의 승리로 판이 끝납니다.';
    el.leaveConfirm.textContent = '항복하기';
  }
  setSoundPanel(false);
  el.leave.showModal();
}

function closeLeave() {
  if (el.leave.open) el.leave.close();
}

async function confirmLeave() {
  closeLeave();
  if (!inMatch || leaving) return;
  if (!online) {
    leaveAiGame();
    return;
  }
  if (pvpOver()) return; // 이미 서버가 판을 끝냈다 (결과 화면이 곧 열린다)
  leaving = true;
  setDisabled(el.btnLeave, true);
  const res = await pvpSurrender();
  leaving = false;
  setDisabled(el.btnLeave, false);
  if (!res.ok && res.error !== 'NOT_IN_GAME') toast('서버에 닿지 않아 항복하지 못했어요. 잠시 뒤 다시 눌러 주세요', true); // 판은 그대로 — 결과는 서버의 game_over 로만 열린다
}

// AI 연습에서 나가기: 진행 중인 연출 · 타이머 · 딜러 턴을 토큰으로 끊고 타이틀로. 결과를 기록하지 않는다 (recordedGame 은 그대로 → 지급 · 전적 없음)
function leaveAiGame() {
  hideRuleCard();
  ++gameId; // 이 판의 비동기 흐름(연출 · 딜러 턴 · 타이머)이 다음 확인에서 모두 멈춘다
  busy = true;
  setInMatch(false);
  stopTimer();
  idleTimer();
  thinking(false);
  clearSubtitles();
  clearTimeout(headlineTimer);
  clearTimeout(sparkTimer);
  el.headline.classList.remove('is-visible');
  el.reveal.classList.remove('is-visible');
  el.sparks.classList.remove('is-active');
  el.gun.classList.remove('aim-up', 'aim-down', 'fire', 'barrel-spin', 'is-doubled', 'shock');
  el.app.classList.remove('shake-hard');
  el.flash.classList.remove('flash-red');
  el.table.classList.remove('zoom-tension', 'zoom-hit');
  document.body.classList.remove('slowmo');
  setCrisis('');
  syncTauntButton();
  sound.stopAmbient({ fade: 1.5 });
  sound.setInGame(false); // 잠금 2 닫기
  applyLoadout(profile.activeLoadout()); // 1판 체험 스킨이었다면 장착해 둔 스킨으로 복귀
  setHtml(el.titleHeading, 'LAST<span>CHAMBER</span>');
  el.titleSub.textContent = '연습 게임을 마쳤다. 다시 앉겠는가?';
  el.titleResult.hidden = true;
  el.btnStart.querySelector('.title-btn-main').textContent = '게임 시작';
  el.btnStart.querySelector('.title-btn-sub').textContent = 'AI 연습 · 랭킹전 · 친선전';
  syncTitleExtras();
  if (!el.title.open) el.title.showModal();
  el.titleInner.scrollTop = 0;
  syncWallet();
  syncPlayerCard();
}

// ───────── 플레이어 입력 ─────────

const playerCanAct = () => Boolean(engine) && !busy && !isPaused() && engine.getPublicState(PLAYER).turn?.isMine === true;

async function handleItem(index) {
  if (!playerCanAct()) return;
  const token = gameId;
  busy = true;
  render();
  const result = await engine.useItem(PLAYER, index); // PvP 에서는 서버가 확정한 결과를 기다린다
  if (token !== gameId) return;
  if (!result.ok) { // 화면에서 미리 막지만 혹시 모를 경우 대비
    busy = false;
    render();
    subtitle('지금은 쓸 수 없는 아이템이다', 'danger');
    if (online) advance(token); // 그새 서버가 보낸 로그가 있으면 이어서 연출
    return;
  }
  gameSfx(() => sound.playItem(), token); // 아이템 사용은 소리만 (진동 없음)
  await present(token);
  if (token !== gameId) return;
  busy = false;
  advance(token);
}

async function handleShoot(target) {
  if (!playerCanAct()) return;
  const token = gameId;
  busy = true; // 중복 클릭 방지
  render();
  const result = await fireSequence(PLAYER, target, token);
  if (token !== gameId || !result) return;
  if (!result.ok) {
    busy = false;
    render();
    if (online) advance(token); // 예: 내가 누르기 직전에 서버가 시간 초과 격발을 해 버렸다 → 그 로그부터 연출
    return;
  }
  await present(token);
  if (token !== gameId) return;
  if (engine.getPublicState(PLAYER).turn?.isMine) resetTimer(); // 나에게 공포탄 → 같은 턴 새 20초
  busy = false;
  advance(token);
}

// ───────── 딜러 턴 ─────────

async function holdWhilePaused(token) {
  while (isPaused() && token === gameId) await sleep(150);
}

// 딜러에게 딜러 시점의 새 로그를 전부 알려 준다 (상대의 비밀 정보는 엔진이 가려서 준다)
function syncDealer() {
  const events = engine.getLog(AI, aiLogIndex);
  aiLogIndex += events.length;
  dealer.observe(events, memory);
}

async function runAITurn(token) {
  busy = true;
  stopTimer();
  idleTimer();
  render();
  thinking(true);
  say(pick(LINES.thinking));

  for (let step = 0; step < 60; step++) {
    await wait(AI_STEP_MS);
    await holdWhilePaused(token);
    if (token !== gameId) return;
    syncDealer();
    const view = engine.getPublicState(AI);
    if (view.winner || !view.turn?.isMine) break;

    const action = dealer.decideNextAction(view, memory) ?? { type: 'shoot', target: 'opponent' };
    let result = null;
    if (action.type === 'item') {
      result = engine.useItem(AI, action.slotIndex);
      if (result.ok) gameSfx(() => sound.playItem(), token); // 탄종변환도 사용 사실과 소리는 공개 (진동 없음)
    }
    if (!result?.ok) { // 격발 (아이템 실패 시에도 상대에게 격발로 진행해 멈추지 않게)
      thinking(false);
      result = await fireSequence(AI, action.type === 'shoot' ? action.target : 'opponent', token);
      if (token !== gameId || !result) return;
    }
    await present(token);
    if (token !== gameId) return;
    if (!engine.getPublicState(AI).turn?.isMine) break;
    thinking(true);
  }

  thinking(false);
  busy = false;
  advance(token);
}

// ───────── 격발 시퀀스 (플레이어·딜러 공용) ─────────

// known = PvP 에서 서버가 이미 확정한 격발 결과({ ok, shell, idx }) — 있으면 엔진을 부르지 않고 연출만 한다 (상대 · 시간 초과 격발)
async function fireSequence(shooter, target, token, known = null) {
  const atDealer = (shooter === AI) === (target === 'self'); // 총구가 딜러(위)를 향하는가
  el.gun.classList.remove('aim-up', 'aim-down');
  el.gun.classList.add(atDealer ? 'aim-up' : 'aim-down');
  gameSfx(() => sound.playHeartbeat(), token);
  el.table.classList.add('zoom-tension');
  await wait(TENSION_MS);
  el.table.classList.remove('zoom-tension');
  if (token !== gameId) return null;

  const result = known ?? await engine.shoot(shooter, target); // PvP 내 격발: 서버 응답을 기다린다
  if (token !== gameId) return null;
  if (!result.ok) {
    el.gun.classList.remove('aim-up', 'aim-down');
    return result;
  }
  if (Number.isInteger(result.idx)) animatedIdx = Math.max(animatedIdx, result.idx); // PvP: 이 격발의 총 연출은 지금 한다 (로그 연출에서 또 하지 않게)
  forget(); // 알고 있던 약실 탄은 방금 소모됨
  if (result.shell === SHELL.LIVE) {
    const slow = !reducedMotion();
    if (slow) { // 슬로모션: 효과 배속(--slow)을 먼저 걸고 화면을 총구 쪽으로 당긴다 (격발 직전 줌인에서 이어짐)
      document.body.classList.add('slowmo');
      el.table.classList.add('zoom-hit');
    }
    if (onGameScreen(token)) { // 실제 게임 화면에서만 총성 · 진동
      if (documentFocused()) { // 포커스가 없으면 소리는 내지 않는다 (진동은 그대로)
        sound.playGunshot();
        sound.playDamage();
        sound.duckAmbient(); // 배경음을 잠깐 낮춰 총성이 살게
      }
      platform.triggerHaptic(atDealer ? 'shot' : 'hit'); // 실탄 1회: 상대가 맞으면 실탄 발사(Medium) · 내가 맞으면 피격(Heavy) — 300ms 쿨타임으로 중복 수신도 한 번만
    }
    restartClasses([[el.gun, 'fire'], [el.app, 'shake-hard'], [el.flash, 'flash-red']]); // 강제 리플로우 1번으로 세 연출을 함께 시작
    if (slow) await wait(SLOWMO_MS);
  } else {
    gameSfx(() => sound.playClick(), token); // 공포탄: 딸깍 소리만 (진동 없음)
  }
  await wait(AFTERMATH_MS);
  el.gun.classList.remove('fire', 'aim-up', 'aim-down');
  el.app.classList.remove('shake-hard');
  el.flash.classList.remove('flash-red');
  el.table.classList.remove('zoom-hit');
  document.body.classList.remove('slowmo');
  return result;
}

// ───────── 로그 연출 ─────────

async function present(token) {
  const entries = engine.getLog(PLAYER, lastLogIndex);
  lastLogIndex += entries.length;
  for (let i = 0; i < entries.length; i++) {
    if (token !== gameId) return;
    await presentEntry(entries[i], entries.slice(i + 1));
  }
  if (token === gameId) render();
}

async function presentEntry(e, rest) {
  switch (e.type) {
    case 'ROUND_START':
      forget();
      render();
      if (e.round > 1) say(pick(LINES.round));
      subtitle(`라운드 ${e.round} — 체력 ${e.hp}칸씩, 먼저 2판을 따면 끝난다`);
      await headline(`ROUND ${['I', 'II', 'III'][e.round - 1]}`, 'info', 1300);
      break;
    case 'LOAD':
      await reloadSequence(e);
      break;
    case 'DEAL':
      markFresh(e);
      dealBuffer[e.player] = e.items;
      render();
      if (e.player === AI) { // 양쪽 지급이 끝나면 한 줄로
        const list = (items) => (items?.length ? items.map((it) => ITEM_INFO[it].name).join(', ') : '없음');
        subtitle(`아이템 지급 — 나: ${list(dealBuffer[PLAYER])} · 딜러: ${list(dealBuffer[AI])}`);
        dealBuffer = {};
        await wait(500);
      }
      break;
    case 'TURN':
      if (online) applyTurnSkin(e.player); // 이번 차례 사람의 총기 스킨 · 총구 화염으로 전환
      if (e.player === PLAYER) {
        resetTimer();
        subtitle('당신의 차례 — 아이템을 쓰거나 방아쇠를 당겨라', 'info', { filler: true });
      } else {
        subtitle('딜러의 차례', 'info', { filler: true });
      }
      break;
    case 'SKIP':
      subtitle(e.player === PLAYER ? '섬광탄에 눈이 멀어 당신의 턴을 건너뛴다' : '섬광탄에 눈이 먼 딜러의 턴을 건너뛴다');
      await headline('SKIP', 'info', 1100);
      break;
    case 'SHOT':
      if (online && e.idx > animatedIdx) { // 상대(또는 시간 초과로 서버가 대신 쏜) 격발 — 총 연출부터
        await fireSequence(e.actor, e.actor === e.target ? 'self' : 'opponent', gameId, { ok: true, shell: e.shell, idx: e.idx });
      }
      await presentShot(e, rest);
      break;
    case 'ITEM':
      if (online && e.actor === AI) gameSfx(() => sound.playItem()); // 상대 턴에서는 사용 직전에 울리던 소리 (내 아이템은 handleItem 이 울린다 · 진동 없음)
      await presentItem(e);
      break;
    case 'ROUND_END': {
      const won = e.winner === PLAYER;
      roundResults[e.round - 1] = won ? 'won' : 'lost';
      renderRounds(e.round);
      const score = won ? el.scorePlayer : el.scoreDealer;
      score.textContent = String(Number(score.textContent) + 1);
      say(pick(won ? LINES.roundWon : LINES.roundLost));
      subtitle(`라운드 ${e.round} ${won ? '승리' : '패배'}`, won ? 'info' : 'danger');
      await headline(won ? 'ROUND WON' : 'ROUND LOST', won ? 'info' : 'danger', 1600);
      break;
    }
    default: // GAME_OVER는 advance()에서 결과 화면으로 처리
      break;
  }
}

async function presentShot(e, rest) {
  const live = e.shell === SHELL.LIVE;
  const self = e.actor === e.target;
  const byMe = e.actor === PLAYER;
  const hitMe = e.target === PLAYER;
  const turnKept = self && !live && !rest.some((x) => x.type === 'LOAD' || x.type === 'TURN');
  patchShells(e.shell);
  if (live) patchHp(hitMe ? el.playerHp : el.dealerHp, hitMe ? el.zonePlayer : el.zoneDealer, e.damage);

  const shooter = byMe ? '당신' : '딜러';
  const aimed = self ? '자기 자신' : hitMe ? '당신' : '딜러';
  const outcome = live
    ? `실탄! ${hitMe ? '당신' : '딜러'} 체력 −${e.damage}`
    : `공포탄${turnKept ? ' — 한 번 더' : ''}`;
  subtitle(`${josa(shooter, '이', '가')} ${aimed}에게 격발 — ${outcome}`, live ? 'danger' : 'blank');
  say(pick(shotLines(byMe, self, live)));
  const word = live ? (e.damage > 1 ? `−${e.damage} DOUBLE SHOT` : 'BANG!') : turnKept ? 'CLICK · AGAIN' : 'CLICK';
  await headline(word, live ? 'danger' : 'blank', 1000);
}

function shotLines(byMe, self, live) {
  if (self) return byMe ? (live ? LINES.selfLivePlayer : LINES.selfBlankPlayer) : (live ? LINES.selfLiveDealer : LINES.selfBlankDealer);
  if (byMe) return live ? LINES.hitDealer : LINES.missDealer;
  return live ? LINES.hitPlayer : LINES.missPlayer;
}

async function presentItem(e) {
  const mine = e.actor === PLAYER;
  const used = e.stolen ?? e.item; // 소매치기면 훔쳐서 바로 쓴 아이템
  const subject = josa(mine ? '당신' : '딜러', '이', '가');
  const head = e.stolen
    ? `${subject} 소매치기로 ${mine ? '딜러' : '당신'}의 ${josa(ITEM_INFO[e.stolen].name, '을', '를')} 훔쳐 사용`
    : `${subject} ${josa(ITEM_INFO[e.item].name, '을', '를')} 사용`;
  let detail = effectText(used, e, mine);

  if (used === ITEM.SCOPE && mine) learn(e.shell, 'SECRET · 약실 확인');
  if (used === ITEM.EJECT) forget();
  if (used === ITEM.CONVERT) {
    if (myKnown) { // 미리 알던 탄이라면 변환 결과도 내가 계산해서 안다
      const before = myKnown;
      learn(flip(before), 'SECRET · 변환 후 약실');
      if (mine) detail = `약실의 ${josa(SHELL_NAME[before], '이', '가')} ${josa(SHELL_NAME[myKnown], '으로', '로')} 바뀌었다 — 당신만 안다`;
    }
    sparkFx();
  }

  const volt = used === ITEM.CONVERT;
  const smashed = used === ITEM.EJECT && Boolean(e.destroyed); // 상대 아이템이 부서졌는가
  const broken = smashed && shatterSlot(e.destroyed, mine);
  subtitle(`${head} — ${detail}`, volt ? 'volt' : 'info');
  if (smashed) say(pick(mine ? LINES.itemBroken : LINES.ejectBreak));
  else if (!mine) say(pick(volt ? LINES.convert : LINES.dealerItem));
  const shown = volt
    ? headline('CONVERTED', 'volt', 1200)
    : headline(ITEM_INFO[e.item].tag + (e.stolen ? ` · ${ITEM_INFO[e.stolen].tag}` : ''), 'info', mine ? 850 : 1050);
  if (broken) await wait(SHATTER_MS); // 부서지는 동안은 아이템 목록을 그대로 둔다
  render();
  await shown;
}

// 탄제거로 파괴되는 아이템을 지금 화면에서 찾아 부서지는 연출을 건다 (이미 다시 그려져 없으면 건너뜀)
function shatterSlot(item, byMe) {
  const node = byMe
    ? el.dealerItems.querySelector(`.dslot[data-item="${item}"]:not(.is-shattered)`)
    : el.playerItems.querySelector(`button.card[data-item="${item}"]:not(.is-shattered)`);
  if (!node) return false;
  node.classList.add('is-shattered');
  return true;
}

function effectText(item, e, mine) {
  switch (item) {
    case ITEM.SCOPE: return mine ? '약실을 몰래 확인했다' : '약실을 몰래 들여다본다';
    case ITEM.DOUBLE: return '다음 한 발 피해 2배';
    case ITEM.FLASH: return mine ? '딜러의 다음 턴을 건너뛴다' : '당신의 다음 턴을 건너뛴다';
    case ITEM.EJECT: {
      const ejected = `약실의 ${josa(SHELL_NAME[e.shell], '을', '를')} 빼냈다`;
      return e.destroyed
        ? `${ejected} — ${mine ? '딜러' : '당신'}의 ${josa(ITEM_INFO[e.destroyed].name, '이', '가')} 파괴됐다`
        : `${ejected} — 파괴할 아이템이 없었다`;
    }
    case ITEM.DRINK: return e.hp === 2 ? '체력 +1 — 단두대에서 벗어났다' : '체력 +1';
    case ITEM.CONVERT: return mine ? '약실의 탄종이 바뀌었다 — 무엇이 됐는지는 아무도 모른다' : '약실의 탄종이 바뀌었다 — 이번 장전의 탄 구성은 이제 가려진다';
    default: return '';
  }
}

async function reloadSequence(e) {
  forget();
  render();
  gameSfx(() => sound.playReload()); // 장전은 소리 · 연출만 (진동 없음)
  restartClass(el.gun, 'barrel-spin');
  el.revealShells.replaceChildren(...Array.from({ length: e.live + e.blank }, (_, i) => {
    const live = i < e.live;
    const icon = svgUse(`shell ${live ? 'is-live' : 'is-blank'}`, live ? 'i-live' : 'i-blank');
    icon.style.setProperty('--i', String(i));
    return icon;
  }));
  setHtml(el.revealCount, `<b class="t-live">실탄 ${e.live}</b> · <b class="t-blank">공포탄 ${e.blank}</b>`); // 숫자만 들어가는 고정 마크업 — 같은 구성이면 건너뛴다
  subtitle(`장전 — 실탄 ${e.live}발 · 공포탄 ${e.blank}발, 순서는 비밀`);
  el.reveal.classList.add('is-visible');
  await wait(REVEAL_MS);
  el.reveal.classList.remove('is-visible');
  el.gun.classList.remove('barrel-spin');
  await wait(250);
}

function markFresh(e) {
  const s = engine.getPublicState(PLAYER);
  const count = (e.player === PLAYER ? s.me : s.opponent).items.length;
  e.items.forEach((_, k) => fresh[e.player].add(count - e.items.length + k)); // 새 아이템은 인벤토리 끝에 붙는다
}

function patchShells(shell) { // 격발 순간 탄 HUD에서 1발을 바로 뺀다 (탄종변환으로 가려졌으면 총 발수만 → 탄종 역산 불가)
  const [icons, count] = !el.unknownRack.hidden ? [el.unknownIcons, el.totalCount]
    : shell === SHELL.LIVE ? [el.liveIcons, el.liveCount] : [el.blankIcons, el.blankCount];
  icons.lastElementChild?.remove();
  count.textContent = String(Math.max(0, Number(count.textContent) - 1));
}

function patchHp(tube, zone, damage) { // 라운드가 넘어가기 전, 맞은 순간의 체력 세그먼트를 바로 꺼서 보여 준다
  const lit = [...tube.querySelectorAll('.cell.is-on')];
  const left = Math.max(0, lit.length - damage);
  lit.slice(left).forEach((cell) => cell.classList.remove('is-on'));
  zone.classList.toggle('is-guillotine', left === 1); // 단두대 진입 — 진동은 이 격발의 실탄 진동 한 번으로 충분하다 (예전엔 여기서 한 번 더 울려 연달아 떨렸다)
  if (zone === el.zonePlayer && left === 1) setCrisis('danger'); // 내가 단두대가 되는 순간 바로 위기 비네팅
}

// 내가 아는 약실 탄 (비밀 팝업)
function learn(shell, kicker) {
  if (shell !== SHELL.LIVE && shell !== SHELL.BLANK) return;
  myKnown = shell;
  el.scope.classList.toggle('is-live', shell === SHELL.LIVE);
  el.scope.classList.toggle('is-blank', shell === SHELL.BLANK);
  el.scopeKicker.textContent = kicker;
  el.scopeResult.textContent = SHELL_NAME[shell];
  el.scope.classList.add('is-visible');
}

function forget() {
  myKnown = null;
  el.scope.classList.remove('is-visible');
}

function sparkFx() { // 탄종변환: 푸른 전기 스파크 + 총 감전
  restartClasses([[el.sparks, 'is-active'], [el.gun, 'shock']]);
  clearTimeout(sparkTimer);
  sparkTimer = setTimeout(() => {
    el.sparks.classList.remove('is-active');
    el.gun.classList.remove('shock');
  }, 950);
}

// ───────── 네온 헤드라인 · 타자기 자막 ─────────

function headline(text, tone = 'info', ms = 1100) {
  clearTimeout(headlineTimer);
  el.headline.textContent = text;
  el.headline.className = `headline tone-${tone}`;
  void el.headline.getBoundingClientRect(); // 같은 글자라도 다시 번쩍이게
  el.headline.classList.add('is-visible');
  headlineTimer = setTimeout(() => el.headline.classList.remove('is-visible'), ms);
  return wait(ms);
}

// 자막은 큐에 쌓아 한 줄씩 타이핑한다 (앞 줄을 읽을 시간 확보, 너무 밀리면 오래된 줄은 버림)
// filler(차례 안내)는 새 줄이 오면 버리고, 밀린 줄이 있으면 빠르게 타이핑해 방금 일어난 일을 놓치지 않게 한다
function subtitle(text, tone = 'info', { filler = false } = {}) {
  text = vsFoe(text);
  el.srLog.textContent = text; // 스크린리더용 전체 문장
  subs.queue = subs.queue.filter((line) => !line.filler);
  if (subs.current?.filler) subs.skip = true; // 치고 있던 차례 안내는 즉시 마무리
  subs.queue.push({ text, tone, filler });
  if (subs.queue.length > 3) subs.queue.splice(0, subs.queue.length - 3);
  if (!subs.running) guard(pumpSubtitles());
}

async function pumpSubtitles() {
  const gen = subs.gen; // 재시작(clearSubtitles) 뒤에는 이전 펌프가 끼어들지 않게
  subs.running = true;
  while (gen === subs.gen && subs.queue.length) {
    subs.current = subs.queue.shift();
    await typeSubtitle(subs.current);
    if (gen !== subs.gen) return;
    subs.current = null;
    const skipped = subs.skip;
    subs.skip = false;
    if (subs.queue.length && !skipped) await wait(subs.queue.length > 1 ? LINE_GAP_RUSH_MS : LINE_GAP_MS);
  }
  if (gen === subs.gen) subs.running = false;
}

function typeSubtitle({ text, tone }) {
  return new Promise((resolve) => {
    clearInterval(subs.typeTimer);
    clearTimeout(subs.hideTimer);
    const chars = [...text];
    el.subGhost.textContent = text; // 전체 폭을 미리 잡아 두고
    el.subTyped.textContent = ''; // 그 위에 한 글자씩
    el.subtitle.className = `subtitle tone-${tone} is-visible`;
    let n = 0;
    subs.typeTimer = setInterval(() => {
      n = subs.skip ? chars.length : Math.min(chars.length, n + (subs.queue.length ? TYPE_RUSH : 1));
      el.subTyped.textContent = chars.slice(0, n).join('');
      if (n < chars.length) return;
      clearInterval(subs.typeTimer);
      el.subtitle.classList.add('is-done');
      subs.hideTimer = setTimeout(() => el.subtitle.classList.remove('is-visible'), 2800);
      resolve();
    }, TYPE_MS);
  });
}

function clearSubtitles() {
  subs.gen += 1;
  subs.queue.length = 0;
  subs.current = null;
  subs.skip = false;
  clearInterval(subs.typeTimer);
  clearTimeout(subs.hideTimer);
  subs.running = false;
  el.subtitle.className = 'subtitle';
  el.subGhost.textContent = '';
  el.subTyped.textContent = '';
}

function restartClass(node, cls) { // 같은 애니메이션 클래스를 처음부터 다시 재생
  restartClasses([[node, cls]]);
}

// 여러 노드의 애니메이션을 한꺼번에 처음부터: 모두 떼고 → 강제 리플로우 한 번 → 모두 붙인다.
// 노드마다 떼고-리플로우-붙이기를 하면 격발 순간 같은 프레임에 레이아웃을 여러 번 다시 계산해 프레임이 밀리고 화면이 깜빡인다.
function restartClasses(pairs) {
  for (const [node, cls] of pairs) node.classList.remove(cls);
  if (pairs.length) void pairs[0][0].getBoundingClientRect();
  for (const [node, cls] of pairs) node.classList.add(cls);
}

// ───────── 렌더링 ─────────

function render() {
  if (!engine) return;
  const s = engine.getPublicState(PLAYER);
  const t = s.turn;
  const myTurn = Boolean(t?.isMine) && !s.winner;
  const canAct = myTurn && !busy;

  renderRounds(s.round);
  setText(el.scoreDealer, String(s.opponent.wins));
  setText(el.scorePlayer, String(s.me.wins));

  renderHp(el.dealerHp, s.opponent, '딜러');
  renderHp(el.playerHp, s.me, '내');
  el.zoneDealer.classList.toggle('is-guillotine', s.opponent.guillotine);
  el.zonePlayer.classList.toggle('is-guillotine', s.me.guillotine);
  el.zoneDealer.classList.toggle('is-stunned', t?.stunned === AI);
  el.zonePlayer.classList.toggle('is-stunned', t?.stunned === PLAYER);
  el.zoneDealer.classList.toggle('is-active', t?.player === AI && !s.winner);
  el.zonePlayer.classList.toggle('is-active', myTurn);
  setText(el.turnLabel, s.winner ? 'GAME OVER' : myTurn ? 'YOUR TURN' : online ? 'OPPONENT' : 'DEALER');
  el.turnLabel.classList.toggle('is-dealer', t?.player === AI);

  // 탄 랙: 탄종변환으로 가려졌으면 총 발수만 (탄종을 역산할 수 없게)
  const obscured = s.live === null;
  setHidden(el.liveRack, obscured);
  setHidden(el.blankRack, obscured);
  setHidden(el.unknownRack, !obscured);
  if (obscured) {
    renderShells(el.unknownIcons, s.total, 'i-unknown');
    setText(el.totalCount, String(s.total));
    setAttr(el.shells, 'aria-label', `남은 탄 ${s.total}발 — 탄종변환으로 탄종이 가려짐`);
  } else {
    renderShells(el.liveIcons, s.live, 'i-live');
    renderShells(el.blankIcons, s.blank, 'i-blank');
    setText(el.liveCount, String(s.live));
    setText(el.blankCount, String(s.blank));
    setAttr(el.shells, 'aria-label', `남은 탄: 실탄 ${s.live}발, 공포탄 ${s.blank}발`);
  }

  renderDealerItems(s.opponent.items);
  renderPlayerItems(s, canAct);

  el.gun.classList.toggle('is-doubled', Boolean(t?.doubleActive));
  setDisabled(el.btnOpponent, !canAct);
  setDisabled(el.btnSelf, !canAct);
  syncMood(s);
}

function renderRounds(round) {
  el.pips.forEach((li, i) => {
    const result = roundResults[i];
    const current = i + 1 === round && !result;
    li.classList.toggle('is-current', current);
    li.classList.toggle('is-won', result === 'won');
    li.classList.toggle('is-lost', result === 'lost');
    if (current) setAttr(li, 'aria-current', 'step');
    else if (li.hasAttribute('aria-current')) li.removeAttribute('aria-current');
    setAttr(li, 'aria-label', `라운드 ${i + 1}${result === 'won' ? ' 승리' : result === 'lost' ? ' 패배' : ''}`);
  });
}

function renderHp(tube, side, label) {
  let cells = tube.querySelectorAll('.cell');
  if (cells.length !== side.maxHp || !tube.querySelector('.tube-glass')) {
    const glass = document.createElement('i');
    glass.className = 'tube-glass';
    tube.replaceChildren(...Array.from({ length: side.maxHp }, () => {
      const cell = document.createElement('span');
      cell.className = 'cell';
      return cell;
    }), glass);
    cells = tube.querySelectorAll('.cell');
  }
  cells.forEach((cell, i) => cell.classList.toggle('is-on', i < side.hp)); // toggle(force) 는 상태가 같으면 아무것도 바꾸지 않는다
  setAttr(tube, 'aria-label', `${label} 체력 ${side.hp}/${side.maxHp}`);
}

function renderShells(container, count, iconId) {
  if (container.childElementCount === count) return;
  container.replaceChildren(...Array.from({ length: count }, () => svgUse('shell', iconId)));
}

// 방금 지급된 슬롯의 등장 연출(.is-new → card-pop). 연출이 끝나면 클래스를 떼어, 슬롯을 다시 쓰더라도 연출이 또 돌지 않게 한다
function markNew(node) {
  node.classList.add('is-new');
  node.addEventListener('animationend', function done(ev) {
    if (ev.target !== node) return; // 안쪽 요소에서 올라온 이벤트는 무시
    node.classList.remove('is-new');
    node.removeEventListener('animationend', done);
  });
}

// 딜러(상대) 아이템 6칸: 아이템 구성이 바뀔 때만 다시 만든다 (render 는 연출마다 여러 번 불린다)
function renderDealerItems(items) {
  const key = items.join('|');
  if (slotKeys[AI] !== key) {
    slotKeys[AI] = key;
    el.dealerItems.replaceChildren(...Array.from({ length: 6 }, (_, i) => {
      const li = document.createElement('li');
      const item = items[i];
      li.className = item ? 'dslot' : 'dslot is-empty';
      if (item) {
        const info = ITEM_INFO[item];
        const name = document.createElement('span');
        name.textContent = info.name;
        li.dataset.item = item;
        li.title = `${info.name} · ${info.tag} — ${info.desc}`;
        li.append(svgUse('', info.icon), name);
        if (fresh[AI].has(i)) markNew(li);
      }
      return li;
    }));
  }
  fresh[AI].clear();
}

// 내 아이템 6칸: 아이템 구성이 바뀔 때만 버튼을 새로 만들고, 사용 가능 여부 · 설명만 바뀌면 그 자리에서 속성만 고친다.
// (예전에는 render 마다 12칸 + SVG 아이콘을 통째로 다시 만들어 모바일에서 아이템 줄이 깜빡였고, 방금 지급된 카드의 등장 연출이
//  같은 프레임의 다음 render 에 지워졌으며, 키보드 포커스도 풀렸다)
function renderPlayerItems(s, canAct) {
  const items = s.me.items;
  const key = items.join('|');
  if (slotKeys[PLAYER] !== key) {
    slotKeys[PLAYER] = key;
    el.playerItems.replaceChildren(...Array.from({ length: 6 }, (_, i) => buildPlayerSlot(items[i], i)));
  }
  for (const btn of el.playerItems.querySelectorAll('button.card')) {
    const item = btn.dataset.item;
    const info = ITEM_INFO[item];
    const reason = canAct ? blockReason(item, s) : null;
    setDisabled(btn, !canAct || reason !== null);
    const label = `${info.name} · ${info.tag} — ${reason ?? info.desc}`;
    if (btn.title !== label) {
      btn.title = label;
      btn.setAttribute('aria-label', label);
    }
  }
  fresh[PLAYER].clear();
}

// 내 아이템 한 칸 (사용 가능 여부 · 설명은 renderPlayerItems 가 바로 채운다 — 처음에는 잠가 둔다)
function buildPlayerSlot(item, i) {
  const li = document.createElement('li');
  if (!item) {
    const empty = document.createElement('span');
    empty.className = 'card is-empty';
    li.append(empty);
    return li;
  }
  const info = ITEM_INFO[item];
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'card';
  if (fresh[PLAYER].has(i)) markNew(btn);
  btn.dataset.index = String(i);
  btn.dataset.item = item;
  btn.disabled = true;

  const icon = document.createElement('span');
  icon.className = 'card-icon';
  icon.append(svgUse('', info.icon));
  const text = document.createElement('span');
  text.className = 'card-text';
  const name = document.createElement('span');
  name.className = 'card-name';
  name.textContent = info.name;
  const tag = document.createElement('span');
  tag.className = 'card-tag';
  tag.textContent = info.tag;
  text.append(name, tag);
  btn.append(icon, text);
  li.append(btn);
  return li;
}

// 엔진의 사용 불가 조건과 같은 규칙 (DOUBLE의 섬광탄 충돌만 공개 정보 한계로 조금 더 엄격) → 쓸 수 없으면 사유 문자열
function blockReason(item, s) {
  const { me, turn } = s;
  switch (item) {
    case ITEM.SCOPE:
      return turn.scopeUsed ? '이번 턴에 이미 사용했다' : turn.doubleUsed ? '더블샷과 같은 턴에는 쓸 수 없다 (확정 2데미지 방지)' : null;
    case ITEM.DOUBLE:
      return turn.doubleActive ? '이미 더블샷이 걸려 있다'
        : turn.stunned !== null ? '섬광탄과 같은 턴에는 쓸 수 없다'
          : turn.scopeUsed ? '투시경과 같은 턴에는 쓸 수 없다 (확정 2데미지 방지)' : null;
    case ITEM.FLASH: return turn.doubleUsed ? '더블샷과 같은 턴에는 쓸 수 없다' : turn.flashLocked ? '섬광탄 효과가 아직 남아 있다' : null;
    case ITEM.DRINK: return me.hp >= me.maxHp ? '체력이 가득 찼다' : null; // 단두대에서도 가능
    case ITEM.PICKPOCKET: return stealable(s).length ? null : '훔쳐서 바로 쓸 수 있는 아이템이 없다';
    default: return null; // EJECT · CONVERT는 언제나 가능
  }
}

const stealable = (s) => s.opponent.items.filter((it) => it !== ITEM.PICKPOCKET && blockReason(it, s) === null);

function svgUse(className, iconId) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  if (className) svg.setAttribute('class', className);
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS(SVG_NS, 'use');
  use.setAttribute('href', `#${iconId}`);
  svg.append(use);
  return svg;
}

// ───────── 20초 턴 타이머 ─────────

const turnLimit = () => (online ? TURN_MS : guidedGame ? GUIDED_TURN_MS : TURN_MS); // 첫 AI 판만 넉넉하게 (온라인은 서버가 정한 20초)

function resetTimer() {
  timer.remaining = online ? pvpRemainingMs(TURN_MS) : turnLimit(); // PvP: 서버가 알려 준 deadline 기준
  timer.shown = -1;
  drawTimer();
}

function startTimer(token) {
  stopTimer();
  timer.last = performance.now();
  drawTimer();
  timer.handle = setInterval(() => tickTimer(token), 100);
}

function stopTimer() {
  clearInterval(timer.handle);
  timer.handle = 0;
}

function tickTimer(token) {
  const now = performance.now();
  const dt = Math.min(now - timer.last, 250); // 한 번에 250ms 넘게 깎지 않음 (탭 숨김·브라우저 정체 뒤 갑작스런 시간 초과 방지)
  timer.last = now;
  if (token !== gameId || !engine) {
    stopTimer();
    return;
  }
  if (busy || isPaused()) return; // 연출 중·도감 보는 중·탭 숨김 중에는 멈춤
  const ticked = Math.max(0, timer.remaining - dt);
  timer.remaining = online ? pvpRemainingMs(ticked) : ticked; // PvP: 연출로 멈춘 시간도 서버는 기다려 주지 않으므로 deadline 에서 바로 구한다
  drawTimer();
  if (timer.remaining > 0) return;
  stopTimer();
  subtitle('시간 초과 — 방아쇠가 저절로 당겨진다', 'danger');
  if (online) return; // PvP: 서버가 대신 방아쇠를 당기고, 그 결과가 state_update 로 온다 (여기서 또 쏘면 이중 격발)
  guard(handleShoot(Math.random() < 0.5 ? 'self' : 'opponent'));
}

function drawTimer() {
  const sec = Math.ceil(timer.remaining / 1000);
  if (sec === timer.shown) return;
  timer.shown = sec;
  // 게이지는 1초 linear 트랜지션이라 '다음 초' 값을 넣어야 실제 시간과 맞는다
  el.timer.style.setProperty('--p', String(Math.max(0, sec - 1) / (turnLimit() / 1000)));
  el.timer.classList.toggle('is-urgent', sec <= URGENT_MS / 1000);
  setAttr(el.timer, 'aria-valuenow', String(sec));
  setText(el.timerText, String(sec));
}

function idleTimer() { // 딜러 턴·대기 중: 꽉 찬 게이지, 숫자 없음 (연출마다 여러 번 불리므로 같은 값은 다시 쓰지 않는다)
  timer.shown = -1;
  el.timer.style.setProperty('--p', '1'); // 인라인 스타일은 값이 같으면 엔진이 무시한다
  el.timer.classList.remove('is-urgent');
  setAttr(el.timer, 'aria-valuenow', String(TURN_MS / 1000));
  setText(el.timerText, '—');
}

// ───────── 게임 룰 & 아이템 도감 ─────────

function openRules(tab) {
  setSoundPanel(false);
  if (tab) selectTab(tab);
  if (!el.rules.open) el.rules.showModal();
}

function closeRules() {
  if (el.rules.open) el.rules.close();
}

function selectTab(which, tabs = el.tabs) { // 도감 'rules' | 'items' · 상점 'guns' | 'tables' | 'chest' | 'taunts' · 프로필 'record' | 'board'
  tabs.forEach((tab) => {
    const on = tab.id === `tab-${which}`;
    tab.setAttribute('aria-selected', String(on));
    tab.tabIndex = on ? 0 : -1;
    $(tab.getAttribute('aria-controls')).hidden = !on;
  });
}

function wireTabs(tabs, onSelect) { // 클릭 · ←/→ 로 탭 전환 (도감 · 상점 · 프로필이 같은 방식). onSelect(which) 는 전환 직후 호출
  tabs.forEach((tab) => {
    tab.addEventListener('click', () => {
      const which = tab.id.replace('tab-', '');
      selectTab(which, tabs);
      onSelect?.(which);
    });
    tab.addEventListener('keydown', (ev) => {
      if (ev.key !== 'ArrowLeft' && ev.key !== 'ArrowRight') return;
      const step = ev.key === 'ArrowLeft' ? -1 : 1; // 탭이 둘일 때는 같지만 상점은 4개 — 왼쪽 화살표는 이전 탭
      const next = tabs[(tabs.indexOf(tab) + step + tabs.length) % tabs.length];
      const which = next.id.replace('tab-', '');
      selectTab(which, tabs);
      next.focus();
      onSelect?.(which);
    });
  });
}

// ───────── 이벤트 연결 ─────────

el.btnStart.addEventListener('click', () => startGame()); // AI 딜러 대전 (PvP 는 로비(multiplayer.js)가 이 클릭을 가로채고, 매칭이 성사되면 pvpSession.js 가 startGame(true) 를 부른다)
initPvp({
  profile,
  onStart: () => startGame(true),
  onUpdate: onPvpUpdate,
  onNotice: (text, tone) => subtitle(text, tone),
  onAbort: (text) => { el.titleSub.textContent = text; }, // 참가비를 내지 못해 시작하지 못함 → 타이틀 화면에 이유를 보여 준다
});
syncSoundUi(); // 저장된 소리 설정을 화면에 반영
// 다른 모듈이 프로필을 바꿨다 (로비가 서버 랭킹 기록으로 맞춤 · 결제 지급 — monetization.js PROFILE_CHANGED 와 같은 이름) → 미니 카드 · 지갑 · 열린 프로필을 다시 그린다
document.addEventListener('lastchamber:profile-changed', () => {
  profile.reload();
  syncWallet();
  syncPlayerCard();
  if (el.profile.open) renderRecord();
});
document.addEventListener('visibilitychange', onVisibilityChange);
// 앱 생명주기 — 화면을 떠나면(백그라운드 전환 · 화면 꺼짐 · 다른 앱/창) 소리를 즉시 멈추고, 보이고 포커스가 돌아오면 이어서.
// 페이지를 떠나면(창 닫기 · 뒤로 가기 · 새로고침) 오디오 컨텍스트 · 배경음 타이머 · PvP 소켓 리스너를 정리한다 (로비 소켓은 multiplayer.js 가 같은 시점에 정리)
let pvpLeftBehind = false; // 페이지 이탈로 진행 중이던 PvP 연결을 끊었다 → bfcache 로 돌아오면 새로 불러와 깨끗한 화면에서 다시 시작
watchLifecycle({
  onAway: () => guardUi(sound.suspend()),
  onBack: () => guardUi(sound.resume()),
  // blur · freeze (화면 잠금 · 탭 내림 · 앱 전환): 곧바로 오디오 컨텍스트를 닫고 소켓을 끊는다 — 소리가 새지 않고, 얼어붙기 전에 연결을 정리한다.
  // PvP 판은 세션을 유지한 채 끊고(pvpPause), 돌아오면 15초 유예 안에 같은 자리로 다시 붙는다(pvpResume). 로비는 매칭 · 기다리는 방을 접는다 (multiplayer.js 가 이 이벤트를 듣는다)
  onHalt: ({ reason }) => {
    guardUi(sound.close());
    pvpPause();
    window.dispatchEvent(new CustomEvent('lastchamber:halt', { detail: { reason } }));
  },
  onRestore: () => pvpResume(),
  onLeave: () => {
    guardUi(sound.close());
    if (online) pvpLeftBehind = true;
    pvpEnd();
  },
  onReturn: () => {
    if (pvpLeftBehind) window.location.reload();
  },
});
// 닫았다 다시 만든 컨텍스트 · iOS 처럼 제스처가 있어야 켜지는 경우: 화면 안에서의 다음 터치가 소리를 되살린다
document.addEventListener('pointerdown', () => {
  if (sound.needsUnlock) guardUi(sound.unlock());
}, { capture: true, passive: true });
el.btnSound.addEventListener('click', () => setSoundPanel(el.soundPanel.hidden));
el.btnMute.addEventListener('click', () => setMuted(!soundPrefs.muted));
el.sfxRange.addEventListener('input', () => onVolumeInput('sfx'));
el.sfxRange.addEventListener('change', () => sound.playClick()); // 슬라이더를 놓으면 찰칵 소리로 음량 확인
el.ambRange.addEventListener('input', () => onVolumeInput('ambient'));
document.addEventListener('pointerdown', (ev) => { // 소리 설정 패널 바깥을 누르면 닫는다
  if (el.soundPanel.hidden || el.soundPanel.contains(ev.target) || el.btnSound.contains(ev.target)) return;
  setSoundPanel(false);
});
el.btnHowto.addEventListener('click', () => openRules('rules'));
el.btnHelp.addEventListener('click', () => openRules());
el.btnRulesClose.addEventListener('click', closeRules);
el.rules.addEventListener('click', (ev) => { if (ev.target === el.rules) closeRules(); }); // 바깥 어두운 곳 클릭
el.title.addEventListener('cancel', (ev) => ev.preventDefault()); // Esc로 결과 화면만 닫혀 멈추는 것 방지
wireTabs(el.tabs);
wireTabs(el.storeTabs);
wireTabs(el.profileTabs, (which) => { if (which === 'board') renderBoard(); }); // 순위표 탭을 열 때마다 실시간 순위를 다시 계산

// 프로필 · 티어 · 순위표 (좌상단 미니 카드 → 프로필 & 랭킹 모달) + 로그인한 닉네임 (session.js 구독 — 로그인 · 닉네임 변경 · 로그아웃마다 바로 반영)
syncFromSession();
userSession.subscribe(syncFromSession);
el.playerCard.addEventListener('click', () => openProfile());
el.btnProfileClose.addEventListener('click', closeProfile);
el.profile.addEventListener('click', (ev) => { if (ev.target === el.profile) closeProfile(); }); // 바깥 어두운 곳
el.nickForm.addEventListener('submit', onNickSubmit);
attachNicknameFilter(el.nickInput, () => nickMessage('')); // 공백은 입력하는 즉시 지우고, 다시 입력하면 이전 안내는 지운다
el.pfTitleList.addEventListener('click', onTitleClick);

// 상점 · 보상 · 탄피 (장착 중인 스킨과 보유 탄피를 화면에 반영하고 시작)
applyLoadout(profile.activeLoadout());
syncWallet();
syncTitleExtras();
el.btnArmory.addEventListener('click', openStore);
el.btnStoreClose.addEventListener('click', closeStore);
el.store.addEventListener('click', (ev) => {
  if (ev.target === el.store) { // 바깥 어두운 곳
    closeStore();
    return;
  }
  const btn = ev.target.closest('button[data-act]');
  const card = btn?.closest('.skin-card');
  if (!btn || btn.disabled || !card || adBusy || chestBusy) return; // 상자가 도는 동안엔 탄피 표시가 흔들리지 않게 다른 구매도 잠깐 막는다
  const run = { taunt: onTauntAction, flame: onFlameAction }[card.dataset.kind] ?? onStoreAction; // 도발 · 총구 화염 카드 / 총기 · 테이블 스킨 카드
  card.classList.add('is-busy');
  guardUi(run(btn.dataset.act, card.dataset.kind, card.dataset.id).finally(() => card.classList.remove('is-busy')));
});
el.btnChest.addEventListener('click', () => guardUi(onChestOpen()));
el.chestResult.addEventListener('click', (ev) => { // 방금 나온 화염을 결과 카드에서 바로 장착
  const btn = ev.target.closest('button[data-flame]');
  if (!btn || btn.disabled || adBusy || chestBusy) return;
  btn.disabled = true;
  btn.textContent = '장착 중';
  guardUi(onFlameAction('equip', 'flame', btn.dataset.flame));
});
el.store.addEventListener('close', () => { el.storeToast.hidden = true; });
el.btnDouble.addEventListener('click', () => guardUi(onDouble()));
el.btnProtect.addEventListener('click', () => guardUi(onProtect()));

// 암시장 · 도발: 확률표를 그리고, 장착한 도발이 있으면 (판이 시작될 때) 인게임 버튼을 보인다
renderOdds();
syncTauntButton();
el.btnTaunt.addEventListener('click', onTauntClick);
document.addEventListener(TAUNT_IN, (ev) => { // Step B: 상대가 보낸 도발 — 알려진 도발 id 만 같은 연출로 재생 (너무 촘촘한 도착은 무시)
  const event = validateTauntEvent(ev.detail);
  const now = performance.now();
  if (!event || !online || !onGameScreen() || isPaused() || engine.getPublicState(PLAYER).winner || now - lastTauntInAt < TAUNT_IN_MIN_GAP_MS) return; // PvP 판 화면에서만
  lastTauntInAt = now;
  playTaunt(event, { from: 'opponent' });
});

el.btnLeave.addEventListener('click', openLeave);
el.ruleCard?.addEventListener('click', hideRuleCard); // 3줄 룰 카드는 탭하면 닫힌다
el.leave.addEventListener('click', (ev) => {
  if (ev.target === el.leave) { closeLeave(); return; } // 바깥 어두운 곳 = 취소
  const act = ev.target.closest('button[data-leave]')?.dataset.leave;
  if (act === 'cancel') closeLeave();
  else if (act === 'confirm') guardUi(confirmLeave());
});
el.btnOpponent.addEventListener('click', () => guard(handleShoot('opponent')));
el.btnSelf.addEventListener('click', () => guard(handleShoot('self')));
el.playerItems.addEventListener('click', (ev) => {
  const btn = ev.target.closest('button.card');
  if (btn && !btn.disabled) guard(handleItem(Number(btn.dataset.index)));
});

// 글자를 입력하는 칸(닉네임)에서는 단축키(M · ? · 방향키 · 숫자)를 쓰지 않는다 — 슬라이더(range)는 해당 없음
const isTextField = (node) => node instanceof HTMLTextAreaElement || (node instanceof HTMLInputElement && ['text', 'search', 'email', 'url', 'tel', 'password', 'number'].includes(node.type));

document.addEventListener('keydown', (ev) => {
  if (ev.repeat || ev.altKey || ev.ctrlKey || ev.metaKey) return;
  if (isTextField(ev.target)) return;
  if (el.login?.open || el.account?.open) return; // 로그인 화면 · 계정 창 위로 도감 · 음소거 단축키가 끼어들지 않게
  if (ev.key === '?') {
    ev.preventDefault();
    if (adBusy) return; // 광고·결제 화면 위로 도감이 뜨지 않게
    if (el.rules.open) closeRules();
    else openRules();
    return;
  }
  if (ev.key === 'm' || ev.key === 'M') {
    ev.preventDefault();
    setMuted(!soundPrefs.muted, true);
    return;
  }
  if (ev.key === 'Escape' && !el.soundPanel.hidden) {
    setSoundPanel(false);
    el.btnSound.focus();
    return;
  }
  if (el.title.open || el.rules.open || el.store.open || el.profile.open || el.leave.open) return;
  if (ev.target instanceof HTMLInputElement) return; // 슬라이더를 방향키·숫자로 조작할 때 격발·아이템이 나가지 않게
  if (ev.key === 'ArrowUp' || ev.key === 'ArrowDown') {
    ev.preventDefault();
    guard(handleShoot(ev.key === 'ArrowUp' ? 'opponent' : 'self'));
  } else if (/^[1-6]$/.test(ev.key)) {
    const btn = el.playerItems.querySelector(`button.card[data-index="${Number(ev.key) - 1}"]`);
    if (btn && !btn.disabled) guard(handleItem(Number(ev.key) - 1));
  }
});
