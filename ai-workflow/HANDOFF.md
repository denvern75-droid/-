# 인계서: 영상 오디오 분석 → Claude 활용 개선

작성일: 2026-10-29 / 저장소: denvern75-droid/- / 브랜치: `ccr-3a58ff2d-hlx21t`

## 0. 갱신 (2026-10-29, PC 세션)
- PC의 yt-dlp(Python 모듈)로 한국어 자동 자막 확보 → 분석 완료
- 산출물: `ai-workflow/APPLY-PROPOSAL.md` (구간별 요지, 갭 분석, 적용안 A~E, CLAUDE.md 문안 초안)
- 남은 일: 적용안 채택 여부·CLAUDE.md 반영은 정책국장 확인 후 진행

## 1. 핵심 요약
- 요청: 유튜브 영상(https://youtu.be/Lrh-elQaS4c)의 오디오 대화 내용을 분석해, 현재 Claude 활용 방식에 바로 적용 가능한 제안을 md로 작성
- 현재 상태: **영상 내용 미확보 → 분석 미착수**. 영상 내용은 어떤 문서에도 추정해 넣지 않았음
- 다음 세션의 첫 작업: 영상 자막 확보 → 분석 → 적용안 md 작성

## 2. 진행 경과
| 구분 | 결과 |
|---|---|
| WebFetch·curl로 YouTube 접속 | 실패 (네트워크 정책상 `www.youtube.com` 차단) |
| Descript에 YouTube URL 가져오기 | 실패 (HTML 페이지로 인식, 거부) |
| 검색엔진에서 영상 ID 검색 | 관련 결과 없음. 제목·채널 모름 |
| 우회 사이트(noembed.com, yewtu.be) | 실패 (허용 도메인 밖) |
| 보유 스킬 중 영상 자막 추출용 | 없음 (`shorts-*`는 영상 제작용) |
| 브라우저 확장(Claude in Chrome) | 클라우드 세션에서 연결 불가. 연결 가능한 PC 폴더 없음 |
| 커넥터 레지스트리 | 회의록용만 확인됨. YouTube 자막용은 확인 못함 |

## 3. 산출물 (브랜치에 푸시 완료)
- `ai-workflow/README.md`: 영상 확보 경로 4종, 분석 절차, 산출물 양식
- `ai-workflow/skills/video-transcript-analysis/SKILL.md`: 영상 분석 스킬 초안
- `ai-workflow/CLAUDE.md.snippet`: CLAUDE.md 붙여넣기용 규칙
- `ai-workflow/PROPOSAL.md`: 4역할 팀 구성, 설정·코드 예시, 확장프로그램 판단, 리스크
- `ai-workflow/HANDOFF.md`: 본 문서

## 4. 새 세션에서 할 일
1. **영상 본문 확보** (우선순위순)
   - ① 유튜브 "더보기 → 스크립트 표시"에서 전체 복사(타임스탬프 표시 권장) 후 붙여넣기
   - ② PC의 Claude Code에서 `/chrome`으로 스크립트 추출 → 결과 붙여넣기
   - ③ 새 세션 환경의 Network access에서 `www.youtube.com` 허용 후 자막 추출 재시도
   - ④ 음성·영상 파일 업로드 → 전사(ElevenLabs·Descript 파일 업로드 방식)
2. **분석**: 구조 파악 → 변수 정의 → 수치·용어 원문 대조 → 재정렬
3. **작성**: 핵심 요약, 구간별 내용, 현재 활용 방식 대비 갭, 적용안 2~3개, 리스크
4. **적용**: CLAUDE.md 규칙·스킬 초안 반영은 사용자 확인 후 진행

## 5. 새 세션 시작용 프롬프트 (복사용)
```
저장소 denvern75-droid/- 의 브랜치 ccr-3a58ff2d-hlx21t 에서
ai-workflow/HANDOFF.md 와 PROPOSAL.md 를 먼저 읽고 이어서 진행해 주세요.
영상: https://youtu.be/Lrh-elQaS4c
[여기에 자막 붙여넣기]
자막 기준으로 분석하고, 현재 Claude 활용 방식에 바로 적용 가능한
개조식(~함/~임) md 제안서를 ai-workflow/ 에 작성해 주세요.
```

## 6. 미확인 사항
- 자막 추출 전용 공식 방법·MCP
- 클라우드 세션에서의 Claude in Chrome 연동
- 클라우드 세션의 CLAUDE.md·MCP 설정 이월 여부
- 영상 자막 취득의 약관·저작권 적합성

## 7. 리스크
- 영상 미확인 상태에서 적용안을 쓰면 오류 발생. 자막 확보 전 분석 금지
- 자동 자막의 고유명사·수치 오인식. 원문 대조 필수
- 확장프로그램은 로그인 상태가 공유되어 접근 범위가 넓음
- 설정·권한 예시는 초안이며 PC에서 동작 확인 후 적용
