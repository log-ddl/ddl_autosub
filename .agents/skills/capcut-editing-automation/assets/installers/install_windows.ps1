# CapCut Editing Automation: puts the finished timeline into your CapCut project.
# Run it with CapCut fully quit. Nothing is deleted: the old project files are backed up first.
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectName = '__PROJECT_NAME__'
$Content = '__CONTENT_NAME__'
$Duration = '__DURATION__'
$utf8 = New-Object System.Text.UTF8Encoding($false)

function Finish($code) { Write-Host ''; Read-Host 'Press Enter to close this window' | Out-Null; exit $code }

Write-Host "Installing the timeline into the CapCut project `"$ProjectName`"..."
if (Get-Process -Name 'CapCut' -ErrorAction SilentlyContinue) {
  Write-Host 'CapCut is still running. Close it completely (also check the system tray), then run this again.'
  Finish 1
}
$root = Join-Path $env:LOCALAPPDATA 'CapCut\User Data\Projects\com.lveditor.draft'
if (-not (Test-Path $root)) {
  Write-Host "CapCut's projects folder isn't in the usual place."
  $root = (Read-Host 'In CapCut open Settings > Projects > Draft location, copy that path, paste it here and press Enter').Trim('"')
}
$P = $null
foreach ($d in Get-ChildItem -Path $root -Directory) {
  $m = Join-Path $d.FullName 'draft_meta_info.json'
  if (Test-Path $m) {
    $t = [IO.File]::ReadAllText($m)
    if ($t -match ('"draft_name"\s*:\s*"' + [regex]::Escape($ProjectName) + '"')) { $P = $d.FullName; break }
  }
}
if (-not $P) {
  Write-Host "No CapCut project called `"$ProjectName`" was found in $root."
  Write-Host 'Check the project name in CapCut (it must match exactly) and that you saved it at least once.'
  Finish 1
}
$main = Join-Path $P $Content
if (-not (Test-Path $main)) {
  Write-Host "The project folder doesn't contain $Content. Was this timeline built from a different CapCut project?"
  Finish 1
}
$first = [IO.File]::ReadAllBytes($main) | Select-Object -First 1
if ($first -ne 123) {
  Write-Host "This CapCut version stores projects in a locked format, so the timeline can't be installed."
  Finish 1
}
$bk = Join-Path $P ('_backup_before_cca_' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
New-Item -ItemType Directory -Force -Path $bk | Out-Null
$tid = $null
$pj = Join-Path $P 'Timelines\project.json'
if (Test-Path $pj) {
  $pt = [IO.File]::ReadAllText($pj)
  if ($pt -match '"main_timeline_id"\s*:\s*"([^"]*)"') { $tid = $Matches[1] }
}
$rels = @($Content, "$Content.bak", 'template-2.tmp')
if ($tid) { $rels += @("Timelines\$tid\$Content", "Timelines\$tid\$Content.bak", "Timelines\$tid\template-2.tmp") }
$src = Join-Path $here ('draft\' + $Content)
$written = 0
foreach ($rel in $rels) {
  $f = Join-Path $P $rel
  if ((Test-Path $f) -or ($rel -eq $Content)) {
    $b = Join-Path $bk $rel
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $b) | Out-Null
    if (Test-Path $f) { Copy-Item -LiteralPath $f -Destination $b -Force; Set-ItemProperty -LiteralPath $f -Name IsReadOnly -Value $false }
    Copy-Item -LiteralPath $src -Destination $f -Force
    $written++
  }
}
$meta = Join-Path $P 'draft_meta_info.json'
if (Test-Path $meta) {
  Copy-Item -LiteralPath $meta -Destination (Join-Path $bk 'draft_meta_info.json') -Force
  Set-ItemProperty -LiteralPath $meta -Name IsReadOnly -Value $false
  $t = [IO.File]::ReadAllText($meta)
  $t = [regex]::Replace($t, '"tm_duration"\s*:\s*\d+', ('"tm_duration":' + $Duration))
  [IO.File]::WriteAllText($meta, $t, $utf8)
}
Write-Host "Done: wrote the timeline to $written file(s) in $P"
Write-Host "Backup of the previous files: $bk"
Write-Host "Open CapCut and click the project `"$ProjectName`"."
Finish 0
