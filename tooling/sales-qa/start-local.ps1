# Starts Venture OS with the Sales (Dealflow) area on this PC and opens it in your browser.
#   API    http://localhost:4000   (window "VSO API")
#   Web    http://localhost:3000   (window "VSO web")
#   Worker delivers notifications  (window "VSO worker")
# Data: local MongoDB service, database vso_dealflow_dev. Close the three windows to stop.
# Run from PowerShell, in the Venture OS folder:  & .\tooling\sales-qa\start-local.ps1

$root = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$url = "http://localhost:3000/sales/live"

$mongo = Get-Service MongoDB -ErrorAction SilentlyContinue
if (-not $mongo -or $mongo.Status -ne "Running") {
  Write-Warning "The MongoDB service is not running. Start it (Windows Services > MongoDB > Start) and run this again."
  exit 1
}

$busy = @(3000, 4000) | Where-Object { Get-NetTCPConnection -State Listen -LocalPort $_ -ErrorAction SilentlyContinue }
if ($busy.Count -eq 2) {
  Write-Host "Venture OS is already running. Opening $url"
  Start-Process $url
  exit 0
}
if ($busy.Count -eq 1) {
  Write-Warning "Port $busy is in use by something else. Close it (or the old Venture OS window) and run this again."
  exit 1
}

Start-Process powershell -ArgumentList "-NoExit", "-Command", "`$host.UI.RawUI.WindowTitle = 'VSO API'; Set-Location '$root'; node --env-file=.env node_modules/tsx/dist/cli.mjs watch apps/api/src/server.ts"
Start-Process powershell -ArgumentList "-NoExit", "-Command", "`$host.UI.RawUI.WindowTitle = 'VSO web'; Set-Location '$root\apps\web'; node ../../node_modules/next/dist/bin/next dev -p 3000"
# The worker reads the root .env, which may hold real email (Resend) and push (VAPID) keys. Blank ones are set first (a value already set
# is never replaced by the .env file), so the worker uses its local adapters: test notices never reach anyone's inbox or phone.
$quietEnv = Join-Path $env:TEMP "vso-qa-worker.env"
Set-Content -Path $quietEnv -Encoding ascii -Value "RESEND_API_KEY=", "VAPID_PUBLIC_KEY=", "VAPID_PRIVATE_KEY="
Start-Process powershell -ArgumentList "-NoExit", "-Command", "`$host.UI.RawUI.WindowTitle = 'VSO worker'; Set-Location '$root\apps\worker'; node --env-file='$quietEnv' ../../node_modules/tsx/dist/cli.mjs src/index.ts"

Write-Host "Starting... (the first page load compiles for about 20 seconds)"
for ($i = 0; $i -lt 60; $i++) {
  try { Invoke-WebRequest $url -UseBasicParsing -TimeoutSec 5 | Out-Null; break } catch { Start-Sleep -Seconds 2 }
}
Start-Process $url
Write-Host "Opened $url  (you are signed in as Divyansh through the local dev login)."
