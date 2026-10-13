# Venture Studio local production stack helper. Run through deploy\prod.cmd, e.g.:  deploy\prod.cmd up
param(
  [Parameter(Position = 0)] [string] $Command = "help",
  [Parameter(Position = 1)] [string] $Target = ""
)
$ErrorActionPreference = "Stop"
$Deploy = $PSScriptRoot
$Repo = Split-Path $Deploy -Parent
$EnvFile = Join-Path $Deploy ".env"
$ExampleFile = Join-Path $Deploy ".env.example"
$ComposeFile = Join-Path $Deploy "compose.yaml"
$Utf8 = New-Object System.Text.UTF8Encoding($false)

function Read-Settings {
  $settings = @{}
  if (-not (Test-Path $EnvFile)) { return $settings }
  foreach ($line in [System.IO.File]::ReadAllLines($EnvFile)) {
    if ($line -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$') { $settings[$Matches[1]] = $Matches[2].Trim() }
  }
  return $settings
}

function Set-Setting([string] $Name, [string] $Value) {
  $text = [System.IO.File]::ReadAllText($EnvFile)
  $pattern = "(?m)^" + [regex]::Escape($Name) + "=.*$"
  if ([regex]::IsMatch($text, $pattern)) { $text = [regex]::Replace($text, $pattern, ($Name + "=" + $Value).Replace('$', '$$')) }
  else { $text = $text.TrimEnd() + "`n" + $Name + "=" + $Value + "`n" }
  [System.IO.File]::WriteAllText($EnvFile, $text, $Utf8)
}

function New-Secret([int] $Bytes) {
  $buffer = New-Object byte[] $Bytes
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  $rng.GetBytes($buffer); $rng.Dispose()
  return -join ($buffer | ForEach-Object { $_.ToString("x2") })
}

function Get-BackupDir {
  $s = Read-Settings
  $dir = $s["LOCAL_BACKUP_DIR"]; if (-not $dir) { $dir = "../.data/prod-backups" }
  # Combine keeps absolute paths as they are and resolves relative ones from the deploy folder.
  return [System.IO.Path]::GetFullPath([System.IO.Path]::Combine($Deploy, $dir))
}

function Invoke-Compose([string[]] $ComposeArgs, [switch] $AllProfiles) {
  $settings = Read-Settings
  $profileArgs = @()
  if ($AllProfiles -or ($settings["TUNNEL_TOKEN"])) { $profileArgs = @("--profile", "tunnel") }
  & docker compose -f $ComposeFile --env-file $EnvFile @profileArgs @ComposeArgs
  if ($LASTEXITCODE -ne 0) { throw "docker compose $($ComposeArgs -join ' ') failed" }
}

function Test-Settings {
  if (-not (Test-Path $EnvFile)) { Write-Host "deploy\.env does not exist yet. Run: deploy\prod.cmd init" -ForegroundColor Yellow; return $false }
  $s = Read-Settings
  $missing = New-Object System.Collections.Generic.List[string]
  $required = "APP_DOMAIN", "BETTER_AUTH_SECRET", "MONGO_ROOT_PASSWORD", "MONGO_APP_PASSWORD", "VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY", "VAPID_SUBJECT", "RESEND_API_KEY", "EMAIL_FROM", "R2_ENDPOINT", "R2_BUCKET", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"
  foreach ($name in $required) { if (-not $s[$name]) { $missing.Add("$name is empty") } }
  if ($s["APP_DOMAIN"] -match "example\.com|^https?://|/") { $missing.Add("APP_DOMAIN must be your real hostname without https://, e.g. app.yourdomain.com") }
  if ($s["EMAIL_FROM"] -match "example\.com") { $missing.Add("EMAIL_FROM still uses example.com") }
  if ($s["VAPID_SUBJECT"] -match "example\.com") { $missing.Add("VAPID_SUBJECT still uses example.com") }
  if ($s["R2_ENDPOINT"] -match "<account-id>") { $missing.Add("R2_ENDPOINT still has <account-id>") }
  foreach ($name in "MONGO_ROOT_PASSWORD", "MONGO_APP_PASSWORD") { if ($s[$name] -and $s[$name] -notmatch '^[A-Za-z0-9]+$') { $missing.Add("$name must use letters and digits only") } }
  if ($missing.Count -gt 0) {
    Write-Host "Settings to fix in deploy\.env:" -ForegroundColor Yellow
    $missing | ForEach-Object { Write-Host "  - $_" }
    return $false
  }
  if ($s["R2_BUCKET"] -match "dev") { Write-Host "Warning: R2_BUCKET looks like the development bucket ($($s['R2_BUCKET']))." -ForegroundColor Yellow }
  if (-not $s["TUNNEL_TOKEN"]) { Write-Host "Note: TUNNEL_TOKEN is empty, so the site is only reachable on this PC (http://127.0.0.1:$($s['WEB_PORT']))." -ForegroundColor Yellow }
  if (-not $s["BOOTSTRAP_ADMIN_EMAIL"]) { Write-Host "Note: BOOTSTRAP_ADMIN_EMAIL is empty; set it before creating the first admin." -ForegroundColor Yellow }
  if (-not ($s["BACKUP_R2_BUCKET"] -and $s["BACKUP_R2_ACCESS_KEY_ID"] -and $s["BACKUP_R2_SECRET_ACCESS_KEY"] -and $s["BACKUP_R2_ENDPOINT"] -notmatch "<account-id>")) { Write-Host "Note: backup R2 settings are incomplete, so backups stay on this PC only." -ForegroundColor Yellow }
  Write-Host "Settings look complete." -ForegroundColor Green
  return $true
}

function Initialize-Settings {
  if (-not (Test-Path $EnvFile)) {
    Copy-Item $ExampleFile $EnvFile
    Write-Host "Created deploy\.env from the example."
  }
  $s = Read-Settings
  if (-not $s["BETTER_AUTH_SECRET"]) { Set-Setting "BETTER_AUTH_SECRET" (New-Secret 32); Write-Host "Generated BETTER_AUTH_SECRET" }
  if (-not $s["MONGO_ROOT_PASSWORD"]) { Set-Setting "MONGO_ROOT_PASSWORD" (New-Secret 20); Write-Host "Generated MONGO_ROOT_PASSWORD" }
  if (-not $s["MONGO_APP_PASSWORD"]) { Set-Setting "MONGO_APP_PASSWORD" (New-Secret 20); Write-Host "Generated MONGO_APP_PASSWORD" }
  if (-not $s["VAPID_PUBLIC_KEY"] -or -not $s["VAPID_PRIVATE_KEY"]) {
    $json = $null
    Push-Location $Repo
    $previous = $ErrorActionPreference
    try {
      # Native stderr must not abort init when Node or web-push is missing.
      $ErrorActionPreference = "Continue"
      $json = & node -e "process.stdout.write(JSON.stringify(require('web-push').generateVAPIDKeys()))" 2>$null
    } catch { $json = $null } finally { $ErrorActionPreference = $previous; Pop-Location }
    if ($json) {
      $keys = $json | ConvertFrom-Json
      Set-Setting "VAPID_PUBLIC_KEY" $keys.publicKey
      Set-Setting "VAPID_PRIVATE_KEY" $keys.privateKey
      Write-Host "Generated push keys (VAPID)"
    } else { Write-Host "Could not generate push keys here (needs Node and npm install). Fill VAPID_PUBLIC_KEY/PRIVATE_KEY yourself." -ForegroundColor Yellow }
  }
  Write-Host ""
  [void](Test-Settings)
  Write-Host ""
  Write-Host "Edit the remaining values with: deploy\prod.cmd edit"
}

switch ($Command.ToLowerInvariant()) {
  "init" { Initialize-Settings }
  "check" { if (-not (Test-Settings)) { exit 1 } }
  "edit" { if (-not (Test-Path $EnvFile)) { Initialize-Settings }; Start-Process notepad.exe -ArgumentList ('"' + $EnvFile + '"') }
  "capture" {
    # Watches the clipboard for up to 5 minutes and saves, as they are copied in the Cloudflare dashboard:
    # the R2 Access Key ID (32 hex), the R2 Secret Access Key (64 hex), and the tunnel token (or its Docker command).
    # Values are written straight into deploy\.env, never printed, and the clipboard is cleared after each one.
    if (-not (Test-Path $EnvFile)) { Initialize-Settings }
    $need = @{ "R2_ACCESS_KEY_ID" = $true; "R2_SECRET_ACCESS_KEY" = $true; "TUNNEL_TOKEN" = $true }
    $deadline = (Get-Date).AddMinutes(5)
    Write-Host "Watching the clipboard for 5 minutes: copy the R2 Access Key ID, the Secret Access Key, and the tunnel command."
    while ((Get-Date) -lt $deadline -and $need.Count -gt 0) {
      $clip = ""
      try { $clip = Get-Clipboard -Raw } catch { $clip = "" }
      if ($clip) {
        $value = $clip.Trim(); $name = $null
        if ($value -match '--token\s+(\S+)') { $value = $Matches[1] }
        if ($value -match '^[0-9a-f]{32}$') { $name = "R2_ACCESS_KEY_ID" }
        elseif ($value -match '^[0-9a-f]{64}$') { $name = "R2_SECRET_ACCESS_KEY" }
        elseif ($value -match '^eyJ[A-Za-z0-9_\-=.]{40,}$') { $name = "TUNNEL_TOKEN" }
        if ($name -and $need.ContainsKey($name)) {
          Set-Setting $name $value
          [void]$need.Remove($name)
          Set-Clipboard -Value " "
          Write-Host "Saved $name ($($value.Length) characters)."
        }
      }
      Start-Sleep -Milliseconds 500
    }
    if ($need.Count -gt 0) { Write-Host ("Still missing: " + (@($need.Keys) -join ", ")) -ForegroundColor Yellow; exit 1 }
    Write-Host "All three saved to deploy\.env; the clipboard was cleared." -ForegroundColor Green
  }
  "set-tunnel" {
    # Copy the tunnel's Docker command (or just its token) in the Cloudflare dashboard, then run this.
    # The token goes straight from the clipboard into deploy\.env and is never printed.
    if (-not (Test-Path $EnvFile)) { Initialize-Settings }
    $clip = (Get-Clipboard -Raw)
    if (-not $clip) { Write-Host "The clipboard is empty. Copy the tunnel command in Cloudflare first." -ForegroundColor Yellow; exit 1 }
    $token = $clip.Trim()
    if ($token -match '--token\s+(\S+)') { $token = $Matches[1] }
    if ($token -notmatch '^eyJ[A-Za-z0-9_\-=.]+$') { Write-Host "The clipboard does not contain a tunnel token. Copy it again from the tunnel's install step." -ForegroundColor Yellow; exit 1 }
    Set-Setting "TUNNEL_TOKEN" $token
    Set-Clipboard -Value " "
    Write-Host "Tunnel token saved to deploy\.env ($($token.Length) characters); the clipboard was cleared." -ForegroundColor Green
  }
  "up" {
    if (-not (Test-Settings)) { Write-Host "Not starting until the settings above are fixed." -ForegroundColor Red; exit 1 }
    Invoke-Compose @("up", "-d", "--build", "--remove-orphans")
    Invoke-Compose @("ps")
  }
  "down" { Invoke-Compose @("down") -AllProfiles }
  "restart" { if ($Target) { Invoke-Compose @("restart", $Target) } else { Invoke-Compose @("restart") } }
  "status" { Invoke-Compose @("ps", "--all") -AllProfiles }
  "logs" { if ($Target) { Invoke-Compose @("logs", "-f", "--tail", "200", $Target) } else { Invoke-Compose @("logs", "-f", "--tail", "100") } }
  "backup" { Invoke-Compose @("exec", "backup", "/usr/local/bin/backup.sh", "now") }
  "verify-backup" {
    $file = ""
    if ($Target) { $file = "/backups/" + (Split-Path $Target -Leaf) }
    Invoke-Compose @("exec", "backup", "/usr/local/bin/backup.sh", "verify", $file)
  }
  "backups" {
    $path = Get-BackupDir
    Write-Host "Local backups in $path"
    if (Test-Path $path) { Get-ChildItem $path -Filter "*.archive.gz" | Sort-Object LastWriteTime -Descending | Format-Table Name, @{ Name = "Size (MB)"; Expression = { [math]::Round($_.Length / 1MB, 2) } }, LastWriteTime -AutoSize }
  }
  "restore" {
    if (-not $Target) { Write-Host "Usage: deploy\prod.cmd restore <backup file name>   (see: deploy\prod.cmd backups)"; exit 2 }
    $name = Split-Path $Target -Leaf
    $hostFile = [System.IO.Path]::Combine((Get-BackupDir), $name)
    if (-not (Test-Path -LiteralPath $hostFile)) { Write-Host "Backup not found: $hostFile   (see: deploy\prod.cmd backups)" -ForegroundColor Red; exit 1 }
    Write-Host "This REPLACES the live database with $name. A safety copy of the current database is taken first,"
    Write-Host "and the app is stopped during the restore." -ForegroundColor Red
    $answer = Read-Host "Type RESTORE to continue"
    if ($answer -cne "RESTORE") { Write-Host "Cancelled."; exit 1 }
    Invoke-Compose @("stop", "web", "api", "worker")
    $restored = $false
    try { Invoke-Compose @("exec", "backup", "/usr/local/bin/backup.sh", "restore", "/backups/$name"); $restored = $true }
    catch { $restored = $false }
    if ($restored) {
      Invoke-Compose @("start", "api", "worker", "web")
      Write-Host "Restore complete; the app is running again." -ForegroundColor Green
    } else {
      Write-Host "The restore did not finish, so the app stays stopped and scheduled backups are paused." -ForegroundColor Red
      Write-Host "The messages above name the safety copy (pre-restore-...). To return to the previous state:"
      Write-Host "  deploy\prod.cmd restore <that pre-restore file>"
      Write-Host "Or, if nothing was changed (e.g. a damaged file), start the app again with: deploy\prod.cmd up"
      exit 1
    }
  }
  default {
    Write-Host @"
Venture Studio production (local Docker) - deploy\prod.cmd <command>

  init                 create deploy\.env and generate secrets and push keys
  edit                 open deploy\.env in Notepad
  set-tunnel           save the Cloudflare tunnel token from the clipboard into deploy\.env
  check                list settings that still need values
  up                   build and start everything (also applies changed settings)
  status               show containers and their health
  logs [service]       follow logs (services: web, api, worker, mongo, backup, tunnel)
  restart [service]    restart one service or all
  down                 stop everything (data is kept)
  backup               take a database backup now
  backups              list local backups
  verify-backup [file] test-restore a backup into a throwaway database (default: newest)
  restore <file>       replace the live database with a backup (asks for confirmation)
"@
  }
}
