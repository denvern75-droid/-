# 영상 분석 팀 구성 및 적용 제안서

## 1. 핵심 요약
- 영상(https://youtu.be/Lrh-elQaS4c) 내용은 미확보 상태임. 본 문서에 영상 내용은 포함하지 않음
- 확보 실패 사유: 클라우드 세션에서 `www.youtube.com` 차단, 검색엔진 미색인, 우회 사이트(noembed.com·yewtu.be)도 차단
- 본 문서는 (1) 에이전트 팀 구성 (2) 즉시 적용 가능한 설정·코드 (3) 확장프로그램 판단 (4) 리스크를 정리함
- 출처 표기가 있는 항목은 Claude Code 공식 문서 조회 결과임. '미확인'은 문서로 확인하지 못한 항목임

## 2. 에이전트 팀 구성 (로컬 PC·Claude Code 기준 적용안)
| 역할 | 임무 | 권장 도구 | 산출물 |
|---|---|---|---|
| ① 자막 확보 | 영상 URL → 자막·타임코드 텍스트 | 사용자 붙여넣기 > Claude in Chrome > yt-dlp | `transcript.txt` |
| ② 분석 | 구간별 요지, 핵심 주장·도구·수치 추출 | 읽기 전용 | `analysis.md` |
| ③ 검수 | 수치·고유명사 원문 대조, 오인식 표시 | 읽기 전용 | 검수 의견 |
| ④ 문서 작성 | 개조식 보고서, 적용안 2~3개 | 쓰기 | 최종 `.md` |
- 원칙: 확보 실패 시 ②~④ 착수 금지. 영상 내용 추정 금지

## 3. 확장프로그램(Claude in Chrome) 판단
- 근거: https://code.claude.com/docs/en/chrome.md
- 요건: Chrome 또는 Edge, 확장 1.0.36 이상, Claude Code, Pro/Max/Team/Enterprise 직접 계정(`/login` 필요, API 키 불가)
- 사용: PC에서 `claude --chrome` 실행 또는 세션 내 `/chrome`
- 판단: 확장은 사용자 PC 브라우저 전제임. 현재 클라우드 세션과의 연동은 문서에서 확인되지 않음(미확인)
- 권장 순서
  1. PC의 Claude Code에서 `/chrome` 활성화 후 영상 페이지의 스크립트 추출 요청
  2. 추출 텍스트를 이 세션에 붙여넣어 ②~④ 진행
- 리스크: 브라우저 로그인 상태가 공유되어 접근 가능한 사이트 전체에 작동함. 사이트 권한은 확장에서 관리 필요

## 4. 즉시 적용 가능한 설정·코드
### 4-1. 스킬 (자막 추출 전용, 초안)
경로: `.claude/skills/yt-transcript/SKILL.md` (근거: https://code.claude.com/docs/en/skills.md)
```yaml
---
name: yt-transcript
description: 유튜브 URL의 자막 추출 요청 시 사용
disable-model-invocation: true
allowed-tools: Bash(${CLAUDE_SKILL_DIR}/scripts/*)
---
```
- 본문에는 기존 `ai-workflow/skills/video-transcript-analysis/SKILL.md`의 1단계(본문 확보)를 이식함
- `scripts/`에 yt-dlp 호출 스크립트를 두고 해당 경로만 Bash 허용하는 방식임

### 4-2. 서브에이전트 (분석·검수 분리, 초안)
경로: `.claude/agents/<name>.md`, `name`·`description` 필수, `tools`로 허용 목록 제한 (근거: https://code.claude.com/docs/en/sub-agents.md)
- 검수 에이전트는 읽기 전용 도구만 부여해 원문 대조 전용으로 분리함

### 4-3. 권한 설정 (PC에서 직접 검토 후 적용)
경로: `.claude/settings.json` (근거: https://code.claude.com/docs/en/settings.md)
```json
{"permissions":{"allow":["Bash(yt-dlp *)"],"deny":["Read(./.env)"]}}
```
- 본 저장소에는 적용하지 않았음. 적용 여부는 사용자 판단 사항임

### 4-4. 훅·MCP
- 훅: `.claude/settings.json`의 `hooks`, 근거 https://code.claude.com/docs/en/hooks.md
- MCP: `claude mcp add --transport http --scope project <name> <url>` 로 `.mcp.json` 생성, 근거 https://code.claude.com/docs/en/mcp.md
- 자막 추출 전용 공식 MCP·방법은 문서에서 확인되지 않음(미확인)

## 5. 클라우드 세션 네트워크 허용 (대안 3)
- 위치: claude.ai/code → Cloud environments 편집 → Network access (None/Trusted/Full/Custom)
- 방법: Custom 선택 후 Allowed domains에 도메인 입력(와일드카드 지원)
- 근거: https://code.claude.com/docs/en/cloud-environments.md#network-access
- 기본 Trusted 목록에 youtube.com 계열은 없음
- 리스크: Full은 전체 도메인 허용임. 필요한 도메인만 Custom으로 추가 권장

## 6. 행정 문서 업무용 CLAUDE.md 제안 (비공식 제안)
- 문체(~함/~임), 수치 대조 규칙, 근거 조항 병기 규칙을 짧게 명시함
- 검수용 서브에이전트는 읽기 전용으로 분리함
- 기존 `ai-workflow/CLAUDE.md.snippet` 참조
- 클라우드 세션의 CLAUDE.md·MCP 설정 이월 여부는 미확인

## 7. 리스크
- 영상 원본·자막 취득은 플랫폼 약관·저작권 확인이 선행되어야 하며, 공식 문서는 이를 다루지 않음
- 자동 자막은 고유명사·수치 오인식 가능성이 있어 원문 대조 필수
- 확장프로그램 로그인 공유로 인한 접근 범위 확대 주의
- 스킬·권한 예시는 초안이며 실제 적용 전 PC에서 동작 확인이 필요함
