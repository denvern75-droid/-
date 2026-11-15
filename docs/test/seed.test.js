const test = require('node:test');
const assert = require('node:assert');
const S = require('../seed.js');

const json = (o) => ({ ok: true, status: 200, json: async () => o });
const node = (lat, lon, tags) => ({ type: 'node', lat, lon, tags });

test('이름 해석', () => {
  assert.deepEqual(S.parseExit('구로디지털단지역 6번 출구'), { station: '구로디지털단지역', exit: '6' });
  assert.deepEqual(S.parseExit('금호역 1번 출구'), { station: '금호역', exit: '1' });
  assert.equal(S.parseExit('금호역 입구(출구 번호 미정)'), null);
  assert.deepEqual(S.parseStop('구로디지털단지역(중) 정류장 21002'), { name: '구로디지털단지역(중)', ref: '21002' });
  assert.deepEqual(S.parseStop('여의도역6번출구 정류장'), { name: '여의도역6번출구', ref: null });
});

test('출구 선택: 번호 정확 일치만, 애매하면 제외', () => {
  const els = [node(37.4850, 126.9027, { ref: '6' }), node(37.4852, 126.9010, { ref: '5' }), node(37.4849, 126.9020, { name: '구로디지털단지역 4번 출구' })];
  const p = S.pickEntrance(els, '6');
  assert.ok(p && Math.abs(p.lat - 37.4850) < 1e-9);
  assert.equal(S.pickEntrance(els, '9'), null);                                   // 없는 번호
  const dup = [node(37.4850, 126.9027, { ref: '6' }), node(37.4900, 126.9100, { ref: '6' })]; // 멀리 떨어진 동명 → 애매
  assert.equal(S.pickEntrance(dup, '6'), null);
  assert.ok(S.pickEntrance([node(37.4850, 126.9027, { ref: '6' }), node(37.48503, 126.90272, { ref: '6' })], '6')); // 가까우면 평균
  assert.equal(S.pickEntrance([node(37.5, 127.0, { ref: '16' })], '6'), null);    // '16'을 '6'으로 오인하지 않음
});

test('정류장 선택: 번호 우선, 도로 양쪽 동명은 제외', () => {
  const els = [node(37.4860, 126.9040, { name: '구로디지털단지역(중)', ref: '21002' }), node(37.4861, 126.9050, { name: '구로디지털단지역(중)', ref: '21003' })];
  const a = S.pickStop(els, { name: '구로디지털단지역(중)', ref: '21002' });
  assert.ok(a && Math.abs(a.lng - 126.9040) < 1e-9 && a.how.includes('번호'));
  // 번호 정보가 없고 이름만 같은 두 정류장이 80m 떨어져 있으면(양방향) 채우지 않음
  const two = [node(37.4860, 126.9040, { name: '문성초등학교.금천가족문화센터' }), node(37.4866, 126.9046, { name: '문성초등학교.금천가족문화센터' })];
  assert.equal(S.pickStop(two, { name: '문성초등학교.금천가족문화센터', ref: null }), null);
  assert.ok(S.pickStop([two[0]], { name: '문성초등학교 금천가족문화센터', ref: null })); // 표기 차이는 정규화
});

test('전체 실행: 좌표 없는 지점만 채우고 애매한 것은 건너뜀', async () => {
  const route = { legs: [
    { type: 'walk', title: 'a', points: [{ id: 'ex', name: '구로디지털단지역 6번 출구', kind: 'exit' }, { id: 'st', name: '구로디지털단지역(중) 정류장 21002', kind: 'stop' }] },
    { type: 'walk', title: 'b', points: [{ id: 'ds', name: '독산로85길 37 사무실 입구', kind: 'dest' }] },
    { type: 'walk', title: 'c', points: [{ id: 'has', name: '금호역 1번 출구', kind: 'entrance', lat: 37.5, lng: 127.0 }] },
  ] };
  const calls = [];
  const f = async (url, opt) => {
    calls.push(url.split('?')[0]);
    if (url.startsWith('https://nominatim')) {
      if (decodeURIComponent(url).includes('구로디지털단지역')) return json([{ category: 'railway', type: 'station', lat: '37.4852', lon: '126.9015' }]);
      return json([{ lat: '37.4651', lon: '126.9001', address: { house_number: '37', road: '독산로85길' } }]);
    }
    const q = decodeURIComponent(opt.body);
    if (q.includes('subway_entrance')) return json({ elements: [node(37.4850, 126.9027, { ref: '6' })] });
    return json({ elements: [node(37.4860, 126.9040, { name: '구로디지털단지역(중)', ref: '21002' })] });
  };
  const rep = await S.run({ fetch: f, route, destination: '서울 금천구 독산로85길 37', delayMs: 0 });
  assert.deepEqual(rep.seeds.map((s) => s.id).sort(), ['ds', 'ex', 'st']);
  assert.equal(rep.seeds.find((s) => s.id === 'has'), undefined);                  // 이미 좌표 있는 지점은 건드리지 않음
  assert.ok(rep.seeds.every((s) => s.acc >= 30));
  assert.equal(rep.skipped.length, 0);
});

test('주소가 도로까지만 나오면(번지 없음) 채우지 않음, 조회 실패는 건너뜀', async () => {
  const route = { legs: [{ type: 'walk', title: 'b', points: [{ id: 'ds', name: '사무실', kind: 'dest' }] },
    { type: 'walk', title: 'c', points: [{ id: 'x', name: '금호역 1번 출구', kind: 'entrance' }] }] };
  const f = async (url) => decodeURIComponent(url).includes('금호') ? { ok: false, status: 429, json: async () => ({}) } : json([{ lat: '37.46', lon: '126.90', address: { road: '독산로85길' } }]);
  const rep = await S.run({ fetch: f, route, destination: '서울 금천구 독산로85길 37', delayMs: 0 });
  assert.equal(rep.seeds.length, 0);
  assert.equal(rep.skipped.length, 2);
  assert.match(rep.skipped[1].reason, /조회 실패/);
});
