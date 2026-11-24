/**
 * 앱 번들용 웹 자산 만들기 — 게임 실행에 필요한 파일만 www/ 로 복사한다 (Capacitor 의 webDir).
 *
 * server/ · tests/ · node_modules/ · package*.json · scripts/ 같은 서버·개발용 파일은 목록에 없으므로 앱에 섞이지 않는다.
 * 새 정적 파일/폴더가 게임에 필요해지면 INCLUDE 에만 추가한다.
 *
 * 쓰는 법: npm run build:app   (npm run cap:sync = 이걸 만든 뒤 cap sync)
 */
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'www');
const INCLUDE = ['index.html', 'style.css', 'manifest.webmanifest', 'src', 'assets'];

const missing = INCLUDE.filter((name) => !existsSync(path.join(ROOT, name)));
if (missing.length) {
  console.error(`[build:app] 있어야 할 파일/폴더가 없습니다: ${missing.join(', ')}`);
  process.exit(1);
}

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
for (const name of INCLUDE) {
  cpSync(path.join(ROOT, name), path.join(OUT, name), {
    recursive: true,
    filter: (src) => !path.basename(src).startsWith('.'), // .DS_Store 같은 숨김 파일 제외
  });
}
console.log(`[build:app] www/ 생성 완료 ← ${INCLUDE.join(' · ')}`);
