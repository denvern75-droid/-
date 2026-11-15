const test = require('node:test');
const assert = require('node:assert');
const W = require('../engine.js');

// 서울 임의 기준점(테스트용 합성 좌표)
const O = { lat: 37.5, lng: 127.0 };
const M = (Math.PI * 6371000) / 180;
const mN = 1 / M, mE = 1 / (M * Math.cos((37.5 * Math.PI) / 180));
const at = (north, east) => ({ lat: O.lat + north * mN, lng: O.lng + east * mE });

function mk() {
  const log = [], vib = [];
  let t = 1_000_000;
  const io = { speak: (s) => log.push(s), vibrate: (p) => vib.push(p), beep: () => {}, notify: () => {} };
  const eng = W.createEngine({ io, now: () => t });
  const fix = (pos, o = {}) => { t += o.dt || 5000; eng.onFix({ ...pos, acc: 5, heading: null, speed: 0, t, ...o }); };
  return { eng, log, vib, fix, tick: (ms) => (t += ms) };
}

test('시계 방향 변환', () => {
  assert.equal(W.clock(0).text, '정면');
  assert.match(W.clock(90).text, /^3시 방향\(오른쪽 옆\)/);
  assert.match(W.clock(-90).text, /^9시 방향\(왼쪽 옆\)/);
  assert.match(W.clock(-150).text, /^7시 방향\(왼쪽 뒤\)/);
  assert.equal(W.clock(180).cls, 'back');
  assert.equal(W.clock(-175).cls, 'back');
});

test('방위/거리 계산', () => {
  assert.ok(Math.abs(W.dist(O, at(100, 0)) - 100) < 0.5);
  assert.ok(Math.abs(W.bearing(O, at(100, 0)) - 0) < 0.5);
  assert.ok(Math.abs(W.bearing(O, at(0, 100)) - 90) < 0.5);
  assert.ok(Math.abs(W.bearing(O, at(-100, 0)) - 180) < 0.5);
  assert.ok(Math.abs(W.norm180(350 - 10) - -20) < 1e-9);
  assert.ok(Math.abs(W.segDist(at(50, 30), at(0, 0), at(100, 0)) - 30) < 0.5);
});

test('센서 보정: 수평/세운 자세 방위', () => {
  assert.equal(Math.round(W.compassHeading(270, 0, 0)), 90); // 수평, 윗면이 동쪽
  assert.equal(Math.round(W.compassHeading(0, 90, 0)), 0);   // 세워 들고 정면이 북쪽
});

const route = () => ({
  legs: [
    { type: 'walk', title: '출구에서 정류장', intro: '', points: [
      { id: 'e', name: '정류장', kind: 'stop', radius: 8, ...at(-30, -40), say: '탑승 준비' }] },
    { type: 'walk', title: '하차 후', intro: '', points: [
      { id: 'd', name: '사무실', kind: 'dest', radius: 8, ...at(0, 100), say: '도착' }] },
  ],
});

test('출구 위치에서 북쪽을 보고 서 있을 때: 정류장은 남서쪽 → 뒤쪽 방향 안내', () => {
  const { eng, log, fix } = mk();
  eng.start(route(), 0);
  fix(at(0, 0), { dt: 100 });
  eng.onCompass(0); // 북쪽을 보고 있음(센서는 수시로 갱신됨)
  fix(at(0, 0), { dt: 500 });
  const msg = log[log.length - 1];
  assert.match(msg, /정류장까지 50미터/);
  assert.match(msg, /7시 방향|8시 방향/); // 남서 = 약 -143° → 7시
});

test('걸어서 접근하면 도착 안내 후 다음 구간으로', () => {
  const { eng, log, fix } = mk();
  eng.start(route(), 0);
  fix(at(0, 0));
  fix(at(-15, -20), { speed: 1.3, heading: 217 });
  fix(at(-28, -38), { speed: 1.3, heading: 217 });
  fix(at(-29, -39), { speed: 1.3, heading: 217, dt: 1000 });   // 도착은 연속 2회 측정으로 확정
  assert.ok(log.some((s) => /정류장 도착\. 탑승 준비/.test(s)));
  assert.equal(eng.status().legIndex, 1);
});

test('목적지를 지나치면 되돌아가라고 안내', () => {
  const b = mk();
  const r = route(); r.legs[1].points[0].radius = 4;
  b.eng.start(r, 1);
  b.fix(at(12, 60), { speed: 1.3, heading: 90 });
  b.fix(at(12, 95), { speed: 1.3, heading: 90 });
  b.fix(at(12, 135), { speed: 1.3, heading: 90 });
  b.fix(at(12, 141), { speed: 1.3, heading: 90 });   // 지나침은 연속 3회 멀어질 때 알림(서 있을 때의 GPS 잡음과 구분)
  b.fix(at(12, 147), { speed: 1.3, heading: 90 });
  assert.ok(b.log.some((s) => /지나친 것 같음/.test(s)), b.log.join(' | '));
});

test('경로 이탈 경고', () => {
  const { eng, log, fix } = mk();
  const r = route();
  r.legs[0].points = [
    { id: 'a', name: '모퉁이', kind: 'turn', radius: 6, ...at(0, 0) },
    { id: 'b', name: '정류장', kind: 'stop', radius: 6, ...at(0, 150) }];
  eng.start(r, 0);
  eng.next(); // 두 번째 지점이 목표, 이전 지점은 a
  fix(at(45, 40), { speed: 1.3, heading: 90 });
  assert.ok(log.some((s) => /벗어났음/.test(s)), log.join(' | '));
});

test('지하철: 역 카운트다운과 하차 안내', () => {
  const { eng, log } = mk();
  const r = { legs: [
    { type: 'subway', title: '3호선', intro: '탑승', stations: ['금호', '옥수', '압구정', '교대'] },
    { type: 'indoor', title: '환승', intro: '2호선으로 이동' }] };
  eng.start(r, 0);
  eng.next(); assert.match(log[log.length - 1], /옥수역. 내릴 역까지 2개/);
  eng.next(); assert.match(log[log.length - 1], /다음 역이 하차역, 교대/);
  eng.next(); assert.ok(log.some((s) => /교대역 도착. 하차역임/.test(s)), log.join('|'));
  assert.equal(eng.status().legIndex, 1);
});

test('버스: 하차 정류장 접근 단계별 알림 후 자동으로 다음 구간', () => {
  const { eng, log, fix } = mk();
  const r = { legs: [
    { type: 'bus', title: '버스', intro: '', alight: { name: '문성초', ...at(0, 1000) } },
    { type: 'walk', title: '도보', intro: '', points: [{ id: 'd', name: '사무실', kind: 'dest', ...at(50, 1000) }] }] };
  eng.start(r, 0);
  fix(at(0, 520), { speed: 8 }); assert.ok(log.some((s) => /약 500미터/.test(s)));
  fix(at(0, 900), { speed: 8 }); assert.ok(log.some((s) => /하차벨/.test(s)));
  fix(at(0, 980), { speed: 4 }); assert.ok(log.some((s) => /내리세요/.test(s)));
  assert.equal(eng.status().legIndex, 1);
});

test('좌표 미기록 지점은 경고하고 오작동하지 않음', () => {
  const { eng, log, fix } = mk();
  eng.start({ legs: [{ type: 'walk', title: 'x', intro: '', points: [{ id: 'z', name: '미기록', kind: 'stop', lat: null, lng: null }] }] }, 0);
  assert.ok(!/좌표가 기록되지 않은/.test(log[0]), '구간 소개에서는 좌표 누락을 낭독하지 않음(이용자에게 불필요)');
  fix(at(0, 0));
  assert.ok(log.some((s) => /위치 정보가 없어 방향을 안내할 수 없음/.test(s)));
});

test('다회 기록: 중앙값이 이상치에 강함', () => {
  const s = [at(0, 0), at(2, 1), at(1, -1), at(60, 0)].map((p) => ({ ...p, acc: 8 })); // 마지막은 60m 이상치
  const m = W.medianPoint(s);
  assert.ok(W.dist(m, at(1.5, 0)) < 3, '중앙값은 이상치(60m)에 끌려가지 않음');
  assert.ok(W.spreadM(s) > 50);
  assert.equal(W.median([3, 1, 2]), 2);
  assert.equal(W.median([1, 2, 3, 4]), 2.5);
  assert.equal(W.REC.rejectAcc, 25);
});

// 재현 가능한 의사 난수(정규분포 근사)
function rng(seed) { let s = seed; const u = () => ((s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296); return () => (u() + u() + u() + u() - 2) * 1.73; }

test('강건 융합: 튀는 값 제거 + 정확한 측정에 가중', () => {
  const s = [
    { ...at(0, 0), acc: 5 }, { ...at(1, 1), acc: 5 }, { ...at(-1, 1), acc: 5 },
    { ...at(80, 0), acc: 6 },                       // 이상치
  ];
  const f = W.robustFuse(s);
  assert.equal(f.rejected, 1);
  assert.ok(W.dist(f, at(0, 0.7)) < 2, '이상치 영향 없음');
  // 가중: 오차 3m 측정이 오차 30m 측정보다 훨씬 큰 비중
  const w = W.robustFuse([{ ...at(0, 0), acc: 3 }, { ...at(40, 0), acc: 30 }]);
  assert.ok(W.dist(w, at(0, 0)) < 1, '정확한 쪽으로 치우침');
  // 독립 측정 4개를 융합하면 불확도가 줄고 하한 3m 유지
  const g = W.robustFuse([0, 1, 2, 3].map(() => ({ ...at(0, 0), acc: 10 })));
  assert.ok(g.acc < 6 && g.acc >= 3);
});

test('칼만 필터: 직선 보행에서 잡음 감소', () => {
  const n = rng(7), kf = W.createKalman();
  let rawE = 0, kfE = 0, cnt = 0;
  for (let i = 0; i < 90; i++) {
    const truth = at(i * 1.3, 0); // 1.3m/s 북진
    const meas = { ...at(i * 1.3 + n() * 6, n() * 6), acc: 8, heading: null, speed: 0, t: 1_000_000 + i * 1000 };
    const out = kf.update(meas);
    if (i >= 15) { rawE += W.dist(meas, truth) ** 2; kfE += W.dist(out, truth) ** 2; cnt++; }
  }
  const rawRMS = Math.sqrt(rawE / cnt), kfRMS = Math.sqrt(kfE / cnt);
  assert.ok(kfRMS < rawRMS * 0.75, `raw ${rawRMS.toFixed(1)} → kf ${kfRMS.toFixed(1)}`);
});

test('칼만 필터: 진행 방향·속도 추정, 큰 점프 후 재수렴', () => {
  const kf = W.createKalman();
  let out;
  for (let i = 0; i < 25; i++) out = kf.update({ ...at(0, i * 1.4), acc: 5, heading: null, speed: null, t: 2_000_000 + i * 1000 }); // 동쪽 1.4m/s, 기기가 속도를 모름
  assert.ok(Math.abs(out.heading - 90) < 8, `heading ${out.heading}`);
  assert.ok(Math.abs(out.speed - 1.4) < 0.4, `speed ${out.speed}`);
  for (let i = 25; i < 40; i++) out = kf.update({ ...at(500, 500), acc: 5, heading: null, speed: 0, t: 2_000_000 + i * 1000 }); // 위치 점프
  assert.ok(W.dist(out, at(500, 500)) < 30, '재초기화로 수렴');
});

test('낭독용 변환: 오독되는 표기를 소리 나는 대로', () => {
  assert.equal(W.spoken('빠른 승차 8-3, 정류장 21002'), '빠른 승차 8의 3, 정류장 2 1 0 0 2');
  assert.equal(W.spoken('일반 51·5602 탑승'), '일반 51, 5 6 0 2 탑승');
  assert.equal(W.spoken('정류장까지 50미터, 7시 방향(왼쪽 뒤)'), '정류장까지 50미터, 7시 방향, 왼쪽 뒤');
  assert.equal(W.spoken('금호역 입구(출구 번호 미정).'), '금호역 입구, 출구 번호 미정.');
  assert.equal(W.spoken('5623번 버스 도착'), '5 6 2 3번 버스 도착');   // 버스 번호는 한 자리씩
  assert.equal(W.spoken('약 500미터, 749미터 거리'), '약 500미터, 749미터 거리'); // 거리는 그대로
});

test('꺾는 곳 사전 예고: 30m 전, 12m 이내 각 1회', () => {
  const log = [], t0 = { v: 9_000_000 };
  const io = { speak: (s) => log.push(s), vibrate() {}, beep() {}, notify() {} };
  const eng = W.createEngine({ io, now: () => t0.v });
  eng.start({ legs: [{ type: 'walk', title: 'x', intro: '', points: [
    { id: 'turn', name: '꺾는 곳', kind: 'turn', turn: 'right', radius: 6, ...at(100, 0) },
    { id: 'end', name: '끝', kind: 'dest', radius: 6, ...at(100, 100) }] }] }, 0);
  for (const n of [40, 80, 72, 90, 95, 92]) { t0.v += 5000; eng.onFix({ ...at(n, 0), acc: 5, heading: 0, speed: 1.3, t: t0.v }); }
  const pre = log.filter((s) => /꺾기\.$/.test(s));
  assert.equal(pre.filter((s) => /앞에서 오른쪽으로 꺾기/.test(s)).length, 1, pre.join('|'));
  assert.equal(pre.filter((s) => /^곧 오른쪽으로 꺾기/.test(s)).length, 1, pre.join('|'));
});

test('오디오 비콘: 목적지 방향(상대각)을 1.2초 이상 간격으로 전달', () => {
  const calls = [], t0 = { v: 9_500_000 };
  const io = { speak() {}, vibrate() {}, beep() {}, notify() {}, beacon: (rel) => calls.push(Math.round(rel)) };
  const eng = W.createEngine({ io, now: () => t0.v });
  eng.start({ legs: [{ type: 'walk', title: 'x', intro: '', points: [{ id: 'd', name: '끝', kind: 'dest', radius: 6, ...at(0, 100) }] }] }, 0);
  for (let i = 0; i < 4; i++) { t0.v += 2000; eng.onFix({ ...at(0, 0), acc: 5, heading: 0, speed: 1.3, t: t0.v }); } // 북쪽을 향함, 목적지는 동쪽
  assert.equal(calls.length, 4);
  assert.ok(calls.every((r) => r === 90), calls.join(','));  // 오른쪽 직각
});

test('지도 데이터 기준 지점은 안내 시작 때 오차 주의를 알림', () => {
  const log = [];
  const io = { speak: (s) => log.push(s), vibrate() {}, beep() {}, notify() {} };
  const eng = W.createEngine({ io, now: () => 1 });
  eng.start({ legs: [{ type: 'walk', title: 'x', intro: '', points: [
    { id: 'a', name: '지도기준', kind: 'stop', ...at(10, 10), weak: true, samples: [{ ...at(10, 10), acc: 30, src: 'osm' }] },
    { id: 'b', name: '걸어서확인', kind: 'dest', ...at(20, 20), weak: false, samples: [{ ...at(20, 20), acc: 6, src: 'walk' }] }] }] }, 0);
  assert.match(log[0], /현장에서 확인되지 않아 오차가 있을 수 있음/);
  log.length = 0;
  eng.start({ legs: [{ type: 'walk', title: 'x', intro: '', points: [{ id: 'b', name: '걸어서확인', kind: 'dest', ...at(20, 20), weak: false, samples: [{ ...at(20, 20), acc: 6, src: 'walk' }] }] }] }, 0);
  assert.ok(!/확인되지 않아/.test(log[0]));
});

test('버스: 하차 정류장 좌표가 없어도 사무실까지 남은 거리로 하차 준비 안내(자동 전환은 하지 않음)', () => {
  const log = [], t0 = { v: 7_000_000 };
  const io = { speak: (s) => log.push(s), vibrate() {}, beep() {}, notify() {} };
  const eng = W.createEngine({ io, now: () => t0.v });
  eng.start({ legs: [
    { type: 'bus', title: '버스', intro: '', alight: { name: '하차 정류장' } },
    { type: 'walk', title: '도보 400미터', intro: '', points: [{ id: 'd', name: '사무실', kind: 'dest', ...at(0, 0) }] }] }, 0);
  for (const e of [1400, 900, 600, 400, 350]) { t0.v += 3000; eng.onFix({ ...at(0, e), acc: 8, heading: 270, speed: 8, t: t0.v }); } // 사무실까지 동쪽 거리
  assert.equal(log.filter((s) => /하차 정류장이 가까움.*안내방송/.test(s)).length, 1, log.join('|'));   // 위치를 모르므로 하차 시점을 단정하지 않고 한 번만 알림
  assert.equal(eng.status().legIndex, 0, '좌표 없이 자동으로 다음 구간으로 넘기지 않음');
});

test('융합 충돌: 도로 양쪽처럼 비슷한 정확도의 측정이 갈리면 평균(도로 한가운데)을 쓰지 않고 충돌로 표시', () => {
  const near = [{ ...at(0, 0), acc: 5 }, { ...at(0, 1), acc: 5 }, { ...at(30, 0), acc: 5 }, { ...at(30, 1), acc: 5 }];  // 30m 간격 두 군집
  const f = W.robustFuse(near);
  assert.equal(f.conflict, true);
  assert.ok(f.acc >= 15, `오차를 낮게 보고하면 안 됨: ${f.acc}`);
  assert.ok(W.dist(f, at(15, 0.5)) > 10, '두 군집의 한가운데를 정류장으로 쓰면 안 됨');
  // 정확도 차이가 큰 경우는 정확한 쪽을 따름(충돌 아님)
  const g = W.robustFuse([{ ...at(0, 0), acc: 3 }, { ...at(40, 0), acc: 30 }]);
  assert.equal(g.conflict, false); assert.ok(W.dist(g, at(0, 0)) < 1);
});

test('진행 위치 저장·복원: 지도 앱을 다녀와도 처음으로 돌아가지 않음', () => {
  const log = [];
  const io = { speak: (s) => log.push(s), vibrate() {}, beep() {}, notify() {} };
  const route = { legs: [
    { type: 'walk', title: '가', intro: '', points: [{ id: 'a', name: 'A', kind: 'stop', ...at(10, 0) }] },
    { type: 'subway', title: '나', intro: '', stations: ['x', 'y', 'z'] },
    { type: 'walk', title: '다', intro: '', points: [{ id: 'b', name: 'B', kind: 'dest', ...at(50, 0) }] }] };
  const e1 = W.createEngine({ io, now: () => 1 });
  e1.start(route, 0); e1.skipLeg(); e1.next();                         // 지하철 구간에서 한 역 이동
  const snap = e1.snapshot();
  assert.deepEqual(snap, { li: 1, pi: 0, stIdx: 1 });
  const e2 = W.createEngine({ io, now: () => 1 });                       // 앱이 다시 열린 상황
  e2.restore(route, snap);
  assert.equal(e2.status().legIndex, 1); assert.equal(e2.status().stIdx, 1);
  assert.match(log[log.length - 1], /이어서 안내함. 나/);
  assert.equal(W.createEngine({ io }).snapshot(), null);
});

test('안내가 버려지면(말하는 중) 다음 위치 수신 때 다시 시도하고, 구간 첫 안내는 반드시 이어서 말함', () => {
  const spoken = []; let busy = true;
  const io = { speak: (s, prio) => { if (prio === 'normal' && busy) return false; spoken.push([prio, s]); return true; }, vibrate() {}, beep() {}, notify() {} };
  let t = 3_000_000; const eng = W.createEngine({ io, now: () => t });
  eng.start({ legs: [{ type: 'walk', title: 'x', intro: '소개.', points: [{ id: 'd', name: '정류장', kind: 'stop', ...at(0, 200) }] }] }, 0);
  eng.onCompass(90); t += 1000; eng.onFix({ ...at(0, 0), acc: 5, heading: null, speed: 0, t });
  assert.deepEqual(spoken.map((x) => x[0]), ['high', 'queue'], '첫 방향 안내는 소개 뒤 queue로');
  // 걷는 중 주기 안내가 버려져도 다음 수신에서 다시 시도
  for (let i = 1; i <= 70; i++) { t += 1000; eng.onCompass(90); eng.onFix({ ...at(0, i * 1.3), acc: 5, heading: 90, speed: 1.3, t }); }   // 91m 이동(정면 재안내 기준 80m 초과)
  const n = spoken.length; busy = false;
  t += 1000; eng.onFix({ ...at(0, 92.3), acc: 5, heading: 90, speed: 1.3, t });
  assert.equal(spoken.length, n + 1, '말하기가 끝난 직후 밀린 안내가 나와야 함');
});

test('지하철에서 나온 직후 GPS 두절로 오인하지 않음, 역 세기 되돌리기', () => {
  const log = []; let t = 4_000_000;
  const io = { speak: (s) => { log.push(s); }, vibrate() {}, beep() {}, notify() {} };
  const eng = W.createEngine({ io, now: () => t });
  eng.start({ legs: [
    { type: 'walk', title: '가', intro: '', points: [{ id: 'a', name: 'A', kind: 'entrance', ...at(0, 5) }] },
    { type: 'subway', title: '나', intro: '', stations: ['x', 'y', 'z'] },
    { type: 'walk', title: '다', intro: '', points: [{ id: 'b', name: 'B', kind: 'stop', ...at(0, 500) }] }] }, 0);
  eng.onFix({ ...at(0, 5), acc: 5, heading: null, speed: 0, t });      // 입구 도착 → 지하철 구간
  eng.onFix({ ...at(0, 5), acc: 5, heading: null, speed: 0, t });      // 연속 2회 측정으로 확정
  assert.equal(eng.status().legIndex, 1);
  eng.next(); eng.prevLeg();
  assert.match(log[log.length - 1], /한 역 되돌렸음. 현재 x역/); assert.equal(eng.status().stIdx, 0);
  t += 20 * 60 * 1000; eng.next(); eng.next();                          // 20분 뒤 하차 → 도보 구간
  assert.equal(eng.status().legIndex, 2);
  const n = log.length; eng.onCompass(0);
  assert.equal(log.length, n, '구간 진입 직후에는 GPS 두절 경고를 하지 않음');
  t += 21000; eng.onCompass(0);
  assert.match(log[log.length - 1], /지상으로 나오면 방향을 알려줌/);   // 지하철 직후에는 기다리라고 하지 않음
});

test('안전 재검증 회귀: 꺾는 곳 건너뛰기는 가까이 왔다가 멀어질 때만, 알림과 함께', () => {
  const log = []; let t = 6_000_000;
  const io = { speak: (s) => { log.push(s); }, vibrate() {}, beep() {}, notify() {} };
  const mkRoute = () => ({ legs: [{ type: 'walk', title: 'x', intro: '', learned: { text: 'y' }, points: [
    { id: 'c', name: '꺾는 곳', kind: 'turn', turn: 'right', radius: 8, ...at(100, 0), weak: false, samples: [{ ...at(100, 0), acc: 8, src: 'walk' }] },
    { id: 'e', name: '정류장', kind: 'stop', radius: 8, ...at(100, 100), weak: false, samples: [{ ...at(100, 100), acc: 6, src: 'walk' }] }] }] });
  // (1) 꺾는 곳 35m 앞에서 반대로 20m 걸어도 건너뛰지 않음
  let eng = W.createEngine({ io, now: () => t }); eng.start(mkRoute(), 0);
  for (const n of [65, 62, 58, 54, 50, 46, 45]) { t += 1000; eng.onFix({ ...at(n, 0), acc: 5, heading: 180, speed: 1.3, t }); }
  assert.equal(eng._S.pi, 0, '멀리서 반대로 걸은 것만으로 꺾는 곳을 건너뛰면 안 됨');
  // (2) 12m 옆을 스쳐 지나가 계속 멀어지면 알리고 다음 지점으로
  log.length = 0; eng = W.createEngine({ io, now: () => t }); eng.start(mkRoute(), 0);
  for (let n = 70; n <= 135; n += 1.3) { t += 1000; eng.onFix({ ...at(n, 12), acc: 5, heading: 0, speed: 1.3, t }); }
  assert.equal(eng._S.pi, 1); assert.ok(log.some((s) => /꺾는 곳 지점을 지나친 것 같음.*다음 지점으로 안내함/.test(s)));
});

test('안전 재검증 회귀: 지하철 하차 후 첫 지점이 500m 넘게 떨어지면 역 확인 안내, 집에서 출발하는 구간에는 적용하지 않음', () => {
  const log = []; let t = 7_500_000;
  const io = { speak: (s) => { log.push(s); }, vibrate() {}, beep() {}, notify() {} };
  const exit = { id: 'x', name: '6번 출구', kind: 'exit', radius: 8, ...at(0, 0), weak: false, samples: [{ ...at(0, 0), acc: 5, src: 'walk' }] };
  const eng = W.createEngine({ io, now: () => t });
  eng.start({ legs: [{ type: 'subway', title: '지하철', intro: '', stations: ['a', 'b'] }, { type: 'walk', title: '도보', intro: '', learned: { text: 'y' }, points: [exit] }] }, 0);
  eng.next();                                                             // 하차 처리 → 도보 구간
  for (let i = 0; i < 3; i++) { t += 1000; eng.onFix({ ...at(1000, 0), acc: 8, heading: null, speed: 0, t }); }   // 실제로는 1km 떨어진 다른 역(정확한 위치 연속 3회)
  assert.ok(log.some((s) => /1킬로미터 떨어져 있음. 내린 역이 맞는지/.test(s)), log.join('|'));
  assert.ok(!log.some((s) => /6번 출구까지/.test(s)), '역이 다를 수 있는데 일반 방향 안내를 하면 안 됨');
  log.length = 0;
  const e2 = W.createEngine({ io, now: () => t });
  e2.start({ legs: [{ type: 'walk', title: '집에서 역까지', intro: '', learned: { text: 'y' }, points: [exit] }] }, 0);
  t += 1000; e2.onFix({ ...at(749, 0), acc: 8, heading: null, speed: 0, t });
  assert.ok(!log.some((s) => /내린 역이 맞는지/.test(s)));
});

test('안전 재검증 회귀: 추정 오차가 큰 지점(recAcc>20)은 약한 좌표로 취급, 약한 목적지는 30m 앞에서 안내를 끝내지 않음', () => {
  const log = []; let t = 8_500_000;
  const io = { speak: (s) => { log.push(s); }, vibrate() {}, beep() {}, notify() {} };
  const eng = W.createEngine({ io, now: () => t });
  eng.start({ legs: [{ type: 'walk', title: '도보', intro: '', points: [{ id: 'd', name: '사무실', kind: 'dest', radius: 8, ...at(0, 100), weak: false, recAcc: 97 }] }] }, 0);
  for (let e = 40; e <= 80; e += 1.3) { t += 1000; eng.onFix({ ...at(0, e), acc: 5, heading: 90, speed: 1.3, t }); }
  assert.equal(eng.status().legIndex, 0, '20m 앞에서 목적지 도착으로 끝내면 안 됨');
  assert.ok(log.some((s) => /사무실 부근임/.test(s)));
  assert.ok(log.some((s) => /대략/.test(s)));
});

test('안전 재검증 2차 회귀: 하차 처리 뒤 이전 단계는 역 세기를 처음으로 되돌리지 않고 한 역만 되돌림', () => {
  const log = []; let t = 9_000_000;
  const io = { speak: (s) => { log.push(s); }, vibrate() {}, beep() {}, notify() {} };
  const eng = W.createEngine({ io, now: () => t });
  eng.start({ legs: [{ type: 'subway', title: '2호선', intro: '', stations: ['교대', '서초', '방배', '사당'] }, { type: 'walk', title: '도보', intro: '', points: [{ id: 's', name: '정류장', kind: 'stop', ...at(0, 0), weak: true }] }] }, 0);
  eng.next(); eng.next(); eng.next();                         // 사당 하차 처리 → 도보 구간
  assert.equal(eng.status().legIndex, 1);
  eng.prevLeg();                                              // 한 역 일찍 내렸음
  assert.equal(eng.status().legIndex, 0); assert.equal(eng.status().stIdx, 2);
  assert.match(log[log.length - 1], /현재 방배역으로 처리함. 다음 역이 하차역 사당/);
  eng.next(); assert.equal(eng.status().legIndex, 1, '다음 한 번이면 다시 하차역');
});

test('안전 재검증 2차 회귀: 약한 좌표는 그 위치까지 걸어가도 도착 선언·자동 전환이 없고 다음 버튼으로만 진행', () => {
  for (const kind of ['stop', 'dest']) {
    const log = []; let t = 9_500_000;
    const io = { speak: (s) => { log.push(s); }, vibrate() {}, beep() {}, notify() {} };
    const eng = W.createEngine({ io, now: () => t });
    eng.start({ legs: [{ type: 'walk', title: '도보', intro: '', points: [{ id: 'p', name: '지점', kind, radius: 8, ...at(0, 100), weak: true }] }, { type: 'bus', title: '버스', intro: '', alight: { name: 'x' } }] }, 0);
    for (let e = 40; e <= 100; e += 1.3) { t += 1000; eng.onFix({ ...at(0, e), acc: 5, heading: 90, speed: 1.3, t }); }
    for (let i = 0; i < 20; i++) { t += 1000; eng.onFix({ ...at(0, 100), acc: 5, heading: null, speed: 0, t }); }   // 좌표 위에 20초 서 있음
    assert.equal(eng.status().legIndex, 0, kind + ': 자동으로 넘어가면 안 됨');
    assert.ok(!log.some((s) => /도착/.test(s)), kind + ': 도착이라고 말하면 안 됨 → ' + log.filter((s) => /도착/.test(s)).join('|'));
    assert.ok(log.some((s) => /저장된 위치에 왔음.*찾았으면 다음 버튼/.test(s)));
    eng.next(); assert.equal(eng.status().legIndex, 1);
  }
});

test('안전 재검증 2차 회귀: 정류장 앞에 서 있는 동안 GPS 잡음으로 지나쳤다고 말하지 않음', () => {
  let seed = 5; const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
  const log = []; let t = 9_800_000;
  const io = { speak: (s) => { log.push(s); }, vibrate() {}, beep() {}, notify() {} };
  const eng = W.createEngine({ io, now: () => t });
  eng.start({ legs: [{ type: 'walk', title: '도보', intro: '', learned: { text: 'y' }, points: [{ id: 's', name: '정류장', kind: 'stop', radius: 8, ...at(0, 25), weak: false, samples: [{ ...at(0, 25), acc: 5, src: 'walk' }] }] }] }, 0);
  for (let i = 0; i < 300; i++) { t += 1000; eng.onFix({ ...at((rnd() - 0.5) * 30, (rnd() - 0.5) * 30), acc: 8, heading: null, speed: 0, t }); }   // 25m 앞 5분 정지, 위치가 ±15m 흔들림
  assert.equal(log.filter((s) => /지나친/.test(s)).length, 0);
});

test('중앙차로 정류장: 60m 안에서는 방향·거리 안내와 자동 도착을 멈추고 도움 요청을 안내, 다음 버튼으로 진행', () => {
  const log = []; let t = 10_000_000; const beeps = [];
  const io = { speak: (s) => { log.push(s); }, vibrate() {}, beep: (f) => beeps.push(f), notify() {} };
  const eng = W.createEngine({ io, now: () => t });
  eng.start({ legs: [{ type: 'walk', title: '도보', intro: '', points: [{ id: 's', name: '정류장', kind: 'stop', median: true, radius: 8, ...at(0, 150), weak: true }] }, { type: 'bus', title: '버스', intro: '', alight: { name: 'x' } }] }, 0);
  for (let e = 0; e <= 150; e += 1.3) { t += 1000; eng.onFix({ ...at(0, e), acc: 5, heading: 90, speed: 1.3, t }); }
  for (let i = 0; i < 50; i++) { t += 1000; eng.onFix({ ...at(0, 150), acc: 5, heading: null, speed: 0, t }); }
  const n60 = log.findIndex((s) => /도로 한가운데 승강장이라 여기서부터 방향 안내를 멈춤/.test(s));
  assert.ok(n60 > 0, log.join('|'));
  assert.ok(!log.slice(n60 + 1).some((s) => /시 방향|정면|미터 남음|도착/.test(s)), '60m 안에서는 방향·거리·도착을 말하지 않음: ' + log.slice(n60 + 1).join('|'));
  assert.ok(log.slice(n60 + 1).some((s) => /횡단보도는 주변 사람에게 물어보세요/.test(s)), '머무는 동안 다시 알림');
  assert.equal(beeps.length, 0, '차도 쪽으로 끌어당기는 근접 비프 없음');
  assert.equal(eng.status().legIndex, 0); eng.next(); assert.equal(eng.status().legIndex, 1);
});

test('경로 소개: 처음부터 시작하면 전체 길 설명을 먼저 읽고 이어서 첫 구간 안내', () => {
  const log = [];
  const io = { speak: (s, p) => { log.push([p, s]); }, vibrate() {}, beep() {}, notify() {} };
  const route = require('../route.json').routes[0];
  const eng = W.createEngine({ io, now: () => 1 });
  eng.start(route, 0);
  assert.equal(route.id, 'E');
  assert.match(log[0][1], /여의도역 6번 출구로 나와.*5623번.*문성초등학교.*왼쪽으로 길을 건너.*좌회전 지점은 서울정형외과의원.*1층에 행복한 공인중개사 사무소.*3층/);
  assert.equal(log[0][0], 'high'); assert.equal(log[1][0], 'queue');
  const ret = require('../route.json').routes[1];
  assert.equal(ret.id, 'R'); assert.match(ret.overview, /온 길을 그대로 되돌아감.*여의도역 5번 출구/);
});

test('접근성 재검증 2차 회귀: 구간 진입 때는 짧게 말하고, 전체 설명은 요청 시. 문장 끝 버스 번호도 한 자리씩', () => {
  const log = [];
  const io = { speak: (s, p) => { log.push(s); }, vibrate() {}, beep() {}, notify() {} };
  const route = require('../route.json').routes[0];
  const eng = W.createEngine({ io, now: () => 1 });
  eng.start(route, 0);
  const walkIdx = route.legs.findIndex((l, i) => i > 0 && route.legs[i - 1].type === 'bus');
  while (eng.status().legIndex < walkIdx) eng.skipLeg();
  const said = log[log.length - 1];
  assert.ok(said.length <= 90, `하차 직후 안내가 김(${said.length}자): ${said}`);
  assert.match(said, /도로 한가운데 승강장.*음향신호기가 있는 횡단보도.*왼쪽 인도로 건넘/);
  eng.detail();
  assert.match(log[log.length - 1], /서울정형외과의원.*1층에 행복한 공인중개사 사무소.*3층/);
  assert.equal(W.spoken('탑승 버스는 51, 5602, 5627.'), '탑승 버스는 51, 5 6 0 2, 5 6 2 7.');
  assert.equal(W.spoken('거리 1.5킬로미터, 273미터.'), '거리 1.5킬로미터, 273미터.');
});

test('출근 하차 후 구간: 좌회전 지점 근처에서 랜드마크를 알리고 사무실 안내로 넘어감(도착 선언 없음)', () => {
  const log = []; let t = 11_000_000;
  const io = { speak: (s) => { log.push(s); }, vibrate() {}, beep() {}, notify() {} };
  const route = require('../route.json').routes[0];
  const li = route.legs.findIndex((l, i) => i > 0 && route.legs[i - 1].type === 'bus');
  const leg = route.legs[li], turn = leg.points[0], dest = leg.points[1];
  assert.equal(turn.kind, 'turn'); assert.equal(turn.turn, 'left');
  const dTurn = W.dist(route.legs[li - 1].alight, turn), dOff = W.dist(turn, dest);
  assert.ok(dTurn > 120 && dTurn < 160 && dOff > 180 && dOff < 230, `하차→모퉁이 ${Math.round(dTurn)}m, 모퉁이→사무실 ${Math.round(dOff)}m`);
  const eng = W.createEngine({ io, now: () => t }); eng.start(route, li);
  eng.next();   // 길을 건넜다고 확인(그 전에는 방향 안내 없음)
  // 인도(승강장 동쪽 20m)에서 남쪽으로 걸어 모퉁이까지
  const a = route.legs[li - 1].alight, M = (Math.PI * 6371000) / 180;
  for (let s = 0; s <= dTurn; s += 1.2) { t += 1000; eng.onFix({ lat: a.lat - s / M, lng: turn.lng + 0.00005, acc: 6, heading: 180, speed: 1.2, t }); }
  assert.ok(log.some((x) => /앞에서 왼쪽으로 꺾기/.test(x)), '사전 예고');
  assert.ok(log.some((x) => /이 근처가 좌회전 지점임. 서울정형외과의원이 있는 건물을 끼고 왼쪽 골목/.test(x)), log.slice(-4).join('|'));
  assert.equal(eng._S.pi, 1, '사무실 안내로 넘어감');
  assert.ok(!log.some((x) => /도착/.test(x)));
});

test('재검증 3차 회귀: 중앙 승강장 하차 직후에는 건넜다고 확인하기 전까지 방향·거리 안내가 없음(다시 듣기 포함)', () => {
  const log = []; let t = 12_000_000;
  const io = { speak: (s) => { log.push(s); }, vibrate() {}, beep() {}, notify() {} };
  const route = require('../route.json').routes[0];
  const li = route.legs.findIndex((l, i) => i > 0 && route.legs[i - 1].type === 'bus');
  const a = route.legs[li - 1].alight;
  const eng = W.createEngine({ io, now: () => t }); eng.start(route, li);
  for (let i = 0; i < 30; i++) { t += 1000; eng.onFix({ lat: a.lat, lng: a.lng, acc: 6, heading: null, speed: i % 5 ? 0 : 0.8, t }); }
  eng.repeat();
  const bad = log.filter((s) => /시 방향|정면|목표는|좌회전 지점까지/.test(s));   // 승강장을 따라 횡단보도까지의 거리는 허용
  assert.equal(bad.length, 0, '승강장 위에서 방향·거리를 말하면 안 됨: ' + bad.join('|'));
  assert.ok(eng.status().waitCross);
  assert.match(log[log.length - 1], /음향신호기가 있는 횡단보도.*왼쪽 인도로 건넘.*인도에 올라섰으면 다음 버튼/);
  eng.next(); assert.equal(eng._S.pi, 0, '건넜음 확인은 지점을 넘기지 않음'); assert.ok(!eng.status().waitCross);
  t += 1000; eng.onFix({ lat: a.lat, lng: a.lng + 0.0002, acc: 6, heading: 180, speed: 1.2, t });
  assert.match(log[log.length - 1], /좌회전 지점까지 대략 \d+미터. 가던 길을 따라 계속 가세요/);   // 꺾는 곳은 방위 없이 거리만
});

test('재검증 3차 회귀: 다음 버튼을 놓치고 버스에 타도 하차 알림이 시작되고, 승강장이 둘이면 먼저 지나는 쪽 기준으로 알림', () => {
  const log = []; let t = 13_000_000;
  const io = { speak: (s) => { log.push(s); }, vibrate() {}, beep() {}, notify() {} };
  const route = require('../route.json').routes[0];
  const li = route.legs.findIndex((l) => l.type === 'bus') - 1;         // 정류장으로 가는 도보 구간
  const stop = route.legs[li].points[route.legs[li].points.length - 1], al = route.legs[li + 1].alight;
  assert.ok(W.hasXY(al.alt), '하차 승강장 두 곳 좌표');
  const eng = W.createEngine({ io, now: () => t }); eng.start(route, li);
  for (let i = 0; i < 5; i++) { t += 1000; eng.onFix({ lat: stop.lat, lng: stop.lng, acc: 6, heading: null, speed: 0, t }); }
  assert.equal(eng.status().legIndex, li);                               // 다음 버튼을 누르지 않음
  const M = (Math.PI * 6371000) / 180;
  for (let i = 1; i <= 15; i++) { t += 1000; eng.onFix({ lat: stop.lat - (8 * i) / M, lng: stop.lng, acc: 8, heading: 180, speed: 8, t }); }   // 버스 주행
  assert.equal(eng.status().legIndex, li + 1, '버스 구간으로 자동 전환');
  assert.ok(log.some((s) => /버스에 탄 것으로 보고 하차 알림을 시작함/.test(s)));
  assert.ok(eng.status().busEarly, '주행 중 다음 버튼은 확인이 필요함');
  // 북쪽 승강장(먼저 지나는 쪽)에 접근하면 알림
  log.length = 0;
  for (const dN of [450, 140, 30]) { t += 5000; eng.onFix({ lat: al.alt.lat + dN / M, lng: al.alt.lng, acc: 8, heading: 180, speed: 8, t }); }
  assert.ok(log.some((s) => /하차 준비/.test(s)) && log.some((s) => /하차벨을 누르세요. 버스가 서고 정류장 이름이 문성초등학교이면/.test(s)), log.join('|'));
  assert.ok(log.some((s) => /지금 서는 정류장 이름이 문성초등학교이면 내리세요/.test(s)));
  assert.equal(W.spoken('시흥대로138길, 독산로85길 37, 5623번'), '시흥대로138길, 독산로85길 37, 5 6 2 3번');
});

test('버튼 없는 모드: 봉천역 출발 경로를 다음 버튼 없이 끝까지 진행', () => {
  const log = []; let t = 20_000_000; const autos = [];
  const io = { speak: (s) => { log.push(s); }, vibrate() {}, beep() {}, notify() {}, onAuto: (k) => autos.push(k) };
  const route = JSON.parse(JSON.stringify(require('../route.json'))).routes.find((r) => r.id === 'B');
  const eng = W.createEngine({ io, now: () => t, handsFree: true });
  const M = (Math.PI * 6371000) / 180;
  const fix = (lat, lng, speed, hd) => { t += 1000; eng.onFix({ lat, lng, acc: 7, heading: hd == null ? null : hd, speed, t }); eng.tick(); };
  const wait = (sec) => { for (let i = 0; i < sec; i++) { t += 1000; eng.tick(); } };
  eng.start(route, 0);
  assert.ok(!log.some((s) => /버튼/.test(s)), '버튼 없는 모드에서는 버튼 안내를 말하지 않음: ' + log.filter((s) => /버튼/.test(s)).join('|'));
  // 1) 지하철: 위치 없이 6분. 시간 기준 하차 예고
  wait(5 * 60);
  assert.ok(log.some((s) => /곧 하차역일 수 있음. 안내방송에서 구로디지털단지역이 나오면 내리세요/.test(s)), '시간 기준 하차 예고');
  assert.equal(eng.status().legIndex, 0, '위치 없이 도보 구간으로 넘어가지 않음');
  // 2) 지상 복귀: 정류장에서 북쪽 150m, 걷는 속도 → 도보 구간 자동 시작
  const stop = route.legs[1].points[0];
  for (let i = 0; i < 10; i++) fix(stop.lat + (150 - i) / M, stop.lng + 0.0004, 1.0, 180);
  assert.equal(eng.status().legIndex, 1, '지상에 나오면 도보 안내 시작');
  assert.ok(log.some((s) => /지상에 나온 것으로 보고 도보 안내를 시작함/.test(s)));
  // 3) 정류장 근처까지 걷고(60m 안에서는 방향 안내 중지), 버스 탑승 → 차량 속도로 자동 전환
  for (let i = 0; i < 100; i++) fix(stop.lat + Math.max(8, 140 - i * 1.2) / M, stop.lng + 0.00005, i < 110 ? 1.2 : 0, 180);
  assert.equal(eng.status().legIndex, 1);
  const al = route.legs[2].alight;
  let lat = stop.lat;
  for (let i = 0; i < 14; i++) { lat -= 8 / M; fix(lat, stop.lng, 8, 180); }
  assert.equal(eng.status().legIndex, 2, '버스에 타면 하차 알림 시작');
  // 4) 버스로 하차 정류장까지, 정차 후 걷는 속도 → 내린 것으로 자동 전환
  while ((lat - al.lat) * M > 10) { lat -= 8 / M; fix(lat, al.lng, 8, 180); }
  assert.ok(log.some((s) => /하차벨을 누르세요/.test(s)), '하차 예고');
  for (let i = 0; i < 14; i++) fix(al.lat, al.lng + (i * 0.5) / (M * Math.cos(al.lat * Math.PI / 180)), 0.6, 90);
  assert.equal(eng.status().legIndex, 3, '내리면 도보 안내 시작');
  assert.ok(autos.includes('alight'));
  // 5) 승강장에서는 방향 안내 없음 → 40m 넘게 벗어나면 안내 시작
  const k = M * Math.cos(al.lat * Math.PI / 180);
  const n0 = log.length;
  for (let i = 0; i < 10; i++) fix(al.lat, al.lng + (7 + i) / k, 1.0, 90);
  assert.ok(!log.slice(n0).some((s) => /미터|방향/.test(s) && !/건넘|건너/.test(s)), '승강장 근처에서는 방향·거리 안내 없음: ' + log.slice(n0).join('|'));
  const ca = route.legs[3].crossAt;                                    // 승강장을 따라 횡단보도까지 간 뒤 동쪽 인도로 건넘
  for (let i = 1; i <= 30; i++) fix(al.lat + (ca.lat - al.lat) * i / 30, al.lng + (ca.lng - al.lng) * i / 30, 1.0, 160);
  assert.ok(log.some((s) => /횡단보도 근처임. 서울시 횡단보도 자료로는 보행 신호등과 음향신호기가 있음/.test(s)));
  for (let i = 1; i <= 40; i++) fix(ca.lat - (i * 0.6) / M, ca.lng + (i * 1.0) / k, 1.0, 120);
  assert.ok(log.some((s) => /승강장에서 벗어난 것으로 보고 방향 안내를 시작함/.test(s)));
  assert.ok(log.some((s) => /좌회전 지점까지 대략 \d+미터/.test(s)), '건넌 뒤 좌회전 지점 안내');
  assert.ok(!log.some((s) => /버튼/.test(s)), '끝까지 버튼 안내 없음');
});

test('버튼 없는 모드: 잘못 내린 것으로 판단해도 다시 달리면 버스 구간으로 돌아감, 다른 역에서 나오면 경고', () => {
  const log = []; let t = 21_000_000;
  const io = { speak: (s) => { log.push(s); }, vibrate() {}, beep() {}, notify() {} };
  const route = JSON.parse(JSON.stringify(require('../route.json'))).routes.find((r) => r.id === 'B');
  const M = (Math.PI * 6371000) / 180;
  const eng = W.createEngine({ io, now: () => t, handsFree: true });
  const fix = (lat, lng, speed) => { t += 1000; eng.onFix({ lat, lng, acc: 7, heading: 180, speed, t }); eng.tick(); };
  const al = route.legs[2].alight;
  eng.start(route, 2);                                             // 버스 구간
  let lat = al.lat + 600 / M;
  for (let i = 0; i < 62; i++) { lat -= 8 / M; fix(lat, al.lng, 8); }            // 하차 정류장 약 100m 앞까지 주행
  for (let i = 0; i < 13; i++) fix(lat, al.lng, 0.2);              // 신호 대기로 13초 정차 → 내린 것으로 판단
  assert.equal(eng.status().legIndex, 3);
  for (let i = 0; i < 12; i++) { lat -= 8 / M; fix(lat, al.lng, 8); }            // 다시 달림 → 아직 버스 안
  assert.equal(eng.status().legIndex, 2, '버스 구간으로 복귀');
  assert.ok(log.some((s) => /아직 버스 안인 것으로 보고 하차 알림을 계속함/.test(s)));
  // 다른 역(1km 떨어진 곳)에서 지상으로 나온 경우
  log.length = 0;
  const e2 = W.createEngine({ io, now: () => t, handsFree: true });
  e2.start(route, 0); const stop = route.legs[1].points[0];
  for (let i = 0; i < 200; i++) { t += 1000; e2.tick(); }          // 지하 200초
  for (let i = 0; i < 12; i++) { t += 1000; e2.onFix({ lat: stop.lat + 1000 / M, lng: stop.lng, acc: 8, heading: 0, speed: 1.0, t }); e2.tick(); }
  assert.equal(e2.status().legIndex, 0, '다른 역에서는 도보 안내로 넘어가지 않음');
  assert.ok(log.some((s) => /1킬로미터 떨어져 있음. 내린 역이 맞는지/.test(s)), log.join('|'));
});

test('횡단보도 자료: 하차 후 승강장에서 횡단보도까지 거리 안내, 근처에서 음향신호기 정보, 건넌 뒤에만 방향 안내', () => {
  const log = []; let t = 30_000_000;
  const io = { speak: (s) => { log.push(s); }, vibrate() {}, beep() {}, notify() {} };
  const route = JSON.parse(JSON.stringify(require('../route.json'))).routes.find((r) => r.id === 'B');
  const li = route.legs.findIndex((l) => l.startMedian), leg = route.legs[li], ca = leg.crossAt, al = route.legs[li - 1].alight;
  assert.ok(W.hasXY(ca) && W.dist(al, ca) > 35 && W.dist(al, ca) < 60, '횡단보도는 승강장에서 약 45m');
  const eng = W.createEngine({ io, now: () => t, handsFree: true }); eng.start(route, li);
  const steps = 30, f = (k) => ({ lat: al.lat + (ca.lat - al.lat) * k, lng: al.lng + (ca.lng - al.lng) * k });
  for (let i = 0; i <= steps; i++) { t += 1500; const p = f(i / steps); eng.onFix({ ...p, acc: 6, heading: 160, speed: 1.0, t }); eng.tick(); }
  assert.ok(log.some((s) => /횡단보도까지 약 \d+미터/.test(s)), '횡단보도까지 거리');
  assert.ok(log.some((s) => /횡단보도 근처임. 서울시 횡단보도 자료로는 보행 신호등과 음향신호기가 있음/.test(s)));
  assert.ok(eng.status().waitCross, '횡단보도 앞에서는 아직 건너지 않은 것으로 봄');
  const k = (Math.PI * 6371000) / 180 * Math.cos(ca.lat * Math.PI / 180);
  for (let i = 1; i <= 30; i++) { t += 1000; eng.onFix({ lat: ca.lat - 0.00002 * i, lng: ca.lng + (i * 1.2) / k, acc: 6, heading: 100, speed: 1.1, t }); eng.tick(); }
  assert.ok(!eng.status().waitCross, '건넌 뒤 방향 안내 시작'); assert.ok(log.some((s) => /좌회전 지점까지 대략/.test(s)));
});
