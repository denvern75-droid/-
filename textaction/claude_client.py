"""Claude API 호출부.

- API 키: 환경변수 ANTHROPIC_API_KEY (사용자 본인 키 사용, BYOK 방식)
- 모델: 환경변수 TEXTACTION_MODEL 로 변경 가능 (기본 claude-opus-5-5)
"""
import os

import anthropic

from .actions import BASE_SYSTEM, Action

DEFAULT_MODEL = "claude-opus-5-5"


class ActionError(RuntimeError):
    pass


def run_action(action: Action, text: str, client: anthropic.Anthropic | None = None) -> str:
    if not text.strip():
        raise ActionError("선택된 텍스트가 없음. 텍스트를 드래그한 뒤 다시 실행 바람.")

    client = client or anthropic.Anthropic()
    model = os.environ.get("TEXTACTION_MODEL", DEFAULT_MODEL)

    try:
        response = client.beta.messages.create(
            model=model,
            max_tokens=16000,
            system=BASE_SYSTEM,
            output_config={"effort": "low"},
            # 정책상 거절 시 서버가 대체 모델로 자동 재시도함
            betas=["server-side-fallback-2026-07-01"],
            fallbacks="default",
            messages=[{
                "role": "user",
                "content": f"[변환 지시]\n{action.instruction}\n\n[원문]\n{text}",
            }],
        )
    except anthropic.AuthenticationError as e:
        raise ActionError("API 키 오류임. ANTHROPIC_API_KEY 설정 확인 바람.") from e
    except anthropic.RateLimitError as e:
        raise ActionError("요청 한도 초과임. 잠시 후 다시 시도 바람.") from e
    except anthropic.APIStatusError as e:
        raise ActionError(f"API 오류({e.status_code})임: {e.message}") from e
    except anthropic.APIConnectionError as e:
        raise ActionError("네트워크 연결 실패임. 인터넷 연결 확인 바람.") from e

    if response.stop_reason == "refusal":
        raise ActionError("해당 텍스트는 처리할 수 없다는 응답을 받음.")

    result = "".join(b.text for b in response.content if b.type == "text").strip()
    if response.stop_reason == "max_tokens":
        result += "\n\n[주의: 결과가 길어 일부 잘림]"
    return result
