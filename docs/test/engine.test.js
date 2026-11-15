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
  eng.next(); assert.match(log[log.length - 1], /교대역 도착. 하차역임/);
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
  assert.match(log[0], /좌표가 기록되지 않은 지점이 1개/);
  fix(at(0, 0));
  assert.ok(log.some((s) => /좌표가 아직 없음/.test(s)));
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
  for (let i = 0; i < 25; i++) out = kf.update({ ...at(0, i * 1.4), acc: 5, heading: null, speed: 0, t: 2_000_000 + i * 1000 }); // 동쪽 1.4m/s
  assert.ok(Math.abs(out.heading - 90) < 8, `heading ${out.heading}`);
  assert.ok(Math.abs(out.speed - 1.4) < 0.4, `speed ${out.speed}`);
  for (let i = 25; i < 40; i++) out = kf.update({ ...at(500, 500), acc: 5, heading: null, speed: 0, t: 2_000_000 + i * 1000 }); // 위치 점프
  assert.ok(W.dist(out, at(500, 500)) < 30, '재초기화로 수렴');
});

test('낭독용 변환: 오독되는 표기를 소리 나는 대로', () => {
  assert.equal(W.spoken('빠른 승차 8-3, 정류장 21002'), '빠른 승차 8의 3, 정류장 2 1 0 0 2');
  assert.equal(W.spoken('일반 51·5602 탑승'), '일반 51, 5602 탑승');
  assert.equal(W.spoken('정류장까지 50미터, 7시 방향(왼쪽 뒤)'), '정류장까지 50미터, 7시 방향, 왼쪽 뒤');
  assert.equal(W.spoken('금호역 입구(출구 번호 미정).'), '금호역 입구, 출구 번호 미정.');
  assert.equal(W.spoken('5623번 버스 도착'), '5623번 버스 도착'); // 4자리 버스 번호는 그대로
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
  assert.match(log[0], /지도 데이터 기준이라 오차가 있을 수 있음/);
  log.length = 0;
  eng.start({ legs: [{ type: 'walk', title: 'x', intro: '', points: [{ id: 'b', name: '걸어서확인', kind: 'dest', ...at(20, 20), weak: false, samples: [{ ...at(20, 20), acc: 6, src: 'walk' }] }] }] }, 0);
  assert.ok(!/지도 데이터 기준/.test(log[0]));
});

test('버스: 하차 정류장 좌표가 없어도 사무실까지 남은 거리로 하차 준비 안내(자동 전환은 하지 않음)', () => {
  const log = [], t0 = { v: 7_000_000 };
  const io = { speak: (s) => log.push(s), vibrate() {}, beep() {}, notify() {} };
  const eng = W.createEngine({ io, now: () => t0.v });
  eng.start({ legs: [
    { type: 'bus', title: '버스', intro: '', alight: { name: '하차 정류장' } },
    { type: 'walk', title: '도보 400미터', intro: '', points: [{ id: 'd', name: '사무실', kind: 'dest', ...at(0, 0) }] }] }, 0);
  for (const e of [1400, 900, 600, 400, 350]) { t0.v += 3000; eng.onFix({ ...at(0, e), acc: 8, heading: 270, speed: 8, t: t0.v }); } // 사무실까지 동쪽 거리
  assert.ok(log.some((s) => /하차 준비/.test(s)), log.join('|'));
  assert.ok(log.some((s) => /하차벨/.test(s)));
  assert.ok(log.some((s) => /안내방송으로 정류장 이름을 확인/.test(s)));
  assert.equal(eng.status().legIndex, 0, '좌표 없이 자동으로 다음 구간으로 넘기지 않음');
});
