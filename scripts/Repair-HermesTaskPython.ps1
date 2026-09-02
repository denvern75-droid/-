<#
.SYNOPSIS
    Hermes 업무보고 중계 예약 작업이 '절대경로 Python'을 쓰도록 재등록함.

.DESCRIPTION
    증상: 예약 작업은 등록돼 있는데 텔레그램으로 아무것도 오지 않음.
    원인: 작업의 실행 파일이 'python' / 'pythonw' 같은 이름만 지정돼 있거나,
          Microsoft Store 스텁(WindowsApps\python.exe, 0바이트)을 가리킴.
          예약 작업 세션에는 대화형 PATH가 없어 그대로 실행 실패함(오류 0x1 / 0x2).

    본 스크립트는
      1) 실제 실행 가능한 python.exe(또는 pythonw.exe) 절대경로를 찾고
      2) 기존 작업 정의를 XML로 백업한 뒤
      3) 작업의 실행 파일·인수·시작 위치만 교체하고
      4) 24시간 노트북 환경에 맞는 신뢰성 옵션(절전 복귀·놓친 작업 재실행)을 켬
    트리거·계정·일정은 건드리지 않음.

.PARAMETER TaskName
    대상 예약 작업 이름. 기본값은 Hermes 중계 작업 2종임.

.PARAMETER PythonPath
    사용할 python.exe 절대경로. 생략 시 자동 탐지함.

.PARAMETER ScriptRoot
    중계 스크립트가 있는 폴더(작업의 '시작 위치'). 생략 시 기존 값을 유지함.

.PARAMETER UseConsole
    지정 시 python.exe(콘솔 창 표시)를 사용함. 기본은 pythonw.exe(창 없음)임.

.PARAMETER WhatIf
    실제 변경 없이 바뀔 내용만 출력함.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\Repair-HermesTaskPython.ps1 -WhatIf

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\Repair-HermesTaskPython.ps1 `
        -PythonPath "C:\Users\SAMSUNG\AppData\Local\Programs\Python\Python312\python.exe" `
        -ScriptRoot "C:\Hermes\report-relay"
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [string[]] $TaskName = @('HermesDailyReportRelay', 'HermesDailyReportRelayLogon'),
    [string]   $PythonPath,
    [string]   $ScriptRoot,
    [switch]   $UseConsole,
    [string]   $BackupDir = (Join-Path $PSScriptRoot '..\backup\scheduled-tasks')
)

# 공용 함수(Python 탐지·출력 헬퍼·TLS/인코딩 설정) 불러옴
. (Join-Path $PSScriptRoot 'HermesCommon.ps1')

# ------------------------------------------------------------------ 1. Python
Write-Step '1. 실행 가능한 Python 절대경로 확인'

$repoRoot = if ($ScriptRoot) { $ScriptRoot } else { (Resolve-Path (Join-Path $PSScriptRoot '..')).Path }

if ($PythonPath) {
    if (-not (Test-RealPython -Path $PythonPath)) {
        Write-Bad "지정한 경로가 실행 가능한 Python 3 이 아님: $PythonPath"
        Write-Host  "        (Microsoft Store 스텁이거나 경로 오류임. python.org 정식 설치본 경로를 지정하기 바람)"
        exit 2
    }
    $PythonPath = (Resolve-Path -LiteralPath $PythonPath).Path
} else {
    $PythonPath = Find-PythonPath -Root $repoRoot
    if (-not $PythonPath) {
        Write-Bad '실행 가능한 Python 3 을 찾지 못함'
        Write-Host  '        조치: python.org 설치본을 설치하거나 -PythonPath 로 절대경로를 직접 지정하기 바람'
        exit 2
    }
}
Write-Ok "python.exe: $PythonPath"

# 콘솔 창 없이 돌리려면 pythonw.exe 사용 (로그는 파일로 남음)
$exeToUse = $PythonPath
if (-not $UseConsole) {
    $pythonw = Join-Path (Split-Path -Parent $PythonPath) 'pythonw.exe'
    if (Test-Path -LiteralPath $pythonw) {
        $exeToUse = $pythonw
        Write-Ok "예약 실행용: $exeToUse (콘솔 창 없음)"
    } else {
        Write-Warn2 'pythonw.exe 없음 — python.exe 로 진행함(실행 시 콘솔 창이 잠깐 뜸)'
    }
}

# ------------------------------------------------------------------ 2. 백업
Write-Step '2. 기존 작업 정의 백업'
if (-not (Test-Path -LiteralPath $BackupDir)) {
    New-Item -ItemType Directory -Path $BackupDir -Force | Out-Null
}
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'

# ------------------------------------------------------------------ 3. 교체
Write-Step '3. 예약 작업 실행 경로 교체'
$changed = 0
$missing = @()

foreach ($name in $TaskName) {
    $task = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
    if (-not $task) {
        Write-Warn2 "$name — 등록되지 않음(건너뜀)"
        $missing += $name
        continue
    }

    $backupFile = Join-Path $BackupDir "$name-$stamp.xml"
    (Export-ScheduledTask -TaskName $name -TaskPath $task.TaskPath) |
        Out-File -FilePath $backupFile -Encoding utf8
    Write-Ok "$name — 백업: $backupFile"

    $newActions = @()
    foreach ($action in $task.Actions) {
        $oldExe  = $action.Execute
        $oldArgs = $action.Arguments
        $oldCwd  = $action.WorkingDirectory

        Write-Host "        이전: `"$oldExe`" $oldArgs"
        Write-Host "        시작 위치: $oldCwd"

        # Python 실행 액션만 교체함(다른 액션은 원형 유지)
        $isPython = $oldExe -match '(?i)(^|\\)(python|pythonw|py)(\.exe)?$'
        if ($isPython) {
            $cwd = if ($ScriptRoot) { $ScriptRoot }
                   elseif (-not [string]::IsNullOrWhiteSpace($oldCwd)) { $oldCwd }
                   else { $repoRoot }
            $newActions += New-ScheduledTaskAction -Execute $exeToUse `
                                                   -Argument $oldArgs `
                                                   -WorkingDirectory $cwd
            Write-Host "        이후: `"$exeToUse`" $oldArgs" -ForegroundColor Green
            Write-Host "        시작 위치: $cwd" -ForegroundColor Green
        } else {
            Write-Warn2 'Python 액션이 아니므로 원형 유지함'
            # WorkingDirectory 가 비어 있으면 New-ScheduledTaskAction 이 오류를 내므로 보강함
            $keepCwd = if ([string]::IsNullOrWhiteSpace($oldCwd)) { $repoRoot } else { $oldCwd }
            $newActions += New-ScheduledTaskAction -Execute $oldExe `
                                                   -Argument $oldArgs `
                                                   -WorkingDirectory $keepCwd
        }
    }

    # 24시간 노트북 신뢰성 옵션 — 절전 복귀·놓친 일정 보충·실패 재시도
    $settings = $task.Settings
    $settings.StartWhenAvailable        = $true    # 노트북이 꺼져 있어 놓친 일정 보충 실행
    $settings.WakeToRun                 = $true    # 절전 상태에서 깨워 실행
    $settings.DisallowStartIfOnBatteries= $false   # 배터리 상태에서도 실행
    $settings.StopIfGoingOnBatteries    = $false
    $settings.ExecutionTimeLimit        = 'PT1H'
    $settings.RestartCount              = 3        # 실패 시 5분 간격 3회 재시도
    $settings.RestartInterval           = 'PT5M'

    if ($PSCmdlet.ShouldProcess($name, '실행 경로 및 신뢰성 설정 변경')) {
        Set-ScheduledTask -TaskName $name -TaskPath $task.TaskPath `
                          -Action $newActions -Settings $settings | Out-Null
        Write-Ok "$name — 재등록 완료"
        $changed++
    } else {
        Write-Warn2 "$name — WhatIf 모드: 실제 변경 없음"
    }
}

# ------------------------------------------------------------------ 4. 요약
Write-Step '4. 결과 요약'
Write-Host "  대상 작업 : $($TaskName -join ', ')"
Write-Host "  변경 완료 : $changed 건"
if ($missing.Count -gt 0) {
    Write-Warn2 "미등록 작업: $($missing -join ', ') → Install-HermesTasks.ps1 로 신규 등록 필요함"
}
Write-Host ""
Write-Host "  다음 순서(반드시 이 순서로 진행하기 바람)" -ForegroundColor Cyan
Write-Host "   1) 발송 없는 시험 : powershell -ExecutionPolicy Bypass -File .\Test-HermesRelay.ps1"
Write-Host "   2) 통과 시 실제 발송 : powershell -ExecutionPolicy Bypass -File .\Test-HermesRelay.ps1 -Send"
Write-Host "   3) 예약 작업 즉시 실행 : Start-ScheduledTask -TaskName 'HermesDailyReportRelay'"
Write-Host "   4) 결과 확인 : Get-ScheduledTaskInfo -TaskName 'HermesDailyReportRelay' | Select LastRunTime,LastTaskResult"
Write-Host "      LastTaskResult 0 = 정상 / 0x1·0x2 = 실행 파일 경로 오류 / 0x41301 = 실행 중"
