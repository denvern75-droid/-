/* 길동무 UI 레이어: 음성·진동·GPS·나침반·기록 모드 */
(function () {
  'use strict';
  const W = window.WalkNav;
  const $ = (id) => document.getElementById(id);
  const LS_ROUTE = 'walknav.route.v1', LS_SET = 'walknav.settings.v1';

  const set = Object.assign({ voice: true, rate: 1.0, vib: true, beep: true, noti: false },
    JSON.parse(localStorage.getItem(LS_SET) || '{}'));
  const saveSet = () => localStorage.setItem(LS_SET, JSON.stringify(set));

  let data = null, route = null, started = false;
  let lastFix = null, rawFix = null, watchId = null, wake = null, smoothSin = 0, smoothCos = 0, hasCompass = false;
  let actx = null;

  // ---------- 출력(음성/진동/비프/알림) ----------
  let koVoice = null;
  function pickVoice() {
    const vs = speechSynthesis.getVoices();
    koVoice = vs.find((v) => /ko[-_]KR/i.test(v.lang)) || null;
  }
  if ('speechSynthesis' in window) { pickVoice(); speechSynthesis.onvoiceschanged = pickVoice; }

  const io = {
    speak(text, prio) {
      $('now').textContent = text;
      if (!set.voice || !('speechSynthesis' in window)) return;
      if (prio === 'high') speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(W.spoken(text));
      u.lang = 'ko-KR'; u.rate = set.rate; if (koVoice) u.voice = koVoice;
      speechSynthesis.speak(u);
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
    notify(text) {
      if (!set.noti || !('Notification' in window) || Notification.permission !== 'granted') return;
      navigator.serviceWorker && navigator.serviceWorker.ready.then((r) =>
        r.showNotification('길동무', { body: text, tag: 'walknav', renotify: true, vibrate: [200, 100, 200] }));
    },
    onLegChange() { refreshRec(); },
  };
  const engine = W.createEngine({ io });
  const kf = W.createKalman();
  const WL = window.WalkLearn;
  let learner = null;

  // ---------- 센서 ----------
  function startGeo() {
    if (watchId != null) return;
    if (!navigator.geolocation) { io.speak('이 기기는 위치 기능을 지원하지 않음', 'high'); return; }
    watchId = navigator.geolocation.watchPosition((p) => {
      rawFix = { lat: p.coords.latitude, lng: p.coords.longitude, acc: p.coords.accuracy,
        heading: p.coords.heading, speed: p.coords.speed || 0, t: Date.now() };
      recSample(rawFix);                 // 기록은 원시 값으로(이중 평활 방지)
      lastFix = kf.update(rawFix);       // 안내는 칼만 평활 값으로
      if (learner) learner.onFix(lastFix);
      engine.onFix(lastFix); render();
    }, (e) => io.speak('위치 오류: ' + e.message + '. 위치 권한과 GPS를 확인해 주세요.', 'high'),
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
    if (!data) data = await (await fetch('route.json', { cache: 'no-cache' })).json();
    const sel = $('routeSel'); sel.innerHTML = '';
    data.routes.forEach((r, i) => { const o = document.createElement('option'); o.value = i; o.textContent = r.name; sel.appendChild(o); });
    route = data.routes[0];
    refreshRec();
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
  function applyLearnedPoint(e) {
    let tgt = null;
    if (e.id === 'home') tgt = route.home = route.home || { name: '집' };
    else if (e.id === 'alight') tgt = route.legs[e.legIndex].alight;
    else tgt = findPoint(e.id);
    if (!tgt) return;
    tgt.samples = tgt.samples || [];
    tgt.samples.push({ lat: e.lat, lng: e.lng, acc: e.acc, t: Date.now() });
    const m = W.robustFuse(tgt.samples);
    tgt.lat = m.lat; tgt.lng = m.lng; tgt.recAcc = Math.round(m.acc);
    persist(); refreshRec();
  }
  function applyLearnedLeg(e) {
    const l = route.legs[e.legIndex]; if (!l || !l.points) return;
    l.points = l.points.filter((p) => !p.auto);            // 이전 자동 꺾는 지점 교체
    const last = l.points.pop();
    e.turns.forEach((t, i) => l.points.push({ id: `auto-${e.legIndex}-${i}`, auto: true, name: '꺾는 곳', kind: 'turn', radius: 8, lat: t.lat, lng: t.lng,
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
    try { wake = await navigator.wakeLock.request('screen'); } catch (e) {}
    learner = WL.createLearner({ route,
      say: (t) => io.speak(t, 'normal'),
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
      p.lat = m.lat; p.lng = m.lng; p.recAcc = Math.round(m.acc);
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

  // ---------- 버튼 ----------
  $('routeSel').onchange = (e) => { route = data.routes[+e.target.value]; refreshRec(); };
  $('startBtn').onclick = async () => {
    route = data.routes[+$('routeSel').value];
    started = true; startGeo(); startCompass();
    try { wake = await navigator.wakeLock.request('screen'); } catch (e) {}
    if (set.noti && 'Notification' in window && Notification.permission === 'default') await Notification.requestPermission();
    engine.start(route, 0); refreshRec(); render();
    $('startBtn').textContent = '처음부터 다시 시작';
  };
  $('repeatBtn').onclick = () => engine.repeat();
  $('now').onclick = () => engine.repeat();
  $('nextBtn').onclick = () => { engine.next(); render(); };
  $('prevBtn').onclick = () => { engine.prevLeg(); render(); };
  $('skipBtn').onclick = () => { engine.skipLeg(); render(); };
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
    const r = new SR(); r.lang = 'ko-KR'; r.maxAlternatives = 3;
    r.onresult = (ev) => {
      const t = ev.results[0][0].transcript;
      if (/다시|반복/.test(t)) engine.repeat();
      else if (/다음|도착|역/.test(t)) engine.next();
      else if (/이전|뒤로/.test(t)) engine.prevLeg();
      else if (/건너|스킵/.test(t)) engine.skipLeg();
      else if (/위치|도움/.test(t)) $('shareBtn').click();
      else io.speak(`"${t}" 명령을 이해하지 못했음. 다시, 다음, 이전, 건너뛰기, 위치 중에서 말씀해 주세요.`, 'high');
      render();
    };
    r.onerror = () => io.speak('음성 인식 실패', 'high');
    r.start();
  };

  // 설정
  $('voiceOn').checked = set.voice; $('rate').value = set.rate; $('rateV').textContent = set.rate;
  $('vibOn').checked = set.vib; $('beepOn').checked = set.beep; $('notiOn').checked = set.noti;
  const syncLive = () => $('now').setAttribute('aria-live', set.voice ? 'off' : 'polite'); // 앱 음성이 꺼지면 화면낭독기가 대신 읽음
  $('voiceOn').onchange = (e) => { set.voice = e.target.checked; saveSet(); syncLive(); };
  syncLive();
  $('rate').oninput = (e) => { set.rate = +e.target.value; $('rateV').textContent = set.rate; saveSet(); };
  $('vibOn').onchange = (e) => { set.vib = e.target.checked; saveSet(); };
  $('beepOn').onchange = (e) => { set.beep = e.target.checked; saveSet(); };
  $('notiOn').onchange = async (e) => {
    set.noti = e.target.checked; saveSet();
    if (set.noti && 'Notification' in window) await Notification.requestPermission();
  };

  loadData().catch((e) => { $('now').textContent = '경로를 불러오지 못했음: ' + e.message; });
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  setInterval(() => { if (started) render(); }, 1000);
  window.__walknav = { engine, get route() { return route; }, feed: (f) => { lastFix = f; if (learner) learner.onFix(f); engine.onFix(f); render(); } };
})();
