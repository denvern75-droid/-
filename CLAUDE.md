# 저장소 안내 (장애인 접근성 쇼츠 스타일)

이 저장소는 **장애인·시각장애인 접근성 실태 쇼츠**의 촬영 구도·스타일을 재현하기 위한
스킬·프리셋을 담음. GitHub 커넥터로 이 저장소를 연결하면 아래 스킬이 세션에 자동 로드됨.

## 제공 스킬
- `.claude/skills/jeobgeunseong-shorts-style/` — 접근성 쇼츠 스타일 프리셋
  - 촬영 구도 6컷 템플릿, 스타일 앵커 블록, 세션 간 넘김 규격
  - 실제 생성은 org 스킬 체인(`shorts-production` → `shorts-render` → `shorts-audio` → `shorts-publish`)으로 라우팅

## 사용
- "이 스타일로 접근성 쇼츠 만들어줘" → `jeobgeunseong-shorts-style` 진입
- 세션 넘김 시 `assets/style-anchor.json`을 먼저 로드해 앵커 값 고정

## 원칙
- 정면 얼굴·동정 프레임·광과민 유발 요소 금지
- 자막 = 내레이션 완전 일치, 미확정 수치 삽입 금지
- AI/연출 재현컷은 "재현" 표기
