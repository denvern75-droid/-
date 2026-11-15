/*
 * 외부 지도 앱 연계 — 브라우저/Node 공용
 *  1) 지도 앱 열기: 카카오맵·네이버지도·구글지도(안드로이드 intent / 유니버설 링크)
 *  2) 공유로 받은 텍스트·URL에서 좌표 추출(parseShared)
 * 주의: URL 형식은 각 서비스의 공개 규격에 대한 기억에 근거함. 실기기 확인 전에는 '추정'으로 취급하고
 *      좌표는 서울권 범위 검사와 route 검증 도구를 통과한 것만 저장함.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.WalkLinks = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const enc = encodeURIComponent;
  const hasXY = (p) => p && typeof p.lat === 'number' && typeof p.lng === 'number';
  const KOREA = { latMin: 33, latMax: 39, lngMin: 124, lngMax: 132 };      // 한국 전체(순서 판별용)
  const SEOUL = { latMin: 37.40, latMax: 37.72, lngMin: 126.76, lngMax: 127.20 }; // 서울권(저장 허용 범위)
  const inKorea = (a, b) => a >= KOREA.latMin && a <= KOREA.latMax && b >= KOREA.lngMin && b <= KOREA.lngMax;
  const inSeoul = (lat, lng) => lat >= SEOUL.latMin && lat <= SEOUL.latMax && lng >= SEOUL.lngMin && lng <= SEOUL.lngMax;

  // 안드로이드 intent URL: 앱이 없으면 웹 주소로 이동
  function asIntent(url, pkg, fallback) {
    const m = url.match(/^([a-z]+):\/\/(.*)$/i);
    if (!m) return url;
    return `intent://${m[2]}#Intent;scheme=${m[1]};package=${pkg};S.browser_fallback_url=${enc(fallback)};end`;
  }

  // dest: {name, lat, lng}  /  mode: 'transit' | 'walk'
  function mapLinks(dest, mode) {
    const name = dest.name || '';
    const xy = hasXY(dest);
    const kBy = mode === 'walk' ? 'FOOT' : 'PUBLICTRANSIT';
    const kakaoUrl = xy ? `kakaomap://route?ep=${dest.lat},${dest.lng}&by=${kBy}` : `kakaomap://search?q=${enc(name)}`;
    const kakaoWeb = xy ? `https://map.kakao.com/link/to/${enc(name || '목적지')},${dest.lat},${dest.lng}` : `https://map.kakao.com/?q=${enc(name)}`;
    const app = 'walknav';
    const naverUrl = xy
      ? `nmap://route/${mode === 'walk' ? 'walk' : 'public'}?dlat=${dest.lat}&dlng=${dest.lng}&dname=${enc(name || '목적지')}&appname=${app}`
      : `nmap://search?query=${enc(name)}&appname=${app}`;
    const naverWeb = `https://map.naver.com/p/search/${enc(name)}`;
    const googleUrl = `https://www.google.com/maps/dir/?api=1&destination=${xy ? dest.lat + ',' + dest.lng : enc(name)}&travelmode=${mode === 'walk' ? 'walking' : 'transit'}`;
    return {
      kakao: asIntent(kakaoUrl, 'net.daum.android.map', kakaoWeb),
      naver: asIntent(naverUrl, 'com.nhn.android.nmap', naverWeb),
      google: googleUrl,
    };
  }

  // ---------- 공유 텍스트 해석 ----------
  const SHORT = /(kko\.to|naver\.me|maps\.app\.goo\.gl|goo\.gl\/maps|g\.co\/kgs|map\.naver\.com\/p\/entry\/place\/\d+$)/i;
  function parseShared(raw) {
    let text = String(raw || '').replace(/\+/g, ' ');
    try { text = decodeURIComponent(text); } catch (e) { /* 퍼센트가 포함된 일반 문장(예: 50% 할인)은 원문 그대로 해석 */ }
    text = text.replace(/%2C/gi, ',');
    const out = { ok: false, reason: '', name: '', lat: null, lng: null, source: '', raw: text };
    const take = (lat, lng, src) => {
      lat = +lat; lng = +lng;
      if (!isFinite(lat) || !isFinite(lng)) return false;
      if (!inKorea(lat, lng) && inKorea(lng, lat)) [lat, lng] = [lng, lat]; // 순서가 뒤바뀐 경우 교정
      if (!inKorea(lat, lng)) return false;
      out.lat = lat; out.lng = lng; out.source = src; return true;
    };
    let m;
    // 1) 카카오 링크: map.kakao.com/link/map/이름,lat,lng
    if ((m = text.match(/map\.kakao\.com\/link\/(?:map|to|from)\/([^,\/]+),(-?\d+\.\d+),(-?\d+\.\d+)/))) { out.name = m[1]; if (take(m[2], m[3], 'kakao')) return fin(out); }
    // 2) 구글: @lat,lng / !3dLAT!4dLNG / q=,query=,ll=,center=,destination= lat,lng
    if ((m = text.match(/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/)) && take(m[1], m[2], 'google')) return fin(out);
    if ((m = text.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/)) && take(m[1], m[2], 'google')) return fin(out);
    if ((m = text.match(/[?&](?:q|query|ll|center|destination|daddr)=(-?\d+\.\d+),\s*(-?\d+\.\d+)/)) && take(m[1], m[2], 'google')) return fin(out);
    // 3) 네이버: lat=..&lng=.. / c=lng,lat,zoom 형태 추정
    if ((m = text.match(/[?&]lat=(-?\d+\.\d+)[^#\s]*?[?&]lng=(-?\d+\.\d+)/)) && take(m[1], m[2], 'naver')) return fin(out);
    if ((m = text.match(/[?&]c=(-?\d+\.\d+),(-?\d+\.\d+)(?:,|&|$)/)) && take(m[2], m[1], 'naver')) return fin(out);
    // 4) 일반 좌표 문자열: "37.5486, 127.0162" (구글 지도에서 좌표를 복사한 경우)
    for (const g of text.matchAll(/(-?\d{2,3}\.\d{4,})\s*[,\s]\s*(-?\d{2,3}\.\d{4,})/g)) { if (take(g[1], g[2], 'text')) return fin(out); }
    // 5) 좌표 없음
    out.reason = SHORT.test(text) ? 'short' : 'none';
    out.name = leadName(text);
    return out;
  }
  // 공유 텍스트에서 장소 이름만 추출(URL·좌표 제거, 제목과 본문이 같은 말이면 한 번만)
  function leadName(text) {
    let t = String(text).replace(/https?:\/\/\S+/g, ' ').replace(/-?\d{2,3}\.\d{4,}\s*[,\s]\s*-?\d{2,3}\.\d{4,}/g, ' ').replace(/\s+/g, ' ').trim();
    const w = t.split(' ');
    if (w.length >= 2 && w.length % 2 === 0 && w.slice(0, w.length / 2).join(' ') === w.slice(w.length / 2).join(' ')) t = w.slice(0, w.length / 2).join(' ');
    return t.slice(0, 60);
  }
  function fin(out) {
    if (!out.name) out.name = leadName(out.raw);
    if (!inSeoul(out.lat, out.lng)) { out.ok = false; out.reason = 'outside'; return out; }
    out.ok = true; return out;
  }

  // 공유된 이름과 지점 이름의 유사도(0~1): 글자 이중쌍 기준
  function similarity(a, b) {
    const n = (s) => String(s || '').replace(/[\s·()번]/g, '').toLowerCase();
    a = n(a); b = n(b);
    if (!a || !b) return 0;
    if (a === b) return 1;
    if (a.includes(b) || b.includes(a)) return 0.9;
    const bg = (s) => { const r = new Set(); for (let i = 0; i < s.length - 1; i++) r.add(s.slice(i, i + 2)); return r; };
    const A = bg(a), B = bg(b); let inter = 0; A.forEach((x) => { if (B.has(x)) inter++; });
    return (2 * inter) / (A.size + B.size || 1);
  }

  return { mapLinks, asIntent, parseShared, similarity, inSeoul, SEOUL };
});
