@echo off
chcp 65001 > nul
setlocal

REM ============================================================
REM  실제 텔레그램 발송 시험
REM  ※ 복구실행.cmd 가 정상 통과한 뒤에만 실행하기 바람
REM ============================================================

cd /d "%~dp0"

echo.
echo ============================================================
echo  실제 텔레그램 발송을 진행함.
echo ============================================================
choice /C YN /M "지금 실제로 보내시겠습니까"
if errorlevel 2 goto :cancel

powershell -NoProfile -ExecutionPolicy Bypass -File ".\scripts\Test-HermesRelay.ps1" -Send
if errorlevel 1 goto :fail

echo.
echo ============================================================
echo  발송 완료. 텔레그램 수신 여부를 직접 확인하기 바람.
echo.
echo  수신됐다면 예약 작업 경로로 최종 확인:
echo    예약작업확인.cmd
echo ============================================================
goto :end

:fail
echo.
echo  발송 중 오류 발생 - logs\relay.log 를 확인하기 바람.
goto :end

:cancel
echo.
echo  사용자가 취소함. 발송하지 않았음.

:end
echo.
pause
endlocal
