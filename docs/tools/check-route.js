#!/usr/bin/env node
// 경로 좌표 검증: node docs/tools/check-route.js [route.json 경로]
// 1) 형식·범위(서울권) 2) 도보 구간의 직선거리 ≤ 안내 도보거리(제목의 'N미터') 3) 구간 내 지점 간 비정상 거리
const fs = require('fs');
const W = require('../engine.js');
const file = process.argv[2] || require('path').join(__dirname, '..', 'route.json');
const d = JSON.parse(fs.readFileSync(file, 'utf8'));
const BBOX = { latMin: 37.40, latMax: 37.72, lngMin: 126.76, lngMax: 127.20 }; // 서울권 대략 범위
let fail = 0, warn = 0;
const F = (m) => { fail++; console.log('  ✗ 오류:', m); };
const Wn = (m) => { warn++; console.log('  △ 주의:', m); };
const ok = (m) => console.log('  ✓', m);

for (const r of d.routes) {
  console.log(`\n[${r.id}] ${r.name}`);
  const home = r.home && W.hasXY(r.home) ? r.home : (d.home && W.hasXY(d.home) ? d.home : null);
  let missing = 0;
  for (const [li, l] of r.legs.entries()) {
    const pts = (l.points || []).slice();
    if (l.alight) pts.push(Object.assign({ id: 'alight', name: '하차 ' + l.alight.name }, l.alight));
    for (const p of pts) {
      if (!W.hasXY(p)) { missing++; continue; }
      if (p.lat < BBOX.latMin || p.lat > BBOX.latMax || p.lng < BBOX.lngMin || p.lng > BBOX.lngMax) F(`${p.name}: 서울권 범위 밖 (${p.lat}, ${p.lng}). 위도/경도 순서 확인`);
      const dec = (String(p.lat).split('.')[1] || '').length;
      if (dec < 5) Wn(`${p.name}: 소수점 ${dec}자리 — 정밀도 낮음(약 ${Math.round(111000 / 10 ** dec)}m 단위)`);
    }
    if (l.type !== 'walk') continue;
    const m = (l.title.match(/([\d,]+)\s*미터/) || [])[1];
    if (!m) continue;
    const walkM = +m.replace(/,/g, '');
    // 구간의 시작점: 첫 구간은 집, 그 외는 구간 첫 지점(출구 등)
    const chain = li === 0 ? [home].concat(l.points) : l.points;
    const a = chain[0], b = chain[chain.length - 1];
    if (!W.hasXY(a) || !W.hasXY(b) || a === b) { Wn(`'${l.title}': 양 끝 좌표 부족 — 거리 교차 검증 불가`); continue; }
    // 경유 지점이 있으면 꺾은선 길이, 없으면 직선
    let path = 0; for (let i = 1; i < chain.length; i++) if (W.hasXY(chain[i - 1]) && W.hasXY(chain[i])) path += W.dist(chain[i - 1], chain[i]);
    const straight = W.dist(a, b);
    const info = `직선 ${Math.round(straight)}m / 꺾은선 ${Math.round(path)}m / 카카오 도보 ${walkM}m`;
    if (straight > walkM * 1.05 + 15) F(`'${l.title}': 직선거리가 도보거리보다 큼 → 좌표 오류 가능. ${info}`);
    else if (straight < walkM * 0.45) Wn(`'${l.title}': 직선이 도보거리의 절반 미만 → 우회로 많거나 좌표 오류. ${info}`);
    else ok(`'${l.title}': ${info}`);
  }
  console.log(`  좌표 미입력 지점: ${missing}개` + (home ? '' : ' · 집 좌표(route.home) 없음 → 첫 구간 교차검증 불가'));
}
console.log(`\n오류 ${fail}건, 주의 ${warn}건`);
process.exit(fail ? 1 : 0);
