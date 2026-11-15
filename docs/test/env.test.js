const test = require('node:test');
const assert = require('node:assert');
const W = require('../engine.js');
const E = require('../env.js');
const M = (Math.PI * 6371000) / 180, k = Math.cos((37.5 * Math.PI) / 180);
const at = (n, e) => ({ lat: 37.5 + n / M, lng: 127.0 + e / (M * k) });
const cn = (n, e, tags) => ({ type: 'node', lat: at(n, e).lat, lon: at(n, e).lng, tags: Object.assign({ highway: 'crossing' }, tags) });

test('횡단보도: 태그가 없으면 정보 없음, 있으면 그대로', () => {
  const a = E.crossingInfo({ highway: 'crossing' });
  assert.deepEqual([a.signal, a.sound, a.tactile], ['unknown', 'unknown', 'unknown']);
  assert.match(E.crossingText(a), /신호등 정보 없음, 음향신호기 정보 없음, 점자블록 정보 없음/);
  const b = E.crossingInfo({ crossing: 'traffic_signals', 'traffic_signals:sound': 'yes', tactile_paving: 'no' });
  assert.match(E.crossingText(b), /신호등 있음, 음향신호기 있음, 점자블록 없음/);
  assert.match(E.crossingText(E.crossingInfo({ crossing: 'zebra' })), /신호 없는 횡단보도/);
});

test('경로 위 횡단보도: 경로 근처만, 진행 거리순, 중복 제거', () => {
  const a = at(0, 0), b = at(200, 0);
  const els = [cn(150, 3, { crossing: 'traffic_signals' }), cn(60, -2, { crossing: 'zebra' }), cn(100, 80, {}), cn(62, 0, {}), cn(120, 0, { highway: 'bus_stop' })];
  const r = E.crossingsAlong(els, a, b, 20);
  assert.equal(r.length, 2, JSON.stringify(r.map((x) => x.along)));      // 80m 떨어진 것, 버스정류장, 62m 중복 제외
  assert.ok(r[0].along < r[1].along && Math.abs(r[0].along - 60) < 4 && Math.abs(r[1].along - 150) < 4);
});

test('도로: 일방통행·인도 없음은 명시된 경우만 단정', () => {
  const r = E.roadInfo({ highway: 'service', name: '독산로85길', oneway: 'yes', sidewalk: 'no' });
  assert.match(E.roadText(r), /독산로85길, 이면도로·진입로, 일방통행, 인도 없음.*차량 소리에 주의/);
  const u = E.roadInfo({ highway: 'residential' });
  assert.match(E.roadText(u), /일방통행 여부 정보 없음, 인도 유무 정보 없음/);        // 태그 없음 ≠ 양방향
  assert.match(E.roadText(E.roadInfo({ highway: 'living_street' })), /생활도로\(보행자 우선 도로\)/);
  assert.match(E.roadText(E.roadInfo({ highway: 'residential', oneway: 'no', sidewalk: 'both' })), /양방향, 인도 있음/);
  const w = [{ tags: { highway: 'residential', name: '다른길' } }, { tags: { highway: 'service', name: '독산로85길' } }];
  assert.equal(E.pickRoad(w, '독산로85길').name, '독산로85길');
});

test('랜드마크·점포: 가까운 순, 이름 있는 것만, 층은 표기 있을 때만', () => {
  const c = at(0, 0);
  const els = [
    { type: 'node', lat: at(10, 0).lat, lon: at(10, 0).lng, tags: { name: '맛나편의점', shop: 'convenience', 'addr:floor': '1' } },
    { type: 'node', lat: at(30, 0).lat, lon: at(30, 0).lng, tags: { name: '하나은행', amenity: 'bank' } },
    { type: 'node', lat: at(5, 5).lat, lon: at(5, 5).lng, tags: { shop: 'kiosk' } },                 // 이름 없음
    { type: 'way', center: { lat: at(20, 0).lat, lon: at(20, 0).lng }, tags: { name: '디지털빌딩', building: 'yes' } },
    { type: 'node', lat: at(200, 0).lat, lon: at(200, 0).lng, tags: { name: '먼가게', shop: 'x' } },  // 범위 밖
  ];
  const l = E.landmarks(els, c, 40, 4);
  assert.deepEqual(l.map((x) => x.name), ['맛나편의점', '디지털빌딩', '하나은행']);
  assert.equal(l[0].floor, '1'); assert.equal(l[2].floor, '');
  assert.match(E.landmarkText(l, '목적지'), /^목적지 주변: 맛나편의점\(층 표기 1\), 디지털빌딩, 하나은행$/);
});

test('구간 안내문: 주의 문구 포함, 데이터 없으면 빈 문자열', () => {
  assert.equal(E.legText(null), '');
  assert.equal(E.legText({ crossings: [], landmarks: [], road: null, dest: [] }), '');
  const t = E.legText({ crossings: [{}, {}], road: E.roadInfo({ highway: 'service', oneway: 'yes' }), dest: [{ name: '맛나편의점', kind: '점포', floor: '' }] });
  assert.match(t, /건널 횡단보도 2개/); assert.match(t, /진입 도로: .*일방통행/); assert.match(t, /정보 없음은 없다는 뜻이 아님/);
});
