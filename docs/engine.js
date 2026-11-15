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
    if (d < 1000) return `${Math.round(d / 10) * 10}미터`;
    return `${(d / 1000).toFixed(1)}킬로미터`;
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
    function step(f, dt, z, r) {
      f.x += f.v * dt;
      const a = f.p00 + 2 * dt * f.p01 + dt * dt * f.p11 + (q * dt ** 4) / 4;
      const b = f.p01 + dt * f.p11 + (q * dt ** 3) / 2;
      const c = f.p11 + q * dt * dt;
      const S = a + r, K0 = a / S, K1 = b / S, y = z - f.x;
      const gate = Math.abs(y) > 4 * Math.sqrt(S);
      f.x += K0 * y; f.v += K1 * y;
      f.p00 = a - K0 * a; f.p01 = b - K0 * b; f.p11 = c - K1 * b;
      return gate;
    }
    function update(fix) {
      const t = fix.t || Date.now();
      const r = Math.max(fix.acc || 10, 3) ** 2;
      if (!ref || !st || t - lastT > 15000) {
        ref = { lat: fix.lat, lng: fix.lng }; const z = toLocal(ref, fix);
        st = { x: mk({ x: z.x }, r), y: mk({ x: z.y }, r) }; lastT = t; bad = 0;
        return Object.assign({}, fix);
      }
      const dt = Math.min(Math.max((t - lastT) / 1000, 0.2), 10); lastT = t;
      const z = toLocal(ref, fix);
      const g = step(st.x, dt, z.x, r) | step(st.y, dt, z.y, r);
      bad = g ? bad + 1 : 0;
      if (bad >= 3) { ref = { lat: fix.lat, lng: fix.lng }; const z0 = toLocal(ref, fix); st = { x: mk({ x: z0.x }, r), y: mk({ x: z0.y }, r) }; bad = 0; }
      const pos = fromLocal(ref, { x: st.x.x, y: st.y.x });
      const sp = Math.hypot(st.x.v, st.y.v);
      const hd = (deg(Math.atan2(st.x.v, st.y.v)) + 360) % 360; // 북=0, 동=90
      return Object.assign({}, fix, {
        lat: pos.lat, lng: pos.lng, acc: Math.max(3, Math.sqrt(st.x.p00)),
        speed: fix.speed > 0 ? fix.speed : sp,
        heading: Number.isFinite(fix.heading) ? fix.heading : (sp >= 0.7 ? hd : null),
      });
    }
    return { update, reset() { ref = null; st = null; } };
  }

  // ---------- 진동 패턴 (좌 짧짧 / 우 짧짧짧 / 정방향 짧 1 / 유턴 길길길 / 도착 길게) ----------
  const PAT = {
    ahead: [50],
    left: [90, 90, 90],
    right: [90, 90, 90, 90, 90],
    back: [400, 120, 400, 120, 400],
    arrive: [900],
    warn: [200, 100, 200, 100, 200],
  };

  const hasXY = (p) => p && typeof p.lat === 'number' && typeof p.lng === 'number';

  // ---------- 엔진 ----------
  function createEngine(opts) {
    const io = opts.io;
    const now = opts.now || (() => Date.now());
    const C = Object.assign({
      guideEveryMeters: 25, guideEverySec: 20, cueGapSec: 4, offRouteM: 25,
      offRouteGapSec: 25, overshootM: 18, defaultRadius: 12, accCap: 30, beepRangeM: 30,
    }, opts.config || {});

    const S = {
      route: null, li: -1, pi: 0, fix: null, compass: null, track: [],
      stIdx: 0, last: '', minD: Infinity,
      lastGuideAt: 0, lastGuidePos: null, lastCls: null, lastCueAt: 0,
      lastOffAt: 0, lastOverAt: 0, lastBeepAt: 0, warnedMissing: null, busStage: 0,
    };

    const leg = () => (S.route ? S.route.legs[S.li] : null);
    const target = () => { const l = leg(); return l && l.type === 'walk' ? l.points[S.pi] : null; };

    function say(text, prio) {
      S.last = text;
      io.speak(text, prio || 'normal');
      if (io.notify) io.notify(text);
    }

    function currentHeading() {
      const t = now(), f = S.fix;
      if (f && Number.isFinite(f.heading) && f.speed >= 1.0) return { val: f.heading, src: '걷는 방향(GPS)' };
      // 최근 이동 궤적으로 방향 추정
      const tr = S.track;
      if (tr.length >= 2) {
        const a = tr[0], b = tr[tr.length - 1];
        if (b.t - a.t <= 15000 && dist(a, b) >= 6) return { val: bearing(a, b), src: '이동 궤적' };
      }
      if (S.compass && t - S.compass.t < 3000) return { val: S.compass.val, src: '나침반' };
      return null;
    }

    function relTo(p) {
      const f = S.fix; if (!f || !hasXY(p)) return null;
      const b = bearing(f, p), h = currentHeading();
      if (!h) return { b, d: dist(f, p), ck: null, h: null, text: `${cardinal(b)}(방향 센서 대기 중)` };
      const ck = clock(norm180(b - h.val));
      return { b, d: dist(f, p), ck, h, text: ck.text };
    }

    function guide(reason) {
      const t = target(); if (!t) return;
      const r = relTo(t); if (!r) return;
      S.lastGuideAt = now(); S.lastGuidePos = { lat: S.fix.lat, lng: S.fix.lng };
      S.lastCls = r.ck ? r.ck.cls : null;
      say(`${t.name}까지 ${fmtDist(r.d)}, ${r.text}`, reason === 'repeat' ? 'high' : 'normal');
      if (r.ck) io.vibrate(r.ck.cls === 'ahead' ? PAT.ahead : r.ck.cls.startsWith('left') ? PAT.left : r.ck.cls === 'back' ? PAT.back : PAT.right);
    }

    function legIntro(l, i) {
      const head = `${i + 1}단계. ${l.title}.`;
      if (l.type === 'walk') {
        const miss = l.points.filter((p) => !hasXY(p)).length;
        return `${head} ${l.intro || ''}` + (l.learned && l.learned.text ? ` 걸었던 기록: ${l.learned.text}.` : '') + (miss ? ` 주의, 좌표가 기록되지 않은 지점이 ${miss}개 있음.` : '');
      }
      if (l.type === 'subway') {
        const n = l.stations ? l.stations.length - 1 : null;
        return `${head} ${l.intro || ''}` + (n ? ` 총 ${n}개 역 이동. 역에 설 때마다 역 도착 버튼을 누르면 남은 역 수를 알려줌.` : '');
      }
      return `${head} ${l.intro || ''}`;
    }

    function enterLeg(i, prefix) {
      if (i >= S.route.legs.length) {
        S.li = S.route.legs.length; // 종료
        say((prefix ? prefix + ' ' : '') + '모든 안내가 끝났음. 목적지에 도착했음.', 'high');
        io.vibrate(PAT.arrive); return;
      }
      S.li = i; S.pi = 0; S.stIdx = 0; S.minD = Infinity; S.busStage = 0;
      S.lastGuidePos = null; S.lastGuideAt = 0; S.warnedMissing = null;
      const l = leg();
      say((prefix ? prefix + ' ' : '') + legIntro(l, i), 'high');
      if (io.onLegChange) io.onLegChange(i, l);
    }

    function arrive(p) {
      io.vibrate(PAT.arrive);
      S.minD = Infinity; S.lastGuidePos = null; S.lastGuideAt = 0;
      const msg = `${p.name} 도착. ${p.say || ''}`.trim();
      if (S.pi >= leg().points.length - 1) enterLeg(S.li + 1, msg);
      else { S.pi++; say(msg, 'high'); }
    }

    // ---------- 외부 입력 ----------
    function onFix(fix) {
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
          say(`${t.name} 좌표가 아직 없음. 기록 모드에서 저장하거나 다음 버튼으로 건너뛰기 바람.`, 'high');
          io.vibrate(PAT.warn);
        }
        return;
      }
      const tNow = now();
      const d = dist(fix, t);
      const radius = Math.max(t.radius || C.defaultRadius, Math.min(fix.acc || 0, C.accCap));
      if (d <= radius) return arrive(t);

      const endKind = ['stop', 'dest', 'entrance', 'exit'].includes(t.kind);
      if (d < S.minD) S.minD = d;
      else if (endKind && S.minD < 45 && d > S.minD + C.overshootM && tNow - S.lastOverAt > 15000) {
        S.lastOverAt = tNow; io.vibrate(PAT.back);
        const r = relTo(t);
        say(`지나친 것 같음. 멈추고 ${t.name} 쪽으로 돌아가야 함. ${fmtDist(d)}, ${r ? r.text : ''}`, 'high');
        S.minD = d; // 재측정
        return;
      }
      // 경로 이탈 (이전 지점이 있을 때)
      const prev = S.pi > 0 ? l.points[S.pi - 1] : l.start;
      if (hasXY(prev)) {
        const sd = segDist(fix, prev, t);
        if (sd > Math.max(C.offRouteM, (fix.acc || 0) * 1.5) && tNow - S.lastOffAt > C.offRouteGapSec * 1000) {
          S.lastOffAt = tNow; io.vibrate(PAT.warn);
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
      const gotHeading = !first && S.lastCls === null && cls !== null; // 첫 안내가 방향 없이 나갔다면 방향 확보 즉시 재안내
      if (first || gotHeading || moved >= C.guideEveryMeters || (tNow - S.lastGuideAt >= C.guideEverySec * 1000 && moved >= 5)) {
        return guide('auto');
      }
      if (cls && cls !== S.lastCls && tNow - S.lastCueAt >= C.cueGapSec * 1000 && moved >= 3) {
        S.lastCueAt = tNow; S.lastCls = cls;
        const short = { ahead: '정면, 맞게 가는 중', 'left-s': '조금 왼쪽', 'right-s': '조금 오른쪽', 'left-m': '왼쪽으로 꺾기', 'right-m': '오른쪽으로 꺾기', 'left-b': '왼쪽 뒤쪽', 'right-b': '오른쪽 뒤쪽', back: '반대 방향, 유턴' }[cls];
        say(`${short}. ${fmtDist(d)} 남음`, 'normal');
        io.vibrate(cls === 'ahead' ? PAT.ahead : cls.startsWith('left') ? PAT.left : cls === 'back' ? PAT.back : PAT.right);
      }
    }

    function busTick(l) {
      const a = l.alight; if (!hasXY(a) || !S.fix) return;
      const d = dist(S.fix, a);
      const stages = [[500, '하차 정류장까지 약 500미터. 하차 준비'], [150, '곧 하차. 하차벨을 누르세요'], [40, '하차 정류장에 도착함. 내리세요']];
      for (let k = S.busStage; k < stages.length; k++) {
        if (d <= stages[k][0]) {
          S.busStage = k + 1; io.vibrate(k === 2 ? PAT.arrive : PAT.warn);
          if (k === 2) return enterLeg(S.li + 1, `${a.name}. ${stages[k][1]}.`);
          say(`${a.name}. ${stages[k][1]}`, 'high'); break;
        }
      }
    }

    function onCompass(h) { S.compass = { val: ((h % 360) + 360) % 360, t: now() }; }

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
    function prevLeg() { if (S.route) enterLeg(Math.max(0, Math.min(S.li, S.route.legs.length) - 1)); }

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

    return { start, repeat, next, skipLeg, prevLeg, onFix, onCompass, status, _S: S };
  }

  return { createEngine, robustFuse, geoMedian, createKalman, median, medianPoint, spreadM, REC, dist, bearing, norm180, segDist, clock, cardinal, fmtDist, compassHeading, PAT, hasXY };
});
