<#
.SYNOPSIS
  Push the hevy-hook Worker secrets to Cloudflare (run by YOU, not by Claude).

.DESCRIPTION
  Reads the local secret files (never printed) and pipes each value into
  `npx wrangler secret put <NAME>` from workers\hevy-hook:

    <cache>\secrets\hevy.env          HEVY_API_KEY=...          -> HEVY_API_KEY
    <cache>\secrets\strava.json       client_id / client_secret -> STRAVA_CLIENT_ID / STRAVA_CLIENT_SECRET
                                      refresh_token             -> STRAVA_REFRESH_TOKEN (seed; the Worker
                                                                   keeps the rotated token in KV)
    <cache>\secrets\hevy-webhook.txt  random 32-byte hex        -> WEBHOOK_AUTH

  <cache> = $env:ZG_CACHE or $HOME\.claude\cache\daily-dashboard.
  Only secret NAMES are printed. Values go through stdin (never the command line).

.PARAMETER Only
  Set only these names (e.g. -Only WEBHOOK_AUTH after rotating the webhook secret).

.PARAMETER DryRun
  Validate the files and list what would be set; sends nothing.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File tools\set_live_secrets.ps1
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File tools\set_live_secrets.ps1 -Only WEBHOOK_AUTH
#>
[CmdletBinding()]
param(
  [string[]]$Only = @(),
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

$CacheRoot = if ($env:ZG_CACHE) { $env:ZG_CACHE } else { Join-Path $HOME '.claude\cache\daily-dashboard' }
$SecretsDir = Join-Path $CacheRoot 'secrets'
$WorkerDir = Resolve-Path (Join-Path $PSScriptRoot '..\workers\hevy-hook')
$HealthUrl = 'https://hevy.er45.com/live/health'

function Test-Placeholder([object]$v) {
  if ($null -eq $v) { return $true }
  $s = ([string]$v).Trim()
  return ($s -eq '' -or $s.StartsWith('PASTE_'))
}

$values = [ordered]@{}
$problems = @()

# --- hevy.env -------------------------------------------------------------------
$hevyEnv = Join-Path $SecretsDir 'hevy.env'
if (Test-Path $hevyEnv) {
  $key = $null
  foreach ($line in Get-Content -LiteralPath $hevyEnv -Encoding UTF8) {
    $t = $line.Trim()
    if ($t -eq '' -or $t.StartsWith('#') -or -not $t.Contains('=')) { continue }
    $k, $v = $t.Split('=', 2)
    if ($k.Trim() -eq 'HEVY_API_KEY') { $key = $v.Trim().Trim('"').Trim("'") }
  }
  if (Test-Placeholder $key) { $problems += "HEVY_API_KEY missing in $hevyEnv" } else { $values['HEVY_API_KEY'] = $key }
} else { $problems += "missing file $hevyEnv" }

# --- strava.json ----------------------------------------------------------------
$stravaJson = Join-Path $SecretsDir 'strava.json'
if (Test-Path $stravaJson) {
  $s = Get-Content -LiteralPath $stravaJson -Raw -Encoding UTF8 | ConvertFrom-Json
  $map = [ordered]@{ STRAVA_CLIENT_ID = $s.client_id; STRAVA_CLIENT_SECRET = $s.client_secret; STRAVA_REFRESH_TOKEN = $s.refresh_token }
  foreach ($name in $map.Keys) {
    if (Test-Placeholder $map[$name]) { $problems += "$name missing in $stravaJson (run: python tools\strava_sync.py auth)" }
    else { $values[$name] = ([string]$map[$name]).Trim() }
  }
} else { $problems += "missing file $stravaJson" }

# --- hevy-webhook.txt ------------------------------------------------------------
$hookFile = Join-Path $SecretsDir 'hevy-webhook.txt'
if (Test-Path $hookFile) {
  $h = (Get-Content -LiteralPath $hookFile -Raw -Encoding UTF8).Trim()
  if ($h -notmatch '^[0-9a-f]{64}$') { $problems += "WEBHOOK_AUTH in $hookFile is not 64 hex chars" } else { $values['WEBHOOK_AUTH'] = $h }
} else { $problems += "missing file $hookFile" }

if ($Only.Count -gt 0) {
  $keep = [ordered]@{}
  foreach ($n in $Only) {
    if ($values.Contains($n)) { $keep[$n] = $values[$n] } else { $problems += "requested $n is not available" }
  }
  $values = $keep
  $problems = @($problems | Where-Object { $p = $_; ($Only | Where-Object { $p -like "*$_*" }).Count -gt 0 })
}

if ($problems.Count -gt 0) {
  Write-Host 'Cannot continue:' -ForegroundColor Red
  $problems | ForEach-Object { Write-Host "  - $_" }
  exit 2
}

if ($DryRun) {
  Write-Host "Dry run: would set $($values.Count) secret(s) on Worker hevy-hook:"
  $values.Keys | ForEach-Object { Write-Host "  $_" }
  exit 0
}

# --- push --------------------------------------------------------------------------
$npx = if (Get-Command npx.cmd -ErrorAction SilentlyContinue) { 'npx.cmd' } else { 'npx' }
$OutputEncoding = New-Object System.Text.UTF8Encoding $false
$failed = @()
Push-Location $WorkerDir
try {
  foreach ($name in $values.Keys) {
    # PS 5.1 wraps native stderr in ErrorRecords; 'Continue' keeps them non-fatal.
    # Wrangler's own output is discarded (it never contains the value, but stay quiet).
    $ErrorActionPreference = 'Continue'
    $null = $values[$name] | & $npx wrangler secret put $name 2>&1
    $code = $LASTEXITCODE
    $ErrorActionPreference = 'Stop'
    if ($code -eq 0) { Write-Host "set  $name" -ForegroundColor Green }
    else { Write-Host "FAIL $name (wrangler exit $code)" -ForegroundColor Red; $failed += $name }
  }
} finally {
  Pop-Location
  $values.Clear()
}

if ($failed.Count -gt 0) {
  Write-Host "Some secrets failed. Check 'npx wrangler whoami' and retry: -Only $($failed -join ',')"
  exit 1
}

try {
  $hl = Invoke-RestMethod -Uri $HealthUrl -TimeoutSec 15
  Write-Host "health: status=$($hl.status) missingSecrets=[$($hl.missingSecrets -join ', ')]"
} catch {
  Write-Host "health check failed ($($_.Exception.Message)); try $HealthUrl in a browser."
}
