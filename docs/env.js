/*
 * 보행 환경 정보 모델 — 브라우저/Node 공용
 * 건널 횡단보도, 기준이 되는 건물·점포 이름, 진입 도로 성격(일방통행·인도 유무)을 다룸.
 *
 * 핵심 원칙(시각장애 안전): '정보 없음'과 '없음'을 구분함.
 *  - 지도 데이터에 태그가 없으면 항상 '정보 없음'으로 말하고, 없다고 단정하지 않음.
 *  - '일방통행 아님'은 데이터에 명시된 경우에만 말함.
 *  - 점포 층 정보는 데이터에 층 표기가 있을 때만 말함(OSM level=0/1 의 층 해석은 불명확해 숫자 그대로만 전달).
 * 데이터 원천: OSM 자동 조회(seed 단계) 또는 로드뷰 등을 보고 사람이 입력한 값(src: 'manual').
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./engine.js'));
  else root.WalkEnv = factory(root.WalkNav);
})(typeof self !== 'undefined' ? self : this, function (W) {
  'use strict';

  const yn = (v) => (v === 'yes' || v === 'true' ? 'yes' : v === 'no' || v === 'false' ? 'no' : 'unknown');

  // ---------- 횡단보도 ----------
  function crossingInfo(tags) {
    const t = tags || {};
    const type = t.crossing || t['crossing:signals'] && 'traffic_signals' || '';
    let signal = 'unknown';
    if (type === 'traffic_signals' || t['crossing:signals'] === 'yes') signal = 'yes';
    else if (['uncontrolled', 'zebra', 'marked', 'unmarked'].includes(type)) signal = 'no';
    return {
      signal,
      sound: yn(t['traffic_signals:sound']),      // 음향신호기
      tactile: yn(t.tactile_paving),              // 점자블록(보도 경계)
      button: yn(t.button_operated),              // 押しボタン(보행자 작동 버튼)
      island: yn(t['crossing:island']),           // 횡단 중간 섬
    };
  }
  function crossingText(c) {
    const say = (v, yes, no, label) => (v === 'yes' ? `${label} ${yes}` : v === 'no' ? `${label} ${no}` : `${label} 정보 없음`);
    return ['신호등 ' + (c.signal === 'yes' ? '있음' : c.signal === 'no' ? '없음(신호 없는 횡단보도)' : '정보 없음'),
      say(c.sound, '있음', '없음', '음향신호기'), say(c.tactile, '있음', '없음', '점자블록')].join(', ');
  }
  // 경로(a→b) 위 횡단보도: 선분에서 maxOff 이내, a 기준 진행 거리순
  function alongM(p, a, b) {
    const M = (Math.PI * 6371000) / 180, k = Math.cos((p.lat * Math.PI) / 180);
    const ax = (a.lng - p.lng) * M * k, ay = (a.lat - p.lat) * M, bx = (b.lng - p.lng) * M * k, by = (b.lat - p.lat) * M;
    const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
    const t = L2 ? Math.max(0, Math.min(1, (-ax * dx - ay * dy) / L2)) : 0;
    return t * Math.sqrt(L2);
  }
  function crossingsAlong(elements, a, b, maxOff) {
    const off = maxOff == null ? 20 : maxOff;
    return elements.filter((e) => e.tags && e.tags.highway === 'crossing' && W.segDist({ lat: e.lat, lng: e.lon != null ? e.lon : e.lng }, a, b) <= off)
      .map((e) => { const p = { lat: e.lat, lng: e.lon != null ? e.lon : e.lng }; return Object.assign(p, { along: Math.round(alongM(p, a, b)), info: crossingInfo(e.tags) }); })
      .sort((x, y) => x.along - y.along)
      // 같은 횡단(양쪽 보도 끝 노드)이 가까이 중복되면 하나로
      .filter((c, i, arr) => i === 0 || c.along - arr[i - 1].along > 12);
  }

  // ---------- 진입 도로 ----------
  function roadInfo(tags) {
    const t = tags || {};
    const hw = t.highway || '';
    // 도로 표기는 '지도 표기'로만 전달함. 생활도로·주택가 도로가 보차혼용·인도 없음과 같은 뜻은 아님(한국 OSM 분류 합의 불안정)
    const kind = { living_street: '지도에 생활도로로 표기됨. 보차혼용 여부는 확인되지 않음', pedestrian: '지도에 보행자 전용 도로로 표기됨', service: '지도에 이면도로·진입로로 표기됨',
      residential: '지도에 주택가 도로로 표기됨', unclassified: '지도에 일반 도로로 표기됨', tertiary: '지도에 간선 보조 도로로 표기됨', secondary: '지도에 간선 도로로 표기됨',
      primary: '지도에 간선 도로로 표기됨', footway: '지도에 보행로로 표기됨', path: '지도에 보행로로 표기됨' }[hw] || '도로 유형 정보 없음';
    const oneway = t.oneway === 'yes' || t.oneway === 'true' || t.oneway === '1' ? 'yes' : t.oneway === '-1' ? 'reverse' : t.oneway === 'no' ? 'no' : 'unknown';
    const sw = t.sidewalk || '';
    const sidewalk = ['both', 'left', 'right', 'yes', 'separate'].includes(sw) ? 'yes' : ['no', 'none'].includes(sw) ? 'no' : 'unknown';
    return { name: t.name || '', kind, highway: hw, oneway, sidewalk, maxspeed: t.maxspeed || '' };
  }
  function roadText(r) {
    const parts = [];
    if (r.name) parts.push(r.name);
    parts.push(r.kind);
    parts.push(r.oneway === 'yes' ? '일방통행' : r.oneway === 'reverse' ? '일방통행(진행 방향 반대)' : r.oneway === 'no' ? '양방향' : '일방통행 여부 정보 없음');
    parts.push(r.sidewalk === 'yes' ? '인도 있음' : r.sidewalk === 'no' ? '인도 없음. 보행자와 차량이 같은 길을 쓸 수 있으니 차량 소리에 주의' : '인도 유무 정보 없음');
    if (r.maxspeed) parts.push('제한속도 ' + r.maxspeed);
    return parts.join(', ');
  }
  // 목적지 진입 도로 후보 중 가장 가까운 도로 선택용: 이름이 주소의 도로명과 맞으면 우선
  function pickRoad(ways, roadName) {
    const n = (s) => String(s || '').replace(/\s/g, '');
    const c = ways.filter((w) => w.tags && w.tags.highway);
    return (c.find((w) => n(w.tags.name) === n(roadName)) || c[0] || {}).tags || null;
  }

  // ---------- 랜드마크·점포 ----------
  const KIND = (t) => (t.shop ? '점포' : t.amenity ? (t.amenity === 'cafe' || t.amenity === 'restaurant' || t.amenity === 'fast_food' ? '음식점' : '시설') : t.building ? '건물' : '장소');
  function landmarks(elements, center, radius, maxN) {
    const seen = new Set();
    return elements.filter((e) => e.tags && e.tags.name)
      .map((e) => { const p = { lat: e.lat != null ? e.lat : e.center && e.center.lat, lng: e.lon != null ? e.lon : (e.center && e.center.lon) }; return { e, p }; })
      .filter(({ p }) => W.hasXY(p) && W.dist(center, p) <= (radius || 40))
      .sort((a, b) => W.dist(center, a.p) - W.dist(center, b.p))
      .filter(({ e }) => !seen.has(e.tags.name) && seen.add(e.tags.name))
      .slice(0, maxN || 4)
      .map(({ e, p }) => ({ name: e.tags.name, kind: KIND(e.tags), floor: e.tags['addr:floor'] || (e.tags.level != null ? 'level ' + e.tags.level : ''), dist: Math.round(W.dist(center, p)) }));
  }
  function landmarkText(list, where) {
    if (!list || !list.length) return '';
    return `${where} 주변: ` + list.map((l) => `${l.name}${l.kind === '건물' ? '' : ''}${l.floor ? '(층 표기 ' + l.floor + ')' : ''}`).join(', ');
  }

  // ---------- 구간 안내문 ----------
  const CAVEAT = '횡단보도와 도로 정보는 지도 데이터 기준이며 빠져 있을 수 있음. 정보 없음은 없다는 뜻이 아님.';
  function legText(env) {
    if (!env) return '';
    const p = [];
    if (env.crossings && env.crossings.length) p.push(`지도 데이터에 있는 횡단보도 ${env.crossings.length}개. 지도에 없는 횡단보도가 더 있을 수 있음`);
    if (env.landmarks && env.landmarks.length) p.push(env.landmarks.map((x) => landmarkText(x.list, x.where)).filter(Boolean).join('. '));
    if (env.road) p.push('진입 도로: ' + roadText(env.road));
    if (env.dest && env.dest.length) p.push(landmarkText(env.dest, '목적지'));
    return p.length ? p.join('. ') + '. ' + CAVEAT : '';
  }
  function crossingSay(c, k, n) {
    return `${n > 1 ? `${k}번째 ` : ''}횡단보도. ${crossingText(c.info)}. 건너기 전에 차량 소리를 확인하세요.`;
  }

  return { crossingInfo, crossingText, crossingsAlong, roadInfo, roadText, pickRoad, landmarks, landmarkText, legText, crossingSay, CAVEAT };
});
