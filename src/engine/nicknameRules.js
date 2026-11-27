/**
 * ODD ROULETTE - 새로 정하는 닉네임의 규칙 (회원가입 · 닉네임 변경) — 서버(server/index.js)와 화면(src/ui)이 같은 파일을 쓴다. DOM 없음.
 *
 *   checkNewNickname(raw) → { ok: true, nickname } | { ok: false, reason: 'empty' | 'format' | 'banned' }
 *     · 한글(완성형 가~힣) · 영문 · 숫자만 2~10자 (공백 · 특수문자 · 낱자모 · 이모지 불가. 앞뒤 공백은 떼고 본다)
 *     · 욕설 · 비속어 · 운영자 사칭은 'banned'
 *   nicknameKey(name) → 중복 비교용 값 (대소문자 구분 없음) — DB 는 lower(nickname) unique 인덱스 (server/userStore.js ACCOUNT_SQL)
 *
 *   ⚠ 이미 만들어진 계정의 닉네임에는 이 규칙을 적용하지 않는다 (예전 규칙으로 만든 '_ . - ·' 이름도 그대로 로그인 · 표시된다).
 */

export const NEW_NICK_RULE = Object.freeze({ min: 2, max: 10 });
export const NEW_NICK_HINT = '한글 · 영문 · 숫자 2~10자 (공백 · 특수문자 · 비속어 불가)';
export const NEW_NICK_TEXT = Object.freeze({
  empty: '닉네임을 입력해 주세요.',
  format: '2~10자의 한글, 영문, 숫자만 사용할 수 있습니다.',
  banned: '사용할 수 없는 단어가 들어 있어요. 다른 닉네임을 입력해 주세요.',
  available: '사용 가능한 닉네임입니다.',
  taken: '이미 사용 중인 닉네임입니다.',
  takenOnSubmit: '이미 사용 중인 닉네임입니다. 다른 닉네임을 입력해 주세요.',
});

const FORMAT = new RegExp(`^[가-힣A-Za-z0-9]{${NEW_NICK_RULE.min},${NEW_NICK_RULE.max}}$`);

// 한글 욕설 · 비속어: 숫자 · 영문을 뺀 한글만 이어 붙여 찾는다 ('시1발' 도 걸린다)
const KO_BANNED = [
  '시발', '씨발', '시빨', '씨빨', '씨팔', '쒸발', '씨바', '시바놈', '시바년', '개새', '새끼', '쌍놈', '쌍년', '병신', '븅신', '등신', '지랄', '좆', '좇', '씹',
  '존나', '니미럴', '느금', '니애미', '니에미', '애미', '창녀', '창년', '걸레년', '개년', '미친놈', '미친년', '후레자식', '호로자식', '또라이', '닥쳐', '꺼져',
  '섹스', '야동', '강간', '보지', '자지', '틀딱', '맘충', '한남충', '김치녀', '일베',
];
// 영문(발음 표기 포함): 어디에 들어 있어도 막는 말 — 숫자 치환(f1ck 류)은 아래 LEET 로 되돌려 본다
const EN_BANNED = [
  'fuck', 'fuk', 'shit', 'bitch', 'cunt', 'asshole', 'bastard', 'slut', 'whore', 'nigger', 'nigga', 'faggot', 'pussy', 'penis', 'vagina', 'porn',
  'sibal', 'ssibal', 'shibal', 'byungsin', 'byeongsin', 'jiral', 'gaesaekki',
];
// 다른 단어 속에 흔히 들어가는 말(grape · peacock · class …)은 이름 전체가 그 말일 때만
const EN_EXACT = ['ass', 'sex', 'cum', 'tit', 'dick', 'cock', 'fag', 'rape', 'anal'];
// 운영자 사칭
const KO_RESERVED = ['운영자', '운영진', '관리자'];
const EN_RESERVED_PREFIX = ['admin', 'moderator'];
const EN_RESERVED_EXACT = ['gm', 'system', 'official'];
const LEET = Object.freeze({ 0: 'o', 1: 'i', 3: 'e', 4: 'a', 5: 's', 7: 't' });

function isBanned(name) {
  const lower = name.toLowerCase();
  const korean = lower.replace(/[^가-힣]/g, '');
  if (KO_BANNED.some((w) => korean.includes(w)) || KO_RESERVED.some((w) => korean.includes(w))) return true;
  const plain = lower.replace(/\d/g, ''); // 숫자를 끼워 넣은 것
  const leet = lower.replace(/[013457]/g, (d) => LEET[d]); // 숫자로 바꿔 쓴 것
  const english = [plain, leet];
  if (english.some((s) => EN_BANNED.some((w) => s.includes(w)) || EN_EXACT.includes(s))) return true;
  return EN_RESERVED_PREFIX.some((w) => plain.startsWith(w)) || EN_RESERVED_EXACT.includes(plain);
}

/** 새 닉네임 검사 (NFC 정규화 + 앞뒤 공백 제거) */
export function checkNewNickname(raw) {
  if (typeof raw !== 'string' || raw.length > 64) return { ok: false, reason: typeof raw === 'string' ? 'format' : 'empty' };
  const nickname = raw.normalize('NFC').trim();
  if (!nickname) return { ok: false, reason: 'empty' };
  if (!FORMAT.test(nickname)) return { ok: false, reason: 'format' };
  if (isBanned(nickname)) return { ok: false, reason: 'banned' };
  return { ok: true, nickname };
}

export const nicknameKey = (name) => String(name ?? '').normalize('NFC').toLowerCase();
