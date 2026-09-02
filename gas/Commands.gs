/**
 * 텔레그램 봇 양방향 명령 계층
 *
 * 보고를 '받기만' 하는 게 아니라, 텔레그램에서 봇에게 지시를 내려
 * 즉시 실행시키는 통로임. 앞으로 다른 자동화도 COMMANDS 에 한 줄 추가하면 붙음.
 *
 * 동작 방식
 *   텔레그램 → (웹훅) → 이 스크립트의 doPost → 명령 실행 → 답장
 *   PC 전원과 무관하며, 폴링이 아니라 웹훅이라 응답이 즉시임.
 *
 * 설치
 *   1) 배포 → 새 배포 → 유형 '웹 앱'
 *      - 실행 계정: 나
 *      - 액세스 권한: 모든 사용자   ← 텔레그램 서버가 호출해야 하므로 필요함
 *   2) 발급된 /exec URL 을 복사
 *   3) 스크립트 속성에 WEBHOOK_SECRET (임의 문자열) 추가
 *   4) setWebhook() 실행 시 URL 을 물어보지 않고 아래 WEB_APP_URL 속성을 사용함
 *      → 스크립트 속성에 WEB_APP_URL = 복사한 /exec URL 추가 후 setWebhook() 실행
 *
 * 보안
 *   - URL 에 비밀키를 붙여 호출자를 검증함(Apps Script 는 요청 헤더를 볼 수 없어 쿼리 파라미터를 씀)
 *   - 그 위에 CHAT_ID 일치 여부를 한 번 더 확인함 → 외부인이 URL 을 알아내도 명령 실행 불가
 */

var PROP_WEBHOOK_SECRET = 'WEBHOOK_SECRET';
var PROP_WEB_APP_URL = 'WEB_APP_URL';

// ─────────────────────────────────────────────────── 명령 정의
// 새 자동화를 붙일 때는 여기에 항목만 추가하면 됨.

var COMMANDS = [
  {
    names: ['/help', '/도움', '/명령'],
    desc: '사용 가능한 명령 목록',
    run: function () { return helpText_(); }
  },
  {
    names: ['/status', '/상태'],
    desc: '중계 상태 진단(발송 없음)',
    run: function () { return doctor(); }
  },
  {
    names: ['/report', '/보고'],
    desc: '지금 즉시 폴더를 확인해 새 보고를 전송함',
    run: function () {
      relay_(false);
      return '보고 확인·전송을 마쳤음. 새 보고가 있었다면 위에 도착했음.';
    }
  },
  {
    names: ['/list', '/목록'],
    desc: '최근 24시간 내 대상 파일 목록(전송하지 않음)',
    run: function () {
      var c = cfg_();
      var items = collect_(c, Date.now() - BACKFILL_HOURS * 3600 * 1000);
      if (!items.length) { return '최근 24시간 내 대상 파일 없음.'; }
      return '최근 24시간 대상 파일 ' + items.length + '건\n'
        + items.map(function (it) {
            return '· ' + it.name + '  ('
              + Utilities.formatDate(new Date(it.updated), 'Asia/Seoul', 'MM-dd HH:mm') + ')';
          }).join('\n');
    }
  },
  {
    names: ['/dryrun', '/시험'],
    desc: '발송 없는 시험 — 무엇이 전송될지만 확인',
    run: function () {
      var c = cfg_();
      var wm = props_().getProperty(PROP.WATERMARK);
      var since = wm ? Number(wm) : (Date.now() - BACKFILL_HOURS * 3600 * 1000);
      var items = collect_(c, since);
      if (!items.length) { return '전송 대상 없음(모두 전송 완료 상태임).'; }
      return '전송 예정 ' + items.length + '건\n'
        + items.map(function (it) { return '· ' + it.name; }).join('\n');
    }
  },
  {
    names: ['/resend', '/재전송'],
    desc: '전송 이력을 지우고 최근 24시간을 다시 보냄',
    run: function () {
      resetState();
      relay_(false);
      return '이력을 초기화하고 최근 24시간을 재전송했음.';
    }
  },
  {
    names: ['/id', '/아이디'],
    desc: '이 대화방의 chat_id 확인',
    run: function (ctx) { return '이 대화방 chat_id: ' + ctx.chatId; }
  }
];

function helpText_() {
  return '사용 가능한 명령\n'
    + COMMANDS.map(function (c) {
        return c.names[0] + ' (' + c.names.slice(1).join(', ') + ')\n   ' + c.desc;
      }).join('\n')
    + '\n\n※ 명령은 등록된 대화방에서만 동작함.';
}

// ─────────────────────────────────────────────────── 웹훅 진입점

function doPost(e) {
  // 어떤 경우에도 200 을 돌려줘야 함. 오류를 던지면 텔레그램이 같은 요청을 반복 전송함.
  try {
    handleUpdate_(e);
  } catch (err) {
    Logger.log('doPost 처리 오류: ' + err.message);
  }
  return ContentService.createTextOutput('ok');
}

function doGet() {
  // 배포 확인용. 명령은 POST 로만 받음.
  return ContentService.createTextOutput('relay webhook alive');
}

function handleUpdate_(e) {
  var p = props_();
  var secret = p.getProperty(PROP_WEBHOOK_SECRET);

  // 1차 검증 — URL 비밀키
  if (secret && (!e || !e.parameter || e.parameter.k !== secret)) {
    Logger.log('비밀키 불일치 요청 무시함');
    return;
  }
  if (!e || !e.postData || !e.postData.contents) { return; }

  var update = JSON.parse(e.postData.contents);
  var msg = update.message || update.edited_message;
  if (!msg || !msg.text) { return; }

  var c = cfg_();
  var ctx = { chatId: String(msg.chat.id), text: msg.text.trim(), from: msg.from || {} };

  // 2차 검증 — 등록된 대화방만 명령 실행 가능
  if (c.chatId && ctx.chatId !== String(c.chatId)) {
    // /id 만은 허용함(초기 설정 시 chat_id 를 확인해야 하므로)
    if (/^\/(id|아이디)\b/.test(ctx.text)) {
      tgReply_(c, ctx.chatId, '이 대화방 chat_id: ' + ctx.chatId);
    } else {
      Logger.log('미등록 대화방 명령 무시함: ' + ctx.chatId);
    }
    return;
  }

  // 명령어에서 봇 멘션(@봇이름)과 인자를 분리함
  var head = ctx.text.split(/\s+/)[0].split('@')[0].toLowerCase();

  if (head === '/start') {
    tgReply_(c, ctx.chatId, '연결됨. chat_id: ' + ctx.chatId + '\n\n' + helpText_());
    return;
  }

  for (var i = 0; i < COMMANDS.length; i++) {
    if (COMMANDS[i].names.indexOf(head) !== -1) {
      var name = COMMANDS[i].names[0];
      try {
        var result = COMMANDS[i].run(ctx);
        tgReply_(c, ctx.chatId, result || (name + ' 완료'));
      } catch (err) {
        tgReply_(c, ctx.chatId, '⚠ ' + name + ' 실행 중 오류\n' + err.message);
        Logger.log(name + ' 오류: ' + err.stack);
      }
      return;
    }
  }

  if (head.charAt(0) === '/') {
    tgReply_(c, ctx.chatId, '알 수 없는 명령임.\n\n' + helpText_());
  }
}

/** 명령 응답 전용 — 설정된 chat_id 가 아니라 요청이 온 대화방으로 답장함. */
function tgReply_(c, chatId, text) {
  if (!c.botToken) { return; }
  var chunks = String(text).match(/[\s\S]{1,3900}/g) || [''];
  chunks.forEach(function (chunk) {
    try {
      tgCall_(c.botToken, 'sendMessage', { chat_id: chatId, text: chunk, disable_web_page_preview: 'true' });
    } catch (err) {
      Logger.log('답장 실패: ' + err.message);
    }
  });
}

// ─────────────────────────────────────────────────── 웹훅 등록

/** 웹 앱 URL 을 텔레그램에 웹훅으로 등록함. WEB_APP_URL 속성이 먼저 있어야 함. */
function setWebhook() {
  var p = props_();
  var c = cfg_();
  var base = (p.getProperty(PROP_WEB_APP_URL) || '').trim();
  var secret = (p.getProperty(PROP_WEBHOOK_SECRET) || '').trim();

  if (!base) { throw new Error('WEB_APP_URL 속성 없음 — 웹 앱 배포 후 /exec URL 을 넣어야 함'); }
  if (!/\/exec$/.test(base)) { throw new Error('WEB_APP_URL 은 /exec 로 끝나야 함(개발용 /dev 는 외부 호출 불가)'); }
  if (!secret) { throw new Error('WEBHOOK_SECRET 속성 없음 — 임의 문자열을 넣어야 함'); }
  if (!c.botToken) { throw new Error('BOT_TOKEN 없음'); }

  var url = base + '?k=' + encodeURIComponent(secret);
  var res = tgCall_(c.botToken, 'setWebhook', {
    url: url,
    allowed_updates: JSON.stringify(['message', 'edited_message']),
    drop_pending_updates: 'true'
  });
  var msg = '웹훅 등록 완료. 이제 텔레그램에서 /도움 을 입력해 보기 바람.';
  Logger.log(msg + ' (' + res + ')');
  return msg;
}

/** 웹훅 상태 확인 — 최근 오류 원인을 텔레그램이 알려줌. */
function getWebhookInfo() {
  var c = cfg_();
  var info = tgCall_(c.botToken, 'getWebhookInfo', {});
  var text = [
    'URL: ' + (info.url || '(미등록)'),
    '대기 중 업데이트: ' + (info.pending_update_count || 0),
    '최근 오류: ' + (info.last_error_message || '없음'),
    '최근 오류 시각: ' + (info.last_error_date
      ? Utilities.formatDate(new Date(info.last_error_date * 1000), 'Asia/Seoul', 'yyyy-MM-dd HH:mm')
      : '없음')
  ].join('\n');
  Logger.log(text);
  return text;
}

/** 웹훅 해제 — 명령 기능만 끄고 보고 전송은 유지함. */
function deleteWebhook() {
  var c = cfg_();
  tgCall_(c.botToken, 'deleteWebhook', { drop_pending_updates: 'true' });
  Logger.log('웹훅 해제함');
  return '웹훅 해제함';
}
