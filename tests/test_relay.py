# -*- coding: utf-8 -*-
"""중계 로직 단위 시험 — 외부 네트워크 없이 검증함.

실행: python -m unittest discover -s tests -v
"""

import json
import sys
import tempfile
import unittest
from datetime import datetime, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))

from relay.config import Config, ConfigError, load_config  # noqa: E402
from relay.preview import extract_preview  # noqa: E402
from relay.state import State, file_signature  # noqa: E402
from relay.watcher import collect  # noqa: E402


class TempDirCase(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.tmp = Path(self._tmp.name)

    def tearDown(self):
        self._tmp.cleanup()

    def make(self, name: str, text: str = "보고 내용") -> Path:
        p = self.tmp / name
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(text, encoding="utf-8")
        return p


class ConfigTest(TempDirCase):
    def test_validate_reports_missing_values(self):
        errors = Config().validate()
        joined = " ".join(errors)
        self.assertIn("bot_token", joined)
        self.assertIn("chat_id", joined)
        self.assertIn("watch_dirs", joined)

    def test_validate_rejects_malformed_token(self):
        cfg = Config(bot_token="붙여넣기실패", chat_id="1", watch_dirs=["C:\\x"])
        self.assertTrue(any("형식 오류" in e for e in cfg.validate()))

    def test_validate_passes_on_well_formed_config(self):
        cfg = Config(bot_token="123456789:" + "A" * 35, chat_id="-1001234567890",
                     watch_dirs=[str(self.tmp)])
        self.assertEqual(cfg.validate(), [])

    def test_unknown_key_is_rejected_not_silently_ignored(self):
        p = self.tmp / "config.json"
        p.write_text(json.dumps({"chat_idd": "1"}), encoding="utf-8")
        with self.assertRaises(ConfigError):
            load_config(p)

    def test_extensions_are_normalised(self):
        p = self.tmp / "config.json"
        p.write_text(json.dumps({"extensions": ["HWPX", ".PDF"]}), encoding="utf-8")
        self.assertEqual(load_config(p).extensions, [".hwpx", ".pdf"])

    def test_bom_prefixed_config_is_readable(self):
        # 메모장으로 저장하면 UTF-8 BOM 이 붙음 — 이 때문에 파싱 실패하는 사례가 잦음
        p = self.tmp / "config.json"
        p.write_bytes(b"\xef\xbb\xbf" + json.dumps({"chat_id": "7"}).encode("utf-8"))
        self.assertEqual(load_config(p).chat_id, "7")


class WatcherTest(TempDirCase):
    def cfg(self, **kw) -> Config:
        base = dict(bot_token="1:" + "A" * 35, chat_id="1", watch_dirs=[str(self.tmp)],
                    extensions=[".txt", ".hwpx"], stable_checks=1)
        base.update(kw)
        return Config(**base)

    def test_picks_only_configured_extensions(self):
        self.make("보고서.txt")
        self.make("사진.png")
        found = [c.path.name for c in collect(self.cfg(), check_stability=False)]
        self.assertEqual(found, ["보고서.txt"])

    def test_skips_office_lock_files(self):
        self.make("~$보고서.txt")
        self.make("정상보고.txt")
        found = [c.path.name for c in collect(self.cfg(), check_stability=False)]
        self.assertEqual(found, ["정상보고.txt"])

    def test_skips_empty_files(self):
        (self.tmp / "빈파일.txt").write_bytes(b"")
        self.assertEqual(collect(self.cfg(), check_stability=False), [])

    def test_since_filter_excludes_old_files(self):
        old = self.make("작년보고.txt")
        import os
        stale = (datetime.now() - timedelta(days=400)).timestamp()
        os.utime(old, (stale, stale))
        self.make("오늘보고.txt")
        since = datetime.now() - timedelta(hours=24)
        found = [c.path.name for c in collect(self.cfg(), since=since, check_stability=False)]
        self.assertEqual(found, ["오늘보고.txt"])

    def test_recursive_off_ignores_subfolders(self):
        self.make("하위/깊은보고.txt")
        self.make("표층보고.txt")
        found = [c.path.name for c in collect(self.cfg(recursive=False), check_stability=False)]
        self.assertEqual(found, ["표층보고.txt"])

    def test_results_sorted_by_mtime(self):
        import os
        a = self.make("a.txt")
        b = self.make("b.txt")
        os.utime(a, (2_000_000_000, 2_000_000_000))
        os.utime(b, (1_000_000_000, 1_000_000_000))
        found = [c.path.name for c in collect(self.cfg(), check_stability=False)]
        self.assertEqual(found, ["b.txt", "a.txt"])


class StateTest(TempDirCase):
    def test_marks_and_detects_duplicates(self):
        f = self.make("보고.txt")
        st = State(self.tmp / "state" / "state.json")
        sig = file_signature(f)
        self.assertFalse(st.is_sent(str(f).lower(), sig))
        st.mark_sent(str(f).lower(), sig)
        st.save()
        self.assertTrue(State(self.tmp / "state" / "state.json").is_sent(str(f).lower(), sig))

    def test_modified_file_gets_resent(self):
        f = self.make("보고.txt")
        st = State(self.tmp / "state.json")
        st.mark_sent(str(f).lower(), file_signature(f))
        f.write_text("내용이 바뀜 — 다시 보내야 함", encoding="utf-8")
        self.assertFalse(st.is_sent(str(f).lower(), file_signature(f)))

    def test_corrupt_state_file_does_not_crash(self):
        p = self.tmp / "state.json"
        p.write_text("{망가진 JSON", encoding="utf-8")
        st = State(p)
        self.assertEqual(st.data["sent"], {})
        self.assertTrue((self.tmp / "state.corrupt").exists())


class PreviewTest(TempDirCase):
    def test_utf8_text_preview(self):
        f = self.make("보고.txt", "1. 금일 실적\n2. 익일 계획")
        self.assertIn("금일 실적", extract_preview(f, 200))

    def test_cp949_text_preview(self):
        f = self.tmp / "구형보고.txt"
        f.write_bytes("한글 인코딩 시험".encode("cp949"))
        self.assertIn("한글 인코딩 시험", extract_preview(f, 200))

    def test_preview_respects_limit(self):
        f = self.make("긴보고.txt", "가" * 5000)
        self.assertLessEqual(len(extract_preview(f, 100)), 100)

    def test_unknown_extension_returns_empty(self):
        f = self.make("사진.png", "x")
        self.assertEqual(extract_preview(f, 100), "")

    def test_hwpx_preview_from_zip(self):
        import zipfile
        f = self.tmp / "보고.hwpx"
        with zipfile.ZipFile(f, "w") as zf:
            zf.writestr("Contents/section0.xml",
                        "<hp:p><hp:t>주간 업무보고</hp:t></hp:p>")
        self.assertIn("주간 업무보고", extract_preview(f, 200))

    def test_broken_file_returns_empty_instead_of_raising(self):
        f = self.tmp / "손상.hwpx"
        f.write_bytes(b"not a zip")
        self.assertEqual(extract_preview(f, 100), "")


class TelegramPayloadTest(unittest.TestCase):
    def test_message_is_truncated_to_api_limit(self):
        from relay.telegram import MESSAGE_LIMIT
        self.assertLessEqual(MESSAGE_LIMIT, 4096)

    def test_fatal_errors_are_not_retried(self):
        from relay.telegram import TelegramError
        self.assertTrue(TelegramError("x", status=401).is_fatal)
        self.assertFalse(TelegramError("x", status=500).is_fatal)


if __name__ == "__main__":
    unittest.main(verbosity=2)


# ──────────────────────────────────────────────────────────────────────
# 회귀 시험 — 아래는 실제로 발견된 결함이며, 재발을 막기 위해 고정함
# ──────────────────────────────────────────────────────────────────────

class RegressionTest(TempDirCase):
    """진단에서 확인된 결함 5건의 재발 방지."""

    def test_example_config_loads_as_documented(self):
        """결함1: README 의 'config.example.json 을 복사해 쓰라'는 절차가 즉시 실패했음.

        JSON 에 주석 문법이 없어 예시 파일이 "_주의" 같은 설명 키를 쓰는데,
        설정 로더가 이를 오탈자로 보고 거부했음.
        """
        example = Path(__file__).resolve().parent.parent / "config.example.json"
        target = self.tmp / "config.json"
        target.write_text(example.read_text(encoding="utf-8"), encoding="utf-8")
        cfg = load_config(target)          # 여기서 ConfigError 가 나면 안 됨
        self.assertEqual(cfg.chat_id, "123456789")
        self.assertIn(".hwpx", cfg.extensions)

    def test_gdrive_example_config_loads_too(self):
        example = Path(__file__).resolve().parent.parent / "config.gdrive.example.json"
        target = self.tmp / "config.gdrive.json"
        target.write_text(example.read_text(encoding="utf-8"), encoding="utf-8")
        self.assertTrue(load_config(target).watch_dirs)

    def test_typo_key_is_still_rejected(self):
        """주석 키를 허용하되, 밑줄 없는 오탈자는 계속 잡아야 함."""
        p = self.tmp / "config.json"
        p.write_text(json.dumps({"_메모": "설명", "chat_idd": "1"}), encoding="utf-8")
        with self.assertRaises(ConfigError):
            load_config(p)

    def test_stability_check_does_not_scale_with_file_count(self):
        """결함2: 안정성 검사가 파일마다 1초씩 재워, 300건이면 300초가 걸렸음."""
        import time as _time
        from relay.watcher import _filter_stable
        for i in range(120):
            self.make(f"보고{i:03}.txt", "내용")
        cfg = Config(bot_token="1:" + "A" * 35, chat_id="1", watch_dirs=[str(self.tmp)],
                     extensions=[".txt"], stable_checks=3)
        items = collect(cfg, check_stability=False)
        self.assertEqual(len(items), 120)

        started = _time.time()
        survivors = _filter_stable(items, cfg.stable_checks, interval=0.05)
        elapsed = _time.time() - started

        self.assertEqual(len(survivors), 120)
        # 건별로 재웠다면 120 × 2 × 0.05 = 12초. 일괄 처리면 0.1초대여야 함.
        self.assertLess(elapsed, 1.0, f"안정성 검사에 {elapsed:.1f}초 소요 — 파일 수에 비례하고 있음")

    def test_growing_file_is_excluded(self):
        """일괄 처리로 바꾼 뒤에도 '아직 쓰는 중인 파일' 제외 기능이 살아 있어야 함."""
        import threading
        from relay.watcher import _filter_stable
        done = self.make("완료.txt", "다 씀")
        growing = self.make("복사중.txt", "시작")
        cfg = Config(bot_token="1:" + "A" * 35, chat_id="1", watch_dirs=[str(self.tmp)],
                     extensions=[".txt"], stable_checks=2)
        items = collect(cfg, check_stability=False)

        stop = threading.Event()

        def grow():
            while not stop.is_set():
                with growing.open("a", encoding="utf-8") as fh:
                    fh.write("더 씀")
                stop.wait(0.01)

        worker = threading.Thread(target=grow, daemon=True)
        worker.start()
        try:
            survivors = _filter_stable(items, 2, interval=0.3)
        finally:
            stop.set()
            worker.join(timeout=1)

        names = [c.path.name for c in survivors]
        self.assertIn(done.name, names)
        self.assertNotIn(growing.name, names, "쓰는 중인 파일이 전송 대상에 들어감")


class WatermarkTest(TempDirCase):
    """결함3: 전송 실패 파일이 다음 주기에 재시도되지 않고 영영 누락됐음."""

    def cfg(self):
        return Config(bot_token="1:" + "A" * 35, chat_id="1", watch_dirs=[str(self.tmp)],
                      extensions=[".txt"], stable_checks=1,
                      state_path=str(self.tmp / "state.json"),
                      log_path=str(self.tmp / "log.txt"),
                      heartbeat_enabled=False, backfill_hours=24)

    def run_with(self, cfg, outcomes):
        """outcomes: 파일명 → 전송 성공 여부. 실제 텔레그램 호출은 하지 않음."""
        from relay import main as m
        attempted = []

        def fake_send(client, config, cand, *, dry_run):
            attempted.append(cand.path.name)
            return outcomes.get(cand.path.name, True)

        original = m.send_one
        m.send_one = fake_send
        try:
            m.run_once(cfg, dry_run=False)
        finally:
            m.send_one = original
        return attempted

    def test_failed_file_is_retried_next_run(self):
        self.make("성공.txt", "본문")
        self.make("실패.txt", "본문")
        cfg = self.cfg()

        first = self.run_with(cfg, {"실패.txt": False})
        self.assertIn("실패.txt", first)
        self.assertIn("성공.txt", first)

        second = self.run_with(cfg, {})   # 이번에는 모두 성공한다고 가정
        self.assertIn("실패.txt", second, "실패한 파일이 재시도되지 않고 누락됨")

    def test_succeeded_file_is_not_resent(self):
        self.make("보고.txt", "본문")
        cfg = self.cfg()
        self.run_with(cfg, {})
        second = self.run_with(cfg, {})
        self.assertEqual(second, [], "이미 보낸 파일이 다시 전송됨")

    def test_watermark_advances_when_all_succeed(self):
        self.make("보고.txt", "본문")
        cfg = self.cfg()
        self.run_with(cfg, {})
        self.assertIsNotNone(State(Path(cfg.state_path)).watermark)

    def test_watermark_held_back_by_failure(self):
        import time as _time
        old = self.make("먼저.txt", "본문")
        import os
        stale = _time.time() - 3600
        os.utime(old, (stale, stale))
        self.make("나중.txt", "본문")
        cfg = self.cfg()

        self.run_with(cfg, {"먼저.txt": False})
        wm = State(Path(cfg.state_path)).watermark
        self.assertIsNotNone(wm)
        self.assertLessEqual(wm, stale + 1,
                             "실패한 파일보다 기준 시각이 앞서 나가 재조회 범위에서 빠짐")


class TaskCommandTest(unittest.TestCase):
    """결함5: 예약 작업 판정식이 조건을 제대로 가리지 못했음.

    실제 장애 사례를 그대로 넣어 판정이 맞는지 고정함.
    """

    def classify(self, command):
        from relay.doctor import classify_task_command
        return classify_task_command(command)[0]

    def test_bare_name_is_failure(self):
        """이번 장애의 원인 유형 — 예약 작업 세션에는 PATH 가 없음."""
        from relay.doctor import FAIL
        self.assertEqual(self.classify('python C:\\Hermes\\relay.py'), FAIL)
        self.assertEqual(self.classify('pythonw run.py --config c.json'), FAIL)

    def test_store_stub_is_failure(self):
        from relay.doctor import FAIL
        stub = r'"C:\Users\SAMSUNG\AppData\Local\Microsoft\WindowsApps\python.exe" relay.py'
        self.assertEqual(self.classify(stub), FAIL)

    def test_absolute_path_is_ok(self):
        from relay.doctor import OK
        good = r'"C:\Users\SAMSUNG\AppData\Local\Programs\Python\Python312\pythonw.exe" "C:\Hermes\run_relay.py" once'
        self.assertEqual(self.classify(good), OK)

    def test_absolute_path_without_quotes_is_ok(self):
        from relay.doctor import OK
        self.assertEqual(self.classify(r'C:\Python312\python.exe C:\Hermes\run.py'), OK)

    def test_non_python_action_is_left_alone(self):
        from relay.doctor import OK
        self.assertEqual(self.classify(r'C:\Windows\System32\cmd.exe /c echo hi'), OK)

    def test_empty_command_is_warning_not_crash(self):
        from relay.doctor import WARN
        self.assertEqual(self.classify(''), WARN)
        self.assertEqual(self.classify(None), WARN)
