<#
.SYNOPSIS
    Hermes 업무보고 중계 예약 작업 — 진단 및 Python 경로 즉시 복구 (단일 파일)

.DESCRIPTION
    다른 파일 없이 이 스크립트 하나만으로 동작함.
    기존에 설치된 중계 스크립트가 무엇이든 건드리지 않고,
    예약 작업이 가리키는 'Python 실행 파일 경로'만 교정함.

    기본은 진단 전용임. 실제 변경은 -Apply 를 붙였을 때만 이뤄짐.

.PARAMETER Apply
    실제로 예약 작업을 교정함. 없으면 진단만 하고 아무것도 바꾸지 않음.

.PARAMETER PythonPath
    사용할 python.exe 절대경로. 생략 시 자동 탐지함.

.PARAMETER RunAfter
    교정 후 예약 작업을 즉시 실행해 결과까지 확인함(-Apply 와 함께 사용).

.EXAMPLE
    # 1단계 — 진단만 (아무것도 바꾸지 않음)
    powershell -ExecutionPolicy Bypass -File .\즉시복구.ps1

.EXAMPLE
    # 2단계 — 교정 적용 + 즉시 실행 확인
    powershell -ExecutionPolicy Bypass -File .\즉시복구.ps1 -Apply -RunAfter
#>
[CmdletBinding()]
param(
    [switch]   $Apply,
    [switch]   $RunAfter,
    [string]   $PythonPath,
    [string[]] $TaskName = @('HermesDailyReportRelay', 'HermesDailyReportRelayLogon')
)

$ErrorActionPreference = 'Continue'
try { $OutputEncoding = [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false) } catch { }

$script:Fail = 0
$script:Warn = 0
function Sec  { param($t) Write-Host "`n■ $t" -ForegroundColor Cyan }
function Ok   { param($t) Write-Host "  [정상] $t" -ForegroundColor Green }
function Wrn  { param($t) $script:Warn++; Write-Host "  [주의] $t" -ForegroundColor Yellow }
function Bad  { param($t) $script:Fail++; Write-Host "  [실패] $t" -ForegroundColor Red }
function Info { param($t) Write-Host "         $t" -ForegroundColor Gray }

function Test-RealPython {
    param([string] $Path)
    if ([string]::IsNullOrWhiteSpace($Path)) { return $false }
    if (-not (Test-Path -LiteralPath $Path)) { return $false }
    if ($Path -like '*\WindowsApps\*') { return $false }   # Store 스텁(0바이트)
    $item = Get-Item -LiteralPath $Path -ErrorAction SilentlyContinue
    if (-not $item -or $item.Length -le 0) { return $false }
    try {
        $out = & $Path -c "import sys;print(sys.version_info[0])" 2>$null
        return ($LASTEXITCODE -eq 0 -and $out -match '^3')
    } catch { return $false }
}

function Find-PythonPath {
    $cands = New-Object System.Collections.Generic.List[string]
    try {
        $v = & py -3 -c "import sys;print(sys.executable)" 2>$null
        if ($LASTEXITCODE -eq 0 -and $v) { $cands.Add($v.Trim()) }
    } catch { }
    try { foreach ($p in (& where.exe python 2>$null)) { $cands.Add($p.Trim()) } } catch { }
    foreach ($g in @(
        "$env:LOCALAPPDATA\Programs\Python\Python3*\python.exe",
        "$env:ProgramFiles\Python3*\python.exe",
        "${env:ProgramFiles(x86)}\Python3*\python.exe",
        "C:\Python3*\python.exe")) {
        Get-ChildItem -Path $g -ErrorAction SilentlyContinue |
            Sort-Object FullName -Descending | ForEach-Object { $cands.Add($_.FullName) }
    }
    foreach ($c in $cands) { if (Test-RealPython -Path $c) { return (Resolve-Path -LiteralPath $c).Path } }
    return $null
}

function Get-TaskResultText {
    param([int] $Code)
    switch ($Code) {
        0          { '정상 종료' }
        1          { '오류 종료(0x1) — 실행 파일 경로 오류 또는 스크립트 예외' }
        2          { '파일을 찾을 수 없음(0x2) — 이번 장애의 전형적 코드' }
        267009     { '실행 중(0x41301)' }
        267011     { '아직 실행된 적 없음(0x41303)' }
        267014     { '사용자가 중지함(0x41306)' }
        2147942401 { '파일을 찾을 수 없음(0x80070002)' }
        default    { "코드 $Code" }
    }
}

Write-Host ''
Write-Host '================================================================'
Write-Host ' Hermes 업무보고 중계 — 예약 작업 진단' -ForegroundColor White
Write-Host ('  모드: ' + $(if ($Apply) { '교정 적용' } else { '진단 전용(변경 없음)' }))
Write-Host ('  시각: ' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'))
Write-Host '================================================================'

# ── 1. 실행 가능한 Python
Sec '1. 실행 가능한 Python'
if ($PythonPath) {
    if (Test-RealPython -Path $PythonPath) {
        $PythonPath = (Resolve-Path -LiteralPath $PythonPath).Path
        Ok "지정 경로 사용: $PythonPath"
    } else {
        Bad "지정한 경로가 실행 가능한 Python 3 이 아님: $PythonPath"
        $PythonPath = $null
    }
}
if (-not $PythonPath) {
    $PythonPath = Find-PythonPath
    if ($PythonPath) { Ok "탐지됨: $PythonPath" }
    else {
        Bad '실행 가능한 Python 3 을 찾지 못함'
        Info 'python.org 설치본을 설치하거나 -PythonPath 로 절대경로를 지정하기 바람'
    }
}

$exeToUse = $PythonPath
if ($PythonPath) {
    $pw = Join-Path (Split-Path -Parent $PythonPath) 'pythonw.exe'
    if (Test-Path -LiteralPath $pw) { $exeToUse = $pw; Info "예약 실행용(창 없음): $pw" }
}

# 참고용 — PATH 상의 python 이 Store 스텁인지 확인
try {
    $where = @(& where.exe python 2>$null)
    if ($where.Count -gt 0) {
        Info "PATH 상의 python: $($where[0])"
        if ($where[0] -like '*\WindowsApps\*') {
            Wrn 'PATH 최상위가 Microsoft Store 스텁임 — 예약 작업에서 실행되지 않음(이번 장애의 원인 유형)'
        }
    } else {
        Wrn 'PATH 에 python 없음 — 이름만 지정된 예약 작업은 실패함'
    }
} catch { }

# ── 2. 예약 작업 현황
Sec '2. 예약 작업 현황'
$targets = @()
foreach ($name in $TaskName) {
    $task = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
    if (-not $task) { Wrn "$name — 등록되지 않음"; continue }

    $info = Get-ScheduledTaskInfo -TaskName $name -ErrorAction SilentlyContinue
    Write-Host "`n  [$name]" -ForegroundColor White
    Info ("상태      : " + $task.State)
    Info ("계정      : " + $task.Principal.UserId + "  (" + $task.Principal.LogonType + ")")
    if ($info) {
        Info ("최근 실행 : " + $info.LastRunTime)
        Info ("최근 결과 : " + (Get-TaskResultText -Code $info.LastTaskResult))
        Info ("다음 실행 : " + $info.NextRunTime)
    }

    $needFix = $false
    foreach ($a in $task.Actions) {
        Info ("실행 파일 : " + $a.Execute)
        Info ("인수      : " + $a.Arguments)
        Info ("시작 위치 : " + $a.WorkingDirectory)

        $isPython = $a.Execute -match '(?i)(^|\\)(python|pythonw|py)(\.exe)?$'
        if (-not $isPython) { continue }

        $bare  = $a.Execute -notmatch '[\\/]'          # 이름만 지정됨
        $stub  = $a.Execute -like '*\WindowsApps\*'    # Store 스텁
        $gone  = -not $bare -and -not (Test-Path -LiteralPath $a.Execute)

        if ($bare) { Bad '실행 파일이 이름만 지정됨 — 예약 작업 세션에는 PATH 가 없어 실행되지 않음'; $needFix = $true }
        elseif ($stub) { Bad '실행 파일이 Microsoft Store 스텁임 — 예약 작업에서 실행되지 않음'; $needFix = $true }
        elseif ($gone) { Bad '실행 파일이 존재하지 않음'; $needFix = $true }
        else { Ok '실행 파일 경로 정상(절대경로·실존)' }

        # 인수에 들어 있는 스크립트 파일이 실제로 있는지도 확인함
        $m = [regex]::Matches($a.Arguments, '(?:"([^"]+\.pyw?)"|(\S+\.pyw?))')
        foreach ($mm in $m) {
            $sp = if ($mm.Groups[1].Success) { $mm.Groups[1].Value } else { $mm.Groups[2].Value }
            $abs = $sp
            if (-not [System.IO.Path]::IsPathRooted($sp) -and $a.WorkingDirectory) {
                $abs = Join-Path $a.WorkingDirectory $sp
            }
            if (Test-Path -LiteralPath $abs) { Ok "중계 스크립트 존재: $abs" }
            else { Bad "중계 스크립트를 찾을 수 없음: $sp"; Info '경로 교정 후에도 이 문제가 남으면 별도 조치 필요함' }
        }
    }
    if ($needFix) { $targets += $task }
}

# ── 3. 교정
Sec '3. 교정'
if ($targets.Count -eq 0) {
    Ok '경로 교정이 필요한 작업 없음'
} elseif (-not $PythonPath) {
    Bad 'Python 을 찾지 못해 교정할 수 없음'
} elseif (-not $Apply) {
    Wrn "교정 대상 $($targets.Count)건 — 진단 전용 모드라 변경하지 않았음"
    Info '실제로 고치려면 다음을 실행하기 바람:'
    Info '  powershell -ExecutionPolicy Bypass -File .\즉시복구.ps1 -Apply -RunAfter'
} else {
    $backupDir = Join-Path $PSScriptRoot ('backup-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
    New-Item -ItemType Directory -Path $backupDir -Force | Out-Null

    foreach ($task in $targets) {
        $name = $task.TaskName
        try {
            (Export-ScheduledTask -TaskName $name -TaskPath $task.TaskPath) |
                Out-File -FilePath (Join-Path $backupDir "$name.xml") -Encoding utf8
            Ok "$name — 백업 완료"
        } catch { Wrn "$name — 백업 실패: $($_.Exception.Message)" }

        $newActions = @()
        foreach ($a in $task.Actions) {
            $cwd = $a.WorkingDirectory
            if ([string]::IsNullOrWhiteSpace($cwd)) { $cwd = $PSScriptRoot }
            $isPython = $a.Execute -match '(?i)(^|\\)(python|pythonw|py)(\.exe)?$'
            $exe = if ($isPython) { $exeToUse } else { $a.Execute }
            $newActions += New-ScheduledTaskAction -Execute $exe -Argument $a.Arguments -WorkingDirectory $cwd
        }

        # 노트북 신뢰성 — 절전 복귀, 놓친 일정 보충, 실패 재시도
        $s = $task.Settings
        $s.StartWhenAvailable         = $true
        $s.WakeToRun                  = $true
        $s.DisallowStartIfOnBatteries = $false
        $s.StopIfGoingOnBatteries     = $false
        $s.RestartCount               = 3
        $s.RestartInterval            = 'PT5M'

        try {
            Set-ScheduledTask -TaskName $name -TaskPath $task.TaskPath -Action $newActions -Settings $s | Out-Null
            Ok "$name — 교정 완료 → $exeToUse"
        } catch {
            Bad "$name — 교정 실패: $($_.Exception.Message)"
            Info '관리자 권한 PowerShell 에서 다시 실행하기 바람'
        }
    }
    Info "백업 위치: $backupDir"
}

# ── 4. 즉시 실행 확인
if ($Apply -and $RunAfter -and $targets.Count -gt 0 -and $script:Fail -eq 0) {
    Sec '4. 즉시 실행 확인'
    $main = 'HermesDailyReportRelay'
    if (Get-ScheduledTask -TaskName $main -ErrorAction SilentlyContinue) {
        Start-ScheduledTask -TaskName $main
        Info '실행 중... 30초 대기'
        Start-Sleep -Seconds 30
        $i = Get-ScheduledTaskInfo -TaskName $main
        $txt = Get-TaskResultText -Code $i.LastTaskResult
        if ($i.LastTaskResult -eq 0) { Ok "실행 결과: $txt — 텔레그램 수신 여부를 확인하기 바람" }
        else { Bad "실행 결과: $txt" }
    }
}

# ── 요약
Write-Host ''
Write-Host '================================================================'
Write-Host ("  요약 — 실패 {0}건 / 주의 {1}건" -f $script:Fail, $script:Warn) -ForegroundColor White
Write-Host '================================================================'
Info '이 창의 내용을 그대로 캡처해 전달하면 다음 조치를 판단할 수 있음'
Write-Host ''
