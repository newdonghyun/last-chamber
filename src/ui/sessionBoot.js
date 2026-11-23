/**
 * 첫 화면을 그리기 전에 로그인 여부만 판단한다 — index.html <head> 에서 "일반 스크립트"로 (모듈보다 먼저) 실행된다.
 *
 *   로그인 기록이 없으면 <html class="needs-login"> 을 붙인다 → CSS(src/ui/loginGate.css)가 처음부터 로그인 화면을 보여 주고 타이틀을 숨긴다.
 *   모듈(src/ui/loginGate.js)이 나중에 실행될 때 판단을 넘겨받으므로, 타이틀이 잠깐 비쳤다가 로그인 화면으로 바뀌는 깜빡임이 없다.
 *   여기서는 모양만 대강 본다 — 정확한 검사(닉네임 규칙 · UUID 형식)는 src/ui/session.js 가 한다 (둘이 다르면 모듈 쪽을 따른다).
 *   ⚠ 저장 키 · 모양은 src/ui/session.js 의 SESSION_KEY · 저장 형식과 같아야 한다.
 */
(function () {
  'use strict';

  var KEY = 'lastchamber.session';
  var ok = false;
  try {
    var s = JSON.parse(window.localStorage.getItem(KEY) || 'null');
    ok = !!s && s.loggedIn === true && typeof s.id === 'string' && typeof s.nickname === 'string' && s.nickname.length > 0;
  } catch (e) {
    ok = false; // 저장소를 못 쓰는 환경 → 로그인 화면부터
  }
  if (!ok) document.documentElement.classList.add('needs-login');
})();
