# -*- coding: utf-8 -*-
"""전송 이력 상태 저장.

중복 전송 방지 키 = 파일경로 + 크기 + 수정시각(+ 내용 해시).
원자적 쓰기(임시파일 → os.replace)로 중단 시 상태파일 파손을 막음.
"""

from __future__ import annotations

import hashlib
import json
import os
import tempfile
from pathlib import Path
from typing import Any

STATE_VERSION = 1
MAX_ENTRIES = 20000  # 무한 증가 방지


def file_signature(path: Path, *, hash_bytes: int = 1024 * 1024) -> str:
    """파일 앞부분 해시 + 크기 + mtime 으로 서명을 만듦.

    전체 해시는 대용량 파일에서 느리므로 앞 1MB만 사용함.
    크기·mtime이 함께 들어가므로 실무상 충돌 위험은 무시 가능함.
    """
    stat = path.stat()
    digest = hashlib.sha256()
    with path.open("rb") as fh:
        digest.update(fh.read(hash_bytes))
    return f"{stat.st_size}-{int(stat.st_mtime)}-{digest.hexdigest()[:16]}"


class State:
    def __init__(self, path: Path):
        self.path = path
        self.data: dict[str, Any] = {
            "version": STATE_VERSION, "sent": {}, "last_heartbeat": "", "watermark": None,
        }
        self._load()

    def _load(self) -> None:
        if not self.path.exists():
            return
        try:
            raw = json.loads(self.path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            # 손상된 상태파일은 백업 후 초기화함(중계가 멈추는 것보다 재전송이 나음)
            try:
                self.path.replace(self.path.with_suffix(".corrupt"))
            except OSError:
                pass
            return
        if isinstance(raw, dict) and raw.get("version") == STATE_VERSION:
            self.data = raw
            self.data.setdefault("sent", {})
            self.data.setdefault("last_heartbeat", "")
            self.data.setdefault("watermark", None)

    def is_sent(self, key: str, signature: str) -> bool:
        return self.data["sent"].get(key) == signature

    def mark_sent(self, key: str, signature: str) -> None:
        self.data["sent"][key] = signature
        if len(self.data["sent"]) > MAX_ENTRIES:
            # 오래된 것부터 정리(dict 삽입 순서 활용)
            for old in list(self.data["sent"])[: len(self.data["sent"]) - MAX_ENTRIES]:
                del self.data["sent"][old]

    @property
    def watermark(self) -> float | None:
        """여기까지는 처리 완료했다는 기준 시각(epoch 초). None 이면 최초 실행임."""
        value = self.data.get("watermark")
        return float(value) if value is not None else None

    @watermark.setter
    def watermark(self, value: float | None) -> None:
        self.data["watermark"] = value

    @property
    def last_heartbeat(self) -> str:
        return self.data.get("last_heartbeat", "")

    @last_heartbeat.setter
    def last_heartbeat(self, value: str) -> None:
        self.data["last_heartbeat"] = value

    def save(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=str(self.path.parent), prefix=".state-", suffix=".tmp")
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as fh:
                json.dump(self.data, fh, ensure_ascii=False, indent=1)
            os.replace(tmp, self.path)
        except BaseException:
            try:
                os.unlink(tmp)
            except OSError:
                pass
            raise
