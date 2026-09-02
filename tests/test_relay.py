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
