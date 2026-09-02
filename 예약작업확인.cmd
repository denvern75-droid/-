@echo off
chcp 65001 > nul
setlocal

REM ============================================================
REM  예약 작업 상태 확인 및 즉시 실행
REM  예약 작업 경로로 실제 발송까지 되는지 최종 확인함
REM ============================================================

cd /d "%~dp0"

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  ". '.\scripts\HermesCommon.ps1';" ^
  "foreach ($n in @('HermesDailyReportRelay','HermesDailyReportRelayLogon','HermesGDriveReportRelay')) {" ^
  "  $t = Get-ScheduledTask -TaskName $n -ErrorAction SilentlyContinue;" ^
  "  if (-not $t) { Write-Warn2 \"$n - 미등록\"; continue };" ^
  "  $i = Get-ScheduledTaskInfo -TaskName $n;" ^
  "  Write-Host \"`n[$n]\" -ForegroundColor Cyan;" ^
  "  Write-Host ('  상태      : ' + $t.State);" ^
  "  Write-Host ('  실행 파일 : ' + $t.Actions[0].Execute);" ^
  "  Write-Host ('  인수      : ' + $t.Actions[0].Arguments);" ^
  "  Write-Host ('  시작 위치 : ' + $t.Actions[0].WorkingDirectory);" ^
  "  Write-Host ('  최근 실행 : ' + $i.LastRunTime);" ^
  "  Write-Host ('  최근 결과 : ' + (Get-TaskResultText -Code $i.LastTaskResult));" ^
  "  Write-Host ('  다음 실행 : ' + $i.NextRunTime);" ^
  "}"

echo.
choice /C YN /M "지금 예약 작업을 즉시 실행해 보시겠습니까"
if errorlevel 2 goto :end

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "Start-ScheduledTask -TaskName 'HermesDailyReportRelay';" ^
  "Start-Sleep -Seconds 20;" ^
  ". '.\scripts\HermesCommon.ps1';" ^
  "$i = Get-ScheduledTaskInfo -TaskName 'HermesDailyReportRelay';" ^
  "Write-Host ('`n실행 결과 : ' + (Get-TaskResultText -Code $i.LastTaskResult)) -ForegroundColor Yellow"

echo.
echo  결과가 '정상 종료' 이고 텔레그램에 도착했으면 복구 완료임.

:end
echo.
pause
endlocal
