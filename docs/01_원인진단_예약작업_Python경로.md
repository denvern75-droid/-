# 원인 진단 — 예약 작업의 Python 경로 문제

## 1. 핵심 요약

- 장애 내용: 사무실 데스크탑 업무보고가 24시간 노트북을 거쳐 텔레그램으로 전달되지 않음
- 확인된 원인: **PowerShell 문제 아님. Windows 예약 작업이 지정한 Python 실행 경로가 유효하지 않음**
- 조치: 예약 작업 2건이 **절대경로 Python**을 사용하도록 재등록함
- 검증: 발송 없는 시험 통과 후에만 실제 발송 진행함

## 2. 문제 진단

### 2.1 관찰된 사실

| 항목 | 상태 |
|---|---|
| 예약 작업 `HermesDailyReportRelay` (OneDrive 17:45) | 등록됨 · 작동 대상 |
| 예약 작업 `HermesDailyReportRelayLogon` (로그온 시) | 등록됨 |
| 예약 작업 Google Drive 16:00 | **일시정지** — Google Drive 연결 보류에 따른 사용자 요청 사항 |
| 텔레그램 수신 | 없음 |
| 예약 작업 파일 변경 이력 | 없음(교정 미적용 상태였음) |

### 2.2 원인 분석

- 예약 작업은 **대화형 로그온 세션이 아님**
  - 사용자 `PATH` 환경변수가 적용되지 않음
  - `python`, `pythonw`, `py` 처럼 **이름만** 지정된 실행 파일은 해석되지 않음
- Windows 10/11 기본 상태에서 `python`은 **Microsoft Store 스텁**을 가리키는 경우가 많음
  - 위치: `%LOCALAPPDATA%\Microsoft\WindowsApps\python.exe`
  - 실체: **0바이트 리파스 포인트**. 대화형 창에서는 Store를 열지만, 예약 작업에서는 그대로 실패함
- 결과: 스크립트가 한 줄도 실행되지 않음 → 로그도 남지 않음 → “조용한 실패”가 됨
  - `LastTaskResult` = `0x2`(파일 없음) 또는 `0x1`(즉시 오류 종료)

### 2.3 원인이 아닌 것 (배제 근거)

| 후보 | 배제 근거 |
|---|---|
| PowerShell 실행 정책 | 예약 작업이 PowerShell을 거치지 않고 Python을 직접 실행함 |
| 텔레그램 봇 토큰·chat_id | 스크립트가 실행되지 않았으므로 API 호출 자체가 없었음 |
| 사내 방화벽 | 동일. 네트워크 계층까지 도달하지 못함 |
| 중계 스크립트 로직 | 수동 실행 시 정상 동작함 |

> 위 배제 항목은 `python run_relay.py doctor` 로 재확인 가능함(5~7번 점검 항목).

## 3. 실행 전략

### 3.1 교정 (택1)

| 방식 | 명령 | 적용 상황 |
|---|---|---|
| **A. 경로만 교정 (권장)** | `.\scripts\Repair-HermesTaskPython.ps1` | 기존 작업의 트리거·계정·일정을 그대로 두고 실행 파일만 교체함 |
| B. 신규 등록 | `.\scripts\Install-HermesTasks.ps1 -Force` | 작업이 삭제됐거나 정의가 손상된 경우 |
| C. 수동 교정 | 작업 스케줄러 → 속성 → 동작 → 편집 | 스크립트 실행이 불가한 경우 |

방식 A 동작 내용

1. 실행 가능한 Python 3 절대경로 탐색 (`.venv` → `py -3` → `PATH` → 표준 설치 위치 순)
   - `WindowsApps` 경로 및 0바이트 파일은 **자동 배제함**
   - 후보마다 `python -c "import sys;print(...)"` 를 실제 실행해 검증함
2. 기존 작업 정의를 `backup\scheduled-tasks\작업명-일시.xml` 로 백업함
3. 실행 파일·인수·시작 위치만 교체함 (트리거·계정·일정 불변)
4. 노트북 신뢰성 옵션 적용
   - `StartWhenAvailable` — 노트북이 꺼져 있어 놓친 일정을 복귀 후 보충 실행함
   - `WakeToRun` — 절전 상태에서 깨워 실행함
   - `AllowStartIfOnBatteries` — 배터리 상태에서도 실행함
   - 실패 시 5분 간격 3회 재시도

### 3.2 검증 순서 (반드시 이 순서)

```powershell
.\scripts\Repair-HermesTaskPython.ps1 -WhatIf   # 1. 변경 예정 내용만 확인
.\scripts\Repair-HermesTaskPython.ps1           # 2. 교정 적용(백업 자동)
.\scripts\Test-HermesRelay.ps1                  # 3. 진단 + 발송 없는 시험
.\scripts\Test-HermesRelay.ps1 -Send            # 4. 통과 시 실제 발송
Start-ScheduledTask -TaskName 'HermesDailyReportRelay'   # 5. 예약 작업 경로로 최종 확인
```

### 3.3 Google Drive 16:00 작업 처리

- 현재 상태: 사용자 요청에 따라 **일시정지 유지**
- 재개 시점 판단 후 절차
  1. `config.gdrive.example.json` → `config.gdrive.json` 복사·수정
  2. `.\scripts\Install-HermesTasks.ps1 -EnableGDrive`
  3. `.\scripts\Test-HermesRelay.ps1 -ConfigPath .\config.gdrive.json`
- 유의: Google Drive 스트리밍 드라이브(`G:`)는 **해당 사용자 로그온 세션에서만 보임**
  - 예약 작업 계정이 다르면 OneDrive 사례와 동일한 실패가 재발함

## 4. 리스크 요소

| 리스크 | 영향 | 대응 |
|---|---|---|
| 노트북 절전·종료 | 17:45 작업 미실행 | `WakeToRun` + `StartWhenAvailable` + 로그온 시 보충 작업 |
| Python 재설치·버전 변경 시 경로 변동 | 동일 장애 재발 | 재설치 후 `Repair-HermesTaskPython.ps1` 재실행 |
| OneDrive 동기화 지연 | 보고 도착 지연 | 로그온 시 보충 작업이 회수함 |
| 조용한 실패(로그조차 없음) | 장애 인지 지연 | **매일 09시 생존 신고** 발송(`heartbeat`) — 신고가 끊기면 장애로 판단 |
| 예약 작업 계정 불일치 | OneDrive·Google Drive 경로 미인식 | `Install-HermesTasks.ps1` 이 현재 로그온 사용자로 등록함 |
| 텔레그램 첨부 50MB 상한 | 대용량 보고 전송 실패 | 상한 초과 시 본문+경로만 전송하고 로그에 기록함 |
