#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""예약 작업용 진입 스크립트.

예약 작업 세션에는 사용자 PYTHONPATH 가 없으므로 여기서 src 경로를 직접 붙임.
Task Scheduler 에는 항상 이 파일의 '절대경로'를 지정할 것.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent / "src"))

from relay.main import main  # noqa: E402

if __name__ == "__main__":
    raise SystemExit(main())
