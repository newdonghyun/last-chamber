/**
 * LAST CHAMBER - 잠든 서버 깨우기 재시도 (DOM 비의존)
 *
 *   무료 호스팅(Render)은 한동안 접속이 없으면 서버를 재우고, 첫 요청이 오면 깨우는 데 30~60초가 걸린다.
 *   그동안 연결 시도는 시간이 초과되거나 즉시 거절될 수 있다 → 에러로 접지 않고, 서버가 올라올 때까지 정해진 시간 안에서 다시 시도한다.
 *
 *   const socket = await retryUntil((n) => openSocketOnce(), {
 *     deadlineMs: 100_000,   // 이 시간이 지나면 마지막 오류로 포기
 *     gapMs: 2_000,          // 실패한 뒤 다음 시도까지
 *     slowMs: 4_000,         // 이만큼 지나도 성공하지 못하면 onSlow() 를 한 번 부른다 ("서버를 깨우는 중입니다…")
 *     onSlow: () => say('서버를 깨우는 중입니다…'),
 *     shouldStop: () => 화면이 닫혔는가,
 *   });
 *
 *   · attempt 가 'CANCELLED' 오류를 던지거나 shouldStop() 이 true 면 더 시도하지 않고 바로 그 오류를 던진다.
 *   · onSlow 는 첫 시도가 아직 끝나지 않았을 때도 (slowMs 가 지나면) 부른다 — 시도 하나가 30초씩 걸리는 경우에도 안내가 바로 뜬다.
 */

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function retryUntil(attempt, {
  deadlineMs = 100_000,
  gapMs = 2_000,
  slowMs = 4_000,
  onSlow = null,
  shouldStop = () => false,
  sleep = wait,
  now = () => Date.now(),
} = {}) {
  const startedAt = now();
  let slow = false;
  const timer = onSlow ? setTimeout(() => { if (slow) return; slow = true; onSlow(); }, slowMs) : 0;
  try {
    for (let n = 0; ; n += 1) {
      try {
        return await attempt(n);
      } catch (err) {
        if (err?.message === 'CANCELLED' || shouldStop()) throw err;
        if (now() - startedAt + gapMs >= deadlineMs) throw err; // 다음 시도를 해도 마감 안에 끝나지 않는다
        if (onSlow && !slow && now() - startedAt >= slowMs) { // 시도가 빨리 실패하는 경우(즉시 거절)에도 안내
          slow = true;
          onSlow();
        }
        await sleep(gapMs);
        if (shouldStop()) throw err;
      }
    }
  } finally {
    clearTimeout(timer);
  }
}
