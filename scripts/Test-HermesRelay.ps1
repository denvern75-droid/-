<#
.SYNOPSIS
    중계 파이프라인을 단계별로 시험함. 기본은 '발송 없는 시험'임.

.DESCRIPTION
    순서
      1) 절대경로 Python 확인
      2) 진단(doctor) — 폴더 접근·네트워크·봇 인증·chat_id·예약 작업 상태
      3) 발송 없는 시험(--dry-run) — 무엇이 전송될지만 확인함
      4) -Send 지정 시에만 실제 텔레그램 발송
      5) 예약 작업 최근 실행 결과 확인

.PARAMETER Send
    실제 텔레그램 발송까지 수행함. 지정하지 않으면 발송하지 않음.

.PARAMETER Resend
    전송 이력을 무시하고 다시 보냄(-Send 와 함께 사용).

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\Test-HermesRelay.ps1
.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\Test-HermesRelay.ps1 -Send
#>
[CmdletBinding()]
param(
    [switch] $Send,
    [switch] $Resend,
    [string] $PythonPath,
    [string] $ConfigPath
)

. (Join-Path $PSScriptRoot 'HermesCommon.ps1')

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
if (-not $ConfigPath) { $ConfigPath = Join-Path $repoRoot 'config.json' }

Write-Step '1. 절대경로 Python 확인'
if (-not $PythonPath) { $PythonPath = Find-PythonPath -Root $repoRoot }
if (-not $PythonPath) {
    Write-Bad '실행 가능한 Python 3 을 찾지 못함 — 설치 후 다시 실행하기 바람'
    exit 2
}
Write-Ok $PythonPath

if (-not (Test-Path -LiteralPath $ConfigPath)) {
    Write-Warn2 "설정 파일 없음: $ConfigPath (환경변수만으로 진행함)"
}

# 예약 작업과 '같은 진입점'으로 시험해야 실제 실행과 결과가 일치함
$entry = Join-Path $repoRoot 'run_relay.py'
if (-not (Test-Path -LiteralPath $entry)) {
    Write-Bad "진입 스크립트 없음: $entry"
    exit 2
}
$env:PYTHONIOENCODING = 'utf-8'
Push-Location $repoRoot
try {
    Write-Step '2. 진단 실행 (doctor)'
    & $PythonPath $entry doctor --config $ConfigPath
    $doctorCode = $LASTEXITCODE
    if ($doctorCode -ne 0) {
        Write-Bad '진단에서 실패 항목이 발견됨 — 위 [실패] 항목을 먼저 해소하기 바람'
        Write-Host '        해소 후 이 스크립트를 다시 실행하기 바람'
        exit 1
    }
    Write-Ok '진단 통과'

    Write-Step '3. 발송 없는 시험 (--dry-run)'
    & $PythonPath $entry once --config $ConfigPath --dry-run --verbose
    if ($LASTEXITCODE -ne 0) {
        Write-Bad "시험 실행 실패(코드 $LASTEXITCODE)"
        exit 1
    }
    Write-Ok '시험 통과 — 위 목록이 실제 전송 대상임'

    if ($Send) {
        Write-Step '4. 실제 텔레그램 발송'
        # $args 는 PowerShell 자동 변수이므로 다른 이름을 씀
        $pyArgs = @($entry, 'once', '--config', $ConfigPath, '--verbose')
        if ($Resend) { $pyArgs += '--resend' }
        & $PythonPath @pyArgs
        if ($LASTEXITCODE -ne 0) {
            Write-Bad "발송 중 오류 발생(코드 $LASTEXITCODE) — logs\relay.log 확인 필요함"
            exit 1
        }
        Write-Ok '발송 완료 — 텔레그램 수신 여부를 직접 확인하기 바람'
    } else {
        Write-Step '4. 실제 발송 생략'
        Write-Host '  실제로 보내려면: .\Test-HermesRelay.ps1 -Send' -ForegroundColor Yellow
    }
}
finally {
    Pop-Location
}

Write-Step '5. 예약 작업 최근 실행 결과'
foreach ($name in @('HermesDailyReportRelay', 'HermesDailyReportRelayLogon')) {
    $info = Get-ScheduledTaskInfo -TaskName $name -ErrorAction SilentlyContinue
    if (-not $info) { Write-Warn2 "$name — 미등록"; continue }
    $desc = Get-TaskResultText -Code $info.LastTaskResult
    $line = "{0} — 최근 실행 {1} / 결과: {2} / 다음 실행 {3}" -f `
            $name, $info.LastRunTime, $desc, $info.NextRunTime
    if ($info.LastTaskResult -eq 0) { Write-Ok $line } else { Write-Warn2 $line }
}
