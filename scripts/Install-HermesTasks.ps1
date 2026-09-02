<#
.SYNOPSIS
    Hermes 업무보고 중계 예약 작업을 신규 등록함(절대경로 Python 사용).

.DESCRIPTION
    등록 대상
      - HermesDailyReportRelay       : 매일 지정 시각 1회 실행(기본 17:45, OneDrive 기준)
      - HermesDailyReportRelayLogon  : 로그온 시 1회 실행(놓친 보고 보충)
      - HermesGDriveReportRelay      : Google Drive 기준 매일 16:00 (기본 '사용 안 함' 상태로 등록)

    이미 같은 이름의 작업이 있으면 -Force 없이는 덮어쓰지 않음.
    기존 작업의 '경로만' 고치려면 Repair-HermesTaskPython.ps1 을 사용하기 바람.

.PARAMETER DailyTime
    OneDrive 기준 일일 실행 시각. 기본 17:45.

.PARAMETER GDriveTime
    Google Drive 기준 일일 실행 시각. 기본 16:00.

.PARAMETER EnableGDrive
    지정 시 Google Drive 작업을 '사용' 상태로 등록함. 기본은 사용 안 함(연결 보류 상태 유지).

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\Install-HermesTasks.ps1 -Force
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [string] $DailyTime  = '17:45',
    [string] $GDriveTime = '16:00',
    [string] $PythonPath,
    [string] $ScriptRoot,
    [string] $ConfigPath,
    [string] $GDriveConfigPath,
    [switch] $EnableGDrive,
    [switch] $UseConsole,
    [switch] $Force
)

. (Join-Path $PSScriptRoot 'HermesCommon.ps1')

$repoRoot = if ($ScriptRoot) { $ScriptRoot } else { (Resolve-Path (Join-Path $PSScriptRoot '..')).Path }
if (-not $ConfigPath)       { $ConfigPath       = Join-Path $repoRoot 'config.json' }
if (-not $GDriveConfigPath) { $GDriveConfigPath = Join-Path $repoRoot 'config.gdrive.json' }

Write-Step '1. 절대경로 Python 확인'
if (-not $PythonPath) { $PythonPath = Find-PythonPath -Root $repoRoot }
if (-not $PythonPath) {
    Write-Bad '실행 가능한 Python 3 을 찾지 못함 — -PythonPath 로 직접 지정하기 바람'
    exit 2
}
if (-not (Test-RealPython -Path $PythonPath)) {
    Write-Bad "실행 불가한 Python 경로임: $PythonPath"
    exit 2
}
$exeToUse = if ($UseConsole) { $PythonPath } else { Get-PythonwIfAvailable -PythonPath $PythonPath }
Write-Ok "실행 파일: $exeToUse"
Write-Ok "시작 위치: $repoRoot"

# 예약 작업 세션에는 사용자 PATH·PYTHONPATH 가 없으므로 -m 대신 절대경로 스크립트를 지정함
$entry = Join-Path $repoRoot 'run_relay.py'
if (-not (Test-Path -LiteralPath $entry)) {
    Write-Bad "진입 스크립트 없음: $entry"
    exit 2
}

function Register-HermesTask {
    param(
        [string]   $Name,
        [string]   $Description,
        [object[]] $Triggers,
        [string]   $Config,
        [bool]     $Enable = $true
    )

    $existing = Get-ScheduledTask -TaskName $Name -ErrorAction SilentlyContinue
    if ($existing -and -not $Force) {
        Write-Warn2 "$Name — 이미 등록됨(건너뜀). 덮어쓰려면 -Force, 경로만 고치려면 Repair 스크립트 사용"
        return
    }

    $argument = '"{0}" once --config "{1}"' -f $entry, $Config
    $action = New-ScheduledTaskAction -Execute $exeToUse -Argument $argument -WorkingDirectory $repoRoot

    $settings = New-ScheduledTaskSettingsSet `
        -StartWhenAvailable `
        -WakeToRun `
        -AllowStartIfOnBatteries `
        -DontStopIfGoingOnBatteries `
        -ExecutionTimeLimit (New-TimeSpan -Hours 1) `
        -RestartCount 3 `
        -RestartInterval (New-TimeSpan -Minutes 5) `
        -MultipleInstances IgnoreNew
    $settings.Enabled = $Enable

    # 로그온한 사용자 계정으로 실행해야 OneDrive·매핑 경로가 보임(SYSTEM 계정은 보이지 않음)
    $principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" `
                                            -LogonType Interactive -RunLevel Limited

    if ($PSCmdlet.ShouldProcess($Name, '예약 작업 등록')) {
        if ($existing) { Unregister-ScheduledTask -TaskName $Name -Confirm:$false }
        Register-ScheduledTask -TaskName $Name -Description $Description `
            -Action $action -Trigger $Triggers -Settings $settings -Principal $principal | Out-Null
        $state = if ($Enable) { '사용' } else { '사용 안 함(보류)' }
        Write-Ok "$Name — 등록 완료 [$state]"
        Write-Host "        실행: `"$exeToUse`" $argument"
    }
}

Write-Step '2. 예약 작업 등록'

Register-HermesTask -Name 'HermesDailyReportRelay' `
    -Description "업무보고 일일 중계(OneDrive 기준 $DailyTime)" `
    -Triggers @(New-ScheduledTaskTrigger -Daily -At $DailyTime) `
    -Config $ConfigPath

Register-HermesTask -Name 'HermesDailyReportRelayLogon' `
    -Description '업무보고 중계 보충 실행(로그온 시 — 노트북이 꺼져 있어 놓친 보고 회수)' `
    -Triggers @(New-ScheduledTaskTrigger -AtLogOn) `
    -Config $ConfigPath

if (Test-Path -LiteralPath $GDriveConfigPath) {
    Register-HermesTask -Name 'HermesGDriveReportRelay' `
        -Description "업무보고 일일 중계(Google Drive 기준 $GDriveTime)" `
        -Triggers @(New-ScheduledTaskTrigger -Daily -At $GDriveTime) `
        -Config $GDriveConfigPath `
        -Enable ([bool]$EnableGDrive)
} else {
    Write-Warn2 "Google Drive 설정 파일 없음($GDriveConfigPath) — 해당 작업은 등록하지 않음"
    Write-Host  '        Google Drive 연결을 재개하려면 config.gdrive.json 을 만든 뒤 -EnableGDrive 로 다시 실행하기 바람'
}

Write-Step '3. 다음 순서'
Write-Host '   1) 발송 없는 시험 : .\Test-HermesRelay.ps1'
Write-Host '   2) 실제 발송 시험 : .\Test-HermesRelay.ps1 -Send'
Write-Host "   3) 예약 작업 즉시 실행 : Start-ScheduledTask -TaskName 'HermesDailyReportRelay'"
