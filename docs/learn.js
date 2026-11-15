/*
 * 학습 보행(자동 좌표 기록) — UI 비의존, 브라우저/Node 공용
 * 이용자가 경로를 한 번 걸으면 집·출구·정류장·하차지점·사무실 좌표와
 * 구간별 걸은 궤적(방향·거리·꺾는 곳)을 자동으로 만들어 냄.
 *
 * 입력: onFix(fix{lat,lng,acc,t}) 가 1초 안팎 간격으로, tick() 이 1초마다
 * 감지 규칙은 아래 C 상수 참고. 오감지 가능성이 있으므로 결과는 다회 기록으로 융합하는 것을 전제로 함.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./engine.js'));
  else root.WalkLearn = factory(root.WalkNav);
})(typeof self !== 'undefined' ? self : this, function (W) {
  'use strict';

  const C = {
    goodAcc: 30,      // 이 이하 오차의 측정만 위치 기록에 사용
    rideAcc: 60,      // 버스 탑승 중 허용 오차
    lossSec: 25,      // 이 시간 동안 양호한 GPS가 없으면 '신호 끊김'(지하 진입)
    stopSec: 20,      // 정류장 판정: 이 시간 이상 정지
    destSec: 12,      // 목적지 판정: 이 시간 이상 정지
    fastSpeed: 3.0,   // 버스·열차 주행 속도(m/s)
    walkMin: 0.7, walkMax: 2.4, // 보행 속도 범위(m/s)
    walkRunSec: 8,    // 보행 속도가 이 시간 지속되면 '걷기 시작'
    alightWalkSec: 8,
    minRideM: 150,    // 하차 판정 최소 탑승 거리
    minLegFrac: 0.6,  // 도착 판정: 안내 도보거리의 이 비율 이상 걸었을 때만
    stillM: 4.0, trailStepM: 6, rdpM: 8, turnDeg: 35, minSegM: 8,
  };

  const hasXY = W.hasXY;
  const med = W.median;

  // ---------- 궤적 처리 ----------
  function toXY(ref, p) {
    const M = (Math.PI * 6371000) / 180;
    return { x: (p.lng - ref.lng) * M * Math.cos((ref.lat * Math.PI) / 180), y: (p.lat - ref.lat) * M };
  }
  // Ramer–Douglas–Peucker 단순화
  function simplify(pts, tol) {
    if (pts.length <= 2) return pts.slice();
    const ref = pts[0], xy = pts.map((p) => toXY(ref, p));
    const keep = new Array(pts.length).fill(false); keep[0] = keep[pts.length - 1] = true;
    const stack = [[0, pts.length - 1]];
    while (stack.length) {
      const [a, b] = stack.pop();
      let mx = -1, mi = -1;
      const dx = xy[b].x - xy[a].x, dy = xy[b].y - xy[a].y, L2 = dx * dx + dy * dy;
      for (let i = a + 1; i < b; i++) {
        const t = L2 ? Math.max(0, Math.min(1, ((xy[i].x - xy[a].x) * dx + (xy[i].y - xy[a].y) * dy) / L2)) : 0;
        const d = Math.hypot(xy[i].x - (xy[a].x + t * dx), xy[i].y - (xy[a].y + t * dy));
        if (d > mx) { mx = d; mi = i; }
      }
      if (mx > tol) { keep[mi] = true; stack.push([a, mi], [mi, b]); }
    }
    return pts.filter((_, i) => keep[i]);
  }
  // 단순화된 궤적 → 구간(방향·길이)과 꺾는 곳
  function analyzeTrail(trail) {
    const poly = simplify(trail, C.rdpM);
    if (poly.length < 2) return { poly, segments: [], turns: [], distance: 0, text: '' };
    const raw = [];
    for (let i = 1; i < poly.length; i++) raw.push({ b: W.bearing(poly[i - 1], poly[i]), len: W.dist(poly[i - 1], poly[i]), from: i - 1, to: i });
    // 짧은 구간(<minSegM)은 앞 구간에 합침
    const segs = [];
    for (const s of raw) {
      if (segs.length && s.len < C.minSegM) { segs[segs.length - 1].len += s.len; segs[segs.length - 1].to = s.to; }
      else segs.push(Object.assign({}, s));
    }
    // 꺾임이 작은 연속 구간은 합침
    const merged = [segs[0]], turns = [];
    for (let i = 1; i < segs.length; i++) {
      const ang = W.norm180(segs[i].b - merged[merged.length - 1].b);
      if (Math.abs(ang) < C.turnDeg) { const m = merged[merged.length - 1]; m.len += segs[i].len; m.to = segs[i].to; }
      else { const v = poly[merged[merged.length - 1].to]; turns.push({ lat: v.lat, lng: v.lng, turn: ang < 0 ? 'left' : 'right', angle: Math.round(Math.abs(ang)), idx: merged.length }); merged.push(Object.assign({ turn: ang < 0 ? 'left' : 'right', angle: Math.round(Math.abs(ang)) }, segs[i])); }
    }
    turns.forEach((t, k) => { t.nextLen = merged[k + 1].len; });
    const distance = merged.reduce((a, s) => a + s.len, 0);
    const parts = merged.map((s, k) => k === 0
      ? `처음에 ${W.cardinal(s.b)} 방향으로 ${W.fmtDist(s.len)}`
      : `${s.turn === 'left' ? '왼쪽' : '오른쪽'}으로 약 ${s.angle}도 꺾어 ${W.fmtDist(s.len)}`);
    return { poly, segments: merged, turns, distance, text: `${parts.join(', ')} 걸음. 총 약 ${W.fmtDist(distance)}` };
  }

  // ---------- 학습기 ----------
  function createLearner(o) {
    const legs = o.route.legs, now = o.now || (() => Date.now());
    const say = o.say || (() => {}), onPoint = o.onPoint || (() => {}), onLeg = o.onLegDone || (() => {}), onDone = o.onDone || (() => {});
    let li = -1, phase = 'idle', emitId = null, saidFar = false;
    let buf = [], lastGood = null, lastGoodAt = 0, lost = false, sawLoss = false, enteredAt = 0;
    let sm = null, smT = 0, smBuf = [];
    let trail = [], walked = 0, pend = [], walkRunStart = null, boardPt = null, lastFastT = 0, fastRunStart = null;
    const L = () => legs[li];
    const declared = (l) => { const m = (l.title || '').match(/([\d,]+)\s*미터/); return m ? +m[1].replace(/,/g, '') : null; };

    function speedWindow(sec) {
      const t = buf.length ? buf[buf.length - 1].t : 0;
      const w = buf.filter((f) => f.t >= t - sec * 1000);
      if (w.length < 3) return null;
      const dt = (w[w.length - 1].t - w[0].t) / 1000;
      return dt >= sec * 0.6 ? W.dist(w[0], w[w.length - 1]) / dt : null;
    }
    // 정지 판정: 평활 궤적의 실제 이동이 작을 때만(보행 중 순간 정지·GPS 떨림과 구분). 위치는 원시 측정의 중앙값
    function stationaryFor(sec) {
      const t = buf.length ? buf[buf.length - 1].t : 0;
      const w = smBuf.filter((f) => f.t >= t - sec * 1000);
      if (w.length < 3 || (w[w.length - 1].t - w[0].t) < sec * 900) return null;
      const c = W.medianPoint(w);
      if (Math.max(...w.map((f) => W.dist(c, f))) > C.stillM) return null;
      const raw = buf.filter((f) => f.t >= t - sec * 1000);
      return W.medianPoint(raw.length ? raw : w);
    }
    const inWalk = (v) => v != null && v >= C.walkMin && v <= C.walkMax;

    function enter(i, mode) {
      li = i; pend = []; walkRunStart = null; fastRunStart = null; enteredAt = now();
      if (i >= legs.length) { phase = 'done'; say('학습 보행이 끝났음. 기록한 위치와 걸은 방향이 저장되었음.'); onDone(); return; }
      const l = L();
      if (l.type === 'walk') {
        if (mode === 'afterBus') { phase = 'walking'; return; }
        phase = 'startref';
        const f0 = l.points[0];
        emitId = i === 0 ? 'home' : (f0 && f0.kind === 'exit' ? f0.id : null);
        say(`${l.title}. ${i === 0 ? '집에서 잠시 서 있다가 ' : ''}평소처럼 걸어가세요. 위치는 자동으로 기록됨.`);
      } else if (l.type === 'bus') {
        phase = 'bus_wait'; boardPt = trail.length ? trail[trail.length - 1] : null;
        say('버스를 타세요. 하차하면 하차 위치가 자동으로 기록됨.');
      } else {
        phase = 'underground'; sawLoss = lost; walkRunStart = null;
        say(`${l.title}. 지하철을 타세요. 지상으로 나와 걸으면 출구 위치가 자동으로 기록됨.`);
      }
    }
    function startWalk(pt) { phase = 'walking'; trail = [pt]; walked = 0; saidFar = false; }
    function nextWalkIndex(from) { for (let j = from + 1; j < legs.length; j++) if (legs[j].type === 'walk') return j; return -1; }

    function finishWalk(endPt) {
      trail.push({ lat: endPt.lat, lng: endPt.lng });
      const an = analyzeTrail(trail);
      onLeg({ legIndex: li, trail: an.poly, turns: an.turns, distance: an.distance, text: an.text, segments: an.segments });
      say(`${legs[li].title} 구간 기록 완료. ${an.text}`);
      enter(li + 1, 'next');
    }

    function onFix(f) {
      const t = f.t || now();
      const fx = { lat: f.lat, lng: f.lng, acc: f.acc == null ? 10 : f.acc, t };
      buf.push(fx); while (buf.length && buf[0].t < t - 120000) buf.shift();
      const riding = phase === 'riding' || phase === 'bus_wait';
      const good = fx.acc <= (riding ? C.rideAcc : C.goodAcc);
      if (!good) return;
      sm = (!sm || t - smT > 15000) ? { lat: fx.lat, lng: fx.lng } : { lat: sm.lat + 0.35 * (fx.lat - sm.lat), lng: sm.lng + 0.35 * (fx.lng - sm.lng) };
      smBuf.push({ lat: sm.lat, lng: sm.lng, t }); while (smBuf.length && smBuf[0].t < t - 120000) smBuf.shift();
      smT = t; // 궤적은 평활 위치로만 만들어 정지 중 GPS 떨림이 거리로 누적되지 않게 함
      if (fx.acc <= C.goodAcc) { lastGood = fx; lastGoodAt = t; lost = false; }
      if (phase === 'idle' || phase === 'done') return;

      if (phase === 'startref') {
        pend.push(fx);
        if (pend.length >= 5 || (t - pend[0].t >= 8000 && pend.length >= 3)) {
          const best = pend.slice().sort((a, b) => a.acc - b.acc)[0];
          if (emitId) onPoint({ legIndex: li, id: emitId, lat: best.lat, lng: best.lng, acc: best.acc });
          say(emitId === 'home' ? '집 위치를 기록했음. 출발하세요.' : '시작 위치를 기록했음.');
          startWalk(best);
        }
      } else if (phase === 'underground') {
        const v = speedWindow(C.walkRunSec);
        if (fx.acc <= C.goodAcc && inWalk(v) && (sawLoss || t - enteredAt >= 90000)) {
          if (!walkRunStart) walkRunStart = t;
          if (t - walkRunStart >= C.walkRunSec * 1000 - 500) {
            const run = buf.filter((b) => b.t >= walkRunStart && b.acc <= C.goodAcc).slice(0, 3);
            const p = W.medianPoint(run);
            const j = nextWalkIndex(li);
            const firstKnown = j >= 0 ? legs[j].points[0] : null;
            if (hasXY(firstKnown) && W.dist(p, firstKnown) > 300) { walkRunStart = null; return; }   // 알려진 출구와 300m 넘게 떨어지면 출구가 아님(집 근처 보행 등 오감지 방지)
            if (j >= 0) {
              li = j; const first = L().points[0];
              if (first && first.kind === 'exit') {
                onPoint({ legIndex: j, id: first.id, lat: p.lat, lng: p.lng, acc: p.acc });
                say('출구 위치를 기록했음. 다음 지점으로 걸어가세요.');
              }
              sawLoss = false; startWalk(p);
            }
          }
        } else if (!inWalk(v)) walkRunStart = null;
      } else if (phase === 'walking') {
        addTrail(sm);
        const l = L(), last = l.points[l.points.length - 1];
        if (last && (last.kind === 'stop' || last.kind === 'dest')) {
          const dcl = declared(l);
          const need = dcl ? dcl * C.minLegFrac : 40;
          const st = stationaryFor(last.kind === 'dest' ? C.destSec : C.stopSec);
          const farKnown = st && hasXY(last) && W.dist(st, last) > 60;   // 알려진 위치에서 60m 넘게 떨어진 정지(신호 대기 등)는 기록하지 않음
          if (farKnown && walked >= need && !saidFar) { saidFar = true; say(`${last.name} 위치로 기록하지 않았음. 저장된 위치와 ${W.fmtDist(W.dist(st, last))} 다름. 실제로 도착한 것이면 화면의 여기 저장 기능으로 고칠 수 있음.`); }
          if (st && walked >= need && !farKnown) {   // 알려진 위치에서 120m 넘게 떨어진 곳의 정지(신호 대기 등)는 기록하지 않음
            onPoint({ legIndex: li, id: last.id, lat: st.lat, lng: st.lng, acc: st.acc });
            say(`${last.name} 위치를 기록했음.`);
            finishWalk(st);
          }
        }
      } else if (phase === 'bus_wait') {
        if (!boardPt) boardPt = fx;
        const v = speedWindow(6);
        if (v != null && v >= C.fastSpeed) { if (!fastRunStart) fastRunStart = t; if (t - fastRunStart >= 5000) { phase = 'riding'; lastFastT = t; walkRunStart = null; } }
        else fastRunStart = null;
      } else if (phase === 'riding') {
        const v = speedWindow(6), v8 = speedWindow(8);
        if (v != null && v >= C.fastSpeed) { lastFastT = t; walkRunStart = null; }
        else if (inWalk(v8) && t - lastFastT >= 5000) {
          if (!walkRunStart) walkRunStart = t;
          if (t - walkRunStart >= C.alightWalkSec * 1000 - 500 && W.dist(boardPt, fx) >= C.minRideM) {
            const win = buf.filter((b) => b.t >= lastFastT - 2000 && b.t <= lastFastT + 8000);
            const p = win.length ? W.medianPoint(win) : fx;
            const l = L();
            const nl = legs[li + 1], dst = nl && nl.type === 'walk' ? nl.points[nl.points.length - 1] : null;
            if (hasXY(dst) && W.dist(p, dst) > (declared(nl) || 500) + 150) { walkRunStart = null; return; }   // 도착지에서 너무 먼 서행(정체 등)은 하차가 아님
            onPoint({ legIndex: li, id: 'alight', lat: p.lat, lng: p.lng, acc: p.acc });
            say(`${(l.alight && l.alight.name) || '하차 정류장'} 위치를 기록했음. 사무실 방향으로 걸어가세요.`);
            const j = li + 1;
            if (j < legs.length && legs[j].type === 'walk') { li = j; startWalk(p); addTrail(sm); }
            else enter(j, 'next');
          }
        } else walkRunStart = null;
      }
    }
    function addTrail(fx) {
      const last = trail[trail.length - 1];
      const d = last ? W.dist(last, fx) : Infinity;
      if (d >= C.trailStepM) { trail.push({ lat: fx.lat, lng: fx.lng }); if (isFinite(d)) walked += d; }
    }

    function tick() {
      const t = now();
      if (lastGoodAt && t - lastGoodAt >= C.lossSec * 1000 && phase !== 'idle') { lost = true; sawLoss = true; }
      if (phase === 'walking') {
        const l = L(), last = l.points[l.points.length - 1];
        if (last && last.kind === 'entrance' && lost && walked >= 15) {
          const pts = buf.filter((b) => b.acc <= C.goodAcc && b.t >= lastGoodAt - 10000);
          const p = W.medianPoint(pts.length ? pts : [lastGood]);
          if (hasXY(last) && W.dist(p, last) > 150) return;   // 알려진 입구와 150m 넘게 떨어진 GPS 끊김(단지·캐노피 등)은 입구가 아님
          onPoint({ legIndex: li, id: last.id, lat: p.lat, lng: p.lng, acc: p.acc });
          say(`${last.name} 위치를 기록했음.`);
          finishWalk(p);
        }
      }
    }
    function start(i) { enter(i || 0, 'start'); }
    return { start, onFix, tick, get phase() { return phase; }, get legIndex() { return li; } };
  }

  return { createLearner, analyzeTrail, simplify, C };
});
