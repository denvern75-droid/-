@echo off
chcp 65001 > nul
setlocal

REM ============================================================
REM  업무보고 텔레그램 중계 — 장애 복구 (더블클릭 실행)
REM
REM  하는 일
REM    1) 예약 작업의 Python 경로를 절대경로로 교정함 (변경 전 자동 백업)
REM    2) 진단 + 발송 없는 시험을 실행함
REM    3) 실제 발송은 하지 않음 — 결과 확인 후 별도 실행
REM ============================================================

cd /d "%~dp0"

echo.
echo ============================================================
echo  업무보고 텔레그램 중계 - 장애 복구
echo ============================================================
echo.
echo  [1/3] 변경 예정 내용 확인 (실제 변경 없음)
echo ------------------------------------------------------------
powershell -NoProfile -ExecutionPolicy Bypass -File ".\scripts\Repair-HermesTaskPython.ps1" -WhatIf
if errorlevel 2 goto :fail

echo.
echo ------------------------------------------------------------
echo  위 내용대로 예약 작업을 교정함. 기존 정의는 backup 폴더에 백업됨.
echo ------------------------------------------------------------
choice /C YN /M "계속 진행하시겠습니까"
if errorlevel 2 goto :cancel

echo.
echo  [2/3] 예약 작업 교정 적용
echo ------------------------------------------------------------
powershell -NoProfile -ExecutionPolicy Bypass -File ".\scripts\Repair-HermesTaskPython.ps1"
if errorlevel 2 goto :fail

echo.
echo  [3/3] 진단 + 발송 없는 시험
echo ------------------------------------------------------------
powershell -NoProfile -ExecutionPolicy Bypass -File ".\scripts\Test-HermesRelay.ps1"
if errorlevel 1 goto :testfail

echo.
echo ============================================================
echo  복구 완료. 아직 실제 발송은 하지 않았음.
echo.
echo  실제로 텔레그램에 보내려면 아래를 실행하기 바람:
echo    발송시험.cmd
echo ============================================================
goto :end

:testfail
echo.
echo ============================================================
echo  시험 단계에서 문제가 발견됨.
echo  위 [실패] 항목과 logs\relay.log 를 확인하기 바람.
echo ============================================================
goto :end

:fail
echo.
echo ============================================================
echo  교정 실패 - 실행 가능한 Python 을 찾지 못했을 수 있음.
echo  python.org 설치본 설치 후 다시 실행하기 바람.
echo ============================================================
goto :end

:cancel
echo.
echo  사용자가 취소함. 변경된 내용 없음.

:end
echo.
pause
endlocal
