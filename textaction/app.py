"""윈도우용 텍스트 액션 상주 프로그램 (맥 PopClip 방식).

사용법: 아무 프로그램(한글·워드·브라우저)에서 텍스트 드래그 → Ctrl+Alt+Space
       → 메뉴에서 숫자키(1~6) 선택 → 결과 창에서 [붙여넣기] 또는 [복사]
"""
import threading
import time
import tkinter as tk
from tkinter import ttk

import keyboard
import pyperclip

from .actions import ACTIONS
from .claude_client import ActionError, run_action

HOTKEY = "ctrl+alt+space"
FONT = ("맑은 고딕", 11)


def grab_selection() -> str:
    """현재 선택된 텍스트를 클립보드 경유로 가져옴 (기존 클립보드는 복원)."""
    previous = pyperclip.paste()
    pyperclip.copy("")
    keyboard.send("ctrl+c")
    time.sleep(0.15)
    selected = pyperclip.paste()
    pyperclip.copy(previous)
    return selected


class TextActionApp:
    def __init__(self) -> None:
        self.root = tk.Tk()
        self.root.withdraw()
        self.root.title("텍스트 액션")

    # ── 메뉴 ──────────────────────────────────────────
    def show_menu(self, text: str) -> None:
        win = tk.Toplevel(self.root)
        win.title("텍스트 액션 — 작업 선택")
        win.attributes("-topmost", True)
        x, y = win.winfo_pointerxy()
        win.geometry(f"+{x}+{y}")

        ttk.Label(win, text=f"선택 텍스트 {len(text)}자", font=FONT).pack(padx=12, pady=(10, 4))
        for action in ACTIONS:
            ttk.Button(
                win, text=f"{action.hotkey}. {action.label}", width=28,
                command=lambda a=action: self._start(win, a, text),
            ).pack(padx=12, pady=2)
            win.bind(action.hotkey, lambda _e, a=action: self._start(win, a, text))
        win.bind("<Escape>", lambda _e: win.destroy())
        win.focus_force()

    def _start(self, menu: tk.Toplevel, action, text: str) -> None:
        menu.destroy()
        result_win = self._result_window(action.label)
        threading.Thread(
            target=self._worker, args=(action, text, result_win), daemon=True
        ).start()

    def _worker(self, action, text: str, win) -> None:
        try:
            result = run_action(action, text)
        except ActionError as e:
            result = f"[오류] {e}"
        self.root.after(0, win.set_text, result)

    # ── 결과 창 ───────────────────────────────────────
    def _result_window(self, title: str):
        win = tk.Toplevel(self.root)
        win.title(f"결과 — {title}")
        win.attributes("-topmost", True)
        box = tk.Text(win, wrap="word", font=FONT, width=70, height=18)
        box.pack(fill="both", expand=True, padx=8, pady=8)
        box.insert("1.0", "처리 중임…")

        def set_text(value: str) -> None:
            box.delete("1.0", "end")
            box.insert("1.0", value)
            box.focus_set()

        def copy() -> None:
            pyperclip.copy(box.get("1.0", "end-1c"))
            win.destroy()

        def paste() -> None:
            copy()
            time.sleep(0.1)
            keyboard.send("ctrl+v")

        bar = ttk.Frame(win)
        bar.pack(pady=(0, 8))
        ttk.Button(bar, text="붙여넣기 (Enter)", command=paste).pack(side="left", padx=4)
        ttk.Button(bar, text="복사만 (Ctrl+C)", command=copy).pack(side="left", padx=4)
        ttk.Button(bar, text="닫기 (Esc)", command=win.destroy).pack(side="left", padx=4)
        win.bind("<Control-Return>", lambda _e: paste())
        win.bind("<Escape>", lambda _e: win.destroy())
        win.set_text = set_text
        return win

    # ── 실행 ──────────────────────────────────────────
    def on_hotkey(self) -> None:
        text = grab_selection()
        self.root.after(0, self.show_menu, text)

    def run(self) -> None:
        keyboard.add_hotkey(HOTKEY, self.on_hotkey)
        print(f"텍스트 액션 실행 중임. 텍스트 선택 후 {HOTKEY.upper()} 누름. 종료: Ctrl+C")
        self.root.mainloop()


def main() -> None:
    TextActionApp().run()
