# 접근성 쇼츠 스타일 (jeobgeunseong-shorts-style)

장애인·시각장애인 접근성 실태를 다루는 세로 쇼츠(9:16)의 **촬영 구도·스타일을 표준 프리셋**으로
재현하기 위한 저장소. 기준 레퍼런스: "병원 정문에서 혼자 갈 수 있을까?" (9:16 / 24fps).

## 구성

```
.claude/skills/jeobgeunseong-shorts-style/
├── SKILL.md                     # 스킬 본문 (구도 규격·앵커·라우팅)
├── assets/
│   └── style-anchor.json        # 세션 넘김용 기계 판독 앵커 (STYLE LOCK·구도프레임·색·수치규칙)
└── references/
    ├── shot-templates.md        # 6컷 구도 프레임 템플릿 상세
    └── session-handoff.md       # 세션 간 넘김 5블록 규격
```

## 핵심 스타일

- **3단 구도**: 실사 다큐 → 다분할 시설 비교 → 시네마틱 마감
- **인물 앵커**: 흰지팡이 당사자, 파란 상의·검정 백팩 (정면 얼굴 회피)
- **비교컷 규칙**: 시설별 동일 앵글·거리·진입방향 (공정 비교 프레이밍)
- **자막**: 상단 2행, 네이비+앰버, 내레이션과 완전 일치

## 사용

GitHub 커넥터로 이 저장소를 연결하면 스킬이 자동 로드됨.
"이 스타일로 접근성 쇼츠 만들어줘"로 진입하고, 실제 생성은
`shorts-production` → `shorts-render` → `shorts-audio` → `shorts-publish` 체인으로 이관됨.
