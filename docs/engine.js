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
      .replace(/(?<![\d.])(\d{3,4})(?![\d.]|\s*(미터|킬로|개|분|초|도|회|배|원|년|번지))/g, (m) => m.split('').join(' ')) // 버스 번호 5602 → 5 6 0 2
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
      lastOffAt: 0, lastOverAt: 0, lastBeepAt: 0, lastBeacon: 0, pre: {}, inCnt: 0, pendCls: null, clsStreak: 0, lastFixAt: 0, gpsLost: false, fixInLeg: false, busNoteAt: 0, offRoute: false, farWarned: false, busMin: null, busFar: false, warnedMissing: null, busStage: 0,
    };

    const isWeak = (p) => !!p && p.weak === true;   // 걸어서 확인되지 않은 지도 기준 좌표
    const leg = () => (S.route ? S.route.legs[S.li] : null);
    const target = () => { const l = leg(); return l && l.type === 'walk' ? l.points[S.pi] : null; };

    function say(text, prio) {
      S.last = text;
      const ok = io.speak(text, prio || 'normal') !== false;   // false = 다른 안내를 말하는 중이라 버려짐
      if (ok && io.notify) io.notify(text);
      return ok;
    }

    function currentHeading() {
      const t = now(), f = S.fix, moving = !!f && f.speed >= 1.0;
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
      if (!say(`${nm(t)}까지 ${isWeak(t) ? '대략 ' : ''}${fmtDist(r.d)}, ${r.text}`, prio)) return;
      S.lastGuideAt = now(); S.lastGuidePos = { lat: S.fix.lat, lng: S.fix.lng };
      S.lastCls = r.ck ? r.ck.cls : null;
      if (r.ck) io.vibrate(r.ck.cls === 'ahead' ? PAT.ahead : r.ck.cls.startsWith('left') ? PAT.left : r.ck.cls === 'back' ? PAT.back : PAT.right);
    }

    function legIntro(l, i) {
      const head = l.intro ? '' : `${l.title}.`;   // 소개 문장이 있으면 제목은 읽지 않음(같은 말 반복 방지)
      if (l.type === 'walk') {
        const weak = l.points.filter((p) => hasXY(p) && isWeak(p)).length;
        return `${head} ${l.intro || ''}`.trim() + (l.learned && l.learned.text ? ` 걸었던 기록: ${l.learned.text}.` : '') + (weak ? ' 위치 정보가 현장에서 확인되지 않아 오차가 있을 수 있음.' : '');
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

    function enterLeg(i, prefix) {
      if (i >= S.route.legs.length) {
        S.li = S.route.legs.length; // 종료
        say((prefix ? prefix + ' ' : '') + '모든 안내가 끝났음. 목적지에 도착했음.', 'high');
        io.vibrate(PAT.arrive); return;
      }
      S.li = i; S.pi = 0; S.stIdx = 0; S.minD = Infinity; S.busStage = 0;
      S.lastGuidePos = null; S.lastGuideAt = 0; S.warnedMissing = null; S.inCnt = 0; S.busMin = null; S.busFar = false; S.busNoteAt = 0; S.offRoute = false; S.farWarned = false;
      S.lastFixAt = now(); S.gpsLost = false; S.fixInLeg = false;   // 지하 구간 동안의 무수신을 새 구간의 GPS 두절로 오인하지 않음
      const l = leg();
      if (prefix) { say(prefix, 'high'); say(legIntro(l, i), 'queue'); }   // 급한 말을 먼저, 소개는 이어서(짧은 두 번의 낭독)
      else say(legIntro(l, i), 'high');
      if (io.onLegChange) io.onLegChange(i, l);
    }

    function arrive(p) {
      io.vibrate(PAT.arrive);
      S.minD = Infinity; S.lastGuidePos = null; S.lastGuideAt = 0; S.inCnt = 0;
      const msg = (isWeak(p) ? `${p.name} 부근에 도착함. 오차가 있을 수 있으니 주변 사람이나 안내방송으로 확인하세요. ${p.say || ''}` : `${p.name} 도착. ${p.say || ''}`).trim();
      if (S.pi >= leg().points.length - 1) enterLeg(S.li + 1, msg);
      else { S.pi++; say(msg, 'high'); }
    }

    // ---------- 외부 입력 ----------
    function onFix(fix) {
      if (S.gpsLost) { S.gpsLost = false; say(S.fixInLeg ? 'GPS 신호가 돌아왔음.' : 'GPS 신호를 잡았음.', 'queue'); }
      S.lastFixAt = now(); S.fixInLeg = true;
      S.fix = fix;
      S.track.push({ lat: fix.lat, lng: fix.lng, t: fix.t || now() });
      while (S.track.length > 12 || (S.track.length > 2 && S.track[S.track.length - 1].t - S.track[0].t > 15000)) S.track.shift();
      const l = leg(); if (!l) return;
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
      if (S.pi === 0 && !S.farWarned && d > 1500) { S.farWarned = true; io.vibrate(PAT.warn); say(`현재 위치가 ${t.name}에서 ${fmtDist(d)} 떨어져 있음. 아직 도착하지 않았을 수 있으니 안내방송과 주변을 확인하세요.`, 'high'); }
      const weak = isWeak(t);
      const radius = Math.max(t.radius || C.defaultRadius, Math.min(fix.acc || 0, C.accCap), weak ? 30 : 0); // 지도 기준 좌표는 오차 30m를 반영
      if (d <= radius) { S.inCnt++; const need = weak ? (fix.acc <= 10 ? 1 : 2) : (d <= radius * 0.5 ? 1 : d <= radius * 0.8 ? 2 : 3); if (S.inCnt >= need) return arrive(t); } else S.inCnt = 0; // 튄 측정이나 스치는 잡음으로 도착 처리하지 않음

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
      if (d < S.minD) S.minD = d;
      else if ((t.kind === 'turn' || t.kind === 'crossing') && S.minD < 40 && d > S.minD + 15 && S.pi < l.points.length - 1) {
        S.pi++; S.minD = Infinity; S.lastGuidePos = null; S.inCnt = 0; return; // 꺾는 곳·횡단보도를 스쳐 지나갔으면 되돌아가라 하지 않고 다음 지점으로
      }
      else if (endKind && !weak && S.minD < 45 && d > S.minD + C.overshootM && tNow - S.lastOverAt > 15000) {
        S.lastOverAt = tNow; io.vibrate(PAT.back);
        const r = relTo(t);
        say(`지나친 것 같음. 멈추고 ${t.name} 쪽으로 돌아가야 함. ${fmtDist(d)}, ${r ? r.text : ''}`, 'high');
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
      const moving = fix.speed >= 0.9;
      if (cls === S.pendCls) S.clsStreak++; else { S.pendCls = cls; S.clsStreak = 1; }
      const gotHeading = !first && S.lastCls === null && cls !== null; // 첫 안내가 방향 없이 나갔다면 방향 확보 즉시 재안내
      if (first || gotHeading || (moving && (moved >= (cls === 'ahead' ? 80 : C.guideEveryMeters) || (tNow - S.lastGuideAt >= (cls === 'ahead' ? 45 : C.guideEverySec) * 1000 && moved >= 5)))) {   // 맞게 가는 중이면 덜 자주 말함
        return guide(first ? 'first' : 'auto');
      }
      const wrongWay = moving && cls === 'back' && S.clsStreak >= 3 && tNow - S.lastCueAt >= C.cueGapSec * 1000; // 알려 준 반대 방향으로 계속 걸으면 8초마다 다시 알림
      if (wrongWay || moving && cls && cls !== S.lastCls && S.clsStreak >= 2 && tNow - S.lastCueAt >= (cls === 'ahead' ? 20000 : C.cueGapSec * 1000) && moved >= 3) { // 같은 방향이 연속 2회일 때만(잡음으로 인한 번복 방지)
        const short = { ahead: '정면, 맞게 가는 중', 'left-s': '조금 왼쪽', 'right-s': '조금 오른쪽', 'left-m': '왼쪽으로 꺾기', 'right-m': '오른쪽으로 꺾기', 'left-b': '왼쪽 뒤쪽', 'right-b': '오른쪽 뒤쪽', back: '반대 방향, 유턴' }[cls];
        if (!say(`${short}. ${fmtDist(d)} 남음`, cls === 'back' ? 'high' : 'normal')) return;   // 유턴 경고는 다른 안내를 끊고 말함
        S.lastCueAt = tNow; S.lastCls = cls;
        io.vibrate(cls === 'ahead' ? PAT.ahead : cls.startsWith('left') ? PAT.left : cls === 'back' ? PAT.back : PAT.right);
      }
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
        a = { name: '하차 정류장 부근', lat: d.lat, lng: d.lng }; fb = true; scale = m ? +m[1].replace(/,/g, '') : 300; // 직선거리는 도보거리 이하이므로 도보거리 전체를 더해 정류장을 지나치기 전에 알림
      }
      if (!S.fix) return;
      const d = dist(S.fix, a);
      if (S.busMin == null || d < S.busMin) S.busMin = d;
      else if (d > S.busMin + 400 && !S.busFar) { S.busFar = true; io.vibrate(PAT.warn); say('하차 위치에서 멀어지고 있음. 다른 방향 버스일 수 있으니 안내방송으로 행선지를 확인하세요.', 'high'); }
      const stages = fb
        ? [[500 + scale, '하차 정류장이 가까워지고 있음. 하차 준비'], [150 + scale, '곧 하차 정류장일 수 있음. 하차벨을 누르세요'], [40 + scale, '하차 정류장 부근임. 안내방송으로 정류장 이름을 확인하고 내리세요. 내린 뒤 다음 버튼을 누르세요']]
        : [[500, '하차 정류장까지 약 500미터. 하차 준비'], [150, '곧 하차. 하차벨을 누르세요'], [40, '하차 정류장에 도착함. 내리세요']];
      for (let k = S.busStage; k < stages.length; k++) {
        if (d <= stages[k][0]) {
          S.busStage = k + 1; io.vibrate(k === 2 ? PAT.arrive : PAT.warn);
          if (k === 2 && !fb) return enterLeg(S.li + 1, `${a.name}. ${stages[k][1]}.`);
          say(`${a.name}. ${stages[k][1]}`, 'high'); break;
        }
      }
    }

    function checkSilence() {
      const l = leg(); if (!l || (l.type !== 'walk' && l.type !== 'bus') || !S.lastFixAt) return;
      if (!S.gpsLost && now() - S.lastFixAt >= 20000) {
        S.gpsLost = true; io.vibrate(PAT.warn);
        say(S.fixInLeg ? 'GPS 신호가 없음. 방금 안내한 위치를 기준으로 계속 가세요. 신호가 돌아오면 알려줌.' : '아직 GPS 신호를 잡지 못했음. 하늘이 트인 곳에서 잠시 기다리세요.', 'queue');
      }
    }
    function onCompass(h) { S.compass = { val: ((h % 360) + 360) % 360, t: now() }; checkSilence(); }

    // ---------- 사용자 조작 ----------
    function start(route, legIndex) { S.route = route; enterLeg(legIndex || 0); }
    function repeat() {
      const l = leg();
      if (l && l.type === 'walk' && S.fix && hasXY(target())) return guide('repeat');
      if (S.last) say(S.last, 'high');
    }
    // 현재 구간의 "다음" 동작
    function next() {
      const l = leg(); if (!l) return;
      if (l.type === 'walk') {
        if (S.pi >= l.points.length - 1) return enterLeg(S.li + 1, '구간 종료.');
        S.pi++; S.minD = Infinity; S.lastGuidePos = null;
        return say(`다음 지점, ${l.points[S.pi].name}`, 'high');
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
        stIdx: S.stIdx,
      };
    }

    return { start, repeat, next, skipLeg, prevLeg, onFix, onCompass, tick: checkSilence, snapshot, restore, status, _S: S };
  }

  return { createEngine, spoken, robustFuse, geoMedian, createKalman, median, medianPoint, spreadM, REC, dist, bearing, norm180, segDist, clock, cardinal, fmtDist, compassHeading, PAT, hasXY };
});
