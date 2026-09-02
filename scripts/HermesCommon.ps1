<#
    Hermes 중계 스크립트 공용 함수.
    각 스크립트에서 아래처럼 불러 씀:
        . (Join-Path $PSScriptRoot 'HermesCommon.ps1')
#>

$ErrorActionPreference = 'Stop'
# PS 5.1 기본값은 TLS 1.0 이라 api.telegram.org 호출이 실패함
try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch { }
# 한글 출력 깨짐 방지
try { $OutputEncoding = [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false) } catch { }

function Write-Step { param($Text) Write-Host "`n== $Text" -ForegroundColor Cyan }
function Write-Ok   { param($Text) Write-Host "  [정상] $Text" -ForegroundColor Green }
function Write-Warn2{ param($Text) Write-Host "  [주의] $Text" -ForegroundColor Yellow }
function Write-Bad  { param($Text) Write-Host "  [실패] $Text" -ForegroundColor Red }

function Test-RealPython {
    <# 실행 가능한 Python 3 인지 확인함. Microsoft Store 스텁(0바이트)은 거부함. #>
    param([string] $Path)
    if ([string]::IsNullOrWhiteSpace($Path)) { return $false }
    if (-not (Test-Path -LiteralPath $Path)) { return $false }
    if ($Path -like '*\WindowsApps\*') { return $false }
    $item = Get-Item -LiteralPath $Path -ErrorAction SilentlyContinue
    if (-not $item -or $item.Length -le 0) { return $false }
    try {
        $out = & $Path -c "import sys;print(sys.version_info[0])" 2>$null
        return ($LASTEXITCODE -eq 0 -and $out -match '^3')
    } catch { return $false }
}

function Find-PythonPath {
    <# 예약 작업에 넣을 수 있는 '절대경로' Python 을 우선순위대로 탐색함. #>
    param([string] $Root)

    $candidates = New-Object System.Collections.Generic.List[string]

    if ($Root) {
        $candidates.Add((Join-Path $Root '.venv\Scripts\python.exe'))
        $candidates.Add((Join-Path $Root 'venv\Scripts\python.exe'))
    }
    try {
        $viaPy = & py -3 -c "import sys;print(sys.executable)" 2>$null
        if ($LASTEXITCODE -eq 0 -and $viaPy) { $candidates.Add($viaPy.Trim()) }
    } catch { }
    try {
        foreach ($p in (& where.exe python 2>$null)) { $candidates.Add($p.Trim()) }
    } catch { }
    foreach ($g in @(
        "$env:LOCALAPPDATA\Programs\Python\Python3*\python.exe",
        "$env:ProgramFiles\Python3*\python.exe",
        "${env:ProgramFiles(x86)}\Python3*\python.exe",
        "C:\Python3*\python.exe"
    )) {
        Get-ChildItem -Path $g -ErrorAction SilentlyContinue |
            Sort-Object FullName -Descending |
            ForEach-Object { $candidates.Add($_.FullName) }
    }

    foreach ($c in $candidates) {
        if (Test-RealPython -Path $c) { return (Resolve-Path -LiteralPath $c).Path }
    }
    return $null
}

function Get-PythonwIfAvailable {
    <# 콘솔 창 없이 실행하기 위한 pythonw.exe 를 반환함. 없으면 원본 경로를 반환함. #>
    param([string] $PythonPath)
    $pythonw = Join-Path (Split-Path -Parent $PythonPath) 'pythonw.exe'
    if (Test-Path -LiteralPath $pythonw) { return $pythonw }
    return $PythonPath
}

function Get-TaskResultText {
    <# 예약 작업 LastTaskResult 코드를 한글 설명으로 바꿈. #>
    param([int] $Code)
    switch ($Code) {
        0        { '정상 종료' }
        1        { '오류 종료(0x1) — 실행 파일 경로 오류 또는 스크립트 예외' }
        2        { '파일을 찾을 수 없음(0x2) — 실행 파일/스크립트 절대경로 확인 필요함' }
        267009   { '실행 중(0x41301)' }
        267011   { '아직 실행된 적 없음(0x41303)' }
        267014   { '사용자가 중지함(0x41306)' }
        3221225786 { '강제 종료됨(0xC000013A)' }
        default  { "코드 $Code (0x{0:X})" -f $Code }
    }
}
