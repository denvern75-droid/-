/* 길동무 UI 레이어: 음성·진동·GPS·나침반·기록 모드 */
(function () {
  'use strict';
  const W = window.WalkNav;
  const $ = (id) => document.getElementById(id);
  const LS_ROUTE = 'walknav.route.v1', LS_SET = 'walknav.settings.v1';

  const set = Object.assign({ voice: true, rate: 1.0, vib: true, beep: true, beacon: false, noti: false, handsFree: true },
    JSON.parse(localStorage.getItem(LS_SET) || '{}'));
  const saveSet = () => localStorage.setItem(LS_SET, JSON.stringify(set));

  let data = null, route = null, started = false;
  let lastFix = null, rawFix = null, watchId = null, wake = null, smoothSin = 0, smoothCos = 0, hasCompass = false;
  let actx = null, batch = [], batchTimer = null, liveAt = 0;

  // ---------- 출력(음성/진동/비프/알림) ----------
  let koVoice = null;
  function pickVoice() {
    const vs = speechSynthesis.getVoices();
    koVoice = vs.find((v) => /ko[-_]KR/i.test(v.lang)) || null;
  }
  if ('speechSynthesis' in window) { pickVoice(); speechSynthesis.onvoiceschanged = pickVoice; }

  const io = {
    // 우선순위: high = 지금 말하던 것을 끊고 말함 / queue = 이어서 반드시 말함 / normal = 말하는 중이면 버림(false 반환)
    speak(text, prio) {
      const voiceOn = set.voice && 'speechSynthesis' in window;
      const busy = voiceOn && (speechSynthesis.speaking || speechSynthesis.pending || batch.length > 0);
      if (prio === 'normal' && busy) return false;
      const live = $('now'), tNow = Date.now();        // 화면낭독기가 읽는 문장도 낭독용으로 정리
      if (!voiceOn && prio === 'queue' && tNow - liveAt < 1500) live.textContent += ' ' + W.spoken(text);   // 음성 끔 모드: 같은 순간의 이어지는 문장이 앞 문장(예: 내리세요)을 덮어쓰지 않게 이어 붙임
      else live.textContent = W.spoken(text);
      liveAt = tNow;
      if (!voiceOn) return true;
      const utter = (t) => W.spoken(t).split(/(?<=[.?!])\s+/).filter(Boolean).forEach((s) => {   // 문장 단위로 읽어 중간에 끊기지 않게
        const u = new SpeechSynthesisUtterance(s); u.lang = 'ko-KR'; u.rate = set.rate; if (koVoice) u.voice = koVoice; speechSynthesis.speak(u);
      });
      if (prio === 'high') {                           // 취소 직후 바로 말하면 누락되는 기기가 있어 60ms 뒤에 말함
        speechSynthesis.cancel(); batch = [text]; clearTimeout(batchTimer);
        batchTimer = setTimeout(() => { const b = batch; batch = []; b.forEach(utter); }, 60);
      } else if (batch.length) batch.push(text);       // 대기 중인 high 뒤에 순서대로 이어 붙임(순서 뒤집힘 방지)
      else utter(text);
      return true;
    },
    vibrate(p) { if (set.vib && navigator.vibrate) navigator.vibrate(p); },
    beep(freq) {
      if (!set.beep) return;
      try {
        actx = actx || new (window.AudioContext || window.webkitAudioContext)();
        const o = actx.createOscillator(), g = actx.createGain();
        o.frequency.value = freq; g.gain.value = 0.2;
        o.connect(g); g.connect(actx.destination); o.start(); o.stop(actx.currentTime + 0.12);
      } catch (e) { /* 무시 */ }
    },
    // 좌우 스테레오 비콘: 오른쪽이면 오른쪽 귀, 정면이면 높은 음, 뒤쪽이면 낮은 음 두 번
    beacon(rel) {
      if (!set.beacon) return;
      try {
        actx = actx || new (window.AudioContext || window.webkitAudioContext)();
        const a = Math.abs(rel), pan = Math.sin((rel * Math.PI) / 180);
        const freq = a <= 20 ? 880 : a >= 150 ? 330 : 587;
        const beep = (delay) => {
          const o = actx.createOscillator(), g = actx.createGain();
          o.frequency.value = freq; g.gain.value = 0.25; o.connect(g);
          if (actx.createStereoPanner) { const p = actx.createStereoPanner(); p.pan.value = pan; g.connect(p); p.connect(actx.destination); } else g.connect(actx.destination);
          const t0 = actx.currentTime + delay; o.start(t0); o.stop(t0 + 0.09);
        };
        beep(0); if (a >= 150) beep(0.18);
      } catch (e) { /* 무시 */ }
    },
    notify(text) {
      if (!set.noti || !('Notification' in window) || Notification.permission !== 'granted') return;
      navigator.serviceWorker && navigator.serviceWorker.ready.then((r) =>
        r.showNotification('길동무', { body: text, tag: 'walknav', renotify: true, vibrate: [200, 100, 200] }));
    },
    onAuto(type, f) { tripEvent('자동:' + ({ alight: '내림', board: '탑승', crossed: '건넘' }[type] || type), f && f.lat ? { at: [+f.lat.toFixed(6), +f.lng.toFixed(6)] } : {}); },
    onLegChange(i, l) { refreshRec(); tripEvent('구간', { leg: i, title: l && l.title }); },
  };
  const engine = W.createEngine({ io, handsFree: set.handsFree });
  const kf = W.createKalman();
  let geoErr = { code: 0, t: 0 };
  const WL = window.WalkLearn;
  const LK = window.WalkLinks;
  const SD = window.WalkSeed;
  let learner = null;

  // ---------- 센서 ----------
  function startGeo() {
    if (watchId != null) return;
    if (!navigator.geolocation) { io.speak('이 기기는 위치 기능을 지원하지 않음', 'high'); return; }
    watchId = navigator.geolocation.watchPosition((p) => {
      rawFix = { lat: p.coords.latitude, lng: p.coords.longitude, acc: p.coords.accuracy,
        heading: p.coords.heading, speed: Number.isFinite(p.coords.speed) ? p.coords.speed : null, t: Date.now() };
      recSample(rawFix);                 // 기록은 원시 값으로(이중 평활 방지)
      tripFix(rawFix);
      lastFix = kf.update(rawFix);       // 안내는 칼만 평활 값으로
      if (learner) learner.onFix(lastFix);
      engine.onFix(lastFix); render();
    }, (e) => { const t = Date.now(); if (t - geoErr.t < 90000) return; geoErr = { code: e.code, t }; if (e.code === 3) return; /* 위치 확인 지연은 엔진의 GPS 안내가 대신 알림 */ io.speak(e.code === 1 ? '위치 권한이 꺼져 있음. 설정에서 위치 권한을 허용해 주세요.' : e.code === 2 ? '위치를 잡을 수 없음. GPS를 켜고 하늘이 트인 곳으로 이동해 주세요.' : '위치 확인이 늦어지고 있음. 잠시 기다려 주세요.', 'queue'); },
    { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 });
  }
  async function startCompass() {
    try {
      if (window.DeviceOrientationEvent && typeof DeviceOrientationEvent.requestPermission === 'function') {
        const r = await DeviceOrientationEvent.requestPermission();
        if (r !== 'granted') return;
      }
    } catch (e) { return; }
    const onO = (e) => {
      let h = null;
      if (typeof e.webkitCompassHeading === 'number') h = e.webkitCompassHeading;
      else if (e.absolute || e.type === 'deviceorientationabsolute') h = W.compassHeading(e.alpha, e.beta, e.gamma);
      if (h == null) return;
      const r = (h * Math.PI) / 180;
      smoothSin = smoothSin * 0.8 + Math.sin(r) * 0.2; smoothCos = smoothCos * 0.8 + Math.cos(r) * 0.2;
      hasCompass = true;
      engine.onCompass(((Math.atan2(smoothSin, smoothCos) * 180) / Math.PI + 360) % 360);
    };
    window.addEventListener('deviceorientationabsolute', onO, true);
    window.addEventListener('deviceorientation', onO, true);
  }

  // ---------- 경로 로드/저장 ----------
  async function loadData() {
    const saved = localStorage.getItem(LS_ROUTE);
    if (saved) { try { data = JSON.parse(saved); } catch (e) { data = null; } }
    let fresh = null;
    try { fresh = await (await fetch('route.json', { cache: 'no-cache' })).json(); } catch (e) { /* 오프라인 */ }
    if (data && fresh && (fresh.version || 0) > (data.version || 0)) {     // 배포된 경로가 새 판이면 문구는 새 판으로, 기록한 위치는 지점 id로 옮김
      const keep = {};
      data.routes.forEach((rt) => { if (rt.home) keep[rt.id + ':home'] = rt.home; rt.legs.forEach((l, i) => { (l.points || []).forEach((q) => { keep[rt.id + ':' + q.id] = q; }); if (l.alight) keep[rt.id + ':alight' + i] = l.alight; if (l.learned) keep[rt.id + ':learned' + i] = l.learned; }); });
      const carry = (dst, src) => { if (src && W.hasXY(src) && ((src.samples && src.samples.length) || !W.hasXY(dst))) ['lat', 'lng', 'samples', 'recAcc', 'weak', 'quarantine'].forEach((k) => { if (src[k] !== undefined) dst[k] = src[k]; }); };
      fresh.routes.forEach((rt) => { if (keep[rt.id + ':home']) rt.home = keep[rt.id + ':home']; rt.legs.forEach((l, i) => { (l.points || []).forEach((q) => carry(q, keep[rt.id + ':' + q.id])); if (l.alight) carry(l.alight, keep[rt.id + ':alight' + i]); }); });   // 걸으며 만든 꺾는 곳은 새 판에 없으므로 '걸었던 기록' 문구도 옮기지 않음
      data = fresh; localStorage.setItem(LS_ROUTE, JSON.stringify(data));
    }
    if (!data) data = fresh;
    if (!data) throw new Error('경로 파일을 읽지 못함');
    const sel = $('routeSel'); sel.innerHTML = '';
    data.routes.forEach((r, i) => { const o = document.createElement('option'); o.value = i; o.textContent = r.name; sel.appendChild(o); });
    data.routes.forEach((rt) => rt.legs.forEach((l) => (l.points || []).forEach((p) => { if (W.hasXY(p) && !p.auto && !(p.samples && p.samples.length) && p.weak === undefined) p.weak = true; }))); // 출처를 모르는 좌표는 지도 기준(약함)으로 취급
    route = data.routes[0];
    refreshRec(); refreshStartBtn();
  }
  const persist = () => localStorage.setItem(LS_ROUTE, JSON.stringify(data));

  // ---------- 기록 모드 ----------
  let recTarget = null, recBuf = [], recTimer = null;
  function recSample(f) { if (recTarget && f.acc <= 40) recBuf.push(f); }
  function allWalkPoints() {
    const out = [];
    (route ? route.legs : []).forEach((l, li) => { if (l.type === 'walk') l.points.forEach((p, pi) => out.push({ l, li, p, pi })); });
    return out;
  }
  function refreshRec() {
    const box = $('ptList'); if (!box || !route) return; box.innerHTML = '';
    fillLearnUI();
    const pts = allWalkPoints();
    pts.forEach(({ p, l }) => {
      const row = document.createElement('div'); row.className = 'pt';
      const ok = W.hasXY(p);
      const info = document.createElement('div');
      const n = (p.samples || []).length;
      const sp = n > 1 ? ` · 편차 ${Math.round(W.robustFuse(p.samples).spread)}m` : '';
      info.innerHTML = `<b>${p.name}</b><br><small>${l.title}</small><br><span class="${ok ? 'ok' : 'bad'}">${ok ? '저장됨 ' + p.lat.toFixed(6) + ', ' + p.lng.toFixed(6) + ' (' + n + '회' + sp + ')' : '좌표 없음'}</span>`;
      const b = document.createElement('button'); b.textContent = '여기 저장'; b.style.width = '140px';
      b.setAttribute('aria-label', `${p.name} 위치를 현재 위치로 기록. 현재 ${n}회 기록됨`);
      b.onclick = () => recordPoint(p);
      const box2 = document.createElement('div'); box2.style.cssText = 'display:flex;flex-direction:column;gap:6px';
      box2.appendChild(b);
      if (n) { const c = document.createElement('button'); c.textContent = '기록 지우기'; c.className = 'danger'; c.style.width = '140px'; c.style.minHeight = '48px';
        c.onclick = () => { if (confirm(p.name + ' 기록을 지울까요?')) { p.samples = []; p.lat = null; p.lng = null; persist(); refreshRec(); } };
        box2.appendChild(c); }
      row.append(info, box2); box.appendChild(row);
    });
    // 하차 정류장 좌표(버스 구간)
    route.legs.forEach((l) => {
      if (l.type !== 'bus' || !l.alight) return;
      const row = document.createElement('div'); row.className = 'pt';
      const ok = W.hasXY(l.alight);
      const info = document.createElement('div');
      info.innerHTML = `<b>하차 정류장: ${l.alight.name}</b><br><span class="${ok ? 'ok' : 'bad'}">${ok ? '저장됨' : '좌표 없음 (없으면 하차 알림 불가)'}</span>`;
      const b = document.createElement('button'); b.textContent = '여기 저장'; b.style.width = '140px';
      b.onclick = () => recordPoint(l.alight);
      row.append(info, b); box.appendChild(row);
    });
  }
  // ---------- 학습 보행(자동 기록) ----------
  function fillLearnUI() {
    const sel = $('learnFrom'); if (!sel || !route) return;
    const keep = sel.value;
    sel.innerHTML = '';
    route.legs.forEach((l, i) => { const o = document.createElement('option'); o.value = i; o.textContent = (i === 0 ? '처음부터: ' : (i + 1) + '단계: ') + l.title; sel.appendChild(o); });
    if (keep && sel.options[keep]) sel.value = keep;
    const sums = route.legs.map((l, i) => (l.learned && l.learned.text) ? `<p><b>${i + 1}단계 ${l.title}</b><br>${l.learned.text}</p>` : '').join('');
    $('learnSum').innerHTML = sums || '<p>아직 걸어서 기록된 구간이 없음.</p>';
  }
  function findPoint(id) {
    for (const l of route.legs) { const p = (l.points || []).find((q) => q.id === id); if (p) return p; }
    return null;
  }
  // 기존 좌표(출처 불명)는 지우지 않고 낮은 비중(오차 25m)의 기준값으로 남겨 새 측정과 융합
  const markWeak = (tgt) => { tgt.weak = !(tgt.samples || []).some((s) => !s.src || s.src === 'walk'); };
  function seedExisting(tgt) {
    if (W.hasXY(tgt) && !(tgt.samples && tgt.samples.length)) tgt.samples = [{ lat: tgt.lat, lng: tgt.lng, acc: 25, t: 0, src: 'seed' }];
  }
  function applyLearnedPoint(e) {
    let tgt = null;
    if (e.id === 'home') tgt = route.home = route.home || { name: '집' };
    else if (e.id === 'alight') tgt = route.legs[e.legIndex].alight;
    else tgt = findPoint(e.id);
    if (!tgt) return;
    seedExisting(tgt);
    tgt.samples = tgt.samples || [];
    if (W.hasXY(tgt)) {     // 기존 위치와 크게 다른 학습 값은 오감지일 수 있어 병합하지 않고 보류함
      const walkedBefore = tgt.samples.some((q) => !q.src || q.src === 'walk');
      const dd = W.dist(tgt, e);
      if (dd > (walkedBefore ? 60 : 80)) {
        (tgt.quarantine = tgt.quarantine || []).push({ lat: e.lat, lng: e.lng, acc: e.acc, t: Date.now() }); persist();
        io.speak(`${tgt.name || '이'} 지점 기록이 기존 위치와 ${W.fmtDist(dd)} 달라 반영하지 않고 보류했음.`, 'queue'); return;
      }
    }
    tgt.samples.push({ lat: e.lat, lng: e.lng, acc: e.acc, t: Date.now(), src: 'walk' });
    const m = W.robustFuse(tgt.samples);
    tgt.lat = m.lat; tgt.lng = m.lng; tgt.recAcc = Math.round(m.acc); markWeak(tgt); if (m.conflict) tgt.weak = true;
    persist(); refreshRec();
  }
  function applyLearnedLeg(e) {
    const l = route.legs[e.legIndex]; if (!l || !l.points) return;
    l.points = l.points.filter((p) => !p.auto);            // 이전 자동 꺾는 지점 교체
    const last = l.points.pop();
    e.turns.forEach((t, i) => l.points.push({ id: `auto-${e.legIndex}-${i}`, auto: true, weak: false, name: '꺾는 곳', kind: 'turn', radius: 8, lat: t.lat, lng: t.lng, samples: [{ lat: t.lat, lng: t.lng, acc: 8, t: Date.now(), src: 'walk' }],
      turn: t.turn, angle: t.angle,
      say: `${t.turn === 'left' ? '왼쪽' : '오른쪽'}으로 약 ${t.angle}도 꺾기. 이후 ${W.fmtDist(t.nextLen)} 직진.` }));
    l.points.push(last);
    l.learned = { text: e.text, distance: Math.round(e.distance), at: Date.now() };
    persist(); refreshRec();
  }
  function stopLearn(msg) {
    learner = null; $('learnBtn').textContent = '직접 걸으며 자동 기록';
    if (msg) io.speak(msg, 'high');
  }
  $('learnBtn').onclick = async () => {
    if (learner) return stopLearn('학습 보행을 중지했음. 지금까지 기록된 내용은 저장되어 있음.');
    route = data.routes[+$('routeSel').value];
    startGeo(); startCompass();
    try { wake = await navigator.wakeLock.request('screen'); } catch (e) { io.speak('화면이 꺼지면 안내가 멈출 수 있음. 화면을 켜 두세요.', 'queue'); }
    learner = WL.createLearner({ route,
      say: (t) => io.speak(t, 'queue'),
      onPoint: applyLearnedPoint, onLegDone: applyLearnedLeg,
      onDone: () => stopLearn() });
    $('learnBtn').textContent = '학습 보행 중지';
    io.speak('학습 보행을 시작함. 평소처럼 걸으세요. 위치는 자동으로 기록되며 별도 조작은 필요 없음. 하늘이 트인 곳에서 5초 정도 서 있으면 집 위치가 먼저 기록됨.', 'high');
    learner.start(+$('learnFrom').value || 0);
  };
  $('learnSumBtn').onclick = () => {
    const parts = route.legs.map((l, i) => (l.learned && l.learned.text) ? `${i + 1}단계 ${l.title}. ${l.learned.text}.` : '').filter(Boolean);
    io.speak(parts.length ? parts.join(' ') : '아직 걸어서 기록된 구간이 없음.', 'high');
  };
  setInterval(() => { if (learner) learner.tick(); }, 1000);

  // ---------- 지도 데이터 자동 연결(처음 가는 길 대비) ----------
  function findById(rt, id) { for (const l of rt.legs) { const p = (l.points || []).find((q) => q.id === id); if (p) return p; } return null; }
  async function autoSeed(force) {
    if (!SD || !navigator.onLine || !route || !data) return;
    const need = route.legs.some((l) => (l.points || []).some((p) => !W.hasXY(p)));
    const last = +localStorage.getItem('walknav.seed.t') || 0;
    if (!force && (!need || Date.now() - last < 6 * 3600 * 1000)) return;
    $('seedMsg').textContent = '지도 데이터를 가져오는 중임.';
    if (force) io.speak('지도 데이터로 출구와 정류장 위치를 가져오는 중임.', 'normal');
    let rep;
    try { rep = await SD.run({ fetch: window.fetch.bind(window), route, destination: data.destination }); }
    catch (e) { $('seedMsg').textContent = '지도 데이터를 가져오지 못했음: ' + e.message; if (force) io.speak('지도 데이터를 가져오지 못했음.', 'high'); return; }
    if (rep.seeds.length || !rep.skipped.some((q) => /조회 실패/.test(q.reason))) localStorage.setItem('walknav.seed.t', String(Date.now()));   // 조회 자체가 실패했으면 다음에 다시 시도
    const notes = [];
    rep.seeds.forEach((s) => {
      const tgt = findById(route, s.id); if (!tgt) return;
      const walked = (tgt.samples || []).some((q) => !q.src || q.src === 'walk');
      if (walked) return;                                    // 걸어서 확인된 지점은 지도 데이터로 바꾸지 않음
      const before = W.hasXY(tgt) ? { lat: tgt.lat, lng: tgt.lng } : null;
      seedExisting(tgt); tgt.samples = tgt.samples || [];
      tgt.samples.push({ lat: s.lat, lng: s.lng, acc: s.acc, t: Date.now(), src: 'osm' });
      const m = W.robustFuse(tgt.samples);
      tgt.lat = m.lat; tgt.lng = m.lng; tgt.recAcc = Math.round(m.acc); markWeak(tgt);
      if (before && W.dist(before, s) > 50) notes.push(`${tgt.name}: 기존 좌표와 지도 데이터가 ${Math.round(W.dist(before, s))}미터 다름`);
    });
    persist(); refreshRec();
    const msg = `지도 데이터로 ${rep.seeds.length}개 지점의 위치를 채웠고 ${rep.skipped.length}개는 애매하거나 없어 건너뜀.` + (notes.length ? ' 주의: ' + notes.join('. ') + '.' : '') + ' 지도 데이터 기준이라 오차가 있을 수 있음.';
    $('seedMsg').textContent = msg + (rep.skipped.length ? ' 건너뜀: ' + rep.skipped.map((q) => q.name).join(', ') : '');
    const still = route.legs.reduce((n, l) => n + (l.points || []).filter((q) => !W.hasXY(q)).length, 0);
    if (rep.seeds.length || force) io.speak(msg, 'queue');
    else if (still && !started) io.speak(`위치 정보가 없는 지점이 ${still}개 있음. 그 지점에서는 방향을 안내하지 못함.`, 'queue');   // 조용히 실패하지 않음
  }
  $('seedBtn').onclick = () => autoSeed(true);

  // ---------- 외부 지도 앱 연계 ----------
  function officeDest() {
    const last = route && route.legs.slice().reverse().find((l) => l.type === 'walk' && l.points.length);
    const p = last && last.points[last.points.length - 1];
    return { name: (data && data.destination) || '독산로85길 37', lat: p && W.hasXY(p) ? p.lat : null, lng: p && W.hasXY(p) ? p.lng : null };
  }
  const openMap = (k) => { const l = LK.mapLinks(officeDest(), 'transit'); io.speak(['카카오맵', '네이버지도', '구글지도'][['kakao', 'naver', 'google'].indexOf(k)] + '을 엽니다.', 'high'); window.location.href = l[k]; };
  $('openKakao').onclick = () => openMap('kakao');
  $('openNaver').onclick = () => openMap('naver');
  $('openGoogle').onclick = () => openMap('google');

  // ---------- 공유로 받은 위치 ----------
  let shared = null;
  function savePoints() {
    const out = [];
    out.push({ label: '집', ref: () => (route.home = route.home || { name: '집' }) });
    route.legs.forEach((l) => {
      (l.points || []).filter((p) => !p.auto).forEach((p) => out.push({ label: p.name, ref: () => p }));
      if (l.type === 'bus' && l.alight) out.push({ label: '하차 정류장 ' + l.alight.name, ref: () => l.alight });
    });
    return out;
  }
  function handleShared(text) {
    const r = LK.parseShared(text);
    const box = $('shareBox'); box.hidden = false; shared = r;
    if (!r.ok) {
      const why = { short: '공유된 링크가 짧은 주소라 위치 숫자가 들어 있지 않음. 지도 앱에서 좌표를 복사해 공유하거나, 걸어서 자동 기록을 이용해 주세요.',
        outside: '받은 위치가 서울권 밖이라 저장하지 않았음.', none: '공유된 내용에서 위치를 찾지 못했음.' }[r.reason] || '위치를 읽지 못했음.';
      $('shareMsg').textContent = why; $('shareSaveBtn').hidden = true; $('shareTarget').hidden = true;
      io.speak('공유를 받았음. ' + why, 'high'); return;
    }
    const pts = savePoints();
    const sel = $('shareTarget'); sel.innerHTML = '';
    let best = 0, bs = -1, second = -1;
    const ph = document.createElement('option'); ph.value = -1; ph.textContent = '지점을 선택해 주세요'; sel.appendChild(ph); // 직접 고르기 전에는 저장 불가
    pts.forEach((q, i) => { const o = document.createElement('option'); o.value = i; o.textContent = q.label; sel.appendChild(o); const sc = LK.similarity(r.name, q.label); if (sc > bs) { second = bs; bs = sc; best = i; } else if (sc > second) second = sc; });
    const sure = bs >= 0.95 && bs - second >= 0.15;   // 이름이 사실상 같을 때만 자동 선택('금호역'만으로 '금호역 1번 출구'를 고르지 않음)   // 출구와 정류장처럼 이름이 비슷한 후보가 여럿이면 자동 선택하지 않음
    if (sure) sel.value = best;
    $('shareSaveBtn').hidden = false; sel.hidden = false;
    const nm = r.name ? r.name + ', ' : '';
    $('shareMsg').textContent = `받은 위치: ${nm}위도 ${r.lat.toFixed(5)}, 경도 ${r.lng.toFixed(5)}. 지도 앱의 위치는 건물이나 장소 중심이라 출구·정류장과 수 미터 어긋날 수 있음.`;
    io.speak(`공유를 받았음. ${nm}위치를 읽었음. ` + (sure ? `${pts[best].label} 지점으로 저장할까요. 맞으면 이 지점으로 저장을 누르세요.` : '저장할 지점을 고른 뒤 저장을 누르세요.'), 'high');
  }
  $('shareSaveBtn').onclick = () => {
    if (!shared || !shared.ok) return;
    const idx = +$('shareTarget').value;
    if (!(idx >= 0)) { io.speak('저장할 지점을 먼저 선택해 주세요.', 'high'); return; }
    const q = savePoints()[idx]; if (!q) return;
    const tgt = q.ref();
    seedExisting(tgt);
    tgt.samples = tgt.samples || [];
    tgt.samples.push({ lat: shared.lat, lng: shared.lng, acc: 25, t: Date.now(), src: shared.source }); // 장소 중심 좌표는 오차 25m로 가중치를 낮춤
    const m = W.robustFuse(tgt.samples);
    tgt.lat = m.lat; tgt.lng = m.lng; tgt.recAcc = Math.round(m.acc); markWeak(tgt);
    persist(); refreshRec(); $('shareBox').hidden = true;
    io.speak(`${q.label} 위치를 저장했음. 걸어서 기록하면 더 정확해짐.`, 'high'); shared = null; $('now').focus();
  };
  $('shareCancelBtn').onclick = () => { $('shareBox').hidden = true; shared = null; io.speak('저장하지 않았음.', 'high'); };
  (function readShareParams() {
    const q = new URLSearchParams(location.search);
    const txt = [q.get('title'), q.get('text'), q.get('url')].filter(Boolean).join(' ');
    if (!txt) return;
    history.replaceState(null, '', location.pathname);
    const wait = setInterval(() => { if (data) { clearInterval(wait); route = data.routes[+$('routeSel').value || 0]; handleShared(txt); } }, 200);
  })();
  window.__walknav_share = handleShared;

  function recordPoint(p) {
    if (!lastFix) { startGeo(); io.speak('GPS를 잡는 중임. 잠시 후 다시 눌러주세요.', 'high'); return; }
    recTarget = p; recBuf = (rawFix && Date.now() - rawFix.t < 5000 && rawFix.acc <= 40) ? [rawFix] : []; io.speak('위치 기록 중. 8초간 가만히 서 계세요.', 'high');
    clearTimeout(recTimer);
    recTimer = setTimeout(() => {
      let buf = recBuf.slice();
      if (!buf.length && rawFix && Date.now() - rawFix.t < 60000 && rawFix.acc <= 40) buf = [rawFix]; // 갱신이 드문 환경 대비
      if (!buf.length) { io.speak('GPS가 부정확해 저장하지 못했음. 하늘이 트인 곳에서 다시 시도해 주세요.', 'high'); recTarget = null; return; }
      // 1) 한 번의 기록(8초): 이상치 제거 + 오차 가중 평균. 같은 순간의 오차는 서로 닮아 있으므로 오차값은 줄이지 않고 중앙 오차를 사용
      const one = W.robustFuse(buf);
      const avg = { lat: one.lat, lng: one.lng, acc: W.median(buf.map((f) => f.acc)), t: Date.now() };
      if (avg.acc > W.REC.rejectAcc) {
        io.speak(`오차가 약 ${Math.round(avg.acc)}미터로 너무 큼. 하늘이 트인 곳에서 잠시 후 다시 기록해 주세요.`, 'high'); recTarget = null; return;
      }
      p.samples = p.samples || [];
      const base = p.samples.length ? W.robustFuse(p.samples) : (W.hasXY(p.ref) ? p.ref : null);
      const shift = base ? W.dist(base, avg) : 0;
      p.samples.push(avg);
      // 2) 여러 번 기록: 기록 간 오차는 독립에 가까우므로 융합하면 오차가 줄어듦
      const m = W.robustFuse(p.samples);
      p.lat = m.lat; p.lng = m.lng; p.recAcc = Math.round(m.acc); p.weak = !!m.conflict;
      persist(); refreshRec();
      let msg = `${p.name || '지점'} 위치를 저장했음. ${p.samples.length}회 기록, 추정 오차 약 ${Math.round(m.acc)}미터.`;
      if (m.rejected) msg += ` 튀는 기록 ${m.rejected}건은 제외했음.`;
      if (avg.acc > W.REC.warnAcc) msg += ' 이번 측정 오차가 큰 편이니 다른 시간에 한 번 더 기록하길 권함.';
      if (shift > W.REC.warnShiftM) msg += ` 주의, 이전 기록과 약 ${Math.round(shift)}미터 어긋남. 서 있는 위치를 확인하고 다시 기록하세요.`;
      else if (p.samples.length < 2) msg += ' 정확도를 위해 다른 날 한 번 더 기록하길 권함.';
      io.speak(msg, 'high');
      recTarget = null;
    }, 8000);
  }
  $('addPtBtn').onclick = () => {
    if (!rawFix) return io.speak('GPS가 아직 없음', 'high');
    const s = engine.status(); const l = s.leg;
    if (!l || l.type !== 'walk') return io.speak('도보 구간에서만 지점을 추가할 수 있음. 먼저 안내를 시작하고 도보 구간으로 이동하세요.', 'high');
    const name = prompt('지점 이름 (예: 횡단보도 앞, 골목 꺾는 곳)', '꺾는 지점'); if (!name) return;
    const kind = prompt('종류: turn(꺾는 곳) / crossing(횡단보도) 중 입력', 'turn') || 'turn';
    const say = prompt('도착 시 읽어줄 안내 (예: 오른쪽으로 꺾어 직진)', '') || '';
    const np = { id: 'u' + Date.now(), name, kind, radius: 8, say, lat: rawFix.lat, lng: rawFix.lng, recAcc: Math.round(rawFix.acc), samples: [{ lat: rawFix.lat, lng: rawFix.lng, acc: rawFix.acc, t: Date.now() }] };
    const idx = Math.max(0, engine._S.pi);
    l.points.splice(idx, 0, np); persist(); refreshRec();
    io.speak(`${name} 지점을 추가했음`, 'high');
  };
  $('exportBtn').onclick = () => { $('io').value = JSON.stringify(data, null, 1); $('io').select(); try { navigator.clipboard.writeText($('io').value); } catch (e) {} io.speak('경로를 복사했음', 'high'); };
  $('importBtn').onclick = () => {
    try { const d = JSON.parse($('io').value); if (!d.routes) throw new Error('routes 없음'); data = d; persist(); loadData(); io.speak('경로를 불러왔음', 'high'); }
    catch (e) { io.speak('불러오기 실패: ' + e.message, 'high'); }
  };
  $('resetBtn').onclick = () => { if (confirm('기록한 좌표를 모두 지우고 초기 경로로 되돌릴까요?')) { localStorage.removeItem(LS_ROUTE); loadData(); } };

  // ---------- 화면 갱신 ----------
  function render() {
    const s = engine.status();
    $('mLeg').textContent = s.leg ? `${s.legIndex + 1}/${s.legCount} ${s.leg.title}` : '-';
    $('mPt').textContent = s.point ? s.point.name : (s.leg && s.leg.type === 'subway' && s.leg.stations ? `${s.leg.stations[s.stIdx]}역 → 하차 ${s.leg.stations[s.leg.stations.length - 1]}역` : '-');
    $('mDist').textContent = s.dist != null ? W.fmtDist(s.dist) : '-';
    $('mDir').textContent = s.clock || '-';
    $('mAcc').textContent = s.acc != null ? Math.round(s.acc) + 'm' : '-';
    $('mSrc').textContent = s.headingSrc || (hasCompass ? '대기' : '없음');
  }

  // ---------- 이동 기록(안내 시작과 함께 자동 저장) ----------
  // 궤적(3초마다 위치)과 사건(구간 전환, 이용자 확인)을 폰에 저장. 나중에 좌표 보정과 꺾는 지점 분석에 사용
  const LS_TRIPS = 'walknav.trips.v1';
  let trip = null, tripLastAt = 0;
  const loadTrips = () => { try { return JSON.parse(localStorage.getItem(LS_TRIPS) || '[]'); } catch (e) { return []; } };
  function saveTrip() {
    if (!trip) return;
    const all = loadTrips().filter((x) => x.id !== trip.id); all.push(trip);
    while (all.length > 6) all.shift();
    try { localStorage.setItem(LS_TRIPS, JSON.stringify(all)); } catch (e) { all.shift(); try { localStorage.setItem(LS_TRIPS, JSON.stringify(all)); } catch (e2) { /* 저장 공간 부족 */ } }
  }
  function tripStart() { trip = { id: 'trip-' + Date.now(), routeId: route.id, routeName: route.name, start: Date.now(), track: [], events: [] }; saveTrip(); }
  function tripFix(f) {
    if (!trip || f.t - tripLastAt < 3000 || !(f.acc <= 60) || trip.track.length >= 4000) return;
    tripLastAt = f.t;
    trip.track.push([Math.round((f.t - trip.start) / 1000), +f.lat.toFixed(6), +f.lng.toFixed(6), Math.round(f.acc), f.speed == null ? null : +(+f.speed).toFixed(1)]);
    if (trip.track.length % 10 === 0) saveTrip();
  }
  function tripEvent(type, extra) {
    if (!trip) return;
    trip.events.push(Object.assign({ t: Math.round((Date.now() - trip.start) / 1000), type, fix: rawFix && Date.now() - rawFix.t < 10000 ? [+rawFix.lat.toFixed(6), +rawFix.lng.toFixed(6), Math.round(rawFix.acc)] : null }, extra || {}));
    saveTrip();
  }
  // 이용자가 다음 버튼으로 확인한 순간의 위치를 '확인된 좌표'로 저장(찾았음·건넜음·내렸음)
  function captureConfirm(s) {
    const f = rawFix && Date.now() - rawFix.t < 10000 && rawFix.acc <= 25 ? rawFix : null;
    const l = s.leg; if (!l) return;
    if (s.waitCross) { tripEvent('건넜음', { leg: s.legIndex }); if (f) { (l.crossSamples = l.crossSamples || []).push({ lat: f.lat, lng: f.lng, acc: f.acc, t: Date.now() }); persist(); } return; }
    if (l.type === 'walk' && s.point) {
      tripEvent('찾았음', { leg: s.legIndex, point: s.point.id, name: s.point.name });
      if (f && (s.near || !W.hasXY(s.point))) applyLearnedPoint({ id: s.point.id, legIndex: s.legIndex, lat: f.lat, lng: f.lng, acc: Math.max(f.acc, 8) });
      return;
    }
    if (l.type === 'bus') {
      tripEvent('내렸음', { leg: s.legIndex });
      if (f && f.speed != null && f.speed < 3 && l.alight) applyLearnedPoint({ id: 'alight', legIndex: s.legIndex, lat: f.lat, lng: f.lng, acc: Math.max(f.acc, 8) });
      return;
    }
    if (l.type === 'subway') tripEvent('역', { leg: s.legIndex, idx: s.stIdx });
  }
  $('tripShareBtn').onclick = async () => {
    const all = loadTrips();
    if (!all.length) return io.speak('저장된 이동 기록이 없음.', 'high');
    const text = JSON.stringify({ app: 'gildongmu', exported: new Date().toISOString(), route: data, trips: all });
    try {
      const file = new File([text], 'gildongmu-trips.json', { type: 'application/json' });
      if (navigator.canShare && navigator.canShare({ files: [file] })) await navigator.share({ files: [file], title: '길동무 이동 기록' });
      else if (navigator.share) await navigator.share({ title: '길동무 이동 기록', text });
      else { await navigator.clipboard.writeText(text); }
      io.speak(`이동 기록 ${all.length}건을 보낼 준비를 했음.`, 'high');
    } catch (e) { io.speak('이동 기록 보내기를 취소했음.', 'high'); }
  };

  // ---------- 버튼 ----------
  $('routeSel').onchange = (e) => { route = data.routes[+e.target.value]; refreshRec(); };
  const PROG = 'walknav.prog.v1';
  const loadProg = () => { try { const q = JSON.parse(localStorage.getItem(PROG) || 'null'); return q && Date.now() - q.t < 12 * 3600 * 1000 ? q : null; } catch (e) { return null; } };
  const saveProg = () => { if (!started || !route) return; const s = engine.snapshot(); if (s) localStorage.setItem(PROG, JSON.stringify(Object.assign({ routeId: route.id, t: Date.now() }, s))); else if (engine.status().legIndex >= (route.legs || []).length) localStorage.removeItem(PROG); };
  const refreshStartBtn = () => { $('startBtn').textContent = loadProg() ? '이어서 안내 시작' : '안내 시작'; };
  setInterval(saveProg, 2000);
  $('startBtn').onclick = async () => {
    route = data.routes[+$('routeSel').value];
    started = true; startGeo(); startCompass();
    let wakeFail = false;
    try { wake = await navigator.wakeLock.request('screen'); } catch (e) { wakeFail = true; }
    if (set.noti && 'Notification' in window && Notification.permission === 'default') await Notification.requestPermission();
    const prog = loadProg();
    if (prog && prog.routeId === route.id) engine.restore(route, prog); else engine.start(route, 0);
    if (wakeFail) io.speak('화면이 꺼지면 안내가 멈출 수 있음. 화면을 켜 두세요.', 'queue');
    if (!trip) { tripStart(); io.speak('이동 기록을 함께 저장함.', 'queue'); }
    $('startBtn').hidden = true;   // 진행 중 실수로 눌러 처음으로 돌아가지 않게 숨김
    $('now').focus();              // 숨긴 버튼에 있던 화면낭독기 포커스를 안내 영역으로 옮김
    refreshRec(); render();
  };
  $('restartBtn').onclick = () => {
    if (!confirm('처음부터 다시 안내할까요?')) return;
    localStorage.removeItem(PROG);
    if (started) engine.start(route, 0); else { $('startBtn').hidden = false; refreshStartBtn(); io.speak('저장된 진행 위치를 지웠음.', 'high'); }
  };
  $('repeatBtn').onclick = () => engine.repeat();
  $('now').onclick = () => engine.repeat();
  const armed = {};
  const twice = (key, fn, msg) => () => { const t = Date.now(); if (armed[key] && t - armed[key] < 15000) { armed[key] = 0; fn(); render(); } else { armed[key] = t; io.speak(msg, 'high'); } };
  const confirmNext = twice('next', () => engine.next(), '안내 중인 지점을 건너뜁니다. 맞으면 한 번 더 누르세요.');
  const doNext = () => {            // 지하철 역 세기, 버스 하차, 위치 정보 없는 지점은 한 번에. 안내 중인 도보 지점을 건너뛰는 것만 확인
    const s = engine.status();
    const go = () => { captureConfirm(s); engine.next(); render(); };
    if (s.waitCross) { go(); return; }   // 길을 건넜다는 확인은 한 번에
    if (s.leg && s.leg.type === 'bus' && s.busEarly) return twice('busnext', go, '아직 달리는 중이거나 하차 정류장 전인 것 같음. 정말 내렸으면 한 번 더 누르세요.')();
    if (s.leg && s.leg.type === 'walk' && s.point && W.hasXY(s.point) && !s.near) return twice('next', () => { tripEvent('건너뜀', { leg: s.legIndex, point: s.point.id }); engine.next(); }, '안내 중인 지점을 건너뜁니다. 맞으면 한 번 더 누르세요.')();
    go();
  };
  $('nextBtn').onclick = () => { doNext(); saveProg(); };
  $('detailBtn').onclick = () => engine.detail();
  $('prevBtn').onclick = () => { const s = engine.status(); if (s.leg && s.leg.type === 'subway' && s.stIdx > 0) { engine.prevLeg(); render(); } else twice('prev', () => engine.prevLeg(), '이전 단계로 돌아갑니다. 맞으면 한 번 더 누르세요.')(); };
  $('skipBtn').onclick = twice('skip', () => engine.skipLeg(), '이 단계를 건너뜁니다. 맞으면 한 번 더 누르세요.');
  $('shareBtn').onclick = async () => {
    if (!lastFix) return io.speak('아직 위치를 잡지 못했음', 'high');
    const url = `https://maps.google.com/?q=${lastFix.lat},${lastFix.lng}`;
    const text = `현재 위치(오차 약 ${Math.round(lastFix.acc)}m): ${url}`;
    try { if (navigator.share) await navigator.share({ title: '내 위치', text }); else await navigator.clipboard.writeText(text); io.speak('위치를 보낼 준비를 했음', 'high'); }
    catch (e) { /* 취소 */ }
  };
  $('voiceCmdBtn').onclick = () => {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) return io.speak('이 브라우저는 음성 명령을 지원하지 않음', 'high');
    if ('speechSynthesis' in window) speechSynthesis.cancel();   // 앱 음성을 인식기가 다시 듣지 않도록
    const r = new SR(); r.lang = 'ko-KR'; r.maxAlternatives = 3;
    r.onresult = (ev) => {
      const t = ev.results[0][0].transcript;
      if (/다시|반복/.test(t)) engine.repeat();
      else if (/위치|도움/.test(t)) $('shareBtn').click();
      else if (/다음/.test(t)) doNext();     // 되돌릴 수 없는 이전·건너뛰기는 음성 명령에서 제외, '역'만으로는 반응하지 않음(오인식 방지)
      else io.speak('명령을 이해하지 못했음. 다시, 다음, 위치 중에서 말씀해 주세요.', 'high');
      render();
    };
    r.onerror = () => io.speak('음성 인식 실패', 'high');
    r.start();
  };

  // 설정
  $('voiceOn').checked = set.voice; $('rate').value = set.rate; $('rate').setAttribute('aria-valuetext', '속도 ' + set.rate + '배');
  $('vibOn').checked = set.vib; $('beepOn').checked = set.beep; $('beaconOn').checked = set.beacon; $('notiOn').checked = set.noti;
  const syncLive = () => $('now').setAttribute('aria-live', set.voice ? 'off' : 'polite'); // 앱 음성이 꺼지면 화면낭독기가 대신 읽음
  $('voiceOn').onchange = (e) => { set.voice = e.target.checked; saveSet(); syncLive(); };
  syncLive();
  $('rate').oninput = (e) => { set.rate = +e.target.value; e.target.setAttribute('aria-valuetext', '속도 ' + set.rate + '배'); saveSet(); };
  $('vibOn').onchange = (e) => { set.vib = e.target.checked; saveSet(); };
  $('hfOn').checked = set.handsFree;
  $('hfOn').onchange = (e) => { set.handsFree = e.target.checked; saveSet(); engine.setHandsFree(set.handsFree); };
  $('beepOn').onchange = (e) => { set.beep = e.target.checked; saveSet(); };
  $('beaconOn').onchange = (e) => { set.beacon = e.target.checked; saveSet(); };
  $('notiOn').onchange = async (e) => {
    set.noti = e.target.checked; saveSet();
    if (set.noti && 'Notification' in window) await Notification.requestPermission();
  };

  loadData().then(() => autoSeed(false)).catch((e) => { $('now').textContent = '경로를 불러오지 못했음: ' + e.message; });
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  setInterval(() => { if (started) { engine.tick(); render(); } }, 1000);   // GPS 두절 감지는 나침반 이벤트가 없어도 동작해야 함
  window.__walknav = { engine, get route() { return route; }, feed: (f) => { lastFix = f; if (learner) learner.onFix(f); engine.onFix(f); render(); }, feedRaw: (f) => { rawFix = f; tripFix(f); lastFix = kf.update(f); engine.onFix(lastFix); render(); } };
})();
