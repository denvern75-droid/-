# -*- coding: utf-8 -*-
"""업무보고 → 텔레그램 중계 진입점.

사용 예 (예약 작업·수동 실행 모두 run_relay.py 절대경로를 씀)
  python run_relay.py once   --config config.json            # 예약 작업용 1회 실행
  python run_relay.py once   --config config.json --dry-run  # 발송 없는 시험
  python run_relay.py watch  --config config.json            # 24시간 상주 감시
  python run_relay.py doctor --config config.json            # 장애 원인 진단
"""

from __future__ import annotations

import argparse
import logging
import logging.handlers
import sys
import time
from datetime import datetime
from pathlib import Path

from .config import Config, ConfigError, load_config
from .state import State, file_signature
from .telegram import TelegramClient, TelegramError
from .preview import extract_preview
from .watcher import Candidate, backfill_since, collect

LOG = logging.getLogger("relay")


def setup_logging(cfg: Config, verbose: bool = False) -> None:
    log_path = Path(cfg.log_path)
    log_path.parent.mkdir(parents=True, exist_ok=True)
    fmt = logging.Formatter("%(asctime)s [%(levelname)s] %(message)s", "%Y-%m-%d %H:%M:%S")

    file_handler = logging.handlers.RotatingFileHandler(
        log_path, maxBytes=cfg.log_max_bytes, backupCount=cfg.log_backup_count, encoding="utf-8"
    )
    file_handler.setFormatter(fmt)

    # pythonw.exe 로 실행되면 sys.stdout/stderr 가 None 이므로 스트림이 실재할 때만 붙임
    handlers: list[logging.Handler] = [file_handler]
    console = sys.stdout or sys.stderr
    if console is not None and (verbose or getattr(console, "isatty", lambda: False)()):
        stream = logging.StreamHandler(console)
        stream.setFormatter(fmt)
        handlers.append(stream)

    root = logging.getLogger()
    root.handlers.clear()
    for h in handlers:
        root.addHandler(h)
    root.setLevel(logging.DEBUG if verbose else logging.INFO)


def build_caption(c: Candidate, preview: str) -> str:
    head = f"📄 업무보고 도착\n파일: {c.path.name}\n수정: {c.mtime_text}\n크기: {c.size/1024:.0f} KB"
    if preview:
        head += "\n────────\n" + preview
    return head


def send_one(client: TelegramClient, cfg: Config, c: Candidate, *, dry_run: bool) -> bool:
    preview = extract_preview(c.path, cfg.preview_chars) if cfg.send_preview else ""
    caption = build_caption(c, preview)

    if dry_run:
        LOG.info("[시험] 발송 생략 — %s (%.0f KB)", c.path, c.size / 1024)
        return True

    try:
        if cfg.send_file and c.size <= cfg.max_attach_bytes:
            client.send_document(cfg.chat_id, c.path, caption=caption,
                                 thread_id=cfg.message_thread_id)
        else:
            note = ""
            if cfg.send_file:  # 첨부 대상이었으나 상한을 넘어 본문만 보내는 경우
                note = (f"\n⚠ 첨부 상한({cfg.max_attach_bytes/1024/1024:.0f}MB) 초과 — 본문만 전송함"
                        f"\n경로: {c.path}")
            client.send_message(cfg.chat_id, caption + note, thread_id=cfg.message_thread_id)
    except TelegramError as exc:
        LOG.error("전송 실패 — %s : %s", c.path.name, exc)
        return False
    LOG.info("전송 완료 — %s", c.path.name)
    return True


def heartbeat(client: TelegramClient, cfg: Config, state: State, *, dry_run: bool) -> None:
    """하루 1회 생존 신고. 무음 장애(아무 보고도 안 오는 상태)를 구분하기 위함."""
    if not cfg.heartbeat_enabled:
        return
    now = datetime.now()
    today = now.strftime("%Y-%m-%d")
    if state.last_heartbeat == today or now.hour < cfg.heartbeat_hour:
        return
    text = f"✅ 중계기 정상 가동 중 ({now:%Y-%m-%d %H:%M})\n감시: " + ", ".join(cfg.watch_dirs)
    if dry_run:
        # 시험 모드는 상태파일을 만들지 않음 — 만들면 다음 실제 실행이 '최초 실행'으로
        # 인식되지 않아 소급 전송(backfill_hours) 범위가 사라짐
        LOG.info("[시험] 생존 신고 생략")
        return
    try:
        client.send_message(cfg.chat_id, text, thread_id=cfg.message_thread_id)
    except TelegramError as exc:
        LOG.warning("생존 신고 실패: %s", exc)
        return
    state.last_heartbeat = today
    state.save()


def run_once(cfg: Config, *, dry_run: bool, ignore_state: bool = False) -> int:
    state = State(Path(cfg.state_path))
    client = TelegramClient(cfg.bot_token, timeout=cfg.timeout_seconds,
                            max_retries=cfg.max_retries, proxy_url=cfg.proxy_url)

    first_run = not Path(cfg.state_path).exists()
    since = backfill_since(cfg) if first_run else None
    candidates = collect(cfg, since=since)

    missing = [d for d in cfg.watch_dirs if not Path(d).exists()]
    for d in missing:
        LOG.error("감시 폴더 접근 불가 — %s (예약 작업 계정 권한/드라이브 매핑 확인 필요함)", d)

    sent = failed = skipped = 0
    for c in candidates:
        try:
            sig = file_signature(c.path)
        except OSError as exc:
            LOG.warning("서명 계산 실패 — %s : %s", c.path, exc)
            continue
        if not ignore_state and state.is_sent(c.key, sig):
            skipped += 1
            continue
        if send_one(client, cfg, c, dry_run=dry_run):
            sent += 1
            if not dry_run:
                state.mark_sent(c.key, sig)
                state.save()
        else:
            failed += 1

    heartbeat(client, cfg, state, dry_run=dry_run)
    LOG.info("실행 요약 — 대상 %d건 / 전송 %d / 중복생략 %d / 실패 %d%s",
             len(candidates), sent, skipped, failed, " (시험모드)" if dry_run else "")
    if missing:
        return 2
    return 1 if failed else 0


def run_watch(cfg: Config, *, dry_run: bool) -> int:
    LOG.info("상주 감시 시작 — 주기 %d초, 대상 %s", cfg.poll_seconds, ", ".join(cfg.watch_dirs))
    while True:
        try:
            run_once(cfg, dry_run=dry_run)
        except KeyboardInterrupt:
            LOG.info("사용자 중단")
            return 0
        except Exception:
            LOG.exception("주기 실행 중 예외 발생 — 다음 주기에 재시도함")
        time.sleep(cfg.poll_seconds)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="relay", description="업무보고 → 텔레그램 중계")
    parser.add_argument("mode", choices=["once", "watch", "doctor"], help="실행 모드")
    parser.add_argument("--config", "-c", default="config.json", help="설정 파일 경로")
    parser.add_argument("--dry-run", action="store_true", help="발송 없는 시험 실행")
    parser.add_argument("--resend", action="store_true", help="전송 이력을 무시하고 재전송함")
    parser.add_argument("--verbose", "-v", action="store_true", help="상세 로그")
    args = parser.parse_args(argv)

    try:
        cfg = load_config(args.config if Path(args.config).exists() else None)
    except ConfigError as exc:
        print(f"[설정 오류] {exc}", file=sys.stderr)
        return 3

    setup_logging(cfg, args.verbose)

    if args.mode == "doctor":
        from .doctor import run_doctor
        return run_doctor(cfg, config_path=args.config)

    errors = cfg.validate()
    if errors:
        for e in errors:
            LOG.error("설정 오류 — %s", e)
        LOG.error("doctor 모드로 원인을 확인하기 바람: python run_relay.py doctor -c %s", args.config)
        return 3

    if args.mode == "watch":
        return run_watch(cfg, dry_run=args.dry_run)
    return run_once(cfg, dry_run=args.dry_run, ignore_state=args.resend)


if __name__ == "__main__":
    raise SystemExit(main())
