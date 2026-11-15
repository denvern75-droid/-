const test = require('node:test');
const assert = require('node:assert');
const L = require('../links.js');

test('지도 앱 링크: 좌표가 있으면 경로, 없으면 검색', () => {
  const a = L.mapLinks({ name: '독산로85길 37', lat: 37.4650, lng: 126.9000 }, 'transit');
  assert.match(a.kakao, /^intent:\/\/route\?ep=37\.465,126\.9&by=PUBLICTRANSIT#Intent;scheme=kakaomap;package=net\.daum\.android\.map;/);
  assert.match(a.naver, /^intent:\/\/route\/public\?dlat=37\.465&dlng=126\.9&dname=/);
  assert.match(a.google, /travelmode=transit/);
  const b = L.mapLinks({ name: '서울 금천구 독산로85길 37' }, 'transit');
  assert.match(b.kakao, /^intent:\/\/search\?q=/);
  assert.match(b.google, /destination=%EC%84%9C%EC%9A%B8/);
  assert.match(L.mapLinks({ name: 'x', lat: 37.5, lng: 127 }, 'walk').google, /travelmode=walking/);
});

test('공유 해석: 좌표가 들어 있는 형식', () => {
  let r = L.parseShared('https://map.kakao.com/link/map/구로디지털단지역 6번 출구,37.485013,126.902762');
  assert.ok(r.ok && Math.abs(r.lat - 37.485013) < 1e-9 && r.source === 'kakao', JSON.stringify(r));
  r = L.parseShared('https://www.google.com/maps/place/x/@37.4852,126.9015,17z/data=!3m1');
  assert.ok(r.ok && r.source === 'google');
  r = L.parseShared('https://maps.google.com/?q=37.5486,127.0162');
  assert.ok(r.ok && Math.abs(r.lng - 127.0162) < 1e-9);
  r = L.parseShared('37.548681, 127.016205');              // 구글 지도에서 좌표 복사
  assert.ok(r.ok && r.source === 'text');
  r = L.parseShared('127.016205, 37.548681');              // 순서가 뒤바뀐 경우 교정
  assert.ok(r.ok && Math.abs(r.lat - 37.548681) < 1e-9);
});

test('공유 해석: 좌표 없는 짧은 링크와 범위 밖 좌표는 저장 불가로 처리', () => {
  let r = L.parseShared('구로디지털단지역 6번 출구 https://kko.to/AbCdEf');
  assert.equal(r.ok, false); assert.equal(r.reason, 'short'); assert.match(r.name, /구로디지털단지역/);
  r = L.parseShared('독산로85길 37 https://maps.app.goo.gl/abc123');
  assert.equal(r.ok, false); assert.equal(r.reason, 'short');
  r = L.parseShared('부산역 35.1150, 129.0403');           // 한국이지만 서울권 밖
  assert.equal(r.ok, false); assert.equal(r.reason, 'outside');
  r = L.parseShared('그냥 텍스트');
  assert.equal(r.ok, false); assert.equal(r.reason, 'none');
});

test('이름 유사도: 공유된 장소명을 지점에 자동 매칭', () => {
  assert.ok(L.similarity('구로디지털단지역 6번출구', '구로디지털단지역 6번 출구') > 0.9);
  assert.ok(L.similarity('구로디지털단지역 6번 출구', '금호역 1번 출구') < 0.5);
  assert.ok(L.similarity('문성초등학교.금천가족문화센터', '문성초등학교.금천가족문화센터 정류장') >= 0.9);
});

test('공유 이름 추출: 제목·본문 중복 제거, URL·좌표 제외', () => {
  const r = L.parseShared('구로디지털단지역 6번 출구 구로디지털단지역 6번 출구 37.485013, 126.902762');
  assert.ok(r.ok); assert.equal(r.name, '구로디지털단지역 6번 출구');
  const k = L.parseShared('금호역 1번 출구 https://maps.google.com/?q=37.548681,127.016205');
  assert.ok(k.ok); assert.equal(k.name, '금호역 1번 출구');
});

test('퍼센트가 들어간 일반 문장도 예외 없이 처리', () => {
  const r = L.parseShared('50% 할인 구로디지털단지역 6번 출구 37.485013, 126.902762');
  assert.ok(r.ok);
  assert.doesNotThrow(() => L.parseShared('100% 확인 %E0%A4%A'));
});
