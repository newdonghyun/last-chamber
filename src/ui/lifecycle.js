/**
 * LAST CHAMBER - 앱 생명주기 감시 (모바일 브라우저 · PWA · 앱 WebView 공통)
 *
 *   watchLifecycle({
 *     onAway:   () => sound.suspend(),   // 화면을 떠남: 백그라운드 전환 · 화면 꺼짐 · 다른 앱/창으로 포커스 이동 · 페이지 숨김
 *     onBack:   () => sound.resume(),    // 다시 화면으로: 보이고(visible) · 포커스가 있고 · 페이지가 살아 있을 때만
 *     onHalt:   ({ reason }) => …,       // blur · freeze 가 오는 즉시 (한 번): 오디오 컨텍스트 close · 소켓 disconnect — 화면 잠금 · 탭 내림 · 앱 전환에서 새는 소리 · 연결을 막는다
 *     onRestore: () => …,                // onHalt 로 끊었던 것을 다시 잇는다 (화면으로 돌아왔을 때, onBack 다음에)
 *     onLeave:  ({ reason, persisted }) => …, // 페이지 이탈(창 닫기 · 뒤로 가기 · 새로고침): 오디오 · 타이머 · 소켓을 모두 정리
 *     onReturn: ({ persisted }) => …,   // 이탈했던 페이지가 되살아남 (bfcache 복귀 · 취소된 beforeunload 뒤 다시 조작)
 *   });
 *
 * - away/back 은 상태가 바뀔 때만 한 번씩 부른다 (blur → visibilitychange 가 연달아 와도 onAway 는 한 번).
 * - 처음 등록할 때 현재 상태로 한 번 부른다 (백그라운드 탭에서 열렸으면 onAway 부터).
 * - leave 는 pagehide · beforeunload 중 먼저 온 쪽에서 한 번만. beforeunload 뒤 이동이 취소되어 페이지가 계속 쓰이면
 *   (다음 터치 · 키 입력) 되살리고, bfcache 에서 돌아오면(pageshow.persisted) 역시 되살린다.
 * - window 의 blur/focus 만 본다 (입력칸 같은 요소의 blur 는 무시).
 * - freeze (Page Lifecycle — 모바일 Chrome 이 화면 잠금 · 탭 내림 때 페이지를 얼린다): 얼린 뒤에는 코드가 돌지 않으므로 이벤트 안에서 곧바로 onAway → onHalt.
 *   document 의 resume 이 오면 풀린다. blur · freeze 가 겹쳐 와도 onHalt 는 한 번 — 화면으로 돌아와 onRestore 를 부른 뒤에야 다시 걸린다.
 * - 단순 숨김(visibilitychange hidden)만 오면 onAway(즉시 무음 · 컨텍스트 정지)까지만 — 닫지는 않는다.
 */

/**
 * @param {{ onAway?: () => void, onBack?: () => void, onLeave?: (info: { reason: string, persisted: boolean }) => void, onReturn?: (info: { persisted: boolean }) => void }} hooks
 * @param {{ win?: Window, doc?: Document }} [env] 테스트용 window · document
 * @returns {() => void} 감시 해제
 */
export function watchLifecycle(hooks, { win = globalThis.window, doc = globalThis.document } = {}) {
  let blurred = false; // window 가 포커스를 잃음 (다른 앱 · 앱 전환 화면 · 다른 창)
  let gone = false; // pagehide · beforeunload 이후 (페이지 이탈 중)
  let away = null; // 마지막으로 알린 상태 (null = 아직 안 알림)
  let revive = null; // beforeunload 뒤 이동이 취소됐을 때 되살리는 1회용 리스너
  let frozen = false; // Page Lifecycle freeze 이후 (resume 이 올 때까지)
  let halted = false; // blur · freeze 로 오디오 · 소켓을 끊은 상태 (한 번만 끊고, 돌아오면 onRestore)

  const call = (fn, arg) => {
    try {
      fn?.(arg);
    } catch (err) {
      console.error('[lifecycle]', err); // 한 훅의 오류가 다른 정리를 막지 않게
    }
  };
  const sync = () => {
    const now = doc.visibilityState === 'hidden' || doc.hidden === true || blurred || gone || frozen;
    if (now === away) return;
    away = now;
    call(now ? hooks.onAway : hooks.onBack);
    if (!now && halted) { // 끊었던 오디오 · 소켓을 다시 잇는다 (onBack 이 먼저 — 소리 컨텍스트부터)
      halted = false;
      call(hooks.onRestore);
    }
  };
  const halt = (reason) => { // 즉시 한 번: 이미 끊었으면(blur 뒤 freeze 등) 다시 부르지 않는다
    if (halted) return;
    halted = true;
    call(hooks.onHalt, { reason });
  };
  const CAPTURE = { capture: true }; // 객체 형식으로 — 불리언 true 는 일부 구현(Node EventTarget)에서 제거가 짝이 맞지 않는다
  const disarmRevive = () => {
    if (!revive) return;
    for (const type of ['pointerdown', 'keydown']) win.removeEventListener(type, revive, CAPTURE);
    revive = null;
  };
  const comeBack = (persisted) => {
    disarmRevive();
    if (!gone) return;
    gone = false;
    blurred = false;
    frozen = false;
    sync();
    call(hooks.onReturn, { persisted });
  };
  const leave = (reason, persisted) => {
    if (gone) return;
    gone = true;
    sync(); // onAway 먼저 (즉시 무음) → 그다음 완전 정리
    call(hooks.onLeave, { reason, persisted });
    if (reason === 'beforeunload') { // 이동이 취소돼 페이지가 계속 쓰이면 다음 조작에서 되살린다
      revive = () => comeBack(false);
      for (const type of ['pointerdown', 'keydown']) win.addEventListener(type, revive, CAPTURE);
    }
  };

  const listeners = [
    [doc, 'visibilitychange', () => sync()],
    [win, 'blur', (e) => { if (e.target === win) { blurred = true; sync(); halt('blur'); } }], // 무음(sync) 먼저, 그다음 완전히 끊기
    [win, 'focus', (e) => { if (e.target === win) { blurred = false; sync(); } }],
    [doc, 'freeze', () => { frozen = true; sync(); halt('freeze'); }],
    [doc, 'resume', () => { frozen = false; sync(); }],
    [win, 'pagehide', (e) => { disarmRevive(); leave('pagehide', Boolean(e.persisted)); }],
    [win, 'beforeunload', () => leave('beforeunload', false)],
    [win, 'pageshow', (e) => { if (e.persisted) comeBack(true); }],
  ];
  for (const [target, type, fn] of listeners) target.addEventListener(type, fn);
  sync();

  return () => {
    disarmRevive();
    for (const [target, type, fn] of listeners) target.removeEventListener(type, fn);
  };
}
