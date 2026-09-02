/**
 * 업무보고 → 텔레그램 중계 (Google Apps Script 판)
 *
 * 노트북·데스크탑 전원과 무관하게 Google 서버에서 실행됨.
 * 데스크탑이 구글드라이브에 보고서를 올려두기만 하면, 이후 모든 PC가 꺼져 있어도 전송됨.
 *
 * 설치 순서는 docs/04_구글드라이브_PC없이_24시간.md 참조.
 *
 * 실행할 함수
 *   setup()          최초 1회 — 설정값 점검 후 시간 기반 트리거 설치
 *   doctor()         진단 — 설정·폴더·봇·대화방 점검(발송 없음)
 *   dryRun()         발송 없는 시험 — 무엇이 전송될지만 기록
 *   runOnce()        수동 1회 실행(실제 발송)
 *   removeTriggers() 트리거 전체 제거
 *   main()           트리거가 호출하는 진입점 — 직접 실행하지 않아도 됨
 */

// ─────────────────────────────────────────────────────────── 상수

var API_BASE = 'https://api.telegram.org';

var PROP = {
  BOT_TOKEN: 'BOT_TOKEN',      // 필수 — BotFather 발급 토큰
  CHAT_ID: 'CHAT_ID',          // 필수 — 받을 대화방 ID
  FOLDER_ID: 'FOLDER_ID',      // 필수 — 감시할 구글드라이브 폴더 ID
  THREAD_ID: 'THREAD_ID',      // 선택 — 그룹 토픽(스레드) ID
  EXTENSIONS: 'EXTENSIONS',    // 선택 — 쉼표 구분. 미지정 시 기본값 사용
  WATERMARK: '_WATERMARK_MS',  // 내부 — 마지막 처리 시각
  SENT_MAP: '_SENT_MAP',       // 내부 — 최근 전송 이력
  HEARTBEAT: '_HEARTBEAT'      // 내부 — 마지막 생존 신고 날짜
};

var DEFAULT_EXTENSIONS = ['hwp', 'hwpx', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'pdf', 'txt', 'csv'];

var BACKFILL_HOURS = 24;        // 최초 실행 시 소급 범위
var MAX_UPLOAD_BYTES = 50 * 1024 * 1024;  // 텔레그램 봇 업로드 상한
var CAPTION_LIMIT = 1000;
var MESSAGE_LIMIT = 4000;
var SENT_MAP_LIMIT = 300;       // 이력 보관 건수(스크립트 속성 용량 보호)
var MAX_DEPTH = 3;              // 하위 폴더 탐색 깊이
var TRIGGER_MINUTES = 15;       // 트리거 주기(분)
var HEARTBEAT_HOUR = 9;         // 생존 신고 시각

// 구글 문서 형식은 원본 바이트가 없어 PDF로 변환해 전송함
var GOOGLE_NATIVE = {
  'application/vnd.google-apps.document': 'pdf',
  'application/vnd.google-apps.spreadsheet': 'pdf',
  'application/vnd.google-apps.presentation': 'pdf'
};

// ─────────────────────────────────────────────────────────── 설정

function props_() {
  return PropertiesService.getScriptProperties();
}

function cfg_() {
  var p = props_();
  var exts = p.getProperty(PROP.EXTENSIONS);
  return {
    botToken: (p.getProperty(PROP.BOT_TOKEN) || '').trim(),
    chatId: (p.getProperty(PROP.CHAT_ID) || '').trim(),
    folderId: (p.getProperty(PROP.FOLDER_ID) || '').trim(),
    threadId: (p.getProperty(PROP.THREAD_ID) || '').trim(),
    extensions: exts
      ? exts.split(',').map(function (e) { return e.trim().replace(/^\./, '').toLowerCase(); }).filter(String)
      : DEFAULT_EXTENSIONS
  };
}

function validate_(c) {
  var errors = [];
  if (!c.botToken) {
    errors.push('BOT_TOKEN 없음 — 스크립트 속성에 추가 필요함');
  } else if (!/^\d{6,}:[A-Za-z0-9_\-]{30,}$/.test(c.botToken)) {
    errors.push('BOT_TOKEN 형식 오류 — "숫자:영문자열" 형태여야 함(앞뒤 공백·따옴표 확인)');
  }
  if (!c.chatId) { errors.push('CHAT_ID 없음'); }
  if (!c.folderId) { errors.push('FOLDER_ID 없음 — 드라이브 폴더 URL 뒤쪽 ID 문자열'); }
  return errors;
}

// ─────────────────────────────────────────────────────────── 텔레그램

function tgCall_(token, method, payload) {
  var url = API_BASE + '/bot' + token + '/' + method;
  for (var attempt = 1; attempt <= 4; attempt++) {
    var res = UrlFetchApp.fetch(url, {
      method: 'post',
      payload: payload,
      muteHttpExceptions: true
    });
    var code = res.getResponseCode();
    var body;
    try { body = JSON.parse(res.getContentText()); } catch (e) { body = { description: res.getContentText() }; }

    if (code === 200 && body.ok) { return body.result; }

    // 호출량 초과 — 서버가 알려준 시간만큼 쉬고 재시도함
    if (code === 429) {
      var wait = (body.parameters && body.parameters.retry_after) || 5;
      Utilities.sleep(Math.min(wait, 30) * 1000);
      continue;
    }
    // 토큰·대화방 문제는 재시도해도 소용없음
    if (code >= 400 && code < 500) {
      throw new Error(method + ' 실패(' + code + '): ' + (body.description || ''));
    }
    Utilities.sleep(Math.min(Math.pow(2, attempt), 20) * 1000);
  }
  throw new Error(method + ' 실패 — 재시도 한도 초과');
}

function tgSendMessage_(c, text) {
  var payload = { chat_id: c.chatId, text: text.slice(0, MESSAGE_LIMIT), disable_web_page_preview: 'true' };
  if (c.threadId) { payload.message_thread_id = c.threadId; }
  return tgCall_(c.botToken, 'sendMessage', payload);
}

function tgSendDocument_(c, blob, caption) {
  // Apps Script 는 payload 에 Blob 이 있으면 multipart/form-data 로 자동 구성함
  var payload = { chat_id: c.chatId, document: blob };
  if (caption) { payload.caption = caption.slice(0, CAPTION_LIMIT); }
  if (c.threadId) { payload.message_thread_id = c.threadId; }
  return tgCall_(c.botToken, 'sendDocument', payload);
}

// ─────────────────────────────────────────────────────────── 파일 수집

function fileBlob_(file) {
  var mime = file.getMimeType();
  if (GOOGLE_NATIVE[mime]) {
    var pdf = file.getAs('application/pdf');
    pdf.setName(file.getName() + '.pdf');
    return pdf;
  }
  return file.getBlob();
}

function extOf_(name) {
  var idx = name.lastIndexOf('.');
  return idx === -1 ? '' : name.slice(idx + 1).toLowerCase();
}

/** 감시 폴더(하위 포함)에서 watermark 이후 수정된 파일을 모음. */
function collect_(c, sinceMs) {
  var out = [];
  var root;
  try {
    root = DriveApp.getFolderById(c.folderId);
  } catch (e) {
    throw new Error('폴더 접근 실패 — FOLDER_ID 확인 필요함: ' + e.message);
  }

  function walk(folder, depth) {
    var files = folder.getFiles();
    while (files.hasNext()) {
      var f = files.next();
      var updated = f.getLastUpdated().getTime();
      if (updated <= sinceMs) { continue; }

      var mime = f.getMimeType();
      var isNative = !!GOOGLE_NATIVE[mime];
      if (!isNative && c.extensions.indexOf(extOf_(f.getName())) === -1) { continue; }
      if (!isNative && f.getSize() === 0) { continue; }

      out.push({ file: f, updated: updated, id: f.getId(), name: f.getName(), size: f.getSize() });
    }
    if (depth >= MAX_DEPTH) { return; }
    var subs = folder.getFolders();
    while (subs.hasNext()) { walk(subs.next(), depth + 1); }
  }

  walk(root, 1);
  out.sort(function (a, b) { return a.updated - b.updated; });
  return out;
}

// ─────────────────────────────────────────────────────────── 전송 이력

function sentMap_() {
  var raw = props_().getProperty(PROP.SENT_MAP);
  if (!raw) { return {}; }
  try { return JSON.parse(raw); } catch (e) { return {}; }
}

function saveSentMap_(map) {
  var keys = Object.keys(map);
  if (keys.length > SENT_MAP_LIMIT) {
    // 오래된 것부터 정리함(스크립트 속성 용량 보호)
    keys.sort(function (a, b) { return map[a] - map[b]; });
    keys.slice(0, keys.length - SENT_MAP_LIMIT).forEach(function (k) { delete map[k]; });
  }
  props_().setProperty(PROP.SENT_MAP, JSON.stringify(map));
}

// ─────────────────────────────────────────────────────────── 본문

function caption_(item) {
  return '📄 업무보고 도착'
    + '\n파일: ' + item.name
    + '\n수정: ' + Utilities.formatDate(new Date(item.updated), 'Asia/Seoul', 'yyyy-MM-dd HH:mm')
    + (item.size ? '\n크기: ' + Math.round(item.size / 1024) + ' KB' : '');
}

function heartbeat_(c, dryRun) {
  var today = Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyyy-MM-dd');
  var hour = Number(Utilities.formatDate(new Date(), 'Asia/Seoul', 'H'));
  if (props_().getProperty(PROP.HEARTBEAT) === today || hour < HEARTBEAT_HOUR) { return; }
  if (dryRun) { Logger.log('[시험] 생존 신고 생략'); return; }
  try {
    tgSendMessage_(c, '✅ 중계 정상 가동 중 (구글드라이브 · PC 무관)\n'
      + Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyyy-MM-dd HH:mm'));
    props_().setProperty(PROP.HEARTBEAT, today);
  } catch (e) {
    Logger.log('생존 신고 실패: ' + e.message);
  }
}

function relay_(dryRun) {
  var c = cfg_();
  var errors = validate_(c);
  if (errors.length) { throw new Error('설정 오류 — ' + errors.join(' / ')); }

  // 트리거가 겹쳐 돌면 중복 전송이 생기므로 잠금을 검
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30 * 1000)) {
    Logger.log('이전 실행이 진행 중 — 이번 회차 건너뜀');
    return;
  }

  try {
    var p = props_();
    var stored = p.getProperty(PROP.WATERMARK);
    var watermark = stored ? Number(stored) : (Date.now() - BACKFILL_HOURS * 3600 * 1000);

    var scanStarted = Date.now();
    var items = collect_(c, watermark);
    var map = sentMap_();
    var sent = 0, skipped = 0, failed = 0;
    // 처리하지 못한 파일의 수정시각. 기준 시각을 이 지점보다 앞으로 옮기면
    // 해당 파일은 다음 조회 범위에서 빠져 영영 재시도되지 않음.
    var unfinished = [];

    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      if (map[it.id] === it.updated) { skipped++; continue; }

      if (dryRun) {
        Logger.log('[시험] 발송 생략 — ' + it.name);
        sent++;
        continue;
      }

      try {
        if (it.size && it.size > MAX_UPLOAD_BYTES) {
          tgSendMessage_(c, caption_(it) + '\n⚠ 첨부 상한(50MB) 초과 — 본문만 전송함\n'
            + '원본: ' + it.file.getUrl());
        } else {
          tgSendDocument_(c, fileBlob_(it.file), caption_(it));
        }
        map[it.id] = it.updated;
        saveSentMap_(map);
        sent++;
        Logger.log('전송 완료 — ' + it.name);
      } catch (e) {
        failed++;
        unfinished.push(it.updated);
        Logger.log('전송 실패 — ' + it.name + ' : ' + e.message);
      }
    }

    if (!dryRun) {
      // 가장 이른 미처리 시각까지만 전진시킴. 모두 성공했으면 이번 조회 시작 시각까지.
      var next = unfinished.length ? Math.min.apply(null, unfinished) : scanStarted;
      p.setProperty(PROP.WATERMARK, String(Math.max(next, watermark)));
    }

    heartbeat_(c, dryRun);
    Logger.log('실행 요약 — 대상 ' + items.length + '건 / 전송 ' + sent
      + ' / 중복생략 ' + skipped + ' / 실패 ' + failed + (dryRun ? ' (시험모드)' : ''));
  } finally {
    lock.releaseLock();
  }
}

// ─────────────────────────────────────────────────────────── 공개 함수

/** 트리거 진입점. */
function main() {
  relay_(false);
}

/** 수동 1회 실행(실제 발송). */
function runOnce() {
  relay_(false);
}

/** 발송 없는 시험 — 실행 기록에서 전송 대상만 확인함. */
function dryRun() {
  relay_(true);
}

/** 진단 — 발송하지 않고 설정·폴더·봇·대화방을 점검함. */
function doctor() {
  var lines = ['================ 진단 결과 ================'];
  var c = cfg_();

  lines.push('\n■ 1. 설정값');
  var errors = validate_(c);
  if (errors.length) {
    errors.forEach(function (e) { lines.push('[실패] ' + e); });
  } else {
    lines.push('[정상] BOT_TOKEN 형식 확인 (봇 ID ' + c.botToken.split(':')[0] + ')');
    lines.push('[정상] CHAT_ID: ' + c.chatId);
  }
  lines.push('[정상] 대상 확장자: ' + c.extensions.join(', '));

  lines.push('\n■ 2. 드라이브 폴더');
  if (!c.folderId) {
    lines.push('[실패] FOLDER_ID 없음');
  } else {
    try {
      var folder = DriveApp.getFolderById(c.folderId);
      lines.push('[정상] 폴더 접근 가능: ' + folder.getName());
      var recent = collect_(c, Date.now() - BACKFILL_HOURS * 3600 * 1000);
      lines.push((recent.length ? '[정상] ' : '[주의] ')
        + '최근 ' + BACKFILL_HOURS + '시간 내 대상 파일 ' + recent.length + '건'
        + (recent.length ? ' — ' + recent.slice(-3).map(function (r) { return r.name; }).join(', ') : ''));
    } catch (e) {
      lines.push('[실패] 폴더 접근 불가 — ' + e.message);
    }
  }

  lines.push('\n■ 3. 봇 인증');
  if (!c.botToken) {
    lines.push('[실패] BOT_TOKEN 없음 — 이후 점검 생략');
  } else {
    try {
      var me = tgCall_(c.botToken, 'getMe', {});
      lines.push('[정상] 봇 확인: @' + me.username);
    } catch (e) {
      lines.push('[실패] getMe 실패 — ' + e.message);
    }
  }

  lines.push('\n■ 4. 대화방');
  try {
    var updates = tgCall_(c.botToken, 'getUpdates', { limit: 30, timeout: 0 }) || [];
    var seen = {};
    updates.forEach(function (u) {
      var m = u.message || u.channel_post || u.my_chat_member;
      if (m && m.chat) { seen[m.chat.id] = m.chat.type + ' / ' + (m.chat.title || m.chat.first_name || ''); }
    });
    var ids = Object.keys(seen);
    if (ids.length) {
      lines.push('[정상] 최근 대화방 후보: ' + ids.map(function (k) { return k + ' → ' + seen[k]; }).join('; '));
      if (c.chatId && ids.indexOf(c.chatId) === -1) {
        lines.push('[주의] 설정된 CHAT_ID 가 최근 이력에 없음 — 그룹→슈퍼그룹 전환 시 ID 변경됨(-100...)');
      }
    } else {
      lines.push('[주의] 최근 대화 이력 없음 — 봇에게 /start 를 1회 보내야 함');
    }
  } catch (e) {
    lines.push('[주의] getUpdates 생략 — ' + e.message);
  }

  lines.push('\n■ 5. 트리거');
  var triggers = ScriptApp.getProjectTriggers().filter(function (t) { return t.getHandlerFunction() === 'main'; });
  lines.push((triggers.length ? '[정상] ' : '[주의] ') + 'main 트리거 ' + triggers.length + '개'
    + (triggers.length ? '' : ' — setup() 실행 필요함'));

  lines.push('\n■ 6. 처리 기준 시각');
  var wm = props_().getProperty(PROP.WATERMARK);
  lines.push('[정상] ' + (wm
    ? Utilities.formatDate(new Date(Number(wm)), 'Asia/Seoul', 'yyyy-MM-dd HH:mm')
    : '미설정 — 최초 실행 시 최근 ' + BACKFILL_HOURS + '시간을 소급함'));

  lines.push('\n===========================================');
  var text = lines.join('\n');
  Logger.log(text);
  return text;
}

/** 최초 1회 — 설정 점검 후 시간 기반 트리거를 설치함. */
function setup() {
  var c = cfg_();
  var errors = validate_(c);
  if (errors.length) {
    throw new Error('설정을 먼저 채워야 함 — ' + errors.join(' / '));
  }
  removeTriggers();
  ScriptApp.newTrigger('main').timeBased().everyMinutes(TRIGGER_MINUTES).create();
  var msg = TRIGGER_MINUTES + '분 주기 트리거 설치 완료. 이제 PC 전원과 무관하게 동작함.';
  Logger.log(msg);
  return msg;
}

/** 트리거 전체 제거. */
function removeTriggers() {
  var n = 0;
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'main') { ScriptApp.deleteTrigger(t); n++; }
  });
  Logger.log('트리거 ' + n + '개 제거함');
  return n;
}

/** 전송 이력 초기화 — 처음부터 다시 보내야 할 때만 사용함. */
function resetState() {
  var p = props_();
  p.deleteProperty(PROP.WATERMARK);
  p.deleteProperty(PROP.SENT_MAP);
  p.deleteProperty(PROP.HEARTBEAT);
  Logger.log('전송 이력 초기화함 — 다음 실행 시 최근 ' + BACKFILL_HOURS + '시간을 소급 전송함');
}
