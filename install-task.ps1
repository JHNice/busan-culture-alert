# Registers "BusanCultureAlert" to run at Windows logon (hidden window).
# Usage (PowerShell):  powershell -ExecutionPolicy Bypass -File .\install-task.ps1
# Optional:            -DelayMinutes 2   -DailyAt "18:00"
param(
  [int]$DelayMinutes = 1,
  [string]$DailyAt = ""
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$taskName = 'BusanCultureAlert'

$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) { Write-Host "[ERROR] node.exe not found in PATH. Install Node.js first." -ForegroundColor Red; exit 1 }
$node = $nodeCmd.Source
$vbs = Join-Path $root 'run.vbs'
if (-not (Test-Path (Join-Path $root 'config.json'))) {
  Write-Host "[WARN] config.json not found yet. Copy config.example.json to config.json and fill in keys before next logon." -ForegroundColor Yellow
}

$arg = "`"$vbs`" `"$node`""
$user = "$env:USERDOMAIN\$env:USERNAME"

try {
  $action = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument $arg -WorkingDirectory $root
  $logon = New-ScheduledTaskTrigger -AtLogOn -User $user
  $logon.Delay = "PT$($DelayMinutes)M"
  $triggers = @($logon)
  if ($DailyAt -ne "") { $triggers += New-ScheduledTaskTrigger -Daily -At $DailyAt }
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 15)
  $principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
  Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $triggers -Settings $settings -Principal $principal `
    -Description 'Busan culture events -> Discord webhook (once per day)' -Force | Out-Null
  Write-Host "[OK] Task Scheduler: '$taskName' registered (runs $DelayMinutes min after logon)." -ForegroundColor Green
}
catch {
  Write-Host "[WARN] Task Scheduler registration failed: $($_.Exception.Message)" -ForegroundColor Yellow
  Write-Host "       Falling back to Startup folder shortcut..."
  $startup = [Environment]::GetFolderPath('Startup')
  $lnkPath = Join-Path $startup "$taskName.lnk"
  $ws = New-Object -ComObject WScript.Shell
  $lnk = $ws.CreateShortcut($lnkPath)
  $lnk.TargetPath = "$env:WINDIR\System32\wscript.exe"
  $lnk.Arguments = $arg
  $lnk.WorkingDirectory = $root
  $lnk.Save()
  Write-Host "[OK] Startup shortcut created: $lnkPath" -ForegroundColor Green
}

# Desktop shortcut for the calendar app
try {
  $desktop = [Environment]::GetFolderPath('Desktop')
  $calLnk = Join-Path $desktop 'Busan Culture Calendar.lnk'
  $ws2 = New-Object -ComObject WScript.Shell
  $c = $ws2.CreateShortcut($calLnk)
  $c.TargetPath = "$env:WINDIR\System32\wscript.exe"
  $c.Arguments = "`"$(Join-Path $root 'calendar.vbs')`" `"$node`""
  $c.WorkingDirectory = $root
  $c.IconLocation = (Join-Path $root 'calendar\calendar.ico')
  $c.Description = 'Busan culture events calendar'
  $c.Save()
  Write-Host "[OK] Desktop shortcut created: $calLnk" -ForegroundColor Green
}
catch {
  Write-Host "[WARN] Desktop shortcut failed: $($_.Exception.Message)" -ForegroundColor Yellow
}
