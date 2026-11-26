/**
 * LAST CHAMBER - 서버 지갑 클라이언트 (탄피 · 스킨 · 출석 · 긴급 보급의 거울)
 *
 *   로그인한 계정의 탄피 · 스킨 · 화염 · 도발 · 칭호 · 상자 기록 · 출석 · 긴급 보급 횟수는 서버(Supabase players)가 원본이다 (server/wallet.js).
 *   이 클래스는 그 동작을 서버에 요청하고, 돌려받은 지갑으로 이 기기의 PlayerProfile(localStorage)을 맞춘다 (adoptWallet).
 *   → 이 기기에서 탄피 · 보유 스킨을 고쳐도 다음 동기화 · 다음 동작 때 서버 값으로 되돌아가고, 서버는 요청마다 가격 · 보유 · 횟수 · 날짜를 다시 검증한다.
 *
 *   const wallet = new WalletClient({ profile, session });
 *   const r = await wallet.buyWithBrass('gun', 'gold');   // PlayerProfile.buyWithBrass 와 같은 { ok, reason, short, brass } — 로그인 중이면 서버가 실행
 *   await wallet.sync();                                   // 로그인 · 로비 · 상점을 열 때: 서버 지갑 + 출석 · 긴급 보급 상태
 *   wallet.state                                           // { today, attendance, emergency, practice } (서버가 알려 준 가장 최근 상태 | null)
 *
 *   · 칭호는 꾸밈 요소라 이 기기에서 장착한다 (서버는 상자로 얻은 칭호만 알려 준다).
 *   · 로그인하지 않은 손님은 서버 지갑이 없다 → 모든 동작이 예전처럼 이 기기의 PlayerProfile 에서 처리된다 (AI 연습만 하는 손님).
 *   · 서버가 WALLET_SETUP_REQUIRED(DB 에 지갑 컬럼이 아직 없음)로 답하면 이번 접속에서는 예전 방식(이 기기에 저장)으로 계속한다 — 게임이 멈추지 않게.
 *   · 서버에 닿지 못하면 { ok: false, reason: 'offline' } — 탄피 · 스킨을 바꾸는 동작은 하지 않는다 (화면은 안내 문구를 보인다).
 *   · 값이 바뀌거나 동기화가 실패할 때마다 document 에 'lastchamber:wallet-changed' 를 낸다 (화면이 지갑 · 상점 · 로비 · 출석 팝업을 다시 그린다).
 */

import { userSession } from './session.js';
import { walletCall } from './accountApi.js';
import { getChestItem, PlayerProfile } from './storeData.js';

export const WALLET_CHANGED = 'lastchamber:wallet-changed';

export class WalletClient {
  #profile;
  #session;
  #call;
  #legacy = false; // 서버 지갑을 쓸 수 없다고 알려 와서 이번 접속은 예전 방식
  #state = null;
  #owner = null; // state · error 를 받은 계정 (계정을 바꾸면 앞 계정의 것은 보이지 않는다)
  #error = null; // 가장 최근 동기화가 실패한 이유 (성공하면 null) — 화면이 '출석 정보를 못 불러왔어요 (코드)' 를 보인다

  /** @param {{ profile: import('./storeData.js').PlayerProfile, session?: object, call?: Function }} options call = (action, args) → 서버 응답 (테스트에서 바꾼다) */
  constructor({ profile, session = userSession, call = null }) {
    this.#profile = profile;
    this.#session = session;
    this.#call = call ?? ((action, args) => walletCall(action, args, { session }));
  }

  /** 서버 지갑을 쓰는가 (로그인했고, 서버가 지갑을 쓸 수 있다고 한 상태) */
  get remote() {
    return this.#session.isLoggedIn && !this.#legacy;
  }

  /** 가장 최근에 서버가 알려 준 출석 · 긴급 보급 · 연습 보상 상태 (손님이거나 아직 못 받았으면 null) */
  get state() {
    return this.remote && this.#owner === this.#session.user?.id ? this.#state : null;
  }

  /** 가장 최근 동기화 실패 코드 (WALLET_SETUP_REQUIRED · OFFLINE · TIMEOUT · SERVER_ERROR …) | null */
  get lastError() {
    return this.#session.isLoggedIn && this.#owner === this.#session.user?.id ? this.#error : null;
  }

  #take(res) {
    this.#error = null;
    this.#owner = this.#session.user?.id;
    if (res.state) this.#state = res.state;
    const changed = res.wallet ? this.#profile.adoptWallet(res.wallet) : false;
    globalThis.document?.dispatchEvent?.(new CustomEvent(WALLET_CHANGED, { detail: { changed } }));
    return changed;
  }

  async #op(action, args, local) {
    if (!this.remote) return local();
    const res = await this.#call(action, args);
    if (!res?.ok) {
      if (res?.error === 'WALLET_SETUP_REQUIRED') { // DB 에 지갑 컬럼이 아직 없다 → 이번 접속은 예전처럼
        this.#legacy = true;
        this.#state = null;
        return local();
      }
      const offline = res?.error === 'OFFLINE' || res?.error === 'TIMEOUT';
      return { ok: false, reason: offline ? 'offline' : 'server', error: res?.error, message: res?.message };
    }
    this.#take(res);
    return res.result;
  }

  /**
   * 서버 지갑으로 거울을 맞춘다 → { ok, changed } (손님이면 { ok: true, changed: false })
   * 서버가 아직 지갑 컬럼이 없다고 해서 예전 방식이 된 접속도, 동기화(로그인 · 로비를 열 때)마다 다시 물어본다 —
   * 그 사이 서버에 SQL 이 적용됐다면 새로고침 없이 서버 지갑으로 넘어온다.
   */
  async sync() {
    if (!this.#session.isLoggedIn) return { ok: true, changed: false };
    const res = await this.#call('get', {});
    if (!res?.ok) {
      if (res?.error === 'WALLET_SETUP_REQUIRED') { this.#legacy = true; this.#state = null; }
      this.#error = res?.error ?? 'UNKNOWN';
      this.#owner = this.#session.user?.id;
      globalThis.document?.dispatchEvent?.(new CustomEvent(WALLET_CHANGED, { detail: { changed: false, error: this.#error } }));
      return { ok: false, error: res?.error };
    }
    this.#legacy = false;
    return { ok: true, changed: this.#take(res) };
  }

  // ── 상점 (PlayerProfile 과 같은 이름 · 같은 반환값 — 서버가 실행하면 Promise) ──
  buyWithBrass(kind, id) { return this.#op('buy', { kind, id }, () => this.#profile.buyWithBrass(kind, id)); }
  equip(kind, id) { return this.#op('equip', { kind, id }, () => this.#profile.equip(kind, id)); }
  equipFlame(id) { return this.#op('flame', { id }, () => this.#profile.equipFlame(id)); }
  buyTaunt(id) { return this.#op('taunt_buy', { id }, () => this.#profile.buyTaunt(id)); }
  equipTaunt(id) { return this.#op('taunt_equip', { id }, () => this.#profile.equipTaunt(id)); }

  /** 상자: 서버가 추첨한다 (결과의 item 은 id 만 오므로 이 기기의 카탈로그 항목으로 되돌려 준다) */
  async openChest() {
    const r = await this.#op('chest', {}, () => this.#profile.openChest());
    if (r?.ok && r.item && Object.keys(r.item).length === 1) return { ...r, item: getChestItem(r.item.id) ?? r.item };
    return r;
  }

  // ── 출석 · 긴급 보급 · 연습 보상 (서버 지갑이 있을 때만 — 손님은 { ok: false, error: 'LOGIN_REQUIRED' }) ──
  async checkIn() {
    if (!this.remote) return { ok: false, error: 'LOGIN_REQUIRED' };
    return this.#op('checkin', {}, () => ({ ok: false, error: 'WALLET_SETUP_REQUIRED' }));
  }

  async emergency() {
    if (!this.remote) return { ok: false, error: 'LOGIN_REQUIRED' };
    return this.#op('emergency', {}, () => ({ ok: false, error: 'WALLET_SETUP_REQUIRED' }));
  }

  /** AI 연습 판 보상 (서버 값으로 지급 — 하루 5판) → { ok, granted, limited, left } | null (서버 지갑이 아니면 기기에서 이미 처리됨) */
  async practice(won) {
    if (!this.remote) return null;
    const r = await this.#op('practice', { won: won === true }, () => null);
    return r?.ok ? r : null;
  }
}

let shared = null;
/** 화면 모듈들이 같이 쓰는 지갑 클라이언트 하나 (app.js · multiplayer.js — 같은 localStorage 프로필을 맞춘다) */
export const sharedWallet = () => (shared ??= new WalletClient({ profile: new PlayerProfile() }));
