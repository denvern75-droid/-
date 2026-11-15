/*
 * 지도 데이터 자동 연결(초기 좌표 채우기) — 브라우저/Node 공용
 * 처음 가는 길에서도 안내가 가능하도록, 앱을 열 때 오픈스트리트맵(OSM) 데이터로
 * 출구·정류장·사무실 좌표를 자동으로 채움. 이용자 조작 없음.
 *
 * 안전 원칙(시각장애 보행): 애매하면 채우지 않음.
 *  - 출구: 역 주변 출입구 중 출구 번호가 정확히 일치하는 것만(여러 개면 30m 이내일 때만 중심점)
 *  - 정류장: 정류장 번호(ref) 일치 우선, 이름만 일치하면 후보가 하나이거나 25m 이내일 때만(도로 양쪽 구분 불가 시 제외)
 *  - 주소: 번지(house_number)까지 있는 결과만. 도로 중심 좌표는 채우지 않음
 *  - 채운 값은 오차 30~40m의 '약한 표본'(src: osm)으로만 저장 → 걸어서 기록한 값이 항상 우선
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./engine.js'));
  else root.WalkSeed = factory(root.WalkNav);
})(typeof self !== 'undefined' ? self : this, function (W) {
  'use strict';

  const NOMINATIM = 'https://nominatim.openstreetmap.org/search';
  const OVERPASS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];
  const SEOUL_VIEWBOX = '126.76,37.72,127.20,37.40'; // left,top,right,bottom
  const WEAK = new Set(['osm', 'seed', 'kakao', 'naver', 'google', 'text']);

  const norm = (s) => String(s || '').replace(/[\s·.()（）\-_,]/g, '').toLowerCase();
  const inSeoul = (lat, lng) => lat >= 37.40 && lat <= 37.72 && lng >= 126.76 && lng <= 127.20;

  // ---------- 이름 해석 ----------
  function parseExit(name) {
    const m = String(name || '').match(/^(.+?역)\s*(\d+(?:-\d+)?)\s*번\s*(?:출구|입구)/);
    return m ? { station: m[1].replace(/\s/g, ''), exit: m[2] } : null;
  }
  function parseStop(name) {
    const m = String(name || '').match(/^(.+?)\s*정류장\s*(\d{4,5})?\s*$/);
    return m ? { name: m[1].trim(), ref: m[2] || null } : null;
  }

  // ---------- 후보 선택(애매하면 null) ----------
  const centroid = (els) => ({ lat: els.reduce((a, e) => a + e.lat, 0) / els.length, lng: els.reduce((a, e) => a + (e.lon != null ? e.lon : e.lng), 0) / els.length });
  const ll = (e) => ({ lat: e.lat, lng: e.lon != null ? e.lon : e.lng });
  const allClose = (els, m) => els.every((a) => els.every((b) => W.dist(ll(a), ll(b)) <= m));

  function pickEntrance(elements, exitNo, station) {
    if (station) elements = elements.filter((e) => { const m = e.tags && e.tags.name && String(e.tags.name).match(/([가-힣A-Za-z0-9]+역)/); return !m || norm(m[1]) === norm(station); }); // 다른 역 이름이 적힌 출입구는 제외
    const re = new RegExp('(^|[^0-9])' + exitNo.replace('-', '[-–]') + '\\s*번');
    const c = elements.filter((e) => e.tags && (e.tags.ref === exitNo || (e.tags.name && re.test(e.tags.name)) || (e.tags.ref && String(e.tags.ref).replace(/\D/g, '') === exitNo && exitNo.indexOf('-') < 0 && e.tags.ref === exitNo)));
    if (!c.length) return null;
    if (c.length === 1) return Object.assign(ll(c[0]), { acc: 30, how: '출구번호 일치' });
    return allClose(c, 30) ? Object.assign(centroid(c), { acc: 30, how: '출구번호 일치(복수 평균)' }) : null;
  }
  function pickStop(elements, want) {
    if (want.ref) {
      const byRef = elements.filter((e) => e.tags && [e.tags.ref, e.tags.local_ref].map((v) => String(v == null ? '' : v)).includes(want.ref));
      if (byRef.length === 1) return Object.assign(ll(byRef[0]), { acc: 40, how: '정류장 번호 일치' });
      if (byRef.length > 1 && allClose(byRef, 25)) return Object.assign(centroid(byRef), { acc: 40, how: '정류장 번호 일치(복수 평균)' });
    }
    // 이름만 일치하는 후보는 사용하지 않음: 도로 한쪽만 입력된 경우 반대편 위치가 '이름 일치'로 채워질 수 있음
    return null; // 도로 양쪽 정류장 구분 불가 → 채우지 않음
  }

  // ---------- 네트워크 ----------
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function nominatim(f, q, extra) {
    const url = `${NOMINATIM}?q=${encodeURIComponent(q)}&format=jsonv2&addressdetails=1&limit=20&countrycodes=kr&accept-language=ko&viewbox=${SEOUL_VIEWBOX}&bounded=1${extra || ''}`;
    const r = await f(url, { headers: { Accept: 'application/json' } });
    if (!r.ok) throw new Error('nominatim ' + r.status);
    return r.json();
  }
  async function overpass(f, query) {
    let last;
    for (const ep of OVERPASS) {
      try {
        const r = await f(ep, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'data=' + encodeURIComponent(query) });
        if (r.ok) return (await r.json()).elements || [];
        last = new Error('overpass ' + r.status);
      } catch (e) { last = e; }
    }
    throw last;
  }

  // 한 지점(좌표 없음)을 채울 수 있으면 {lat,lng,acc,how} 반환
  async function seedExit(f, name, cache, delay) {
    const x = parseExit(name); if (!x) return null;
    if (!cache[x.station]) {
      await sleep(delay);
      const res = await nominatim(f, x.station);
      const st = res.find((r) => (r.category === 'railway' || r.type === 'station' || r.class === 'railway') && inSeoul(+r.lat, +r.lon));
      cache[x.station] = st ? { lat: +st.lat, lng: +st.lon } : false;
    }
    const c = cache[x.station]; if (!c) return null;
    const els = await overpass(f, `[out:json][timeout:25];node["railway"="subway_entrance"](around:200,${c.lat},${c.lng});out body;`);
    return pickEntrance(els, x.exit, x.station);
  }
  async function seedStop(f, name, near) {
    const s = parseStop(name); if (!s || !near) return null;
    const els = await overpass(f, `[out:json][timeout:25];node["highway"="bus_stop"](around:500,${near.lat},${near.lng});out body;`);
    return pickStop(els, s);
  }
  async function seedAddress(f, address, delay) {
    const num = (String(address).match(/(\d+)(?:-\d+)?\s*$/) || [])[1];
    const road = (String(address).match(/([가-힣]+\d*(?:대로|로|길)(?:\d+길)?)\s*\d+(?:-\d+)?\s*$/) || [])[1];
    if (!num || !road) return null;                   // 번지와 도로명을 해석하지 못하면 채우지 않음
    await sleep(delay);
    const res = await nominatim(f, address);
    const hit = res.find((r) => r.address && String(r.address.house_number) === num && norm(r.address.road).includes(norm(road)) && inSeoul(+r.lat, +r.lon));
    return hit ? { lat: +hit.lat, lng: +hit.lon, acc: 40, how: '주소(번지·도로명 일치). 건물 중심이라 입구와 다를 수 있음' } : null;
  }

  /*
   * run({fetch, route, destination, delayMs}) → 보고서
   * route 의 좌표 없는 지점만 채움. 반환 seeds: [{id|kind, name, lat, lng, acc, how}], skipped: [{name, reason}]
   * 정류장은 같은 구간의 출구 좌표를 기준으로 500m 안에서 찾음(출구 → 정류장 도보 구간 구조 활용)
   */
  async function run(o) {
    const f = o.fetch, delay = o.delayMs == null ? 1100 : o.delayMs, route = o.route;
    const cache = {}, seeds = [], skipped = [];
    const noXY = (p) => !(p && W.hasXY(p));
    for (const [li, l] of route.legs.entries()) {
      if (l.type === 'walk') {
        let anchor = null;
        for (const p of l.points) {
          if (W.hasXY(p)) { anchor = p; continue; }
          try {
            let s = null;
            if (p.kind === 'exit' || p.kind === 'entrance') s = await seedExit(f, p.name, cache, delay);
            else if (p.kind === 'stop') s = await seedStop(f, p.name, anchor);
            else if (p.kind === 'dest') s = await seedAddress(f, o.destination || '', delay);
            if (s) { seeds.push(Object.assign({ legIndex: li, id: p.id, name: p.name }, s)); anchor = s; }
            else skipped.push({ legIndex: li, id: p.id, name: p.name, reason: '일치하는 데이터 없음 또는 후보가 애매함' });
          } catch (e) { skipped.push({ legIndex: li, id: p.id, name: p.name, reason: '조회 실패: ' + e.message }); }
        }
      }
    }
    return { seeds, skipped };
  }

  return { run, parseExit, parseStop, pickEntrance, pickStop, norm, WEAK };
});
