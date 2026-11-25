/**
 * LAST CHAMBER - 느와르 닉네임 생성기 (가입할 때 닉네임을 비워 두면 서버가 붙여 준다)
 *
 *   noirNickname()                → '붉은총잡이' 처럼 형용사 + 명사 (2~10자 규칙 안: 각 말은 3자 이하 · 숫자는 2자리)
 *   noirNickname(rng, { number }) → '붉은총잡이42' — 같은 이름이 이미 있을 때 숫자를 붙여 구분한다
 *
 *   server/userStore.js 의 signup 이 이미 쓰인 이름이면 다시 뽑는다 (중복 검사는 거기서 — 이 파일은 DB 를 모른다).
 *   모든 조합은 cleanNickname 규칙(한글 · 공백 없음 · 2~10자)을 통과한다 — tests/server.test.mjs 가 전부 확인한다.
 */

export const NOIR_ADJECTIVES = Object.freeze([
  '검은', '붉은', '은빛', '새벽', '안개', '낡은', '고요한', '마지막', '비밀', '한밤', '잿빛', '외로운', '차가운', '뒷골목', '지하', '밀주', '느린', '조용한', '떠도는', '푸른',
]);
export const NOIR_NOUNS = Object.freeze([
  '총잡이', '딜러', '탄피', '그림자', '까마귀', '늑대', '약실', '방아쇠', '도박꾼', '재즈', '시가', '트렌치', '룰렛', '카드', '바텐더', '탐정', '사냥꾼', '여우', '밀수꾼', '악사',
]);

const pick = (list, rng) => list[Math.floor(rng() * list.length)];

/** @param {() => number} [rng] [0, 1) 난수 (테스트에서 고정) @param {{ number?: boolean }} [options] number: 끝에 두 자리 숫자를 붙인다 */
export function noirNickname(rng = Math.random, { number = false } = {}) {
  const base = `${pick(NOIR_ADJECTIVES, rng)}${pick(NOIR_NOUNS, rng)}`;
  return number ? `${base}${10 + Math.floor(rng() * 90)}` : base;
}
