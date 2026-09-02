# 업무보고 텔레그램 중계 (Hermes Report Relay)

사무실 데스크탑에서 올라온 업무보고를 **텔레그램으로 중계**하는 자동화임.
현재 장애(“텔레그램으로 아무것도 오지 않음”)의 원인과 교정 절차를 함께 포함함.

두 가지 운영 방식을 제공함.

| 방식 | 실행 주체 | PC 전원 의존 | 봇 명령 | 용도 |
|---|---|---|---|---|
| **A. 노트북 중계** (`src/`, `scripts/`) | 노트북 Windows 예약 작업 | 있음 | 없음 | **현행 복구용** |
| **B. 구글드라이브** (`gas/`) | 구글 서버 (Apps Script) | **없음** | **있음** | 노트북을 없애는 방식 |

B는 노트북·데스크탑이 모두 꺼져 있어도 동작하며, 텔레그램에서 봇에게 `/보고`·`/상태` 같은 **지시도 보낼 수 있음**.
설치: [`docs/04_구글드라이브_PC없이_24시간.md`](docs/04_구글드라이브_PC없이_24시간.md)

---

## 1. 이번 장애의 원인

| 구분 | 내용 |
|---|---|
| 증상 | 예약 작업은 등록돼 있으나 텔레그램 수신 없음 |
| 원인 | **Windows 예약 작업의 Python 경로 문제** — 실행 파일이 `python`/`pythonw` 이름만 지정됐거나 Microsoft Store 스텁(`WindowsApps\python.exe`, 0바이트)을 가리킴 |
| 이유 | 예약 작업 세션에는 대화형 `PATH`가 없음. 이름만으로는 해석되지 않아 실행 즉시 실패함(`LastTaskResult` = `0x1` 또는 `0x2`) |
| 아님 | PowerShell 자체 문제 아님. 스크립트 로직 문제 아님 |
| 교정 | 두 예약 작업이 **절대경로 Python**을 쓰도록 재등록함 |

대상 예약 작업

- `HermesDailyReportRelay` — OneDrive 기준 매일 17:45 (현재 작동 대상)
- `HermesDailyReportRelayLogon` — 로그온 시 보충 실행
- `HermesGDriveReportRelay` — Google Drive 기준 매일 16:00 (**연결 보류로 일시정지 상태 유지**)

상세: [`docs/01_원인진단_예약작업_Python경로.md`](docs/01_원인진단_예약작업_Python경로.md)

---

## 2. 교정 절차 (노트북에서 이 순서대로 실행)

> **가장 쉬운 방법**: 저장소 폴더에서 `복구실행.cmd` 를 **더블클릭**하면 아래 1~3단계가 자동 진행됨.
> 각 단계마다 진행 여부를 되묻고, 실제 발송은 `발송시험.cmd` 로 분리해 두었음.

> 모두 **관리자 권한 PowerShell**에서 실행하기 바람.
> 예약 작업을 만든 계정과 **같은 사용자**로 로그인한 상태여야 OneDrive 경로가 보임.

```powershell
cd C:\Hermes\report-relay          # 저장소를 내려받은 위치

# 0) 설정 준비 (최초 1회)
Copy-Item config.example.json config.json
notepad config.json                # chat_id, watch_dirs(절대경로) 입력
setx TELEGRAM_BOT_TOKEN "봇토큰"    # 토큰은 파일 대신 환경변수 권장 — 이후 PowerShell 새로 열기

# 1) 무엇이 바뀔지만 확인 (실제 변경 없음)
powershell -ExecutionPolicy Bypass -File .\scripts\Repair-HermesTaskPython.ps1 -WhatIf

# 2) 실제 교정 — 기존 정의는 backup\scheduled-tasks 에 XML로 자동 백업됨
powershell -ExecutionPolicy Bypass -File .\scripts\Repair-HermesTaskPython.ps1

# 3) 발송 없는 시험 (진단 + dry-run)
powershell -ExecutionPolicy Bypass -File .\scripts\Test-HermesRelay.ps1

# 4) 3)이 통과했을 때만 실제 발송
powershell -ExecutionPolicy Bypass -File .\scripts\Test-HermesRelay.ps1 -Send

# 5) 예약 작업 자체를 즉시 실행해 최종 확인
Start-ScheduledTask -TaskName 'HermesDailyReportRelay'
Get-ScheduledTaskInfo -TaskName 'HermesDailyReportRelay' | Select-Object LastRunTime, LastTaskResult
```

`LastTaskResult` 판독

| 값 | 의미 |
|---|---|
| `0` | 정상 |
| `0x1` | 스크립트 예외 또는 실행 파일 경로 오류 → `logs\relay.log` 확인 |
| `0x2` | 실행 파일을 찾을 수 없음 → **이번 장애의 코드**. 절대경로 재등록 필요 |
| `0x41301` | 실행 중 |
| `0x41303` | 아직 실행된 적 없음 |

예약 작업이 아예 없으면 신규 등록:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\Install-HermesTasks.ps1 -Force
```

---

## 3. 구성

```
run_relay.py                       예약 작업이 호출하는 진입 스크립트(절대경로로 지정)
config.example.json                OneDrive 기준 설정 예시
config.gdrive.example.json         Google Drive 기준 설정 예시(보류 작업용)
src/relay/
  config.py                        설정 로딩·검증(환경변수 우선)
  watcher.py                       감시 폴더에서 전송 대상 선별
  state.py                         중복 전송 방지(경로+크기+수정시각+해시)
  preview.py                       hwpx·docx·xlsx·pdf·txt 본문 미리보기 추출
  telegram.py                      Bot API 클라이언트(표준 라이브러리만 사용)
  doctor.py                        8단계 장애 원인 진단
  main.py                          once / watch / doctor 모드
scripts/
  HermesCommon.ps1                 공용 함수(절대경로 Python 탐지 등)
  Repair-HermesTaskPython.ps1      기존 예약 작업의 Python 경로 교정  ← 이번 장애 대응
  Install-HermesTasks.ps1          예약 작업 신규 등록
  Test-HermesRelay.ps1             진단 → 무발송 시험 → 실제 발송
gas/
  Code.gs                          구글드라이브 중계 본체(PC 없이 24시간)
  Commands.gs                      봇 양방향 명령 계층(/보고 /상태 /목록 …)
  appsscript.json                  Apps Script 매니페스트(권한·시간대)
복구실행.cmd                        더블클릭 복구 — 교정 → 진단 → 무발송 시험
발송시험.cmd                        확인 후 실제 텔레그램 발송
예약작업확인.cmd                    등록 경로·최근 결과 확인 및 즉시 실행
tests/test_relay.py                단위 시험 23건
docs/                              원인 진단·점검표·전환 방식·GitHub 로그인 정리
```

**외부 라이브러리 없이 동작함**(Python 3.9+ 표준 라이브러리만 사용).
`.xlsx`·`.pdf` 본문 미리보기가 필요하면 선택 설치:

```powershell
python -m pip install openpyxl pypdf
```

미설치 시에도 중계는 정상 동작하며, 해당 형식은 미리보기 없이 파일만 첨부함.

---

## 4. 실행 모드

| 명령 | 용도 |
|---|---|
| `python run_relay.py once --config config.json` | 1회 실행 — 예약 작업용 |
| `python run_relay.py once --config config.json --dry-run` | 발송 없는 시험 |
| `python run_relay.py once --config config.json --resend` | 전송 이력 무시하고 재전송 |
| `python run_relay.py watch --config config.json` | 상주 감시(기본 60초 주기) |
| `python run_relay.py doctor --config config.json` | 8단계 원인 진단 |

---

## 5. 설정 시 반드시 지킬 것

1. **절대경로만 사용함** — `%OneDrive%`, `%USERPROFILE%` 등 환경변수는 예약 작업 세션에 없음
2. **매핑 드라이브(`Z:`) 금지** — 예약 작업 세션에는 매핑이 없음. UNC 경로(`\\PC명\공유폴더`) 사용
3. **봇에게 `/start` 1회 발송 필수** — 봇은 먼저 말을 걸 수 없어, 그 전에는 `chat_id`가 조회되지 않음
4. **토큰은 환경변수로** — `config.json` 은 `.gitignore` 로 제외돼 있으나 환경변수가 더 안전함
5. **그룹 → 슈퍼그룹 전환 시 `chat_id` 변경됨** — `-100...` 형태로 다시 확인해야 함

---

## 6. 관련 문서

- [`docs/01_원인진단_예약작업_Python경로.md`](docs/01_원인진단_예약작업_Python경로.md) — 이번 장애 원인·교정 근거
- [`docs/02_텔레그램_미수신_점검표.md`](docs/02_텔레그램_미수신_점검표.md) — 계층별 원인 판별표
- [`docs/03_깃허브_구글로그인.md`](docs/03_깃허브_구글로그인.md) — GitHub 구글 로그인 가능 여부 및 대안
- [`docs/04_구글드라이브_PC없이_24시간.md`](docs/04_구글드라이브_PC없이_24시간.md) — 노트북 없이 운영하는 방식·봇 명령 설치

---

## 7. 시험

```bash
python -m unittest discover -s tests -v
```
