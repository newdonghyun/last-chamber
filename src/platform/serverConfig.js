/**
 * 서버 주소 설정 — window.LAST_CHAMBER_SERVER 를 자동으로 정한다 (multiplayer.js 가 이 값으로 Socket.io 에 붙는다).
 *
 * index.html <head> 맨 위에서 "일반 스크립트"로 가장 먼저 실행돼야 한다 (모듈 스크립트보다 앞).
 *   · 게임 서버가 직접 내준 웹 페이지 (브라우저 · 로컬 개발)  → 지금 접속한 도메인(location.origin) 그대로
 *   · Capacitor 앱 · 토스 미니앱 웹뷰 등 다른 곳에서 실행    → 클라우드 서버 주소(CLOUD_SERVER_URL)
 *   · 이미 window.LAST_CHAMBER_SERVER 가 지정돼 있으면 그 값을 그대로 둔다 (스테이징 서버 등으로 바꿔 끼울 때)
 *
 * 서버 쪽에서는 CORS_ORIGIN 이 비었거나 '*' 이면 앱/토스 웹뷰 출처가 허용된다 (server/index.js).
 */
(function () {
  'use strict';

  // ▼▼▼ 실제 배포한 클라우드 서버 주소 — 배포 후 이 한 줄만 바꾸면 된다 (끝의 / 는 없어도 된다) ▼▼▼
  const CLOUD_SERVER_URL = 'https://last-chamber.onrender.com';
  // ▲▲▲

  if (typeof window === 'undefined') return;
  if (typeof window.LAST_CHAMBER_SERVER === 'string' && window.LAST_CHAMBER_SERVER.trim()) return;

  const loc = window.location || {};

  let native = false; // Capacitor 네이티브 앱 (iOS · Android)
  try {
    const cap = window.Capacitor;
    native = !!cap && typeof cap.isNativePlatform === 'function' && cap.isNativePlatform();
  } catch {
    native = false;
  }

  const servedByWeb = /^https?:$/.test(loc.protocol || ''); // capacitor: · file: · app: 같은 앱 전용 주소가 아니면 true
  const toss = /(^|\.)tossmini\.com$/i.test(loc.hostname || ''); // 토스 미니앱 웹뷰 (정적 파일이 토스 쪽에서 내려온다)

  window.LAST_CHAMBER_SERVER = native || toss || !servedByWeb ? CLOUD_SERVER_URL : loc.origin;
})();
