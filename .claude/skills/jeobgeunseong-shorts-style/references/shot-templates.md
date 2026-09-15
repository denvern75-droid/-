# 구도 프레임 템플릿 상세 (shot templates)

레퍼런스 영상("병원 정문에서 혼자 갈 수 있을까?")의 구도를 6컷 타임라인에 매핑함.
각 컷은 `shorts-render` 프롬프트에 §3 STYLE LOCK 뒤에 붙여 사용함.

---

## 컷 1 — 도입 훅 (0~10s)
- **구도**: 시설 외관 와이드, 로우앵글, 상단 하늘 여백 큼
- **의도**: "혼자 갈 수 있을까?" 질문형 훅
- **카메라**: rapid push-in
- **프롬프트 예**: `wide low-angle shot of a Korean public hospital exterior, blue sky headroom, crosswalk in foreground, rapid push-in`

## 컷 2 — 도달 (10~20s)
- **구도**: 로비 아이레벨 풀샷, 바닥 타일 원근선으로 소실점 형성
- **카메라**: slow dolly-in
- **프롬프트 예**: `eye-level full shot of a hospital lobby, glossy floor tiles forming a strong vanishing point, people blurred in background, slow dolly-in`

## 컷 3 — 동선 (20~30s)
- **구도**: 주인공 미디엄~오버숄더, 흰지팡이 동선 시작
- **카메라**: lateral tracking shot
- **프롬프트 예**: `over-the-shoulder tracking shot of the recurring subject walking with a white cane across the lobby, lateral tracking`

## 컷 4 — 접수 (30~40s)
- **구도**: 키오스크/안내데스크 손 클로즈업
- **카메라**: match cut (손 → 기기 버튼)
- **프롬프트 예**: `close-up of hands and a white cane operating a ticket kiosk keypad, match cut from hand to device`

## 컷 5 — 비교 (40~50s) ★ 이 스타일의 핵심
- **구도**: 다분할(3분할) 스플릿 스크린 — 시립병원·주민센터·보건소
- **규칙**: 세 시설 모두 **동일 앵글·동일 거리·동일 진입 방향(뒤에서 정문 진입)**
- **의도**: 시설 간 접근성 격차의 공정 비교
- **구현**: 각 패널을 동일 프롬프트 골격으로 생성 후 세로 3분할 합성(ffmpeg vstack), 패널 간 애니메이션 전환 허용

## 컷 6 — 마감 (50~60s)
- **구도**: 오버숄더 시네마틱, 역광 골든톤, 얕은 심도
- **카메라**: rapid push-in
- **주의**: 실사 컷과 색온도 이질감 보정 필수. 연출/AI 재현 시 "재현" 표기
- **프롬프트 예**: `cinematic over-the-shoulder shot of the subject walking into a sunlit corridor, warm backlight, shallow depth of field, rapid push-in`

---

## 공통 금칙
- 정면 얼굴·실존 인물 유사 묘사 금지
- 부감 단독샷(동정 프레임) 금지
- 플리커·스트로브·급회전 금지 (광과민 발작 고려)
- 화면 내 한글 글자 생성 금지 → 자막 오버레이로만 처리
