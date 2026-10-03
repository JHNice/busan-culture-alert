# Removes the scheduled task and/or Startup shortcut.
$taskName = 'BusanCultureAlert'
if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
  Write-Host "[OK] Scheduled task removed."
}
$lnk = Join-Path ([Environment]::GetFolderPath('Startup')) "$taskName.lnk"
if (Test-Path $lnk) { Remove-Item $lnk; Write-Host "[OK] Startup shortcut removed." }
$cal = Join-Path ([Environment]::GetFolderPath('Desktop')) 'Busan Culture Calendar.lnk'
if (Test-Path $cal) { Remove-Item $cal; Write-Host "[OK] Desktop calendar shortcut removed." }
