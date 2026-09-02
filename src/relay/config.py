# -*- coding: utf-8 -*-
"""설정 로딩·검증 모듈.

우선순위: 환경변수 > config.json > 기본값
비밀값(BOT_TOKEN)은 config.json 대신 환경변수 사용을 권장함.
"""

from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

# 텔레그램 봇 API 단일 파일 업로드 상한(문서 기준 50MB)
TELEGRAM_MAX_UPLOAD_BYTES = 50 * 1024 * 1024

DEFAULT_EXTENSIONS = [
    ".hwp", ".hwpx", ".doc", ".docx", ".xls", ".xlsx", ".xlsm",
    ".ppt", ".pptx", ".pdf", ".txt", ".csv", ".md",
]

TOKEN_RE = re.compile(r"^\d{6,}:[A-Za-z0-9_\-]{30,}$")


class ConfigError(ValueError):
    """설정값이 비었거나 형식이 어긋날 때 발생함."""


@dataclass
class Config:
    # --- 텔레그램 ---
    bot_token: str = ""
    chat_id: str = ""
    message_thread_id: int | None = None      # 그룹 토픽(스레드) 지정 시
    send_file: bool = True                    # 원본 파일 첨부 여부
    send_preview: bool = True                 # 본문 미리보기 텍스트 동봉 여부
    preview_chars: int = 700

    # --- 감시 대상(윈드라이브 = 사무실 데스크탑 공유 네트워크 드라이브) ---
    watch_dirs: list[str] = field(default_factory=list)
    recursive: bool = True
    extensions: list[str] = field(default_factory=lambda: list(DEFAULT_EXTENSIONS))
    ignore_patterns: list[str] = field(
        default_factory=lambda: ["~$*", ".~*", "*.tmp", "*.crdownload", "*.part", "Thumbs.db"]
    )
    min_bytes: int = 1                        # 0바이트 파일 제외
    max_attach_bytes: int = TELEGRAM_MAX_UPLOAD_BYTES

    # --- 동작 ---
    poll_seconds: int = 60
    stable_checks: int = 2                    # 복사 중 파일 방지: 크기 동일 확인 횟수
    backfill_hours: int = 24                  # 최초 실행 시 소급 전송 범위(0=소급 없음)
    state_path: str = "state/state.json"
    log_path: str = "logs/relay.log"
    log_max_bytes: int = 2 * 1024 * 1024
    log_backup_count: int = 5

    # --- 생존 신고(무음 장애 탐지) ---
    heartbeat_hour: int = 9                   # 매일 09시 KST 기준 1회
    heartbeat_enabled: bool = True

    # --- 네트워크 ---
    timeout_seconds: int = 60
    max_retries: int = 5
    proxy_url: str = ""                       # 사내망에서 프록시 필요 시

    @property
    def watch_paths(self) -> list[Path]:
        return [Path(d) for d in self.watch_dirs]

    def validate(self) -> list[str]:
        """치명 오류 목록을 반환함. 빈 리스트면 정상임."""
        errors: list[str] = []
        if not self.bot_token:
            errors.append("bot_token 없음 — 환경변수 TELEGRAM_BOT_TOKEN 또는 config.json 설정 필요함")
        elif not TOKEN_RE.match(self.bot_token):
            errors.append("bot_token 형식 오류 — '숫자:영문자열' 형태여야 함(앞뒤 공백·따옴표 혼입 확인)")
        if not self.chat_id:
            errors.append("chat_id 없음 — doctor 명령으로 조회 가능함")
        if not self.watch_dirs:
            errors.append("watch_dirs 없음 — 감시할 폴더(윈드라이브 경로) 1개 이상 필요함")
        if self.poll_seconds < 5:
            errors.append("poll_seconds 는 5 이상이어야 함")
        if self.stable_checks < 1:
            errors.append("stable_checks 는 1 이상이어야 함")
        if self.max_attach_bytes > TELEGRAM_MAX_UPLOAD_BYTES:
            errors.append(
                f"max_attach_bytes 는 {TELEGRAM_MAX_UPLOAD_BYTES} 이하여야 함(텔레그램 봇 업로드 상한)"
            )
        return errors


def _coerce(raw: dict[str, Any]) -> dict[str, Any]:
    """config.json 의 알려진 키만 통과시킴(오탈자 키는 무시하지 않고 알림)."""
    known = {f for f in Config.__dataclass_fields__}
    unknown = sorted(set(raw) - known)
    if unknown:
        raise ConfigError("설정 파일에 알 수 없는 키 있음: " + ", ".join(unknown))
    return {k: v for k, v in raw.items() if k in known}


def _env_override(cfg: Config) -> Config:
    env = os.environ
    if env.get("TELEGRAM_BOT_TOKEN"):
        cfg.bot_token = env["TELEGRAM_BOT_TOKEN"].strip().strip('"').strip("'")
    if env.get("TELEGRAM_CHAT_ID"):
        cfg.chat_id = env["TELEGRAM_CHAT_ID"].strip()
    if env.get("RELAY_WATCH_DIRS"):
        # 세미콜론 구분(윈도우 경로에 콜론이 들어가므로 ';' 사용)
        cfg.watch_dirs = [p for p in env["RELAY_WATCH_DIRS"].split(";") if p.strip()]
    if env.get("RELAY_PROXY_URL"):
        cfg.proxy_url = env["RELAY_PROXY_URL"].strip()
    return cfg


def load_config(path: str | os.PathLike[str] | None = None) -> Config:
    cfg = Config()
    if path:
        p = Path(path)
        if not p.exists():
            raise ConfigError(f"설정 파일 없음: {p}")
        try:
            raw = json.loads(p.read_text(encoding="utf-8-sig"))
        except json.JSONDecodeError as exc:
            raise ConfigError(f"설정 파일 JSON 오류: {p} — {exc}") from exc
        if not isinstance(raw, dict):
            raise ConfigError("설정 파일 최상위는 객체(JSON object)여야 함")
        cfg = Config(**_coerce(raw))
    cfg = _env_override(cfg)
    cfg.extensions = [e.lower() if e.startswith(".") else "." + e.lower() for e in cfg.extensions]
    return cfg
