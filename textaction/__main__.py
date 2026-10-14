"""실행 진입점.

  python -m textaction                       → 상주 모드(단축키)
  python -m textaction --action gaejosik --text "..."   → 명령줄 1회 실행(점검용)
  python -m textaction --list                → 액션 목록 출력
"""
import argparse
import sys

from .actions import ACTIONS, ACTIONS_BY_KEY


def main() -> None:
    parser = argparse.ArgumentParser(prog="textaction")
    parser.add_argument("--action", choices=sorted(ACTIONS_BY_KEY))
    parser.add_argument("--text", help="생략 시 표준입력에서 읽음")
    parser.add_argument("--list", action="store_true")
    args = parser.parse_args()

    if args.list:
        for a in ACTIONS:
            print(f"{a.key:10s} {a.label}")
        return

    if args.action:
        from .claude_client import ActionError, run_action

        text = args.text if args.text is not None else sys.stdin.read()
        try:
            print(run_action(ACTIONS_BY_KEY[args.action], text))
        except ActionError as e:
            sys.exit(f"[오류] {e}")
        return

    from .app import main as gui_main

    gui_main()


if __name__ == "__main__":
    main()
