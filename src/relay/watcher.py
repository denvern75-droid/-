# -*- coding: utf-8 -*-
"""감시 폴더에서 '보낼 대상' 파일을 골라냄."""

from __future__ import annotations

import fnmatch
import time
from dataclasses import dataclass
from datetime import datetime, timedelta
from pathlib import Path

from .config import Config


@dataclass
class Candidate:
    path: Path
    size: int
    mtime: float

    @property
    def key(self) -> str:
        # 대소문자 무시(윈도우 파일시스템 기준)
        return str(self.path).lower()

    @property
    def mtime_text(self) -> str:
        return datetime.fromtimestamp(self.mtime).strftime("%Y-%m-%d %H:%M")


def _ignored(name: str, patterns: list[str]) -> bool:
    return any(fnmatch.fnmatch(name, pat) for pat in patterns)


def _is_stable(path: Path, checks: int, interval: float = 1.0) -> bool:
    """복사·저장이 진행 중인 파일을 거르기 위해 크기가 멈췄는지 확인함."""
    try:
        last = path.stat().st_size
    except OSError:
        return False
    for _ in range(max(checks - 1, 0)):
        time.sleep(interval)
        try:
            now = path.stat().st_size
        except OSError:
            return False
        if now != last:
            return False
        last = now
    return True


def collect(cfg: Config, *, since: datetime | None = None, check_stability: bool = True) -> list[Candidate]:
    """조건에 맞는 파일을 수정시각 오름차순으로 반환함.

    since 가 주어지면 그 시각 이후 수정된 파일만 고름(최초 실행 소급 범위 제한용).
    """
    cutoff = since.timestamp() if since else None
    found: list[Candidate] = []
    exts = set(cfg.extensions)

    for root in cfg.watch_paths:
        if not root.exists():
            continue
        walker = root.rglob("*") if cfg.recursive else root.glob("*")
        for item in walker:
            try:
                if not item.is_file():
                    continue
                if item.suffix.lower() not in exts:
                    continue
                if _ignored(item.name, cfg.ignore_patterns):
                    continue
                stat = item.stat()
                if stat.st_size < cfg.min_bytes:
                    continue
                if cutoff is not None and stat.st_mtime < cutoff:
                    continue
            except OSError:
                # 권한 없음·네트워크 드라이브 순단 → 다음 주기에 다시 시도함
                continue
            found.append(Candidate(path=item, size=stat.st_size, mtime=stat.st_mtime))

    found.sort(key=lambda c: c.mtime)
    if check_stability:
        found = [c for c in found if _is_stable(c.path, cfg.stable_checks)]
    return found


def backfill_since(cfg: Config) -> datetime | None:
    if cfg.backfill_hours <= 0:
        return datetime.now()
    return datetime.now() - timedelta(hours=cfg.backfill_hours)
