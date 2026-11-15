const test = require('node:test');
const assert = require('node:assert');
const W = require('../engine.js');
const WL = require('../learn.js');

const M = (Math.PI * 6371000) / 180, k = Math.cos((37.5 * Math.PI) / 180);
const at = (n, e) => ({ lat: 37.5 + n / M, lng: 127.0 + e / (M * k) });
let seed = 11; const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
const noise = (s) => (rnd() + rnd() + rnd() + rnd() - 2) * 1.73 * s;

// 가상 경로: 집 → (북으로 200m) 입구 → 지하철 → 출구 → (동 150m, 북 120m 꺾음) 정류장 → 버스 → 하차 → 도보 → 사무실
const route = () => ({ legs: [
  { type: 'walk', title: '집에서 입구까지 200미터', points: [{ id: 'ent', name: '금호역 입구', kind: 'entrance' }] },
  { type: 'subway', title: '지하철', stations: ['a', 'b'] },
  { type: 'walk', title: '출구에서 정류장까지 270미터', points: [
    { id: 'ex', name: '출구', kind: 'exit' }, { id: 'stp', name: '정류장', kind: 'stop' }] },
  { type: 'bus', title: '버스', alight: { name: '하차 정류장' } },
  { type: 'walk', title: '하차 정류장에서 사무실까지 380미터', points: [{ id: 'dst', name: '사무실', kind: 'dest' }] },
] });

function sim(opts = {}) {
  const sigma = opts.sigma == null ? 2 : opts.sigma;
  let t = 5_000_000; const events = [], pts = {}, legs = [], says = [];
  const L = WL.createLearner({ route: route(), now: () => t, say: (s) => says.push(s),
    onPoint: (e) => { pts[e.id] = e; events.push(e.id); }, onLegDone: (e) => legs.push(e) });
  const fix = (pos, acc) => L.onFix({ lat: pos.lat + noise(sigma) / M, lng: pos.lng + noise(sigma) / (M * k), acc: acc || 6, t });
  const sec = (n, fn) => { for (let i = 0; i < n; i++) { t += 1000; fn(i); L.tick(); } };
  const gap = (n) => { for (let i = 0; i < n; i++) { t += 1000; L.tick(); } };

  L.start(0);
  sec(10, () => fix(at(0, 0)));                                   // 집에서 서 있음
  sec(154, (i) => fix(at(1.3 * i, 0)));                           // 북으로 200m 걷기
  gap(120);                                                       // 지하(GPS 없음)
  sec(10, (i) => fix(at(500, 3000 + 15 * i), 20));                // 고가 구간 열차 속도(보행 아님)
  gap(60);
  sec(14, (i) => fix(at(0, 5000 + 1.3 * i), 8));                 // 출구에서 동쪽으로 걷기 시작
  return { L, fix, sec, gap, events, pts, legs, says, get t() { return t; } };
}

test('집·입구 자동 기록: 지하 진입(GPS 끊김) 순간 입구 확정', () => {
  const s = sim();
  assert.ok(s.pts.home, '집 기록됨');
  assert.ok(W.dist(s.pts.home, at(0, 0)) < 8, '집 위치 정확');
  assert.ok(s.pts.ent, '입구 기록됨');
  assert.ok(W.dist(s.pts.ent, at(200, 0)) < 15, `입구 위치 오차 ${Math.round(W.dist(s.pts.ent, at(200, 0)))}m`);
  assert.equal(s.legs[0].legIndex, 0);
});

test('열차 속도 구간은 출구로 오인하지 않고, 걷기 시작 지점을 출구로 기록', () => {
  const s = sim();
  assert.ok(s.pts.ex, `출구 기록됨. 이벤트: ${s.events}`);
  assert.ok(W.dist(s.pts.ex, at(0, 5000)) < 15, `출구 오차 ${Math.round(W.dist(s.pts.ex, at(0, 5000)))}m`);
});

// 현재 위치(cur)에서 목표(to)로 속도 v로 이동하는 가상 보행
function walkTo(s, cur, to, v, acc) {
  const d = W.dist(cur, to), n = Math.max(1, Math.round(d / v));
  s.sec(n, (i) => s.fix({ lat: cur.lat + ((to.lat - cur.lat) * (i + 1)) / n, lng: cur.lng + ((to.lng - cur.lng) * (i + 1)) / n }, acc || 7));
  return to;
}

test('정류장·하차·사무실 자동 기록과 방향 요약', () => {
  const s = sim();
  let cur = at(0, 5000 + 1.3 * 13);
  cur = walkTo(s, cur, at(0, 5115), 1.3);                         // 동쪽 직진
  cur = walkTo(s, cur, at(155, 5115), 1.3);                       // 북쪽으로 꺾어 직진 (합계 약 270m)
  s.sec(30, () => s.fix(cur, 7));                                 // 정류장 정지 30초
  assert.ok(s.pts.stp, `정류장 기록됨. 이벤트: ${s.events}`);
  assert.ok(W.dist(s.pts.stp, at(155, 5115)) < 12, '정류장 오차');
  // 버스 8m/s 60초(동쪽 480m)
  s.sec(60, (i) => s.fix(at(155, 5115 + 8 * (i + 1)), 12));
  const alightPos = at(155, 5115 + 8 * 60);
  cur = alightPos;
  cur = walkTo(s, cur, at(155 + 60, 5115 + 480), 1.3);            // 하차 후 북쪽 보행(감지 지연 포함)
  assert.ok(s.pts.alight, `하차 기록됨. 이벤트: ${s.events}`);
  assert.ok(W.dist(s.pts.alight, alightPos) < 40, `하차 오차 ${Math.round(W.dist(s.pts.alight, alightPos))}m`);
  cur = walkTo(s, cur, at(155 + 60 + 300, 5115 + 480), 1.3);      // 북쪽 300m 더
  cur = walkTo(s, cur, at(155 + 60 + 300, 5115 + 480 + 80), 1.3); // 동쪽 80m (오른쪽 꺾음) -> 합계 약 440m
  s.sec(25, () => s.fix(cur, 7));
  assert.ok(s.pts.dst, `사무실 기록됨. 이벤트: ${s.events}`);
  const leg = s.legs.find((l) => l.legIndex === 2);
  assert.ok(leg, '출구→정류장 구간 요약 생성');
  assert.match(leg.text, /처음에 동쪽 방향으로 .*왼쪽\(약 \d+도\)으로 꺾어/);
  assert.equal(leg.turns.length, 1);
  assert.ok(leg.distance > 230 && leg.distance < 310, `거리 ${Math.round(leg.distance)}m`);
  const last = s.legs.find((l) => l.legIndex === 4);
  assert.ok(last && last.distance > 330 && last.distance < 470, '사무실 구간 거리 ' + (last && Math.round(last.distance)));
});

test('궤적 분석: ㄱ자 경로에서 방향·꺾는 곳·거리', () => {
  const tr = [];
  for (let i = 0; i <= 100; i += 4) tr.push(at(i, 0));            // 북 100m
  for (let i = 4; i <= 150; i += 4) tr.push(at(100, i));          // 동 150m (오른쪽 꺾임)
  const a = WL.analyzeTrail(tr);
  assert.equal(a.turns.length, 1);
  assert.equal(a.turns[0].turn, 'right');
  assert.ok(Math.abs(a.turns[0].angle - 90) < 12);
  assert.ok(Math.abs(a.distance - 250) < 15, `거리 ${a.distance}`);
  assert.match(a.text, /처음에 북쪽 방향으로 100미터, 오른쪽\(약 \d+도\)으로 꺾어 150미터/);
});

test('횡단보도에서 잠깐 선 것은 정류장으로 오인하지 않음(걸은 거리 부족)', () => {
  const s = sim();
  let cur = at(0, 5000 + 1.3 * 13);
  cur = walkTo(s, cur, at(70, 5000 + 1.3 * 13), 1.3);            // 출구에서 약 70m
  s.sec(30, () => s.fix(cur, 7));                                 // 신호 대기 30초
  assert.ok(!s.pts.stp, '신호 대기를 정류장으로 기록하면 안 됨');
  cur = walkTo(s, cur, at(200, 5000 + 1.3 * 13), 1.3);            // 계속 걷기(총 약 200m 이상)
  s.sec(30, () => s.fix(cur, 7));                                 // 정류장에서 정지
  assert.ok(s.pts.stp, '충분히 걸은 뒤 정지하면 기록됨');
});
