# -*- coding: utf-8 -*-
"""장애 원인 진단 — '텔레그램으로 아무것도 안 온다'의 원인을 계층별로 좁힘.

점검 순서(위에서 실패하면 아래는 볼 필요 없음)
  1) 실행 환경(Python 경로·계정·작업 디렉터리)   ← 예약 작업 실패의 최다 원인
  2) 설정값
  3) 감시 폴더 접근성                             ← 예약 작업 계정에서 OneDrive/매핑드라이브 안 보이는 문제
  4) 쓰기 권한(상태·로그)
  5) 네트워크 도달
  6) 봇 인증(getMe)
  7) 대화방(chat_id) 유효성
  8) 예약 작업 등록 상태(Windows)
"""

from __future__ import annotations

import os
import socket
import subprocess
import sys
import tempfile
from pathlib import Path

from .config import Config
from .telegram import TelegramClient, TelegramError
from .watcher import collect

OK, WARN, FAIL = "[정상]", "[주의]", "[실패]"
TASK_NAMES = ("HermesDailyReportRelay", "HermesDailyReportRelayLogon")


class Report:
    def __init__(self) -> None:
        self.lines: list[str] = []
        self.failures = 0
        self.warnings = 0

    def add(self, level: str, title: str, detail: str = "") -> None:
        if level == FAIL:
            self.failures += 1
        elif level == WARN:
            self.warnings += 1
        self.lines.append(f"{level} {title}" + (f"\n        └ {detail}" if detail else ""))

    def section(self, name: str) -> None:
        self.lines.append(f"\n■ {name}")

    def render(self) -> str:
        head = "=" * 64 + "\n업무보고 텔레그램 중계 — 진단 결과\n" + "=" * 64
        tail = f"\n{'=' * 64}\n요약: 실패 {self.failures}건 / 주의 {self.warnings}건"
        return head + "\n".join(self.lines) + tail


# ----------------------------------------------------------------- 개별 점검
def check_runtime(rep: Report) -> None:
    rep.section("1. 실행 환경")
    exe = Path(sys.executable) if sys.executable else None
    if not exe:
        rep.add(FAIL, "Python 실행 파일 경로 확인 불가")
        return

    rep.add(OK, f"Python {sys.version.split()[0]}", f"경로: {exe}")

    # Microsoft Store 스텁(0바이트 리파스 포인트)은 예약 작업에서 실행되지 않음
    lowered = str(exe).lower()
    if "windowsapps" in lowered:
        rep.add(
            FAIL,
            "Microsoft Store 스텁 Python 사용 중",
            "예약 작업에서 실행되지 않음. python.org 정식 설치본의 절대경로로 재등록 필요함",
        )
    elif "\\venv\\" in lowered or "\\.venv\\" in lowered:
        rep.add(OK, "가상환경 Python 사용 중", "예약 작업에도 이 절대경로를 그대로 지정해야 함")

    rep.add(OK, f"실행 계정: {os.environ.get('USERNAME') or os.environ.get('USER', '미상')}")
    rep.add(OK, f"작업 디렉터리: {Path.cwd()}")

    # 예약 작업은 대화형 세션이 아니므로 사용자 환경변수가 비어 있을 수 있음
    if os.name == "nt" and not os.environ.get("OneDrive"):
        rep.add(WARN, "환경변수 OneDrive 없음",
                "설정에 %OneDrive% 대신 절대경로(C:\\Users\\...\\OneDrive\\...)를 써야 함")


def check_config(rep: Report, cfg: Config, config_path: str) -> None:
    rep.section("2. 설정값")
    p = Path(config_path)
    rep.add(OK if p.exists() else WARN,
            f"설정 파일: {p.resolve() if p.exists() else str(p) + ' (없음 — 환경변수만 사용)'}")
    for err in cfg.validate():
        rep.add(FAIL, err)
    if cfg.bot_token:
        rep.add(OK, "bot_token 형식 확인", f"봇 ID {cfg.bot_token.split(':')[0]}")
    if cfg.chat_id:
        rep.add(OK, f"chat_id: {cfg.chat_id}")
    if cfg.proxy_url:
        rep.add(OK, f"프록시 지정됨: {cfg.proxy_url}")


def check_watch_dirs(rep: Report, cfg: Config) -> None:
    rep.section("3. 감시 폴더 접근성")
    if not cfg.watch_dirs:
        rep.add(FAIL, "감시 폴더 미지정")
        return
    for raw in cfg.watch_dirs:
        path = Path(raw)
        if not path.exists():
            hint = "매핑 드라이브(Z: 등)는 예약 작업 세션에 없음 → UNC 경로(\\\\PC명\\공유폴더) 사용 필요함" \
                if len(raw) > 1 and raw[1] == ":" and not raw.lower().startswith("c:") else \
                "경로 오타 또는 계정 권한 확인 필요함"
            rep.add(FAIL, f"접근 불가: {raw}", hint)
            continue
        try:
            total = sum(1 for _ in path.rglob("*"))
        except OSError as exc:
            rep.add(FAIL, f"열람 실패: {raw}", str(exc))
            continue
        rep.add(OK, f"접근 가능: {raw}", f"하위 항목 {total}개")

    hits = collect(cfg, check_stability=False)
    rep.add(OK if hits else WARN, f"조건에 맞는 보고 파일 {len(hits)}건",
            "확장자 필터(extensions) 또는 보고서 저장 위치 확인 필요함" if not hits
            else "최근: " + ", ".join(c.path.name for c in hits[-3:]))


def check_writable(rep: Report, cfg: Config) -> None:
    rep.section("4. 쓰기 권한")
    for label, target in (("상태파일", Path(cfg.state_path)), ("로그파일", Path(cfg.log_path))):
        parent = target.parent if str(target.parent) else Path(".")
        try:
            parent.mkdir(parents=True, exist_ok=True)
            fd, tmp = tempfile.mkstemp(dir=str(parent))
            os.close(fd)
            os.unlink(tmp)
            rep.add(OK, f"{label} 디렉터리 쓰기 가능", str(parent.resolve()))
        except OSError as exc:
            rep.add(FAIL, f"{label} 디렉터리 쓰기 불가: {parent}", str(exc))


def check_network(rep: Report, cfg: Config) -> None:
    rep.section("5. 네트워크 도달")
    if cfg.proxy_url:
        rep.add(WARN, "프록시 사용 중 — 직접 연결 시험은 건너뜀")
        return
    try:
        with socket.create_connection(("api.telegram.org", 443), timeout=10):
            rep.add(OK, "api.telegram.org:443 연결 성공")
    except OSError as exc:
        rep.add(FAIL, "api.telegram.org:443 연결 실패",
                f"{exc} — 사내 방화벽 차단 또는 프록시 설정(proxy_url) 필요함")


def check_bot(rep: Report, cfg: Config) -> TelegramClient | None:
    rep.section("6. 봇 인증")
    if not cfg.bot_token:
        rep.add(FAIL, "bot_token 없음 — 이후 점검 생략")
        return None
    client = TelegramClient(cfg.bot_token, timeout=cfg.timeout_seconds,
                            max_retries=2, proxy_url=cfg.proxy_url)
    try:
        me = client.get_me()
    except TelegramError as exc:
        rep.add(FAIL, "getMe 실패", f"{exc} — 토큰 오타·재발급 여부 확인 필요함")
        return None
    rep.add(OK, f"봇 확인: @{me.get('username')} ({me.get('first_name')})")
    return client


def check_chat(rep: Report, cfg: Config, client: TelegramClient | None) -> None:
    rep.section("7. 대화방(chat_id)")
    if client is None:
        rep.add(WARN, "봇 인증 실패로 점검 생략")
        return
    try:
        updates = client.get_updates(limit=30)
    except TelegramError as exc:
        rep.add(WARN, "getUpdates 실패", str(exc))
        updates = []

    seen: dict[str, str] = {}
    for u in updates or []:
        msg = u.get("message") or u.get("channel_post") or u.get("my_chat_member") or {}
        chat = msg.get("chat") or {}
        if chat.get("id") is not None:
            seen[str(chat["id"])] = f"{chat.get('type')} / {chat.get('title') or chat.get('username') or chat.get('first_name', '')}"

    if seen:
        rep.add(OK, "최근 대화방 후보", "; ".join(f"{k} → {v}" for k, v in seen.items()))
    else:
        rep.add(WARN, "최근 대화 이력 없음",
                "봇에게 /start 를 1회 보내야 chat_id 조회·발송이 가능함(봇은 먼저 말 걸 수 없음)")

    if cfg.chat_id and seen and cfg.chat_id not in seen:
        rep.add(WARN, f"설정된 chat_id({cfg.chat_id})가 최근 이력에 없음",
                "오래된 대화면 정상일 수 있으나, 그룹 → 슈퍼그룹 전환 시 ID가 -100... 형태로 바뀌므로 확인 필요함")


def check_scheduled_tasks(rep: Report) -> None:
    rep.section("8. 예약 작업 등록 상태(Windows)")
    if os.name != "nt":
        rep.add(WARN, "Windows 환경이 아니므로 점검 생략")
        return
    for name in TASK_NAMES:
        try:
            out = subprocess.run(
                ["schtasks", "/Query", "/TN", name, "/V", "/FO", "LIST"],
                capture_output=True, timeout=20,
            )
        except (OSError, subprocess.TimeoutExpired) as exc:
            rep.add(WARN, f"{name} 조회 실패", str(exc))
            continue
        if out.returncode != 0:
            rep.add(WARN, f"{name} 미등록")
            continue
        text = out.stdout.decode("cp949", "replace")
        stub = "WindowsApps" in text
        bare = any(line.strip().endswith(("python.exe", "pythonw.exe", "python", "py.exe"))
                   and ":" not in line.split(":", 1)[-1][:3] for line in text.splitlines())
        detail = []
        for line in text.splitlines():
            if "실행할 작업" in line or "Task To Run" in line:
                detail.append(line.split(":", 1)[-1].strip())
        rep.add(FAIL if (stub or bare) else OK, f"{name} 등록됨",
                (detail[0] if detail else "") +
                ("  ← Store 스텁 Python 사용(실행 안 됨)" if stub else ""))


def run_doctor(cfg: Config, *, config_path: str = "config.json") -> int:
    rep = Report()
    check_runtime(rep)
    check_config(rep, cfg, config_path)
    check_watch_dirs(rep, cfg)
    check_writable(rep, cfg)
    check_network(rep, cfg)
    client = check_bot(rep, cfg)
    check_chat(rep, cfg, client)
    check_scheduled_tasks(rep)

    text = rep.render()
    print(text)
    try:
        out = Path(cfg.log_path).parent / "doctor-report.txt"
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(text, encoding="utf-8")
        print(f"\n진단 결과 저장: {out.resolve()}")
    except OSError:
        pass
    return 1 if rep.failures else 0
