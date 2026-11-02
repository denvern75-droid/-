# 헤르메스 세컨드브레인 연결·자동화 키트

노트북에서 구동 중인 Hermes Agent를 **텔레그램(허브) + Gmail·구글드라이브(적재) + 카카오 나에게 보내기(긴급)** 구조로 확장하기 위한 설정 문서 모음임.

## 1. 구조 요약

```
[입력]                         [처리]                 [저장]                    [출력]
텔레그램(메모·음성·사진) ─┐
네이버·다음 → Gmail(라벨) ─┼──▶ Hermes(노트북) ──▶ 구글드라이브/SecondBrain ──▶ 텔레그램(일상 알림)
드라이브 '투입함' 폴더 ────┘          │                      ▲                   카카오 나에게(긴급)
                                      └── 예약 작업 ─────────┘
                                   Claude 클라우드 세션 ──(Drive로 읽기)──▶ 보고서·HWPX·엑셀 산출
```

| 채널 | 역할 | 비고 |
|---|---|---|
| 텔레그램 | 주 허브(입력·출력) | 연결 완료 |
| Gmail | 메일 적재 단일 창구 | 네이버·다음은 자동전달로 합류 |
| 구글드라이브 | 볼트 보관·공유, 문서 투입함 | Drive for desktop 동기화 |
| 카카오 나에게 보내기 | 긴급 알림 전용 | 출력 전용, 1일 3건 이하 |

## 2. 파일 구성

| 경로 | 내용 |
|---|---|
| `vault-skeleton/` | 구글드라이브 `SecondBrain` 폴더에 복사할 볼트 골격·템플릿 |
| `hermes/cron-prompts.md` | 예약 작업 8종 등록용 자연어 프롬프트 |
| `hermes/standing-instructions.md` | 텔레그램 캡처·분류·승인 규칙(상시 지침) |
| `hermes/config.example.yaml` | MCP 연결 설정 예시 |
| `gmail/filters.md` | Gmail 라벨·필터 규칙표 |
| `mail-forwarding/naver-daum-checklist.md` | 네이버·다음 → Gmail 자동전달 체크리스트 |
| `docs/운영가이드.md` | 도입 순서, 리스크 대응, 주간 점검표 |

## 3. 도입 순서 (요약)

1. `vault-skeleton/` 내용을 구글드라이브 `SecondBrain` 폴더로 복사함 → Obsidian에서 해당 폴더를 볼트로 엶
2. 네이버·다음 자동전달 설정 → Gmail 필터 등록 (`mail-forwarding/`, `gmail/`)
3. Hermes 설정에 볼트 경로·Gmail·Drive MCP 연결 (`hermes/config.example.yaml`)
4. 상시 지침 등록 (`hermes/standing-instructions.md`)
5. 1순위 예약 작업 3종부터 등록 → 1주 시범 운영 → 나머지 등록 (`hermes/cron-prompts.md`)

세부 절차는 `docs/운영가이드.md` 참조.
