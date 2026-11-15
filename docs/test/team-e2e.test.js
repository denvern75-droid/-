/*
 * 길동무 시나리오(E2E) 시험 — 시각장애인이 '사전 답사 없이 처음 가는 길'을 걸을 때의 안내 품질 검증
 *
 * 전제(실제 앱 docs/app.js 와 동일한 파이프라인):
 *   원시 GPS(잡음) → createKalman().update() → engine.onFix()   /  나침반 → engine.onCompass()
 * 좌표는 서울 임의 기준점 기준 합성 좌표(미터→도 변환). 지도 데이터 기준 지점은 오차 30m 가정(weak).
 * GPS 잡음: 1Hz, 매 샘플 σ 3~8m 균등, 4% 확률로 25m 튀는 값. 걷는 중에는 방향·속도 필드 제공(방향 ±10° 잡음),
 * 정지 중에는 heading=null, speed=0 (브라우저 Geolocation 실제 동작).
 * 모든 시나리오는 여러 시드(1..SEEDS)로 반복하며, 한 시드라도 기대에서 벗어나면 실패(이용자는 운 좋은 날만 쓰지 않음).
 *
 * 기대 동작은 '귀로 듣는 이용자' 관점으로 각 시나리오 위에 먼저 적었고, 어긋나면 skip 없이 실패로 둔다.
 */
const test = require('node:test');
const assert = require('node:assert');
const W = require('../engine.js');

// ---------- 합성 좌표계 ----------
const O = { lat: 37.5, lng: 127.0 };
const M = (Math.PI * 6371000) / 180;
const mN = 1 / M, mE = 1 / (M * Math.cos((O.lat * Math.PI) / 180));
const at = (north, east) => ({ lat: O.lat + north * mN, lng: O.lng + east * mE });
const SEEDS = 8;

// ---------- 시뮬레이터 ----------
function sim(seed, o = {}) {
  let s = (seed * 2654435761) >>> 0;
  const u = () => ((s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296);
  const gauss = () => Math.sqrt(-2 * Math.log(u() + 1e-12)) * Math.cos(2 * Math.PI * u());
  let t = 5_000_000 + seed * 100_000;
  const t0 = t;
  const log = [], vib = [];
  const io = {
    speak: (text, prio) => log.push({ t: t - t0, text, prio }),
    vibrate: (p) => vib.push({ t: t - t0, p }),
    beep() {}, notify() {},
  };
  const eng = W.createEngine({ io, now: () => t, config: o.config });
  const kf = W.createKalman();
  const st = { n: 0, e: 0, facing: 0, stats: { outliers: 0 } };
  const hasCompass = o.compass !== false;

  // 1초 진행. moving: {hdg} 이면 걷는 중
  function tick(moving, opt = {}) {
    t += opt.dt || 1000;
    if (hasCompass && !opt.noCompass) eng.onCompass(((moving ? moving.hdg : st.facing) + gauss() * 4 + 360) % 360);
    if (opt.gpsOff) return;
    const sigma = 3 + 5 * u();
    let dn = gauss() * sigma, de = gauss() * sigma, acc = sigma;
    if (u() < 0.04) { const a = u() * 2 * Math.PI; dn = 25 * Math.cos(a); de = 25 * Math.sin(a); acc = 12; st.stats.outliers++; }
    const walking = moving && !o.noHeading;
    const raw = {
      ...at(st.n + dn, st.e + de), acc,
      heading: walking ? (moving.hdg + gauss() * 10 + 360) % 360 : null,
      speed: walking ? 1.3 + gauss() * 0.15 : 0, t,
    };
    eng.onFix(kf.update(raw));
  }
  const hdgTo = (n, e) => (Math.atan2(e - st.e, n - st.n) * 180 / Math.PI + 360) % 360;
  const distTo = (n, e) => Math.hypot(n - st.n, e - st.e);
  return {
    eng, log, vib, st, io, tick, hdgTo, distTo, at,
    now: () => t - t0,
    stand(sec, facing, opt) { if (facing != null) st.facing = facing; for (let i = 0; i < sec; i++) tick(null, opt); },
    // 목표점까지 걷기. until() 이 true 면 중단. 반환: 경과 초
    walk(n, e, opt = {}) {
      const speed = opt.speed || 1.3; let sec = 0;
      while (sec < (opt.maxSec || 300) && distTo(n, e) > (opt.stopWithin || 1.5)) {
        if (opt.until && opt.until()) break;
        const h = hdgTo(n, e), step = Math.min(speed, distTo(n, e));
        st.n += step * Math.cos(h * Math.PI / 180); st.e += step * Math.sin(h * Math.PI / 180); st.facing = h;
        tick({ hdg: h }); sec++;
      }
      return sec;
    },
    legIndex: () => eng.status().legIndex,
    heardSince(ms, re) { return log.filter((x) => x.t >= ms && re.test(x.text)); },
    dump: () => log.map((x) => `[+${Math.round(x.t / 1000)}s] ${x.text}`).join('\n  '),
  };
}

const pt = (id, name, kind, n, e, x = {}) => ({ id, name, kind, ...at(n, e), radius: 10, ...x });
const walkLeg = (title, points, x = {}) => ({ type: 'walk', title, intro: '', points, ...x });
const forSeeds = (fn, n = SEEDS) => {
  const fails = [];
  for (let sd = 1; sd <= n; sd++) { try { fn(sd); } catch (err) { fails.push(`seed ${sd}: ${err.message}`); } }
  assert.equal(fails.length, 0, `${fails.length}/${n} 시드 실패\n` + fails.slice(0, 3).join('\n---\n'));
};
const BACK_RE = /유턴|반대 방향|뒤돌아|뒤쪽/;

// =====================================================================
// 시나리오 1. 출구에서 나온 직후 서 있는 이용자 → 7시 방향 정류장 안내 → 실제로 걸어 도착
// 기대(이용자 귀): 서 있는 5초 안에 "정류장까지 50미터 안팎, 7시 방향" 한 번. 걸어가는 동안 "유턴/반대/지나침/경로 이탈"
//   같은 거짓 경고가 없고, 정류장 근처(반경 안)에서 "정류장 도착" 후 다음 구간 안내. 도착까지 걷는 시간은 50m/1.3 ≈ 40초+여유 70초 이내.
// =====================================================================
const route1 = () => ({ legs: [
  walkLeg('출구에서 정류장', [pt('s', '정류장', 'stop', -43.3, -25, { say: '탑승 준비' })]),
  walkLeg('하차 후', [pt('d', '사무실', 'dest', 0, 100)]),
] });

test('S1-a 서 있는 이용자: 5초 안에 7시 방향·약 50미터 안내', () => {
  forSeeds((sd) => {
    const x = sim(sd); x.eng.start(route1(), 0);
    x.stand(5, 0);
    const heard = x.log.filter((l) => /정류장까지/.test(l.text));
    assert.ok(heard.length >= 1, '정류장까지 거리 안내 없음\n  ' + x.dump());
    assert.match(heard[0].text, /(4[05]|50|55)미터/, heard[0].text);
    assert.match(heard[0].text, /7시 방향|6시 방향|8시 방향/, heard[0].text); // 약 7시(±1시 허용)
  });
});

test('S1-b 안내대로 걸어가 도착: 70초 내 도착, 걷는 동안 거짓 경고(유턴/지나침/이탈) 없음', () => {
  forSeeds((sd) => {
    const x = sim(sd); x.eng.start(route1(), 0);
    x.stand(5, 0);
    const startMs = x.now();
    const sec = x.walk(-43.3, -25, { maxSec: 90, until: () => x.legIndex() === 1 });
    x.stand(1);
    assert.equal(x.legIndex(), 1, `도착 못함(${sec}s)\n  ` + x.dump());
    const fake = x.heardSince(startMs + 4000, /지나친|벗어났음/);   // 걷기 시작 4초 뒤부터
    assert.equal(fake.length, 0, '거짓 경고: ' + fake.map((f) => f.text).join(' | ') + '\n  ' + x.dump());
    const uturn = x.heardSince(startMs + 8000, BACK_RE);
    assert.equal(uturn.length, 0, '맞게 걷는데 유턴 안내: ' + uturn.map((f) => f.text).join(' | '));
    assert.ok(x.log.some((l) => /정류장 도착\. 탑승 준비/.test(l.text)));
  });
});

// =====================================================================
// 시나리오 2. 출구에서 정류장 반대 방향(남쪽)을 보고 서 있다가 그대로 걷기 시작
// 기대: 서 있을 때 "뒤쪽(6시)/뒤돌아" 안내. 이용자가 (안내를 흘려듣고) 반대 방향으로 걷기 시작해도
//   걷기 시작 후 8초 안에 "유턴/반대 방향" 교정 안내가 나오고, 교정 후(북쪽으로 걸음) 도착. 교정 이후 낡은 유턴 안내가 계속 반복되지 않음.
// =====================================================================
const route2 = () => ({ legs: [walkLeg('출구에서 정류장', [pt('s', '정류장', 'stop', 100, 0, { say: '탑승 준비' })]), walkLeg('끝', [pt('d', '사무실', 'dest', 100, 100)])] });

test('S2 반대로 걷기 시작 → 8초 내 유턴 교정, 교정 후 도착', () => {
  forSeeds((sd) => {
    const x = sim(sd); x.eng.start(route2(), 0);
    x.stand(3, 180);                       // 남쪽(정류장 반대)을 보고 섬
    assert.ok(x.log.some((l) => BACK_RE.test(l.text)), '서 있을 때 뒤쪽 안내 없음\n  ' + x.dump());
    const walkStart = x.now();
    let corrected = null;
    x.walk(-60, 0, { maxSec: 30, until: () => { corrected = x.log.find((l) => l.t > walkStart && BACK_RE.test(l.text)); return !!corrected; } });
    assert.ok(corrected, '30초 걸어도 교정 안내 없음\n  ' + x.dump());
    assert.ok(corrected.t - walkStart <= 8000, `교정이 늦음: ${(corrected.t - walkStart) / 1000}s 후 "${corrected.text}"`);
    x.stand(2);                            // 반응 시간
    const turnedAt = x.now();
    x.walk(100, 0, { maxSec: 200, until: () => x.legIndex() === 1 });
    assert.equal(x.legIndex(), 1, '교정 후에도 도착 못함\n  ' + x.dump());
    const stale = x.heardSince(turnedAt + 10000, BACK_RE);
    assert.equal(stale.length, 0, '맞게 돌아선 뒤에도 유턴 안내: ' + stale.map((f) => f.text).join(' | '));
  });
});

// =====================================================================
// 시나리오 3. 정류장을 지나쳐 계속 걷는 경우
// 기대: 정류장 맞은편 보도(동쪽 14m 옆)를 따라 걸어 지나침. 지나친 뒤 35m 이내에 "지나친 것 같음 … 돌아가야 함, N시 방향" 한 번.
//   첫 경고 이후 10초 동안 같은 경고 반복 금지(소음).
// =====================================================================
test('S3 정류장 지나침: 35m 이내 경고, 문구에 되돌아갈 방향 포함', () => {
  forSeeds((sd) => {
    const x = sim(sd);
    const r = { legs: [walkLeg('x', [pt('s', '정류장', 'stop', 100, 14, { radius: 8 })]), walkLeg('y', [pt('d', '끝', 'dest', 300, 100)])] };
    x.eng.start(r, 0);
    x.st.n = 40; x.st.e = 14;               // 정류장 60m 전 (정류장 맞은편 보도)
    x.stand(2, 0);
    let warn = null, pastAt = null;
    x.walk(180, 14, { maxSec: 120, until: () => { warn = x.log.find((l) => /지나친/.test(l.text)); if (warn && !pastAt) pastAt = x.st.n; return !!warn; } });
    assert.equal(x.legIndex(), 0, '14m 옆을 지나갔는데 도착 처리됨(반경 과대)');
    assert.ok(warn, '180m까지 걸어도 지나침 경고 없음\n  ' + x.dump());
    assert.ok(pastAt - 100 <= 35, `지나침 경고가 늦음: 정류장 ${Math.round(pastAt - 100)}m 지난 뒤`);
    assert.match(warn.text, /돌아가/, warn.text);
    assert.match(warn.text, /시 방향|뒤쪽|정면/, warn.text);
    // 경고 뒤 계속 걸어도 10초 내 중복 경고 없음
    const n0 = x.log.filter((l) => /지나친/.test(l.text)).length;
    x.walk(200, 14, { maxSec: 10 });
    assert.equal(x.log.filter((l) => /지나친/.test(l.text)).length, n0, '10초 내 지나침 경고 반복');
  });
});

// =====================================================================
// 시나리오 4. 경로 이탈 후 복귀
// 기대: 동쪽 직선 경로(150m)에서 북쪽으로 45m 빗나감 → 25m 넘은 뒤 15초 안에 "경로에서 N미터 벗어났음 + 방향".
//   이탈이 지속돼도 경고는 30초에 1~2회 이내. 경로로 돌아오면 거짓 경고 없이 안내가 이어지고 "돌아왔음/맞게 가는 중" 확인 문구가 있으며 끝내 도착.
// =====================================================================
test('S4 경로 이탈 → 15초 내 경고 → 복귀 확인 → 도착', () => {
  forSeeds((sd) => {
    const x = sim(sd);
    const r = { legs: [walkLeg('직선', [pt('a', '모퉁이', 'turn', 0, 0, { radius: 6 }), pt('b', '정류장', 'stop', 0, 150, { radius: 6 })]), walkLeg('y', [pt('d', '끝', 'dest', 0, 250)])] };
    x.eng.start(r, 0); x.eng.next();
    x.stand(2, 90);
    // 경로 위 20m 지점까지 직진 → 북쪽으로 빗나가며 진행
    x.walk(0, 20, { maxSec: 30 });
    let exceed25 = null;
    const wps = [[45, 75], [45, 95]];
    let warn = null;
    for (const [wn, we] of wps) {
      x.walk(wn, we, { maxSec: 60, until: () => { if (!exceed25 && x.st.n > 30) exceed25 = x.now(); warn = x.log.find((l) => /벗어났음/.test(l.text)); return !!warn && x.now() - exceed25 > 3000; } });
      if (warn) break;
    }
    assert.ok(exceed25, '시뮬레이션 오류: 이탈 안 함');
    assert.ok(warn, '45m 벗어났는데 경고 없음\n  ' + x.dump());
    assert.ok(warn.t - exceed25 <= 15000, `이탈 경고 지연 ${(warn.t - exceed25) / 1000}s`);
    assert.match(warn.text, /시 방향|뒤쪽|정면/, warn.text);
    // 경고를 듣고 2초 뒤 복귀(경로 위 점으로)
    x.stand(2);
    const backAt = x.now();
    x.walk(0, x.st.e + 20, { maxSec: 60, until: () => x.st.n < 3 });
    const onRouteAt = x.now();
    x.walk(0, 150, { maxSec: 200, until: () => x.legIndex() === 1 });
    assert.equal(x.legIndex(), 1, '복귀 후 도착 못함\n  ' + x.dump());
    const warnsAfterBack = x.log.filter((l) => l.t > onRouteAt + 5000 && /벗어났음/.test(l.text));
    assert.equal(warnsAfterBack.length, 0, '복귀 후에도 이탈 경고: ' + warnsAfterBack.map((l) => l.text).join('|'));
    const confirm = x.log.filter((l) => l.t >= backAt && l.t <= onRouteAt + 15000 && /돌아왔|복귀|맞게 가는 중|경로 위/.test(l.text));
    assert.ok(confirm.length >= 1, '경로로 돌아왔다는 확인 안내 없음(이용자는 맞게 왔는지 알 수 없음)\n  ' + x.dump());
  });
});

test('S4-b 이탈 상태가 길어져도 경고는 30초에 2회 이하', () => {
  forSeeds((sd) => {
    const x = sim(sd);
    const r = { legs: [walkLeg('직선', [pt('a', '모퉁이', 'turn', 0, 0, { radius: 6 }), pt('b', '정류장', 'stop', 0, 150, { radius: 6 })])] };
    x.eng.start(r, 0); x.eng.next();
    x.st.n = 50; x.st.e = 60; x.stand(2, 0);        // 경로에서 50m 이탈 상태
    const t1 = x.now();
    x.walk(120, 60, { maxSec: 30 });                // 경로와 반대로 더 멀어짐
    const n = x.log.filter((l) => l.t >= t1 && /벗어났음/.test(l.text)).length;
    assert.ok(n <= 2, `30초에 이탈 경고 ${n}회`);
  });
});

// =====================================================================
// 시나리오 5. 지도 좌표가 실제 정류장에서 25m 어긋난 경우 (지도 데이터 기준, 오차 30m)
// 기대: 이용자는 안내에 따라 접근해 실제 정류장 앞에 선다. 그때 엔진은 (a) 도착으로 판정하거나,
//   (b) 최소한 "지도 오차일 수 있음/표지 확인/다음 버튼" 등 이용자가 스스로 빠져나올 수단을 45초 안에 말해야 한다.
//   '정류장까지 25미터' 같은 안내만 영원히 반복해서는 안 됨. 또 지도 기준(weak) 지점의 도착 반경은 기록 오차(≈30m)를 반영해야 함.
// =====================================================================
test('S5 지도 좌표 25m 어긋남: 실제 정류장 앞에서 도착 판정 또는 오차 안내', () => {
  forSeeds((sd) => {
    const x = sim(sd);
    const real = { n: -43.3, e: -25 };
    const mapped = { n: real.n + 12.5, e: real.e - 21.7 };            // 지도상 위치는 실제와 25m 어긋남
    const weakPt = pt('s', '정류장', 'stop', mapped.n, mapped.e, { weak: true, samples: [{ ...at(mapped.n, mapped.e), acc: 30, src: 'osm' }] });
    delete weakPt.radius;                                             // 지도 데이터 지점은 반경 미지정(기본값)
    x.eng.start({ legs: [walkLeg('출구에서 정류장', [weakPt]), walkLeg('끝', [pt('d', '사무실', 'dest', 0, 100)])] }, 0);
    x.stand(4, 0);
    x.walk(real.n, real.e, { maxSec: 90, stopWithin: 2, until: () => x.legIndex() === 1 });
    const reachedAt = x.now();
    const arrivedEarly = x.legIndex() === 1;
    if (!arrivedEarly) x.stand(45);
    const arrived = x.legIndex() === 1;
    const help = x.heardSince(reachedAt, /오차|지도|표지|다음 버튼|건너|직접 확인|주변을 확인/);
    assert.ok(arrived || help.length > 0,
      '실제 정류장 앞에 45초 서 있어도 도착 판정도, 오차 안내도 없음. 마지막 안내: "' + (x.log[x.log.length - 1] || {}).text + '"\n  ' + x.dump());
  });
});

test('S5-b 지도 기준(weak) 지점의 도착 반경은 지도 오차(≈30m)를 반영해야 함', () => {
  const x = sim(1);
  const p = pt('s', '정류장', 'stop', 0, 100, { weak: true, samples: [{ ...at(0, 100), acc: 30, src: 'osm' }] });
  delete p.radius;
  x.eng.start({ legs: [walkLeg('x', [p]), walkLeg('y', [pt('d', '끝', 'dest', 0, 300)])] }, 0);
  // 실제 정류장이 지도점에서 20m 떨어진 곳에 있고 이용자가 그 위에 정확히 서 있음(GPS 잡음 거의 없음)
  x.eng.onFix({ ...at(0, 80), acc: 4, heading: 90, speed: 1.3, t: 1 });
  assert.equal(x.legIndex(), 1, '지도점에서 20m(지도 오차 30m 이내) 이내인데 도착 판정 안 됨: 반경 ' + Math.max(p.radius || 12, 4));
});

// =====================================================================
// 시나리오 6. 버스 구간: 하차 정류장 좌표 없음 → 사무실까지 거리로 대체 → 수동 '다음' → 도보
// 기대: 버스가 실제 하차 정류장에 서기 *전*(최소 40m 전)에 "내리세요" 수준(3단계) 안내가 나와야 함(내릴 수 있는 시간).
//   3단계 안내는 각 1회. '다음' 후 도보 구간 안내가 시작되고 사무실에 도착.
// =====================================================================
function busRoute(straightToOffice, alight) {
  return { legs: [
    { type: 'bus', title: '버스', intro: '', alight },
    walkLeg('도보 400미터', [pt('d', '사무실', 'dest', 0, 6000 + straightToOffice, { radius: 10 })]),
  ] };
}
function rideBus(x, fromE, toE, stopAfterFirstFinal) {
  x.st.e = fromE; x.st.n = 0;
  const finalRe = /안내방송|내리세요/;
  let finalAt = null;
  while (x.st.e < toE) {
    x.st.e = Math.min(toE, x.st.e + 8); x.st.facing = 90;
    x.tick({ hdg: 90 });
    if (!finalAt && x.log.some((l) => finalRe.test(l.text))) finalAt = { e: x.st.e };
  }
  return finalAt;
}

test('S6-a 하차 좌표 없음(우회 보행, 직선 340m): 3단계 안내가 정류장 도착 전에 나오고 각 1회, 다음 → 도보 도착', () => {
  forSeeds((sd) => {
    const x = sim(sd);
    const stopE = 6000;                                // 실제 하차 정류장
    x.eng.start(busRoute(340, { name: '하차 정류장' }), 0);
    const finalAt = rideBus(x, 600, stopE);
    for (const re of [/하차 준비/, /하차벨/, /안내방송/]) assert.equal(x.log.filter((l) => re.test(l.text)).length, 1, `${re} 횟수\n  ` + x.dump());
    assert.ok(finalAt && finalAt.e <= stopE - 40, `내리라는 안내가 늦음: 정류장 ${finalAt ? stopE - finalAt.e : '-'}m 전`);
    assert.equal(x.legIndex(), 0, '자동 전환하면 안 됨');
    x.stand(3);
    x.eng.next();
    assert.equal(x.legIndex(), 1);
    x.walk(0, 6340, { maxSec: 400, until: () => x.legIndex() === 2 });
    assert.equal(x.legIndex(), 2, '도보 구간 도착 못함\n  ' + x.dump());
  });
});

test('S6-c 하차 좌표 없음(직선 400m 보도): 버스가 정류장에 서기 전에 마지막 안내가 나와야 함', () => {
  forSeeds((sd) => {
    const x = sim(sd);
    const stopE = 6000;                                // 정류장에서 사무실까지 직선 400m = 안내문 400미터
    x.eng.start(busRoute(400, { name: '하차 정류장' }), 0);
    // 버스가 정류장에 도착해 15초 정차(문 열림) — 이 동안에도 못 들으면 내릴 수 없음
    const finalAt = rideBus(x, 600, stopE);
    const beforeDwell = !!finalAt;
    if (!beforeDwell) for (let i = 0; i < 15; i++) x.tick(null);
    const heard = x.log.some((l) => /안내방송|내리세요/.test(l.text));
    assert.ok(beforeDwell, `정류장 도착 시점까지 '내리세요' 안내 없음(정차 15초 후 청취=${heard}). 마지막: "${(x.log[x.log.length - 1] || {}).text}"`);
  });
});

test('S6-b 하차 정류장·도착지 좌표가 모두 없으면: 무음이 아니라 대체 안내(안내방송 확인/다음 버튼)', () => {
  const x = sim(1);
  x.eng.start({ legs: [{ type: 'bus', title: '버스', intro: '', alight: { name: '하차 정류장' } }, walkLeg('도보 400미터', [{ id: 'd', name: '사무실', kind: 'dest', lat: null, lng: null }])] }, 0);
  const before = x.log.length;
  rideBus(x, 600, 6000);
  const said = x.log.slice(before);
  assert.ok(said.length >= 1, '버스 20분 동안 아무 안내도 없음(앱이 멈춘 것과 구별 불가)');
});

// =====================================================================
// 시나리오 7. GPS가 한동안 끊겼다 복구(지하/터널)
// 기대: (a) 끊긴 동안 무음이 길어지면 "GPS 신호 없음" 같은 알림이 있어야 함(이용자는 앱이 죽었는지 모름) — 엔진에 타이머/틱이 없으면 실패.
//   (b) 복구 첫 3초 안에 새 위치 기준 안내(거리 ±20m, 정면)가 나옴. (c) 복구 직후 거짓 이탈/지나침 경고 없음.
//   (d) 정류장 가까이서 끊겼다 정류장을 지난 위치에서 복구되면 즉시 지나침 경고.
// =====================================================================
const route7 = (stopN) => ({ legs: [walkLeg('직진', [pt('s', '정류장', 'stop', stopN, 0, { radius: 8 })]), walkLeg('y', [pt('d', '끝', 'dest', stopN + 100, 0)])] });

test('S7-a 지하 구간 100초 동안 GPS 없음: 무음 중 이용자에게 신호 끊김을 알려야 함', () => {
  const x = sim(1); x.eng.start(route7(250), 0);
  x.stand(3, 0); x.walk(40, 0, { maxSec: 40 });
  const n0 = x.log.length;
  for (let i = 0; i < 100; i++) { x.st.n += 1.3; x.tick({ hdg: 0 }, { gpsOff: true }); }
  const said = x.log.slice(n0);
  assert.ok(said.some((l) => /GPS|신호|위치.*(없|끊|못)/.test(l.text)), `GPS 100초 두절 동안 안내 ${said.length}건, 신호 끊김 알림 없음`);
});

test('S7-b GPS 복구 3초 안에 새 위치 기준 안내(남은 약 80m), 거짓 경고 없음', () => {
  forSeeds((sd) => {
    const x = sim(sd); x.eng.start(route7(250), 0);
    x.stand(3, 0); x.walk(40, 0, { maxSec: 40 });
    for (let i = 0; i < 100; i++) { x.st.n += 1.3; x.tick({ hdg: 0 }, { gpsOff: true }); }  // 약 170m 지점에서 복구
    const back = x.now();
    for (let i = 0; i < 3; i++) { x.st.n += 1.3; x.tick({ hdg: 0 }); }
    const g = x.heardSince(back, /정류장까지/);
    assert.ok(g.length >= 1, '복구 후 3초 내 안내 없음\n  ' + x.dump());
    const m = g[0].text.match(/(\d+)미터/);
    assert.ok(m && Math.abs(+m[1] - 80) <= 20, `복구 후 거리 오류: ${g[0].text}`);
    assert.match(g[0].text, /정면|1시|11시|12시/, g[0].text);
    assert.equal(x.heardSince(back, /지나친|벗어났음/).length, 0, '복구 직후 거짓 경고');
  });
});

test('S7-c 정류장 15m 앞에서 GPS 두절, 정류장 70m 뒤에서 복구: 즉시 지나침 경고', () => {
  forSeeds((sd) => {
    const x = sim(sd); const r = route7(100); r.legs[0].points[0].radius = 6;
    x.eng.start(r, 0);
    x.st.n = 60; x.stand(2, 0); x.walk(88, 0, { maxSec: 40, until: () => x.legIndex() === 1 });
    x.stand(3);
    assert.equal(x.legIndex(), 0, '88m에서 도착 처리됨(반경 과대?)');
    for (let i = 0; i < 50; i++) x.tick({ hdg: 0 }, { gpsOff: true });
    x.st.n = 170; const back = x.now();
    for (let i = 0; i < 4; i++) { x.st.n += 1.3; x.tick({ hdg: 0 }); }
    assert.ok(x.heardSince(back, /지나친/).length >= 1, '복구 후 4초 내 지나침 경고 없음\n  ' + x.dump());
  });
});

// =====================================================================
// 시나리오 8. 방향 센서 없는 경우
// 기대: (a) 나침반·진행방향 모두 없이 서 있을 때, 맹인에게 "북동쪽" 같은 절대방위는 쓸모없음 → "몇 걸음 걸어 보라" 등
//   방향을 얻는 행동 지시가 있어야 함. (b) 방향 센서 없이 목적지 쪽으로 똑바로 걸어갈 때(GPS 방향필드 없음, 잡음 σ3~8m)
//   "유턴/반대 방향" 같은 틀린 교정이 시드의 10% 이상에서 나오면 안 됨. (c) 나침반이 안정적인데 서 있으면 계속 같은 시계 방향.
// =====================================================================
test('S8-a 방향 정보 전혀 없이 서 있을 때: 방향을 얻는 행동 지시(걸어 보라 등)가 있어야 함', () => {
  const x = sim(1, { compass: false });
  x.eng.start({ legs: [walkLeg('x', [pt('s', '정류장', 'stop', 40, 40)])] }, 0);
  x.stand(8, 0);
  const g = x.log.filter((l) => /정류장까지/.test(l.text));
  assert.ok(g.length >= 1, '안내 없음');
  assert.match(g[0].text, /걸어|걸음|움직|돌려|돌아서|앞으로/, `절대방위만 말함: "${g[0].text}"`);
});

test('S8-b 방향 센서 없이 목적지로 똑바로 걷는 중 40초: 거짓 유턴·반대 안내가 시드의 10% 미만', () => {
  const N = 20; let bad = 0; const ex = [];
  for (let sd = 1; sd <= N; sd++) {
    const x = sim(sd, { compass: false, noHeading: true });
    x.eng.start({ legs: [walkLeg('x', [pt('s', '정류장', 'stop', 200, 0)])] }, 0);
    x.stand(2, 0); x.walk(60, 0, { maxSec: 1 }); const t1 = x.now();
    x.walk(200, 0, { maxSec: 40 });
    const f = x.heardSince(t1, BACK_RE);
    if (f.length) { bad++; if (ex.length < 3) ex.push(`seed ${sd}: ${f[0].text}`); }
  }
  assert.ok(bad / N < 0.1, `똑바로 걷는데 유턴/반대 안내 ${bad}/${N} 시드. 예: ${ex.join(' ; ')}`);
});

test('S8-c 나침반이 안정적으로 북쪽, 목적지 동쪽, 서 있는 30초: 안내 시계방향은 항상 3시 부근', () => {
  forSeeds((sd) => {
    const x = sim(sd);
    x.eng.start({ legs: [walkLeg('x', [pt('s', '정류장', 'stop', 0, 80)])] }, 0);
    const n0 = x.log.length;
    x.stand(30, 0);
    const bad = x.log.slice(n0).map((l) => l.text).filter((s) => /정류장까지|오른쪽|왼쪽|뒤쪽|정면/.test(s) && !/(2|3|4)시 방향|오른쪽 옆|오른쪽 앞|오른쪽으로 꺾기/.test(s));
    assert.equal(bad.length, 0, '정지·나침반 일정한데 방향이 흔들림: ' + bad.join(' | '));
  });
});

// =====================================================================
// 시나리오 9. 같은 지점에서 안내 반복(소음) — 30초 발화 횟수
// 기대: (a) 한 자리에 서 있는 30초 동안 발화 2회 이하(첫 안내 + 많아야 1번 되풀이). (b) 맞게 걷는 30초 동안 발화 4회 이하.
//   (c) 같은 문장이 10초 안에 되풀이되지 않음.
// =====================================================================
test('S9-a 한 자리에 서 있는 30초: 발화 2회 이하', () => {
  const counts = [];
  forSeeds((sd) => {
    const x = sim(sd);
    x.eng.start({ legs: [walkLeg('x', [pt('s', '정류장', 'stop', 0, 80)])] }, 0);
    const n0 = x.log.length; x.stand(30, 0);
    const c = x.log.length - n0; counts.push(c);
    assert.ok(c <= 2, `서 있는 30초 동안 ${c}회 발화(시드별: ${counts.join(',')})\n  ` + x.log.slice(n0).map((l) => `[+${Math.round(l.t / 1000)}s] ${l.text}`).join('\n  '));
  });
});

test('S9-b 맞는 방향으로 걷는 30초: 발화 4회 이하', () => {
  forSeeds((sd) => {
    const x = sim(sd);
    x.eng.start({ legs: [walkLeg('x', [pt('s', '정류장', 'stop', 300, 0)])] }, 0);
    x.stand(2, 0); const n0 = x.log.length;
    x.walk(300, 0, { maxSec: 30 });
    const c = x.log.length - n0;
    assert.ok(c <= 4, `맞게 걷는 30초 동안 ${c}회 발화\n  ` + x.log.slice(n0).map((l) => `[+${Math.round(l.t / 1000)}s] ${l.text}`).join('\n  '));
  });
});

test('S9-c 같은 문장이 10초 안에 되풀이되지 않음(정지 30초)', () => {
  forSeeds((sd) => {
    const x = sim(sd);
    x.eng.start({ legs: [walkLeg('x', [pt('s', '정류장', 'stop', 0, 80)])] }, 0);
    x.stand(30, 0);
    const l = x.log.slice(1);
    for (let i = 1; i < l.length; i++) assert.ok(!(l[i].text === l[i - 1].text && l[i].t - l[i - 1].t < 10000), `10초 안 동일 문장 반복: "${l[i].text}"`);
  });
});
