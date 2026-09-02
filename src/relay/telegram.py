# -*- coding: utf-8 -*-
"""텔레그램 Bot API 클라이언트(표준 라이브러리만 사용).

설계 의도
- 외부 의존성 0 → 사내 노트북에서 pip 설치 없이 동작함
- 429(Too Many Requests) retry_after 준수, 5xx/네트워크 오류는 지수 백오프 재시도함
- 한글은 반드시 UTF-8 바이트로 인코딩해 전송함(파워쉘 5.1의 한글 깨짐 문제와 동일 원인 차단)
"""

from __future__ import annotations

import json
import mimetypes
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from dataclasses import dataclass
from pathlib import Path

API_BASE = "https://api.telegram.org"
# 텔레그램 메시지 본문 상한(4096자). 여유를 두고 자름.
MESSAGE_LIMIT = 4000
CAPTION_LIMIT = 1000


class TelegramError(RuntimeError):
    def __init__(self, message: str, *, status: int | None = None, payload: dict | None = None):
        super().__init__(message)
        self.status = status
        self.payload = payload or {}

    @property
    def is_fatal(self) -> bool:
        """재시도해도 소용없는 오류인지 판별함(토큰·chat_id 문제 등)."""
        return self.status in (400, 401, 403, 404)


@dataclass
class TelegramClient:
    bot_token: str
    timeout: int = 60
    max_retries: int = 5
    proxy_url: str = ""

    def _opener(self) -> urllib.request.OpenerDirector:
        handlers: list[urllib.request.BaseHandler] = []
        if self.proxy_url:
            handlers.append(urllib.request.ProxyHandler({"http": self.proxy_url, "https": self.proxy_url}))
        return urllib.request.build_opener(*handlers)

    def _url(self, method: str) -> str:
        return f"{API_BASE}/bot{self.bot_token}/{method}"

    # ------------------------------------------------------------------ core
    def _request(self, method: str, body: bytes, content_type: str) -> dict:
        last_exc: Exception | None = None
        for attempt in range(1, self.max_retries + 1):
            req = urllib.request.Request(
                self._url(method),
                data=body,
                headers={"Content-Type": content_type, "User-Agent": "eopmu-relay/1.0"},
                method="POST",
            )
            try:
                with self._opener().open(req, timeout=self.timeout) as resp:
                    payload = json.loads(resp.read().decode("utf-8"))
                if payload.get("ok"):
                    return payload["result"]
                raise TelegramError(
                    f"{method} 실패: {payload.get('description')}",
                    status=payload.get("error_code"),
                    payload=payload,
                )
            except urllib.error.HTTPError as exc:
                raw = exc.read().decode("utf-8", "replace")
                try:
                    payload = json.loads(raw)
                except json.JSONDecodeError:
                    payload = {"description": raw}
                err = TelegramError(
                    f"{method} HTTP {exc.code}: {payload.get('description', raw)[:300]}",
                    status=exc.code,
                    payload=payload,
                )
                if exc.code == 429:
                    wait = int(payload.get("parameters", {}).get("retry_after", 5))
                    time.sleep(min(wait, 60))
                    last_exc = err
                    continue
                if err.is_fatal:
                    raise err
                last_exc = err
            except (urllib.error.URLError, TimeoutError, OSError) as exc:
                last_exc = TelegramError(f"{method} 네트워크 오류: {exc}")
            except TelegramError as exc:
                if exc.is_fatal:
                    raise
                last_exc = exc
            if attempt < self.max_retries:
                time.sleep(min(2 ** attempt, 30))
        raise last_exc or TelegramError(f"{method} 실패(원인 미상)")

    def _post_json(self, method: str, data: dict) -> dict:
        clean = {k: v for k, v in data.items() if v is not None}
        return self._request(method, json.dumps(clean, ensure_ascii=False).encode("utf-8"),
                             "application/json; charset=utf-8")

    def _post_multipart(self, method: str, fields: dict, file_field: str, file_path: Path) -> dict:
        boundary = "----relay" + uuid.uuid4().hex
        buf = bytearray()
        for key, value in fields.items():
            if value is None:
                continue
            buf += f"--{boundary}\r\n".encode()
            buf += f'Content-Disposition: form-data; name="{key}"\r\n\r\n'.encode()
            buf += str(value).encode("utf-8") + b"\r\n"
        ctype = mimetypes.guess_type(file_path.name)[0] or "application/octet-stream"
        # 파일명은 RFC 2231 대신 UTF-8 리터럴로 넣음(텔레그램이 그대로 수용함)
        safe_name = file_path.name.replace('"', "_").replace("\r", "").replace("\n", "")
        buf += f"--{boundary}\r\n".encode()
        buf += (
            f'Content-Disposition: form-data; name="{file_field}"; filename="{safe_name}"\r\n'
            f"Content-Type: {ctype}\r\n\r\n"
        ).encode("utf-8")
        buf += file_path.read_bytes() + b"\r\n"
        buf += f"--{boundary}--\r\n".encode()
        return self._request(method, bytes(buf), f"multipart/form-data; boundary={boundary}")

    # --------------------------------------------------------------- public
    def get_me(self) -> dict:
        return self._request("getMe", b"{}", "application/json; charset=utf-8")

    def get_updates(self, limit: int = 20) -> list[dict]:
        return self._post_json("getUpdates", {"limit": limit, "timeout": 0})  # type: ignore[return-value]

    def send_message(self, chat_id: str, text: str, *, thread_id: int | None = None) -> dict:
        return self._post_json(
            "sendMessage",
            {
                "chat_id": chat_id,
                "text": text[:MESSAGE_LIMIT],
                "message_thread_id": thread_id,
                "disable_web_page_preview": True,
            },
        )

    def send_document(self, chat_id: str, file_path: Path, *, caption: str = "",
                      thread_id: int | None = None) -> dict:
        return self._post_multipart(
            "sendDocument",
            {
                "chat_id": chat_id,
                "caption": caption[:CAPTION_LIMIT] or None,
                "message_thread_id": thread_id,
                "disable_content_type_detection": "true",
            },
            "document",
            file_path,
        )
