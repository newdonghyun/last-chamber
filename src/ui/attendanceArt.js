/**
 * ODD ROULETTE - 출석 7일 보상 일러스트 (직접 그린 SVG — 느와르 카지노: 황동 · 크롬 · 푸른 화염 · 금장 · 무광 티타늄)
 *
 *   ART_DEFS      모든 그림이 같이 쓰는 그라디언트 (모달에 한 번만 넣는다 — display:none 으로 감추면 일부 브라우저에서 칠이 사라지므로 크기 0 으로 둔다)
 *   artFor(day)   1~7일차 그림 (7일차는 두 칸짜리 넓은 그림)
 *   STAMP         수령 완료 칸에 찍는 붉은 도장
 */

const grad = (id, stops, attrs = 'x1="0" y1="0" x2="1" y2="0"') =>
  `<linearGradient id="${id}" ${attrs}>${stops.map(([o, c]) => `<stop offset="${o}" stop-color="${c}"/>`).join('')}</linearGradient>`;
const radial = (id, stops, attrs = '') =>
  `<radialGradient id="${id}" ${attrs}>${stops.map(([o, c, a = 1]) => `<stop offset="${o}" stop-color="${c}" stop-opacity="${a}"/>`).join('')}</radialGradient>`;
const VERTICAL = 'x1="0" y1="0" x2="0" y2="1"';

export const ART_DEFS = `<svg class="daily-defs" width="0" height="0" aria-hidden="true" focusable="false"><defs>${[
  grad('att-brass', [[0, '#5a3d0e'], [0.22, '#c9962f'], [0.4, '#fbe7a8'], [0.62, '#c9962f'], [1, '#4a300a']]),
  grad('att-chrome', [[0, '#f8fbff'], [0.3, '#b9c4d4'], [0.5, '#6c7787'], [0.68, '#e4ebf6'], [1, '#59626f']], VERTICAL),
  grad('att-black', [[0, '#5a5f68'], [0.28, '#23262b'], [0.7, '#121316'], [1, '#050506']], VERTICAL),
  grad('att-gold', [[0, '#fff0b4'], [0.35, '#e8bd4e'], [0.65, '#a8781b'], [1, '#f2d27a']], VERTICAL),
  grad('att-wood', [[0, '#8a4c26'], [1, '#2c1306']], VERTICAL),
  grad('att-crate', [[0, '#5b4526'], [1, '#241908']], VERTICAL),
  radial('att-ruby', [[0, '#ffc2c2'], [0.35, '#ef2b45'], [1, '#5a0510']], 'cx=".38" cy=".32" r=".7"'),
  radial('att-flame', [[0, '#ffffff'], [0.25, '#c6f6ff'], [0.55, '#29a8ff'], [0.85, '#1437c9'], [1, '#0a1560', 0.1]]),
  radial('att-glow-gold', [[0, '#ffd87a', 0.55], [1, '#ffd87a', 0]]),
  radial('att-glow-blue', [[0, '#3fb4ff', 0.65], [1, '#3fb4ff', 0]]),
].join('')}</defs></svg>`;

const art = (viewBox, body) => `<svg viewBox="${viewBox}" aria-hidden="true" focusable="false">${body}</svg>`;
const shadow = (cx, cy, rx) => `<ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="2.2" fill="#000" opacity=".55"/>`;
const spark = (x, y, r, color = '#fff3c4') => `<path d="M${x} ${y - r}Q${x} ${y} ${x + r} ${y}Q${x} ${y} ${x} ${y + r}Q${x} ${y} ${x - r} ${y}Q${x} ${y} ${x} ${y - r}Z" fill="${color}"/>`;

/** 빈 탄피 하나 (왼쪽 위 = x, y · 너비 10 · 높이 30) */
const casing = (x, y, rotate = 0, scale = 1) => `<g transform="translate(${x} ${y}) rotate(${rotate} 5 15) scale(${scale})">
  <rect x="0" y="2.6" width="10" height="24" rx="1" fill="url(#att-brass)"/>
  <rect x="2.4" y="5" width="1.3" height="16" rx=".6" fill="#fff7d8" opacity=".6"/>
  <ellipse cx="5" cy="2.8" rx="5" ry="2" fill="#241702" stroke="#f6dd95" stroke-width=".9"/>
  <rect x=".7" y="22.6" width="8.6" height="2.4" fill="#3a2705"/>
  <rect x="-.8" y="25.4" width="11.6" height="3.8" rx="1" fill="url(#att-brass)" stroke="#3a2705" stroke-width=".5"/>
</g>`;

/** 리볼버 옆모습 (총구가 오른쪽 · 64×40 안). body = 몸통 칠 · grip = 손잡이 칠 · edge = 테두리 · line = 홈 */
const revolver = ({ body, grip, edge, line, extra = '' }) => `<g stroke="${edge}" stroke-width=".8" stroke-linejoin="round">
  <path d="M14 21 24 22 19.5 36.5Q18.6 39.4 15.4 39L9.4 38Q6.6 37.2 7.8 34.4Z" fill="${grip}"/>
  <path d="M14.5 10.5H38L40 14V23.5H27L23.5 26.5H16Q11.5 23.5 11.8 17Q12.4 11.5 14.5 10.5Z" fill="${body}"/>
  <path d="M15.5 11.5 10 6.8Q8.2 6.8 8.4 9L12.6 15Z" fill="${body}"/>
  <rect x="38" y="11" width="23" height="6.4" rx="1.2" fill="${body}"/>
  <path d="M39 17.4H55L52.5 21H39Z" fill="${body}"/>
  <path d="M55.5 11 58 7.4 60 11Z" fill="${body}"/>
  <rect x="22" y="11.6" width="15.5" height="13.4" rx="3.2" fill="${body}"/>
  <path d="M25 25Q24.6 33.6 31 33.4Q36.4 32.8 36 23.8" fill="none" stroke="${body}" stroke-width="2.1"/>
  <path d="M29.4 25Q28.8 28.8 31.8 30.4" fill="none" stroke="${edge}" stroke-width="1.5" stroke-linecap="round"/>
</g>
<g stroke="${line}" stroke-linecap="round" fill="none">
  <path d="M24.5 15.2H35M24.5 18.4H35M24.5 21.6H35" stroke-width="1.5" opacity=".7"/>
  <path d="M40 13H59" stroke-width=".8" opacity=".9"/>
  <circle cx="19" cy="18" r="1.7" stroke-width=".9"/>
</g>${extra}`;

const DAY1 = art('0 0 64 48', `
  <ellipse cx="32" cy="30" rx="22" ry="16" fill="url(#att-glow-gold)"/>
  ${shadow(32, 43.5, 11)}
  ${casing(27, 12, -6, 1.04)}
  ${spark(44, 13, 4)}${spark(19, 24, 2.4)}`);

const DAY3 = art('0 0 64 48', `
  <ellipse cx="32" cy="30" rx="28" ry="17" fill="url(#att-glow-gold)"/>
  ${shadow(32, 43.5, 22)}
  ${casing(15, 13, -13)}
  ${casing(39, 13, 13)}
  ${casing(27, 8, 0, 1.08)}
  ${casing(27, 24, 82, 0.8)}
  ${spark(53, 11, 3.6)}${spark(10, 16, 2.6)}`);

const DAY5 = art('0 0 64 48', `
  <ellipse cx="32" cy="26" rx="31" ry="21" fill="url(#att-glow-gold)"/>
  ${shadow(32, 45, 27)}
  <path d="M10 20 15 13H49L54 20Z" fill="#1a1106" stroke="#a9843c" stroke-width=".8"/>
  ${casing(14, 5, -8, 0.82)}${casing(23, 2, -2, 0.86)}${casing(32, 3.5, 3, 0.84)}${casing(41, 5, 9, 0.82)}
  <rect x="9" y="20" width="46" height="24" rx="2.4" fill="url(#att-crate)" stroke="#c9a35b" stroke-width="1.1"/>
  <path d="M9 26H55" stroke="#c9a35b" stroke-width=".8" opacity=".7"/>
  <g fill="url(#att-gold)">
    <path d="M9 20h7v2.6h-4.4V27H9zM55 20h-7v2.6h4.4V27H55zM9 44h7v-2.6h-4.4V37H9zM55 44h-7v-2.6h4.4V37H55z"/>
    <path d="m32 28 2 4.6 5 .4-3.8 3.3 1.2 4.9-4.4-2.7-4.4 2.7 1.2-4.9L25 33l5-.4z"/>
  </g>
  ${casing(2, 30, -74, 0.62)}
  ${spark(56, 9, 3.6)}${spark(8, 12, 2.6)}`);

// 2일차 — 실버 룰렛: 은빛 크롬 리볼버 + 뒤의 룰렛 휠
const DAY2 = art('0 0 64 48', `
  <g fill="none" stroke="#aab6c8" opacity=".32">
    <circle cx="32" cy="23" r="20" stroke-width="2.4" stroke-dasharray="5.2 5.2"/>
    <circle cx="32" cy="23" r="15.5" stroke-width=".8"/>
  </g>
  ${shadow(32, 44, 24)}
  <g transform="translate(-1 2.5)">${revolver({ body: 'url(#att-chrome)', grip: 'url(#att-black)', edge: '#2c333f', line: '#4d5766' })}</g>
  ${spark(52, 8, 4.2, '#ffffff')}${spark(15, 38, 2.6, '#dfe9ff')}`);

// 4일차 — 블루 플레임: 총구에서 터지는 푸른 화염
const DAY4 = art('0 0 64 48', `
  <ellipse cx="40" cy="23" rx="24" ry="22" fill="url(#att-glow-blue)"/>
  <path d="M21 24 31 18.5 27.5 9 38 15.5 42 3 45.5 15 56 7.5 52.5 19 63 21.5 53 27 60 37.5 48.5 33.5 47 45 40.5 34.5 31 41.5 32.5 30.5Z" fill="url(#att-flame)"/>
  <path d="M23 24 35 20 38 13 42.5 19.5 50 17 46.5 23.5 54 26 45 28.5 46 35 40 30 33.5 33 35 27Z" fill="#9fe8ff" opacity=".9"/>
  <ellipse cx="34" cy="24" rx="9" ry="4.6" fill="#fff"/>
  <g stroke="#05070d" stroke-width=".8" fill="url(#att-black)">
    <rect x="1" y="20" width="22" height="8.4" rx="1.4"/>
    <rect x="20" y="19" width="3.6" height="10.4" rx=".8"/>
    <path d="M14 20 16.5 16.6 18.5 20Z"/>
  </g>
  <path d="M3 22H19" stroke="#6fd0ff" stroke-width=".9" stroke-linecap="round"/>
  ${spark(56, 41, 2.8, '#bfeeff')}${spark(27, 6, 2.2, '#bfeeff')}<circle cx="60" cy="13" r="1.1" fill="#7fd8ff"/><circle cx="25" cy="38" r=".9" fill="#7fd8ff"/>`);

// 6일차 — 블러드 골드: 금장 프레임 안의 금빛 리볼버 + 붉은 보석
const ruby = (x, y, r) => `<path d="M${x} ${y - r} ${x + r} ${y} ${x} ${y + r} ${x - r} ${y}Z" fill="url(#att-ruby)" stroke="#ffd978" stroke-width=".7"/>`;
const DAY6 = art('0 0 64 48', `
  <rect x="2" y="3" width="60" height="42" rx="3.5" fill="#2a060a" stroke="url(#att-gold)" stroke-width="2"/>
  <rect x="5" y="6" width="54" height="36" rx="2" fill="none" stroke="#c9a35b" stroke-width=".6" opacity=".8"/>
  <g fill="none" stroke="#e8bd4e" stroke-width=".9" stroke-linecap="round">
    <path d="M7 13Q7 8 12 8M57 13Q57 8 52 8M7 35Q7 40 12 40M57 35Q57 40 52 40"/>
  </g>
  <g transform="translate(-.5 4)">${revolver({
    body: 'url(#att-gold)', grip: 'url(#att-wood)', edge: '#5b3c06', line: '#7a520c',
    extra: `${ruby(29.8, 18.3, 3.6)}${ruby(15.2, 31.5, 2.6)}<circle cx="47" cy="19.2" r="1.2" fill="url(#att-ruby)"/>`,
  })}</g>
  ${ruby(32, 4, 2.8)}${spark(53, 11, 3.2)}`);

// 7일차 — 팬텀 블랙 + 탄피 500: 무광 블랙 티타늄 리볼버 · 황금 왕관 · 탄피 (넓은 칸)
const DAY7 = art('0 0 136 56', `
  <ellipse cx="68" cy="30" rx="64" ry="27" fill="url(#att-glow-gold)"/>
  <g stroke="#e8bd4e" stroke-width="1" opacity=".28" stroke-linecap="round">
    <path d="M68 2V9M45 6 49 12M91 6 87 12M24 16 31 19M112 16 105 19M18 34H26M118 34H110"/>
  </g>
  ${shadow(66, 52, 46)}
  <g transform="translate(30 10) scale(1.12)">${revolver({
    body: 'url(#att-black)', grip: 'url(#att-black)', edge: '#8e96a4', line: '#8b93a0',
    extra: '<path d="M40 17.4H55M22.6 11.6H37" stroke="url(#att-gold)" stroke-width="1" fill="none"/><circle cx="19" cy="18" r="1.7" fill="url(#att-gold)"/><path d="M11 35.5 17 36.5" stroke="url(#att-gold)" stroke-width="1.4"/>',
  })}</g>
  <g fill="url(#att-gold)" stroke="#6b4a0c" stroke-width=".7" stroke-linejoin="round">
    <path d="M52 15 49 3 56.5 8.5 62 1 67.5 8.5 75 3 72 15Z"/>
    <rect x="52" y="14.2" width="20" height="3.6" rx=".8"/>
    <circle cx="49" cy="3" r="1.5"/><circle cx="62" cy="1.6" r="1.5"/><circle cx="75" cy="3" r="1.5"/>
  </g>
  <circle cx="62" cy="11.4" r="2" fill="url(#att-ruby)"/>
  ${casing(10, 22, -10, 0.9)}${casing(19, 26, 4, 0.86)}${casing(105, 25, -4, 0.86)}${casing(115, 21, 11, 0.9)}${casing(96, 36, 80, 0.62)}
  ${spark(108, 10, 4.4)}${spark(25, 11, 3.2)}${spark(128, 40, 2.4)}`);

const BY_DAY = [DAY1, DAY2, DAY3, DAY4, DAY5, DAY6, DAY7];

export const artFor = (day) => BY_DAY[day - 1] ?? DAY1;

export const STAMP = `<svg class="daily-stamp" viewBox="0 0 64 44" aria-hidden="true" focusable="false">
  <g transform="rotate(-13 32 22)" fill="none" stroke="#ff3b47">
    <rect x="3" y="8" width="58" height="28" rx="4" stroke-width="2.6" fill="rgba(70,0,6,.55)"/>
    <rect x="6.4" y="11.4" width="51.2" height="21.2" rx="2" stroke-width=".9" stroke-dasharray="14 1.4 7 1"/>
    <text x="32" y="23.2" fill="#ff5560" stroke="none" font-size="11" font-weight="900" text-anchor="middle">수령 완료</text>
    <text x="32" y="30.6" fill="#ff5560" stroke="none" font-size="5.6" font-weight="800" letter-spacing="2.2" text-anchor="middle">CLAIMED</text>
  </g>
</svg>`;
