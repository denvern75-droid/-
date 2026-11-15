/*
 * 보행 안내 엔진 (UI 비의존) — 브라우저/Node 공용
 * - 현재 위치·진행(몸) 방향으로 "N시 방향 M미터" 안내 생성
 * - 지점 도착, 경로 이탈, 지나침(오버슈트), 하차 임박, 지하철 역 카운트다운 처리
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.WalkNav = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const R = 6371000;
  const rad = (d) => (d * Math.PI) / 180;
  const deg = (r) => (r * 180) / Math.PI;

  // ---------- 지리 계산 ----------
  function dist(a, b) {
    const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
    const s = Math.sin(dLat / 2) ** 2 +
      Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(s));
  }
  function bearing(a, b) {
    const p1 = rad(a.lat), p2 = rad(b.lat), dl = rad(b.lng - a.lng);
    const y = Math.sin(dl) * Math.cos(p2);
    const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
    return (deg(Math.atan2(y, x)) + 360) % 360;
  }
  // 각도를 (-180, 180] 로. 양수 = 시계방향(오른쪽)
  function norm180(a) {
    a = ((a % 360) + 360) % 360;
    return a > 180 ? a - 360 : a;
  }
  // 점 p 에서 선분 a-b 까지 최단거리(m)
  function segDist(p, a, b) {
    const k = Math.cos(rad(p.lat));
    const M = (Math.PI * R) / 180; // 위도 1도 = M 미터 (dist()와 동일 기준)
    const ax = (a.lng - p.lng) * M * k, ay = (a.lat - p.lat) * M;
    const bx = (b.lng - p.lng) * M * k, by = (b.lat - p.lat) * M;
    const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
    const t = len2 ? Math.max(0, Math.min(1, (-ax * dx - ay * dy) / len2)) : 0;
    return Math.hypot(ax + t * dx, ay + t * dy);
  }
  // 상대각(rel) → 시계 방향 표현
  function clock(rel) {
    const a = Math.abs(rel);
    let hour = Math.round(rel / 30);
    hour = ((hour % 12) + 12) % 12 || 12;
    if (a <= 15) return { hour: 12, cls: 'ahead', text: '정면', rel };
    if (a >= 165) return { hour: 6, cls: 'back', text: '뒤쪽(6시 방향). 뒤돌아서 가야 함', rel };
    const side = rel > 0 ? '오른쪽' : '왼쪽';
    const part = a <= 60 ? '앞' : a <= 110 ? '옆' : '뒤';
    const size = a <= 60 ? 's' : a <= 110 ? 'm' : 'b';
    return { hour, cls: (rel > 0 ? 'right-' : 'left-') + size, text: `${hour}시 방향(${side} ${part})`, rel };
  }
  function cardinal(b) {
    return ['북', '북동', '동', '남동', '남', '남서', '서', '북서'][Math.round(b / 45) % 8] + '쪽';
  }
  function fmtDist(d) {
    if (d < 20) return `${Math.max(1, Math.round(d))}미터`;
    if (d < 100) return `${Math.round(d / 5) * 5}미터`;
    if (Math.round(d / 10) * 10 < 1000) return `${Math.round(d / 10) * 10}미터`;
    const km = d / 1000;
    return Math.abs(km - Math.round(km)) < 0.05 ? `${Math.round(km)}킬로미터` : `${km.toFixed(1)}킬로미터`;
  }
  // 기기 방향 센서 → 나침반 방위(진행방향). 평평하게 들면 윗면, 세워 들면 뒷면 기준
  function compassHeading(alpha, beta, gamma) {
    if (beta == null || gamma == null || alpha == null) return null;
    if (Math.abs(beta) < 45) return (360 - alpha) % 360; // 수평에 가까움: 윗면 방향
    const x = rad(beta), y = rad(gamma), z = rad(alpha);
    const cY = Math.cos(y), cZ = Math.cos(z), sX = Math.sin(x), sY = Math.sin(y), sZ = Math.sin(z);
    const Vx = -cZ * sY - sZ * sX * cY;
    const Vy = -sZ * sY + cZ * sX * cY;
    let h = Math.atan2(Vx, Vy);
    if (h < 0) h += 2 * Math.PI;
    return deg(h);
  }

  // ---------- 다회 기록 보정 ----------
  function median(a) {
    const b = a.slice().sort((x, y) => x - y), n = b.length;
    return n % 2 ? b[(n - 1) / 2] : (b[n / 2 - 1] + b[n / 2]) / 2;
  }
  // 샘플({lat,lng,acc}) 여러 개의 성분별 중앙값. 이상치에 강함
  function medianPoint(samples) {
    return { lat: median(samples.map((q) => q.lat)), lng: median(samples.map((q) => q.lng)), acc: median(samples.map((q) => q.acc || 0)) };
  }
  // 중앙값에서 가장 먼 샘플까지의 거리(m)
  function spreadM(samples) {
    const m = medianPoint(samples);
    return samples.reduce((mx, q) => Math.max(mx, dist(m, q)), 0);
  }
  const REC = { rejectAcc: 25, warnAcc: 15, warnShiftM: 30 };

  // ---------- 정밀 보정: 강건 융합 + 칼만 필터 ----------
  const MPD = (Math.PI * R) / 180; // 위도 1도 = MPD 미터
  const toLocal = (ref, q) => ({ x: (q.lng - ref.lng) * MPD * Math.cos(rad(ref.lat)), y: (q.lat - ref.lat) * MPD });
  const fromLocal = (ref, v) => ({ lat: ref.lat + v.y / MPD, lng: ref.lng + v.x / (MPD * Math.cos(rad(ref.lat))) });

  // 기하 중앙값(Weiszfeld): 이상치에 강한 대표점
  function geoMedian(pts) {
    let c = { x: pts.reduce((a, q) => a + q.x, 0) / pts.length, y: pts.reduce((a, q) => a + q.y, 0) / pts.length };
    for (let it = 0; it < 60; it++) {
      let nx = 0, ny = 0, w = 0;
      for (const q of pts) { const d = Math.max(Math.hypot(q.x - c.x, q.y - c.y), 1e-6); nx += q.x / d; ny += q.y / d; w += 1 / d; }
      const n = { x: nx / w, y: ny / w };
      if (Math.hypot(n.x - c.x, n.y - c.y) < 1e-4) { c = n; break; }
      c = n;
    }
    return c;
  }

  /*
   * 여러 측정({lat,lng,acc})을 하나로 융합
   * 1) 기하 중앙값을 중심으로, 거리의 MAD(중앙값 절대편차)로 이상치 제거 (3개 이상일 때)
   * 2) 남은 값을 1/오차² 가중 평균 (오차가 작은 측정에 큰 비중)
   * 3) 결과 불확도 = 1/√Σ(1/오차²), 단 하한 3m (측정 오차가 서로 독립이라는 가정의 과신 방지)
   */
  function robustFuse(samples) {
    const n = samples.length;
    if (!n) return null;
    const ref = samples[0];
    const loc = samples.map((q) => toLocal(ref, q));
    const sig = samples.map((q) => Math.max(q.acc || 5, 3));
    let keep = loc.map((_, i) => i);
    if (n >= 3) {
      const g = geoMedian(loc);
      const d = loc.map((q) => Math.hypot(q.x - g.x, q.y - g.y));
      const s = Math.max(median(d) * 1.4826, 3); // 거리 척도(최소 3m)
      keep = d.map((v, i) => [v, i]).filter(([v]) => v <= 3 * s).map(([, i]) => i);
      if (keep.length < 2) keep = d.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]).slice(0, 2).map(([, i]) => i);
    }
    let sw = 0, sx = 0, sy = 0;
    for (const i of keep) { const w = 1 / (sig[i] * sig[i]); sw += w; sx += w * loc[i].x; sy += w * loc[i].y; }
    const pos = fromLocal(ref, { x: sx / sw, y: sy / sw });
    const out = Object.assign(pos, { acc: Math.max(3, 1 / Math.sqrt(sw)), used: keep.length, rejected: n - keep.length });
    out.spread = Math.max(...keep.map((i) => Math.hypot(loc[i].x - sx / sw, loc[i].y - sy / sw)));
    out.acc = Math.max(out.acc, out.spread);              // 서로 어긋난 측정을 평균 내고도 정확하다고 말하지 않음
    const sg = keep.map((i) => sig[i]), ratio = Math.max(...sg) / Math.min(...sg);
    out.conflict = false;
    if (keep.length >= 2 && out.spread > Math.max(15, 2 * Math.min(...sg)) && ratio < 3) {   // 비슷한 정확도인데 서로 15m 넘게 어긋남(예: 도로 양쪽)
      const last = loc[Math.max(...keep)], pl = fromLocal(ref, last);   // 두 군집의 평균(도로 한가운데)을 쓰지 않고 가장 최근 값을 사용
      out.lat = pl.lat; out.lng = pl.lng; out.conflict = true;
    }
    return out;
  }

  /*
   * 보행용 칼만 필터: 등속 모델(위치+속도), x·y 독립 2상태 필터
   * 측정잡음 R=오차², 공정잡음은 가속도 표준편차(걷기 약 1.2m/s²)로 설정
   * 오차가 큰 측정은 자동으로 비중이 낮아지고, 연속 3회 크게 벗어나면 재초기화
   */
  function createKalman(opts) {
    const q = ((opts && opts.accelStd) || 1.2) ** 2;
    let ref = null, st = null, lastT = 0, bad = 0;
    const mk = (z, r) => ({ x: z.x, v: 0, p00: r, p01: 0, p11: 4 });
    function predict(f, dt) {
      f.x += f.v * dt;
      const a = f.p00 + 2 * dt * f.p01 + dt * dt * f.p11 + (q * dt ** 4) / 4;
      const b = f.p01 + dt * f.p11 + (q * dt ** 3) / 2;
      const c = f.p11 + q * dt * dt;
      f.p00 = a; f.p01 = b; f.p11 = c;
    }
    const innov = (f, z, r) => Math.abs(z - f.x) / Math.sqrt(f.p00 + r);
    function correct(f, z, r) {
      const S = f.p00 + r, K0 = f.p00 / S, K1 = f.p01 / S, y = z - f.x, a = f.p00, b = f.p01;
      f.x += K0 * y; f.v += K1 * y;
      f.p00 = a - K0 * a; f.p01 = b - K0 * b; f.p11 = f.p11 - K1 * b;
    }
    let fast = 0; // 보행 속도(1.2m/s 이상)가 연속 확인된 횟수
    function update(fix) {
      const t = fix.t || Date.now();
      const r = Math.max(fix.acc || 10, 3) ** 2;
      if (!ref || !st || t - lastT > 15000) {
        ref = { lat: fix.lat, lng: fix.lng }; const z = toLocal(ref, fix);
        st = { x: mk({ x: z.x }, r), y: mk({ x: z.y }, r) }; lastT = t; bad = 0; fast = 0;
        return Object.assign({}, fix);
      }
      const dt = Math.min(Math.max((t - lastT) / 1000, 0.2), 10); lastT = t;
      const z = toLocal(ref, fix);
      predict(st.x, dt); predict(st.y, dt);
      const gated = innov(st.x, z.x, r) > 4 || innov(st.y, z.y, r) > 4;   // 4σ 밖의 측정: 튄 값으로 보고 반영하지 않음
      if (gated) {
        bad++;
        if (bad >= 3) { ref = { lat: fix.lat, lng: fix.lng }; const z0 = toLocal(ref, fix); st = { x: mk({ x: z0.x }, r), y: mk({ x: z0.y }, r) }; bad = 0; fast = 0; } // 3회 연속이면 실제 이동으로 보고 재초기화
      } else { bad = 0; correct(st.x, z.x, r); correct(st.y, z.y, r); }
      const pos = fromLocal(ref, { x: st.x.x, y: st.y.x });
      const sp = Math.hypot(st.x.v, st.y.v);
      fast = (!gated && sp >= 1.2) ? fast + 1 : (sp >= 1.2 ? fast : 0);
      const conf = fast >= 3;
      const hd = (deg(Math.atan2(st.x.v, st.y.v)) + 360) % 360; // 북=0, 동=90
      return Object.assign({}, fix, {
        lat: pos.lat, lng: pos.lng, acc: Math.max(3, Math.sqrt(st.x.p00)) + (gated ? (fix.acc || 10) * 0.5 : 0),
        speedKnown: Number.isFinite(fix.speed),
        speed: Number.isFinite(fix.speed) ? fix.speed : (conf ? sp : 0),            // 기기가 속도를 주면(0 포함) 그 값을 신뢰함
        heading: (Number.isFinite(fix.heading) && fix.speed >= 0.7) ? fix.heading : (!Number.isFinite(fix.speed) && conf ? hd : null), // 속도를 모를 때만 추정 방향 사용
      });
    }
    return { update, reset() { ref = null; st = null; fast = 0; } };
  }

  // 음성(TTS)·화면낭독용 문장 정리: 낭독에서 오독되는 표기를 소리 나는 대로 바꿈
  function spoken(t) {
    return String(t)
      .replace(/(\d)\s*-\s*(\d)/g, '$1의 $2')               // 8-3 → 8의 3
      .replace(/\b(\d{5})\b/g, (m) => m.split('').join(' ')) // 정류장 번호 21002 → 2 1 0 0 2 (한 자리씩)
      .replace(/(?<![\d.가-힣])(\d{3,4})(?!\d|\.\d|\s*(미터|킬로|개|분|초|도|회|배|원|년|번지|길|로\b))/g, (m) => m.split('').join(' ')) // 버스 번호 5602 → 5 6 0 2
      .replace(/[·•・]/g, ', ')                                 // 51·5602 → 51, 5602
      .replace(/\(약\s*(\d+)\s*도\)/g, ' 약 $1도')                // (약 85도) → 약 85도 (조사가 끊겨 읽히지 않게)
      .replace(/([가-힣A-Za-z])\.([가-힣A-Za-z])/g, '$1 $2')           // 문성초등학교.금천가족문화센터 → 마침표 없이
      .replace(/[()（）]/g, ', ')                               // 괄호는 쉼표로
      .replace(/[→▶◀▷]/g, ', ')
      .replace(/\s*,(\s*,)+/g, ',').replace(/,\s*([.?!])/g, '$1').replace(/\s+/g, ' ').replace(/,\s*$/, '').trim();
  }

  // ---------- 진동 패턴: [진동, 쉼, 진동, ...] 순서. 정방향 1회 / 왼쪽 2회 / 오른쪽 3회 / 유턴 길게 3회 / 도착 길게 1회 / 경고 아주 짧게 5회 ----------
  const PAT = {
    ahead: [160],
    left: [150, 110, 150],
    right: [150, 110, 150, 110, 150],
    back: [450, 150, 450, 150, 450],
    arrive: [1000],
    warn: [60, 60, 60, 60, 60, 60, 60, 60, 60],
  };

  const hasXY = (p) => p && typeof p.lat === 'number' && typeof p.lng === 'number';

  // ---------- 엔진 ----------
  function createEngine(opts) {
    const io = opts.io;
    const now = opts.now || (() => Date.now());
    const C = Object.assign({
      guideEveryMeters: 25, guideEverySec: 20, cueGapSec: 8, offRouteM: 25,
      offRouteGapSec: 25, overshootM: 18, defaultRadius: 12, accCap: 30, beepRangeM: 30,
    }, opts.config || {});

    const S = {
      route: null, li: -1, pi: 0, fix: null, compass: null, track: [],
      stIdx: 0, last: '', minD: Infinity,
      lastGuideAt: 0, lastGuidePos: null, lastCls: null, lastCueAt: 0,
      lastOffAt: 0, lastOverAt: 0, lastBeepAt: 0, lastBeacon: 0, pre: {}, inCnt: 0, inHist: [], closeCnt: 0, nearAt: 0, nearSaid: false, awayCnt: 0, farAt: 0, noShape: false, pendCls: null, clsStreak: 0, lastFixAt: 0, gpsLost: false, fixInLeg: false, busNoteAt: 0, offRoute: false, farWarned: false, busMin: null, busFar: false, warnedMissing: null, busStage: 0,
    };

    S.wHist = []; S.inHistW = (inside) => { S.wHist.push(inside); if (S.wHist.length > 2) S.wHist.shift(); return S.wHist.length === 2 && S.wHist[0] && S.wHist[1]; };   // 연속 2회 확인
    const tNow0 = () => now();
    const isWeak = (p) => !!p && (p.weak === true || p.recAcc > 20);   // 걸어서 확인되지 않은 지도 기준 좌표
    const leg = () => (S.route ? S.route.legs[S.li] : null);
    const target = () => { const l = leg(); return l && l.type === 'walk' ? l.points[S.pi] : null; };

    let handsFree = !!opts.handsFree;
    const HF = () => handsFree;
    function say(text, prio) {
      if (HF()) { text = String(text).split(/(?<=[.?!])\s+/).filter((s) => !/버튼/.test(s)).join(' ').trim(); if (!text) return true; }   // 버튼 없이 쓰는 모드에서는 버튼 안내 문장을 빼고 말함
      S.last = text;
      const ok = io.speak(text, prio || 'normal') !== false;   // false = 다른 안내를 말하는 중이라 버려짐
      if (ok && io.notify) io.notify(text);
      return ok;
    }

    function currentHeading() {
      const t = now(), f = S.fix, moving = !!f && f.speed >= 0.7;
      if (moving && Number.isFinite(f.heading)) return { val: f.heading, src: '걷는 방향(GPS)' };
      if (S.compass && t - S.compass.t < 3000) return { val: S.compass.val, src: '나침반' };
      const tr = S.track;
      if (moving && tr.length >= 2) {            // 정지 중 GPS 잡음으로 방향을 만들지 않도록 이동 중이고 정확도보다 충분히 멀 때만
        const a = tr[0], b = tr[tr.length - 1];
        if (b.t - a.t <= 15000 && dist(a, b) >= Math.max(12, 3 * (f.acc || 5))) return { val: bearing(a, b), src: '이동 궤적' };
      }
      return null;
    }

    function relTo(p) {
      const f = S.fix; if (!f || !hasXY(p)) return null;
      const b = bearing(f, p), h = currentHeading();
      if (!h) return { b, d: dist(f, p), ck: null, h: null, text: '방향을 알 수 없음. 앞으로 몇 걸음 걸으면 방향을 알려줌' };
      const ck = clock(norm180(b - h.val));
      return { b, d: dist(f, p), ck, h, text: ck.text };
    }

    const nm = (t) => t.short || t.name;   // 반복 안내에는 짧은 이름 사용
    function guide(reason) {
      const t = target(); if (!t) return;
      const r = relTo(t); if (!r) return;
      const prio = reason === 'repeat' ? 'high' : reason === 'first' ? 'queue' : 'normal';   // 구간 첫 안내는 소개 뒤에 반드시 이어서 말함
      const turnWeak = isWeak(t) && (t.kind === 'turn' || t.kind === 'crossing');   // 도로 중심선 좌표라 방위는 차도 쪽을 가리킬 수 있어 거리만 말함
      if (!say(turnWeak ? `${nm(t)}까지 대략 ${fmtDist(r.d)}. 가던 길을 따라 계속 가세요.` : `${nm(t)}까지 ${isWeak(t) ? '대략 ' : ''}${fmtDist(r.d)}, ${r.text}`, prio)) return;
      S.lastGuideAt = now(); S.lastGuidePos = { lat: S.fix.lat, lng: S.fix.lng };
      S.lastCls = r.ck ? r.ck.cls : null;
      if (r.ck) io.vibrate(r.ck.cls === 'ahead' ? PAT.ahead : r.ck.cls.startsWith('left') ? PAT.left : r.ck.cls === 'back' ? PAT.back : PAT.right);
    }

    function legIntro(l, i) {
      const head = l.intro ? '' : `${l.title}.`;   // 소개 문장이 있으면 제목은 읽지 않음(같은 말 반복 방지)
      if (l.type === 'walk') {
        const weak = l.points.filter((p) => hasXY(p) && isWeak(p)).length;
        return `${head} ${l.intro || ''}`.trim() + (l.learned && l.learned.text ? ` 걸었던 기록: ${l.learned.text}.` : '') + (weak ? ' 위치 정보가 현장에서 확인되지 않아 오차가 있을 수 있음.' : '') + (!(l.learned && l.learned.text) && l.points.length <= 2 ? ' 이 구간은 길 모양을 모르고 방향과 거리만 알려줌. 길과 횡단보도는 직접 확인하세요.' : '');
      }
      if (l.type === 'subway') {
        const hasCount = /\d+개 역/.test(l.intro || '');
        return `${head} ${l.intro || ''}`.trim() + (l.stations && l.stations.length > 1 ? ` ${hasCount ? '' : `총 ${l.stations.length - 1}개 역 이동. `}역에 설 때마다 다음 버튼을 누르면 남은 역 수를 알려줌.` : '');
      }
      if (l.type === 'bus') {
        const nl = S.route.legs[i + 1], dst = nl && nl.type === 'walk' ? nl.points[nl.points.length - 1] : null;
        const none = !hasXY(l.alight) && !hasXY(dst);
        return `${head} ${l.intro || ''}`.trim() + (none ? ' 하차 위치 정보가 없음. 안내방송과 승객에게 정류장 이름을 확인하고, 내린 뒤 다음 버튼을 누르세요.' : '');
      }
      return `${head} ${l.intro || ''}`.trim();
    }

    // 구간에 들어설 때는 짧게(핵심 두 문장), 전체 설명은 '구간 설명 듣기'로 요청할 때만 읽음. 하차 직후 긴 낭독이 주변 소리를 가리지 않게 함
    function legBrief(l, i) {
      const full = legIntro(l, i);
      if (l.brief) return l.brief + (l.type === 'subway' ? ' 역에 설 때마다 다음 버튼을 누르세요.' : '');
      const parts = full.split(/(?<=[.?!])\s+/).filter(Boolean);
      return parts.length <= 2 ? full : parts.slice(0, 2).join(' ') + ' 자세한 설명은 구간 설명 듣기 버튼.';
    }
    function detail() { const l = leg(); if (l) say(legIntro(l, S.li), 'high'); else if (S.last) say(S.last, 'high'); }

    function enterLeg(i, prefix) {
      if (i >= S.route.legs.length) {
        S.li = S.route.legs.length; // 종료
        say((prefix ? prefix + ' ' : '') + '모든 안내를 마침.', 'high');
        io.vibrate(PAT.arrive); return;
      }
      S.li = i; S.pi = 0; S.stIdx = 0; S.minD = Infinity; S.busStage = 0;
      S.lastGuidePos = null; S.lastGuideAt = 0; S.warnedMissing = null; S.inCnt = 0; S.busMin = null; S.busFar = false; S.busNoteAt = 0; S.offRoute = false; S.farWarned = false; S.fixNear = false; S.farCnt = 0; S.atSaid = false; S.busRiding = false; S.medianAt = 0; S.medianRep = false; S.nearRep = 0; S.crossed = false; S.crossAskAt = 0; S.vehCnt = 0; S.inHist = []; S.prevD = null; S.closeCnt = 0; S.nearSaid = false; S.awayCnt = 0; S.farAt = 0;
      S.legAt = now(); S.soonSaid = false; S.surfCnt = 0; S.surfWarnAt = 0; S.wentUnder = false; S.offCnt = 0; S.crossFrom = null; S.crossCnt = 0; S.nearCross = false; S.crossInfoSaid = false; S.caSaidAt = 0;
      S.lastFixAt = now(); S.gpsLost = false; S.fixInLeg = false;   // 지하 구간 동안의 무수신을 새 구간의 GPS 두절로 오인하지 않음
      const l = leg();
      const brief = prefix === S.route.overview ? legIntro(l, i) : legBrief(l, i);   // 출발 전 경로 소개와 함께일 때만 전체 설명
      if (prefix) { say(prefix, 'high'); say(brief, 'queue'); }   // 급한 말을 먼저, 소개는 이어서
      else say(brief, 'high');
      if (io.onLegChange) io.onLegChange(i, l);
    }

    function arrive(p) {
      io.vibrate(PAT.arrive);
      S.minD = Infinity; S.lastGuidePos = null; S.lastGuideAt = 0; S.inCnt = 0; S.inHist = []; S.prevD = null; S.closeCnt = 0; S.nearSaid = false; S.awayCnt = 0;
      const msg = (isWeak(p) ? `${p.name} 부근에 도착함. 오차가 있을 수 있으니 주변 사람이나 안내방송으로 확인하세요. ${p.say || ''}` : `${p.name} 도착. ${p.say || ''}`).trim();
      if (S.pi >= leg().points.length - 1) enterLeg(S.li + 1, msg);
      else { S.pi++; say(msg, 'high'); }
    }

    // ---------- 외부 입력 ----------
    function onFix(fix) {
      if (S.gpsLost) { S.gpsLost = false; say(S.fixInLeg ? 'GPS 신호가 돌아왔음.' : 'GPS 신호를 잡았음.', 'queue'); }
      if (S.lastFixAt && now() - S.lastFixAt >= 60000) S.wentUnder = true;   // 1분 넘게 위치가 없었음(지하에 있었음)
      S.lastFixAt = now(); S.fixInLeg = true;
      S.fix = fix;
      S.track.push({ lat: fix.lat, lng: fix.lng, t: fix.t || now() });
      while (S.track.length > 12 || (S.track.length > 2 && S.track[S.track.length - 1].t - S.track[0].t > 15000)) S.track.shift();
      const l = leg(); if (!l) return;
      if (HF() && (l.type === 'subway' || l.type === 'indoor')) return surfaceCheck(l, fix);
      if (l.type === 'bus') return busTick(l);
      if (l.type !== 'walk') return;

      const t = target(); if (!t) return;
      if (!hasXY(t)) {
        if (S.warnedMissing !== t.id) {
          S.warnedMissing = t.id;
          say(`${t.name} 위치 정보가 없어 방향을 안내할 수 없음. 주변 사람에게 위치를 물어보세요. 도착하면 다음 버튼을 누르세요.`, 'queue');
          io.vibrate(PAT.warn);
        }
        return;
      }
      const tNow = now();
      const d = dist(fix, t);
      if (fix.speed > 3.5) {   // 차량 속도: 도보 안내를 하지 않음. 10초 넘게 이어지면 다음 버튼을 놓치고 버스에 탄 것으로 보고 하차 알림을 시작
        S.vehCnt = (S.vehCnt || 0) + 1;
        const nl = S.route.legs[S.li + 1];
        const pl0 = S.li > 0 ? S.route.legs[S.li - 1] : null;
        if (S.vehCnt >= 10 && HF() && pl0 && pl0.type === 'bus' && S.pi === 0 && (l.startMedian ? !S.crossed : true) && now() - S.legAt < 180000) { enterLeg(S.li - 1, '아직 버스 안인 것으로 보고 하차 알림을 계속함.'); S.busRiding = true; return; }
        if (S.vehCnt >= 10 && (S.pi >= l.points.length - 1 || HF()) && nl && nl.type === 'bus') { if (io.onAuto) io.onAuto('board', S.track[0] || fix); return enterLeg(S.li + 1, '버스에 탄 것으로 보고 하차 알림을 시작함.'); }
        if (S.vehCnt === 10) say('차량으로 이동 중인 것 같음. 걷는 중이 아니면 다음 버튼으로 단계를 맞춰 주세요.', 'queue');
        return;
      }
      S.vehCnt = 0;
      // 중앙 승강장에 내린 직후: 길을 건넜다고 확인하기 전에는 방향·거리 안내를 하지 않음(승강장 위의 직선 방향은 차로를 가리킴)
      if (l.startMedian && !S.crossed && HF()) {   // 승강장(이전 버스 구간의 하차 좌표)에서 40m 넘게 벗어나면 길을 건넌 것으로 봄
        const pb = S.li > 0 ? S.route.legs[S.li - 1].alight : null;
        const ref = [pb, pb && pb.alt, S.crossFrom].filter(hasXY);
        if (!S.crossFrom) S.crossFrom = { lat: fix.lat, lng: fix.lng };
        const away = Math.min(...[S.crossFrom].concat(ref).map((q) => dist(fix, q)));
        const ca = hasXY(l.crossAt) ? l.crossAt : null, dc = ca ? dist(fix, ca) : Infinity;
        if (ca && dc <= 20) S.nearCross = true;
        // 횡단보도 위치를 알면: 횡단보도 근처까지 갔다가 15m 넘게 벗어나고 승강장에서 50m 넘게 떨어졌을 때 건넌 것으로 봄. 모르면 승강장에서 40m
        S.crossCnt = (ca ? (S.nearCross && dc >= 15 && away >= 50) : away >= 40) ? (S.crossCnt || 0) + 1 : 0;
        if (S.crossCnt >= 3) { S.crossed = true; S.lastGuidePos = null; if (io.onAuto) io.onAuto('crossed', fix); say('승강장에서 벗어난 것으로 보고 방향 안내를 시작함.', 'queue'); }
      }
      if (l.startMedian && !S.crossed && hasXY(l.crossAt)) {   // 건너기 전: 횡단보도까지 남은 거리만 알림(승강장을 따라 걷는 직선 구간), 근처에 오면 신호 정보
        const ca = l.crossAt, dc = dist(fix, ca);
        if (dc <= 20 && !S.crossInfoSaid) { S.crossInfoSaid = true; io.vibrate(PAT.warn); say(`횡단보도 근처임. ${ca.info || ''} 신호와 차량 소리를 직접 확인하고 건너세요.`, 'high'); }
        else if (dc > 20 && (!S.caSaidAt || tNow0() - S.caSaidAt >= 30000)) { S.caSaidAt = tNow0(); say(`횡단보도까지 약 ${fmtDist(dc)}.`, 'queue'); }
      }
      if (l.startMedian && !S.crossed) {
        if (!S.crossAskAt || tNow0() - S.crossAskAt >= 60000) { const first = !S.crossAskAt; S.crossAskAt = tNow0(); if (!first) say('길을 건너 인도에 올라섰으면 다음 버튼을 누르세요.', 'queue'); }
        return;
      }
      // 지하철에서 내린 직후 첫 지점이 500m 넘게 떨어져 있으면 역을 잘못 센 것일 수 있음. 정확한 위치가 연속 3회 확인될 때만 알림
      const prevLegType = S.li > 0 ? S.route.legs[S.li - 1].type : null;
      if (S.pi === 0 && (prevLegType === 'subway' || prevLegType === 'indoor') && !S.fixNear && (fix.acc || 0) <= 50) {
        if (d > 500) {
          S.farCnt = (S.farCnt || 0) + 1;
          if (S.farCnt < 3) return;   // 확인되는 동안(2초)은 방향 안내를 보류
          if (S.farCnt >= 3 && (!S.farAt || tNow - S.farAt >= 60000)) { S.farAt = tNow; io.vibrate(PAT.warn); say(`현재 위치가 ${nm(t)}에서 ${fmtDist(d)} 떨어져 있음. 내린 역이 맞는지 안내방송이나 주변 사람에게 확인하세요. 한 역 일찍 내렸으면 이전 단계 버튼을 눌러 한 역을 되돌릴 수 있음.`, 'high'); return; }
        } else { S.fixNear = true; S.farCnt = 0; }
      }
      // 도로 한가운데(중앙차로) 정류장: 직선 방향 안내는 차도를 가로지르게 하므로 60m 안에서는 방향·비프·도착 판정을 모두 멈추고 도움을 받게 함
      if (t.median && d <= 60) {
        if (!S.medianAt || (tNow - S.medianAt >= 60000 && !S.medianRep)) {
          const firstTime = !S.medianAt; if (!firstTime) S.medianRep = true; S.medianAt = tNow; S.nearSaid = true; io.vibrate(PAT.warn);
          say(firstTime
            ? `${nm(t)} 근처임. 이 정류장은 도로 한가운데 승강장이라 여기서부터 방향 안내를 멈춤. ${t.crossHint || '횡단보도 위치는 앱이 모름.'} 주변 사람에게 중앙 버스정류장으로 가는 횡단보도를 물어보세요. 승강장에 올라서면 다음 버튼을 누르세요.`
            : `${nm(t)}은 도로 한가운데 승강장임. 횡단보도는 주변 사람에게 물어보세요. 승강장에 올라서면 다음 버튼을 누르세요.`, firstTime ? 'high' : 'queue');
        }
        return;
      }
      const weak = isWeak(t);
      const base = t.radius || C.defaultRadius;
      const radius = Math.max(base, Math.min(fix.acc || 0, C.accCap));
      // 도착 확정: 최근 3회 중 2회가 반경 안(가장자리 잡음에 강함), 반경 절반 안이면 즉시. 튄 측정 1회로는 확정하지 않음
      const rIn = (fix.acc || 0) > 15 ? radius : base;   // GPS가 양호하면 지점 반경 그대로, 나쁠 때만 오차만큼 넓힘
      S.inHist.push(d <= rIn); if (S.inHist.length > 3) S.inHist.shift();
      const prevD = S.prevD; S.prevD = d;
      const h = S.inHist, n = h.length;
      const two = n >= 2 && h[n - 1] && h[n - 2], three = n >= 3 && two && h[n - 3];
      if (weak && (t.kind === 'turn' || t.kind === 'crossing') && S.pi < l.points.length - 1 && d <= 25 && S.inHistW(d <= 25)) {
        // 확인되지 않은 꺾는 곳: 근처(15m)에 오면 '이 근처'라고 알리고 다음 지점 안내로 넘어감(도착이라고 하지 않음, 멈춰서 기다리게 하지 않음)
        io.vibrate(t.turn === 'left' ? PAT.left : t.turn === 'right' ? PAT.right : PAT.ahead);
        S.pi++; S.minD = Infinity; S.lastGuidePos = null; S.inHist = []; S.prevD = null; S.nearSaid = false; S.atSaid = false; S.nearRep = 0; S.wHist = [];
        say(t.say || `${nm(t)} 근처임.`, 'high'); return;
      }
      if (weak) {   // 확인되지 않은 좌표에서는 도착을 선언하지 않음: 저장된 위치에 왔음을 알리고 이용자가 찾은 뒤 다음 버튼으로 진행
        if (two && !S.atSaid) { S.atSaid = true; S.nearSaid = true; S.nearAt = tNow; io.vibrate(PAT.ahead); say(`저장된 위치에 왔음. 찾는 곳은 이 주변 수십 미터 안에 있을 수 있음. 주변 사람에게 물어보고, 찾았으면 다음 버튼을 누르세요.`, 'high'); }
      } else
      // 걷는 중에는 연속 3회, 멈춰 서 있으면 연속 2회로 확정(스치는 GPS 오차로 거짓 도착하지 않게). 옆을 지나쳐 확정되지 않으면 아래 지나침 안내가 멈춰서 확인하게 함
      if (three || (two && fix.speed < 0.5) || (d <= rIn * 0.5 && prevD != null && prevD <= rIn * 0.75)) return arrive(t);   // 한 번의 측정만으로는 확정하지 않음
      // 약한 좌표: 30m 안에 들어오면 '부근'임을 한 번 알리고 안내는 계속함(일찍 도착 처리해 이용자를 혼자 두지 않음)
      if (weak && S.nearSaid && d <= 45 && tNow - S.nearAt >= 45000) { S.nearAt = tNow; S.nearRep = (S.nearRep || 0) + 1; if (S.nearRep === 1) say('찾았으면 다음 버튼을 누르세요.', 'queue'); else io.vibrate(PAT.ahead); }   // 재알림은 한 번만, 이후에는 진동만
      if (weak && d <= 30 && !S.nearSaid && t.kind !== 'turn' && t.kind !== 'crossing') {
        S.nearSaid = true; S.nearAt = tNow; io.vibrate(PAT.ahead);
        say(`${nm(t)} 부근임. 30미터 안에 있을 수 있음. 주변 사람에게 확인하고, 찾았으면 다음 버튼을 누르세요.`, 'high');
      }
      // 오디오 비콘(좌우 스테레오): 목적지가 있는 쪽 귀에서 소리가 남. 이어폰 사용 시 효과적
      if (io.beacon && tNow - S.lastBeacon >= 1200) {
        const rb = relTo(t);
        if (rb && rb.ck) { S.lastBeacon = tNow; io.beacon(rb.ck.rel, d); }
      }
      // 꺾는 곳 사전 예고: 30m 전, 10m 전 (갈림길·굽은 길을 미리 알려 주는 방식)
      if (t.turn) {
        const dir = t.turn === 'left' ? '왼쪽' : '오른쪽';
        const k30 = `${S.li}-${S.pi}-30`, k10 = `${S.li}-${S.pi}-10`;
        if (d <= 12 && !S.pre[k10]) { S.pre[k10] = S.pre[k30] = true; io.vibrate(t.turn === 'left' ? PAT.left : PAT.right); say(`곧 ${dir}으로 꺾기.`, 'high'); }
        else if (d <= 30 && !S.pre[k30]) { S.pre[k30] = true; say(`약 ${fmtDist(d)} 앞에서 ${dir}으로 꺾기.`, 'high'); }
      }
      const endKind = ['stop', 'dest', 'entrance', 'exit'].includes(t.kind);
      S.awayCnt = d > S.minD + 15 ? S.awayCnt + 1 : 0;
      if (d <= base) S.closeCnt++;
      if (d < S.minD) S.minD = d;
      else if ((t.kind === 'turn' || t.kind === 'crossing') && S.minD <= Math.max(20, 2 * base) && S.awayCnt >= 3 && S.pi < l.points.length - 1) {
        // 꺾는 곳 가까이(20m 안)까지 왔다가 3회 연속 멀어진 경우만: 스쳐 지나간 것으로 보고 알린 뒤 다음 지점으로
        S.pi++; S.minD = Infinity; S.lastGuidePos = null; S.inHist = []; S.awayCnt = 0; S.nearSaid = false;
        say(`${t.name} 지점을 지나친 것 같음. ${t.say || ''} 다음 지점으로 안내함.`, 'high'); return;
      }
      else if (endKind && !weak && S.minD < 45 && d > S.minD + C.overshootM && fix.speed >= 0.5 && S.awayCnt >= 3 && tNow - S.lastOverAt > 15000) {   // 서 있을 때의 GPS 잡음으로는 지나침을 말하지 않음
        S.lastOverAt = tNow; io.vibrate(PAT.back);
        const r = relTo(t);
        // GPS 오차로는 '바로 옆을 지남'과 '지나침'을 확실히 구분할 수 없어 단정하지 않고 멈춰서 확인하게 함
        say(`${nm(t)} 지점을 지나친 것 같음. 멈추세요. 방향은 ${r ? r.text : ''}, 거리는 ${fmtDist(d)} 안팎임. 바로 옆일 수도 있으니 주변을 확인하고, 아니면 그 방향으로 돌아가세요.`, 'high');
        S.minD = d; // 재측정
        return;
      }
      // 경로 이탈 (이전 지점이 있을 때)
      const prev = S.pi > 0 ? l.points[S.pi - 1] : l.start;
      if (hasXY(prev) && !weak && !isWeak(prev)) {   // 약한 좌표로는 이탈 경고를 하지 않음(오경보가 도로 방향 유도로 이어질 수 있음)
        const sd = segDist(fix, prev, t);
        if (S.offRoute && sd <= Math.max(10, fix.acc || 0)) { S.offRoute = false; say('경로로 돌아왔음.', 'queue'); }
        if (sd > Math.max(C.offRouteM, (fix.acc || 0) * 1.5) && tNow - S.lastOffAt > C.offRouteGapSec * 1000) {
          S.offRoute = true; S.lastOffAt = tNow; io.vibrate(PAT.warn);
          const r = relTo(t);
          say(`경로에서 ${fmtDist(sd)} 벗어났음. ${t.name} 쪽은 ${r ? r.text : ''}, ${fmtDist(d)}`, 'high');
          S.lastGuideAt = tNow; S.lastGuidePos = { lat: fix.lat, lng: fix.lng };
          return;
        }
      }
      // 근접 비프: 가까울수록 빠르게, 정면이면 높은 음
      if (endKind && d < C.beepRangeM && io.beep) {
        const interval = Math.max(300, Math.min(2000, d * 60));
        if (tNow - S.lastBeepAt > interval) {
          S.lastBeepAt = tNow;
          const r = relTo(t);
          io.beep(r && r.ck && r.ck.cls === 'ahead' ? 880 : 440);
        }
      }
      // 주기 안내
      const moved = S.lastGuidePos ? dist(S.lastGuidePos, fix) : Infinity;
      const r = relTo(t);
      const cls = r && r.ck ? r.ck.cls : null;
      const first = !S.lastGuidePos;
      const tr0 = S.track[0], trD = tr0 ? dist(tr0, fix) : 0;
      const moving = fix.speed >= 0.5 || (fix.speedKnown === false && trD >= Math.max(8, 2.5 * (fix.acc || 5)));   // 기기가 속도를 못 줄 때만 궤적으로 판단   // 흰지팡이 보행(0.5~1.0m/s)도 이동으로 인정
      if (cls === S.pendCls) S.clsStreak++; else { S.pendCls = cls; S.clsStreak = 1; }
      const stopped = S.wasMoving && !moving; S.wasMoving = moving;
      if (stopped && endKind && d <= 30 && tNow - S.lastGuideAt >= 20000) return guide('first');   // 목표 근처에서 멈춰 서면 남은 거리와 방향을 바로 알려줌(무음으로 기다리게 하지 않음)
      const gotHeading = !first && S.lastCls === null && cls !== null; // 첫 안내가 방향 없이 나갔다면 방향 확보 즉시 재안내
      if (first || gotHeading || (moving && (moved >= (cls === 'ahead' ? 80 : C.guideEveryMeters) || (tNow - S.lastGuideAt >= (cls === 'ahead' ? 45 : C.guideEverySec) * 1000 && moved >= 5)))) {   // 맞게 가는 중이면 덜 자주 말함
        return guide(first ? 'first' : 'auto');
      }
      if (weak && (t.kind === 'turn' || t.kind === 'crossing')) return;
      const wrongWay = moving && cls === 'back' && S.clsStreak >= 3 && tNow - S.lastCueAt >= (weak ? 20000 : C.cueGapSec * 1000); // 알려 준 반대 방향으로 계속 걸으면 8초마다 다시 알림
      if (wrongWay || moving && cls && cls !== S.lastCls && S.clsStreak >= 2 && tNow - S.lastCueAt >= (cls === 'ahead' ? 20000 : C.cueGapSec * 1000) && moved >= 3) { // 같은 방향이 연속 2회일 때만(잡음으로 인한 번복 방지)
        const short = { ahead: '정면, 맞게 가는 중', 'left-s': '목표는 조금 왼쪽', 'right-s': '목표는 조금 오른쪽', 'left-m': '목표는 왼쪽 방향', 'right-m': '목표는 오른쪽 방향', 'left-b': '목표는 왼쪽 뒤쪽', 'right-b': '목표는 오른쪽 뒤쪽', back: weak ? (S.awayCnt >= 3 ? '목표에서 멀어지고 있음. 멈춰서 주변 사람에게 확인하세요' : '목표는 뒤쪽 방향임. 길을 따라 돌아가는 중이면 계속 가세요') : '반대 방향으로 가고 있음. 목표는 뒤쪽' }[cls];   // 길 모양을 모르므로 꺾으라고 지시하지 않고 목표 방향만 알림
        if (!say(`${short}. ${fmtDist(d)} 남음`, cls === 'back' ? 'high' : 'normal')) return;   // 유턴 경고는 다른 안내를 끊고 말함
        S.lastCueAt = tNow; S.lastCls = cls;
        io.vibrate(cls === 'ahead' ? PAT.ahead : cls.startsWith('left') ? PAT.left : cls === 'back' ? PAT.back : PAT.right);
      }
    }

    // 버튼 없는 모드: 지하철·환승 구간에서 GPS가 다시 잡히고 걷는 속도면 지상에 나온 것으로 보고 다음 도보 구간으로 넘어감
    function surfaceCheck(l, fix) {
      let j = -1;
      for (let k = S.li + 1; k < S.route.legs.length; k++) { const tp = S.route.legs[k].type; if (tp === 'walk') { j = k; break; } if (tp === 'bus') break; }
      if ((fix.acc || 0) > 50) return;
      S.surfCnt = fix.speed >= 0.3 && fix.speed <= 2.5 ? (S.surfCnt || 0) + 1 : 0;
      if (S.surfCnt < 8 || !S.wentUnder) return;
      if (j < 0) {   // 뒤에 도보 구간이 없는 마지막 지하철·환승 구간(예: 집으로 가는 길)
        if (S.li + 1 < S.route.legs.length) enterLeg(S.li + 1, '지상에 나온 것으로 보고 다음 안내를 시작함.');
        return;
      }
      const first = S.route.legs[j].points.find((q) => hasXY(q));
      if (!first || dist(fix, first) <= 450) return enterLeg(j, '지상에 나온 것으로 보고 도보 안내를 시작함.');
      if (!S.surfWarnAt || now() - S.surfWarnAt >= 90000) { S.surfWarnAt = now(); io.vibrate(PAT.warn); say(`지상 위치가 ${nm(first)}에서 ${fmtDist(dist(fix, first))} 떨어져 있음. 내린 역이 맞는지 안내방송이나 주변 사람에게 확인하세요.`, 'high'); }
    }

    function busTick(l) {
      let a = l.alight, fb = false, scale = 0;
      if (!hasXY(a)) {                 // 하차 정류장 좌표가 없으면 사무실(다음 도보 구간의 끝)까지 남은 거리로 대신 안내
        const nl = S.route.legs[S.li + 1], d = nl && nl.type === 'walk' ? nl.points[nl.points.length - 1] : null;
        if (!hasXY(d)) {               // 좌표가 전혀 없으면 3분마다 안내(무음이면 앱이 멈춘 것과 구별할 수 없음)
          const tn = now(); if (!S.busNoteAt) S.busNoteAt = tn;
          if (tn - S.busNoteAt >= 180000) { S.busNoteAt = tn; say('버스 이동 중. 하차 위치 정보가 없으니 안내방송으로 정류장 이름을 확인하세요. 내린 뒤 다음 버튼을 누르세요.', 'queue'); }
          return;
        }
        const m = (nl.title || '').match(/([\d,]+)\s*미터/);
        a = { name: '하차 정류장', lat: d.lat, lng: d.lng }; fb = true; scale = m ? +m[1].replace(/,/g, '') : 300;
      }
      if (!S.fix) return;
      const d = hasXY(a.alt) ? Math.min(dist(S.fix, a), dist(S.fix, a.alt)) : dist(S.fix, a);   // 같은 이름 승강장이 둘이면 먼저 지나는 쪽 기준
      if (S.fix.speed > 3) S.busRiding = true;
      if (S.busRiding && (S.fix.acc || 0) <= 50) {   // 버스가 달리기 시작한 뒤, 정확한 위치로만 판단
        if (S.busMin == null || d < S.busMin) S.busMin = d;
        else if (d > S.busMin + 200) { S.busMin = d; io.vibrate(PAT.warn); say('하차 위치에서 멀어지고 있음. 지나쳤거나 다른 방향 버스일 수 있으니 안내방송으로 확인하세요.', 'high'); }   // 200m 더 멀어질 때마다 다시 알림
      }
      if (fb) {
        // 정류장 위치를 모름: 정류장은 목적지에서 도보거리(scale) 안에 있으므로, 그 범위에 들어서면 한 번만 알리고 하차 시점은 단정하지 않음
        if (S.busStage === 0 && d <= scale + 100) {
          S.busStage = 1; io.vibrate(PAT.warn);
          say('하차 정류장이 가까움. 정확한 위치는 모르니 지금부터 안내방송을 듣고 정류장 이름이 나오면 하차벨을 누르고 내리세요. 내린 뒤 다음 버튼을 누르세요.', 'high');
        }
        return;
      }
      if (HF() && S.busRiding && d <= 150) {   // 하차 정류장 근처에서 걷는 속도가 12초 이어지면 내린 것으로 봄
        S.offCnt = S.fix.speed < 2.5 ? (S.offCnt || 0) + 1 : 0;
        if (S.offCnt >= 12) { if (io.onAuto) io.onAuto('alight', S.fix); return enterLeg(S.li + 1, '버스에서 내린 것으로 보고 다음 안내를 시작함.'); }
      }
      const wk = isWeak(a);
      const two = hasXY(a.alt);
      const stages = two ? [[500, '하차 정류장까지 약 500미터. 하차 준비'], [150, `곧 하차 정류장. 하차벨을 누르세요. 버스가 서고 정류장 이름이 ${a.name}이면 그때 내리세요`], [40, `하차 정류장 부근임. 지금 서는 정류장 이름이 ${a.name}이면 내리세요. 같은 이름 승강장이 둘이라 한 곳을 지나칠 수 있음. 내린 뒤 다음 버튼을 누르세요`]] : [[500, '하차 정류장까지 약 500미터. 하차 준비'], [150, wk ? '곧 하차 정류장일 수 있음. 안내방송을 확인하고 하차벨을 누르세요' : '곧 하차. 하차벨을 누르세요'], [40, wk ? '하차 정류장 부근일 수 있음. 정류장 이름 안내방송이 나오고 문이 열리면 내리세요. 내린 뒤 다음 버튼을 누르세요' : '하차 정류장에 도착함. 내리세요']];
      for (let k = S.busStage; k < stages.length; k++) {
        if (d <= stages[k][0]) {
          S.busStage = k + 1; io.vibrate(k === 2 ? PAT.arrive : PAT.warn);
          if (k === 2 && !wk) return enterLeg(S.li + 1, `${a.name}. ${stages[k][1]}.`);
          say(two ? `${stages[k][1]}.` : `${stages[k][1]}. ${a.name}.`, 'high'); break;
        }
      }
    }

    function autoTick() {
      if (!HF()) return;
      const l = leg(); if (!l) return;
      const t = now(), el = (t - S.legAt) / 60000, nl = S.route.legs[S.li + 1];
      if (l.type === 'subway' || l.type === 'indoor') {
        const min = l.minutes || (l.type === 'subway' && l.stations ? (l.stations.length - 1) * 2 : 4);
        if (l.type === 'subway' && l.stations && !S.soonSaid && el >= min * 0.8) {
          S.soonSaid = true; io.vibrate(PAT.warn);
          say(`곧 하차역일 수 있음. 안내방송에서 ${l.stations[l.stations.length - 1]}역이 나오면 내리세요. 시간으로 어림한 안내라 정확하지 않음.`, 'high');
        }
        if (nl && nl.type !== 'walk' && nl.type !== 'bus' && el >= min * 1.25) enterLeg(S.li + 1);   // 지하에서 이어지는 환승·다음 열차 안내는 시간 기준으로 넘어감
      } else if (l.type === 'walk' && nl && (nl.type === 'subway' || nl.type === 'indoor') && S.gpsLost && S.fixInLeg && el >= 2) {
        const tg = target();
        if (!hasXY(tg) || (S.fix && dist(S.fix, tg) <= 150)) enterLeg(S.li + 1, '지하로 들어간 것으로 보고 다음 안내를 시작함.');
      }
    }
    function checkSilence() {
      autoTick();
      const l = leg(); if (!l || (l.type !== 'walk' && l.type !== 'bus') || !S.lastFixAt) return;
      if (!S.gpsLost && now() - S.lastFixAt >= 20000) {
        S.gpsLost = true; io.vibrate(PAT.warn);
        say(S.fixInLeg ? 'GPS 신호가 없음. 방금 안내한 위치를 기준으로 계속 가세요. 신호가 돌아오면 알려줌.' : (S.li > 0 && ['subway', 'indoor'].includes(S.route.legs[S.li - 1].type) ? '지상으로 나오면 방향을 알려줌.' : '아직 GPS 신호를 잡지 못했음. 하늘이 트인 곳에서 잠시 기다리세요.'), 'queue');
      }
    }
    function onCompass(h) { S.compass = { val: ((h % 360) + 360) % 360, t: now() }; checkSilence(); }

    // ---------- 사용자 조작 ----------
    function start(route, legIndex) { S.route = route; enterLeg(legIndex || 0, !legIndex && route.overview ? route.overview : undefined); }   // 처음부터 시작하면 경로 전체 소개를 먼저 읽음
    function repeat() {
      const l = leg();
      const tg = target();
      if (l && l.type === 'walk' && l.startMedian && !S.crossed) return say((l.brief || l.intro || '') + ' 길을 건너 인도에 올라섰으면 다음 버튼을 누르세요.', 'high');
      if (l && l.type === 'walk' && S.fix && hasXY(tg) && tg.median && dist(S.fix, tg) <= 60) return say(`${nm(tg)}은 도로 한가운데 승강장이라 방향 안내를 멈췄음. 횡단보도는 주변 사람에게 물어보세요. 승강장에 올라서면 다음 버튼을 누르세요.`, 'high');
      if (l && l.type === 'walk' && S.fix && hasXY(tg)) return guide('repeat');
      if (S.last) say(S.last, 'high');
    }
    // 현재 구간의 "다음" 동작
    function next() {
      const l = leg(); if (!l) return;
      if (l.type === 'walk' && l.startMedian && !S.crossed) { S.crossed = true; S.lastGuidePos = null; return say('길을 건넌 것으로 처리함. 이제 방향을 안내함.', 'high'); }
      if (l.type === 'walk') {
        const cur = l.points[S.pi], tip = cur && cur.say ? cur.say + ' ' : '';
        if (S.pi >= l.points.length - 1) return enterLeg(S.li + 1, tip + '구간 종료.');
        S.pi++; S.minD = Infinity; S.lastGuidePos = null; S.inHist = []; S.nearSaid = false; S.atSaid = false; S.medianAt = 0; S.medianRep = false; S.nearRep = 0;
        return say(`${tip}다음 지점, ${nm(l.points[S.pi])}`, 'high');
      }
      if (l.type === 'subway' && l.stations && S.stIdx < l.stations.length - 1) {
        S.stIdx++;
        const left = l.stations.length - 1 - S.stIdx;
        const nm = l.stations[S.stIdx];
        if (left === 0) { io.vibrate(PAT.arrive); return enterLeg(S.li + 1, `${nm}역 도착. 하차역임. 내리세요.`); }
        io.vibrate(left === 1 ? PAT.warn : PAT.ahead);
        return say(`${nm}역. 내릴 역까지 ${left}개 남음.` + (left === 1 ? ` 다음 역이 하차역, ${l.stations[S.stIdx + 1]}. 하차 준비.` : ''), 'high');
      }
      enterLeg(S.li + 1);
    }
    function skipLeg() { if (leg()) enterLeg(S.li + 1, '구간을 건너뜀.'); }
    function prevLeg() {
      const l = leg();
      if (l && l.type === 'subway' && l.stations && S.stIdx > 0) { S.stIdx--; return say(`한 역 되돌렸음. 현재 ${l.stations[S.stIdx]}역. 내릴 역까지 ${l.stations.length - 1 - S.stIdx}개 남음.`, 'high'); }
      const pl = S.route && S.li > 0 && S.li < S.route.legs.length ? S.route.legs[S.li - 1] : null;
      if (l && l.type !== 'subway' && S.pi === 0 && pl && pl.type === 'subway' && pl.stations && pl.stations.length >= 2) {
        // 하차 처리 직후 되돌림: 지하철 구간으로 돌아가되 역 세기는 '하차역 한 역 전'으로 유지(처음으로 초기화하지 않음)
        S.li -= 1; S.pi = 0; S.stIdx = pl.stations.length - 2; S.minD = Infinity; S.lastGuidePos = null; S.fixNear = false; S.farCnt = 0; S.farAt = 0;
        if (io.onLegChange) io.onLegChange(S.li, pl);
        return say(`한 역 되돌렸음. 현재 ${pl.stations[S.stIdx]}역으로 처리함. 다음 역이 하차역 ${pl.stations[S.stIdx + 1]}. 도착하면 다음 버튼을 누르세요.`, 'high');
      }
      if (S.route) enterLeg(Math.max(0, Math.min(S.li, S.route.legs.length) - 1));
    }

    function snapshot() { return S.route && S.li >= 0 && S.li < S.route.legs.length ? { li: S.li, pi: S.pi, stIdx: S.stIdx } : null; }
    function restore(route, snap) {
      S.route = route; S.li = Math.max(0, Math.min(snap.li, route.legs.length - 1)); S.pi = snap.pi || 0; S.stIdx = snap.stIdx || 0;
      S.minD = Infinity; S.lastGuidePos = null; S.lastGuideAt = 0; S.busStage = 0; S.inCnt = 0; S.warnedMissing = null;
      const l = leg();
      say(`이어서 안내함. ${l.title}.` + (l.type === 'subway' && l.stations ? ` 현재 ${l.stations[S.stIdx]}역. 내릴 역까지 ${l.stations.length - 1 - S.stIdx}개 남음.` : ''), 'high');
      S.lastFixAt = now(); S.gpsLost = false; S.fixInLeg = false;
      if (io.onLegChange) io.onLegChange(S.li, l);
    }

    function status() {
      const l = leg(), t = target(), r = t ? relTo(t) : null;
      return {
        legIndex: S.li, legCount: S.route ? S.route.legs.length : 0, leg: l, point: t,
        dist: r ? r.d : null, rel: r && r.ck ? r.ck.rel : null, clock: r ? r.text : null,
        headingSrc: r && r.h ? r.h.src : (currentHeading() || {}).src || null,
        acc: S.fix ? S.fix.acc : null, last: S.last,
        stIdx: S.stIdx, near: S.nearSaid, waitCross: !!(l && l.startMedian && !S.crossed),
        busEarly: !!(l && l.type === 'bus' && S.fix && (S.fix.speed > 3 || (hasXY(l.alight) && Math.min(dist(S.fix, l.alight), hasXY(l.alight.alt) ? dist(S.fix, l.alight.alt) : Infinity) > 300))),
      };
    }

    return { start, repeat, next, skipLeg, prevLeg, onFix, onCompass, tick: checkSilence, setHandsFree(v) { handsFree = !!v; }, detail, snapshot, restore, status, _S: S };
  }

  return { createEngine, spoken, robustFuse, geoMedian, createKalman, median, medianPoint, spreadM, REC, dist, bearing, norm180, segDist, clock, cardinal, fmtDist, compassHeading, PAT, hasXY };
});
