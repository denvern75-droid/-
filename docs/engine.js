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
        return `${head} ${l.intro || ''}` + (miss ? ` 주의, 좌표가 기록되지 않은 지점이 ${miss}개 있음.` : '');
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

  return { createEngine, dist, bearing, norm180, segDist, clock, cardinal, fmtDist, compassHeading, PAT, hasXY };
});
