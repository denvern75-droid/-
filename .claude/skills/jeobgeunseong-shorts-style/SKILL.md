---
name: jeobgeunseong-shorts-style
description: 시각장애인·장애인 접근성 실태를 다루는 세로 쇼츠(9:16)의 촬영 구도·스타일을 표준 프리셋으로 재현하는 스킬. 사용자가 '이 스타일로 쇼츠 만들어줘', '접근성 쇼츠 구도', '병원 접근성 영상', '시립병원·주민센터·보건소 비교 영상', '흰지팡이 당사자 동선 영상', '스타일 앵커 세션 넘김', '구도 프레임 규격', '접근성 쇼츠 스타일 적용' 등을 요청할 때 사용함. 실사 다큐 + 다분할 비교 + 시네마틱 마감의 3단 구도, 상단 자막존, 인물·색·카메라 앵커 블록, 세션 간 넘김(handoff) 규격을 제공하며 실제 생성은 shorts-production/shorts-render/shorts-audio/shorts-publish 체인으로 라우팅함.
---

# 접근성 쇼츠 스타일 — 구도·앵커 프리셋

## 0. 이 스킬의 역할

- 장애인 접근성 실태 쇼츠의 **촬영 구도·색·인물·자막 스타일**을 고정 프리셋으로 제공함
- 실제 제작은 하지 않음 → 아래 체인으로 **라우팅**함
  - `shorts-production` (기획·6컷·검증) → `shorts-render` (그림) → `shorts-audio` (소리) → `shorts-publish` (배포)
- 이 스킬은 그 체인에 투입할 **스타일 앵커 블록 + 구도 프레임 규격 + 세션 넘김 규격**만 확정함
- 기준 레퍼런스: "병원 정문에서 혼자 갈 수 있을까?" (9:16, 24fps, 시립병원·주민센터·보건소 접근성 실태 영상)

## 1. 트리거

"이 스타일로", "접근성 쇼츠", "병원 접근성 영상", "당사자 동선 영상", "시설 비교 영상", "구도 프레임", "스타일 앵커", "세션 넘김"

## 2. 산출 규격 (composition frame spec)

| 항목 | 표준값 | 근거 |
|---|---|---|
| 종횡비 | 9:16 세로 | 쇼츠 표준 |
| 해상도 | 1080×1920 (레퍼런스 406×720 → 업스케일) | 저해상 방지 |
| fps | 24 고정 | 시네마틱 톤 |
| 자막존 | 상단 12~20% (2행) | 인물·정보 가림 방지 |
| 인물 배치 | 중앙~하단 1/3, 정면 얼굴 회피 | 초상권·AI 얼굴 회피 |
| 색 시그니처 | 공공시설 그레이 + 옐로우 점자블록(#F2C230), 자막 네이비(#1A2A4A)+앰버 | 실로암 브랜드 톤 |

전체 규격·수치는 `assets/style-anchor.json`(composition_frames 항목) 참조.

## 3. 스타일 앵커 블록 (shorts-render `[STYLE LOCK]`에 그대로 투입)

```
[STYLE LOCK] photorealistic cinematic, vertical 9:16, Korean urban public
health facility (hospital lobby / community center / public health center).
Muted grey-neutral palette + one signature accent: vivid yellow tactile
paving (#F2C230). Recurring subject: a middle-aged Korean man navigating
alone with a white cane, blue short-sleeve shirt, black backpack, glasses —
shown from BEHIND / over-the-shoulder / cane-and-feet close-up only, never
front face. Soft daylight, gimbal-stabilized smooth motion, no handheld
shake. No on-screen text, no letters, no logos.
```

- 주인공 정의(파란 상의·검정 백팩·흰지팡이·안경)는 전 컷 동일 문구 사용 — 일관성 핵심
- 화면 내 글자 생성 금지, 한글은 §5 자막 오버레이로만 처리
- 얼굴 회피: 뒷모습·오버숄더·손/지팡이/발 클로즈업·실루엣만 사용

## 4. 구도 프레임 템플릿 (6컷 매핑)

레퍼런스 구도를 `shorts-production` 6컷(10초×6) 타임라인에 매핑함. 상세는 `references/shot-templates.md`.

| 컷 | 시각 | 구도 | 카메라워크 |
|---|---|---|---|
| 1 | 0~10 | 시설 외관 와이드·로우앵글, 하늘 여백 (훅) | `rapid push-in` |
| 2 | 10~20 | 로비 아이레벨 풀샷, 바닥 타일 소실점 | `slow dolly-in` |
| 3 | 20~30 | 주인공 미디엄/오버숄더 (동선 시작) | `lateral tracking shot` |
| 4 | 30~40 | 키오스크·안내데스크 손 클로즈업 | `match cut` (손→기기) |
| 5 | 40~50 | **다분할 비교** — 시립병원·주민센터·보건소 동일앵글 | 고정 3분할 |
| 6 | 50~60 | 오버숄더 시네마틱 마감, 역광 골든톤 | `rapid push-in` |

**다분할 비교 규칙(컷 5, 이 스타일의 핵심)**: 시설별로 **동일 앵글·동일 거리·동일 진입 방향(뒤에서 진입)** 고정 → 접근성 격차의 공정 비교 프레이밍.

## 5. 자막 오버레이

- 자막 문구 = 내레이션과 한 글자도 다르지 않게 일치 (음성·자막 이중 전달)
- 상단 2행 고정 배치, Noto Sans CJK KR Bold, 대비 4.5:1 이상
- 색: 네이비(#1A2A4A) 본문 + 앰버 강조 (레퍼런스 톤)

## 6. 세션 간 넘김 (handoff / style anchor)

쇼츠는 컷별로 세션이 분리됨 → 컷 간 일관성 유지를 위해 **매 세션 동일 앵커 블록 전달** 필수. 기계 판독용 규격은 `assets/style-anchor.json` 1개 파일로 관리하고, 새 세션 시작 시 이 파일을 먼저 로드해 값 고정.

넘김 필수 5블록:
1. **스타일 앵커** — §3 STYLE LOCK 전문
2. **인물 앵커** — 주인공 외형 정의 1문장 (전 컷 동일)
3. **자막 앵커** — 폰트·2행·상단정렬·색상
4. **카메라 앵커** — 컷별 앵글·거리·이동방향 (비교컷은 동일값 강제)
5. **수치 무결성** — 시설 수·문항 수 등 조사 수치는 확정 자료 대조 후 고정, 미확정 수치 삽입 금지

## 7. 검증 게이트 (전달 전 필수)

| 게이트 | 점검 |
|---|---|
| 구도 | 상단 자막존 확보, 인물 정면 얼굴 0건, 비교컷 앵글 동일 |
| 일관성 | 주인공 복장·소품·이동축(180도 규칙) 전 컷 일치 |
| 톤 | 실사 컷과 마감 시네마틱 컷 색온도 이질감 보정 완료 |
| 사실 | 영상 내 수치 = 확정 자료 일치, 연출 재현컷은 "재현" 표기 |
| 접근성 | 광과민 유발 플리커·스트로브·급회전 0건, 동정 프레임(부감 단독샷) 0건 |

## 8. 라우팅 순서

1. 이 스킬로 `assets/style-anchor.json` 확정
2. `shorts-production` 호출 → 6컷 대본 + 타임라인 (§4 구도 매핑 첨부)
3. `shorts-render` 호출 → §3 STYLE LOCK + §4 구도 투입, 컷 생성·자막·충돌검증
4. `shorts-audio` 호출 → 내레이션(TTS)·BGM·더킹
5. (승인 후) `shorts-publish` 호출 → 업로드
