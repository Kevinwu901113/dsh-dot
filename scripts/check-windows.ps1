# dsh-computer: Windows feasibility check for the microsandbox backend.
# Run in PowerShell (no admin needed unless the hypervisor check asks for it):
#   powershell -ExecutionPolicy Bypass -File .\check-windows.ps1
# It installs microsandbox into a temp folder, boots the AIO sandbox image as a microVM,
# and checks shell, browser (CDP), MCP, live view (noVNC) and a shared folder.
# A full log is written next to this script: dsh-computer-check.log

param(
  [string]$Image = 'ghcr.io/agent-infra/sandbox:latest',
  [int]$Port = 18080,
  [string]$Memory = '4G',
  [int]$Cpus = 2,
  [string]$Proxy = '',          # e.g. http://127.0.0.1:7890 ; empty = use the Windows system proxy if one is set
  [string]$SmokeImage = 'alpine:3.20',
  [switch]$SkipAio,             # only run the quick microVM smoke test
  [switch]$KeepVm
)

$ErrorActionPreference = 'Continue'
# msb prints UTF-8; without this a Chinese-locale console shows mojibake.
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$log = Join-Path $here 'dsh-computer-check.log'
Start-Transcript -Path $log -Force | Out-Null

$results = [ordered]@{}
function Step($name, $ok, $detail) {
  $results[$name] = if ($ok) { 'PASS' } else { 'FAIL' }
  $color = if ($ok) { 'Green' } else { 'Red' }
  Write-Host ("[{0}] {1} {2}" -f $results[$name], $name, $detail) -ForegroundColor $color
}
function Code($url) {
  $c = & curl.exe -s -o NUL -w "%{http_code}" --noproxy "*" --max-time 5 -X GET $url 2>$null
  if (-not $c) { return '000' } else { return $c }
}
function WaitFor($url, $seconds) {
  for ($i = 0; $i -lt $seconds; $i += 2) { if ((Code $url) -eq '200') { return $true }; Start-Sleep 2 }
  return $false
}

Write-Host "== Environment" -ForegroundColor Cyan
$os = Get-CimInstance Win32_OperatingSystem
Write-Host ("Windows: {0} build {1}, RAM {2:N1} GB" -f $os.Caption, $os.BuildNumber, ($os.TotalVisibleMemorySize / 1MB))
$drive = (Get-Item $env:TEMP).PSDrive
Write-Host ("Free disk on {0}: {1:N1} GB" -f $drive.Name, ($drive.Free / 1GB))
$nodeVer = (& node -v) 2>$null
Step 'node>=22' ($nodeVer -and ([int]($nodeVer.TrimStart('v').Split('.')[0]) -ge 22)) "($nodeVer)"

Write-Host "== Install microsandbox (temp folder)" -ForegroundColor Cyan
$work = Join-Path $env:TEMP 'dsh-computer-check'
New-Item -ItemType Directory -Force -Path $work | Out-Null
Push-Location $work
if (-not (Test-Path package.json)) { & npm init -y | Out-Null }
& npm i microsandbox@0.7.8 --no-fund --no-audit 2>&1 | Select-Object -Last 3
Pop-Location
$msb = Get-ChildItem -Path (Join-Path $work 'node_modules') -Recurse -Filter 'msb.exe' -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty FullName
Step 'msb bundled binary' ([bool]$msb) "($msb)"
if (-not $msb) { Stop-Transcript | Out-Null; exit 1 }
# Windows PowerShell 5.1 turns native stderr into red NativeCommandError records; print it as plain text instead.
function Msb([string[]]$a) {
  & $msb @a 2>&1 | ForEach-Object { if ($_ -is [System.Management.Automation.ErrorRecord]) { $_.Exception.Message } else { $_ } }
}

Write-Host "== Host virtualization (msb doctor)" -ForegroundColor Cyan
Msb @('doctor')
$doctorOk = $LASTEXITCODE -eq 0
Step 'hypervisor available' $doctorOk ''
if (-not $doctorOk) {
  Write-Host "Fix: open PowerShell as Administrator and run these two lines, then REBOOT:" -ForegroundColor Yellow
  Write-Host "  Enable-WindowsOptionalFeature -Online -FeatureName HypervisorPlatform -All -NoRestart" -ForegroundColor Yellow
  Write-Host "  bcdedit /set hypervisorlaunchtype auto" -ForegroundColor Yellow
  Write-Host "Also make sure CPU virtualization (Intel VT-x / AMD SVM) is enabled in BIOS. Then run this script again." -ForegroundColor Yellow
  Stop-Transcript | Out-Null; exit 1
}

Write-Host "== Proxy" -ForegroundColor Cyan
# msb downloads with reqwest, which reads HTTPS_PROXY but not the Windows system proxy (e.g. set by Clash).
if (-not $Proxy -and -not $env:HTTPS_PROXY) {
  $is = Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings' -ErrorAction SilentlyContinue
  if ($is -and $is.ProxyEnable -eq 1 -and $is.ProxyServer) {
    $ps = [string]$is.ProxyServer
    if ($ps -match 'https=([^;]+)') { $ps = $Matches[1] } elseif ($ps -match 'http=([^;]+)') { $ps = $Matches[1] }
    if ($ps -notmatch '^[a-z]+://') { $ps = "http://$ps" }
    $Proxy = $ps
  }
}
if ($Proxy) {
  $env:HTTPS_PROXY = $Proxy; $env:HTTP_PROXY = $Proxy; $env:NO_PROXY = 'localhost,127.0.0.1'
  Write-Host "Using proxy for image downloads: $Proxy"
} elseif ($env:HTTPS_PROXY) {
  Write-Host "Using HTTPS_PROXY from environment: $env:HTTPS_PROXY"
} else {
  Write-Host "No proxy detected; downloading directly (ghcr.io may be slow or drop)." -ForegroundColor Yellow
}

Write-Host "== Smoke test: tiny microVM ($SmokeImage)" -ForegroundColor Cyan
$smoke = 'dsh-computer-smoke'
$smokePort = $Port + 1
$t0 = Get-Date
Msb @('pull', $SmokeImage)
Step 'smoke image pull' ($LASTEXITCODE -eq 0) ("({0:N0}s)" -f ((Get-Date) - $t0).TotalSeconds)
$smokeMount = $null
foreach ($spec in @("${shared}:${guest}:uid=1000,gid=1000", (($shared -replace '\\','/') + ":${guest}:uid=1000,gid=1000"))) {
  Msb @('rm', '-f', '-q', $smoke) | Out-Null
  $t0 = Get-Date
  Msb @('create', '--name', $smoke, '-m', '512M', '-c', '1', '-p', "127.0.0.1:${smokePort}:8080", '--mount-dir', $spec, $SmokeImage)
  if ($LASTEXITCODE -eq 0) { $smokeMount = $spec; break }
  Write-Host "mount spelling rejected: $spec" -ForegroundColor Yellow
}
if (-not $smokeMount) {
  Msb @('rm', '-f', '-q', $smoke) | Out-Null
  $t0 = Get-Date
  Msb @('create', '--name', $smoke, '-m', '512M', '-c', '1', '-p', "127.0.0.1:${smokePort}:8080", $SmokeImage)
}
$smokeUp = $LASTEXITCODE -eq 0
Step 'microVM boot' $smokeUp ("({0:N1}s)" -f ((Get-Date) - $t0).TotalSeconds)
if ($smokeUp) {
  $u = (Msb @('exec', $smoke, '--no-tty', '--', 'uname', '-sr')) -join ' '
  Step 'microVM exec' ($u -match 'Linux') "($u)"
  if ($smokeMount) {
    $r = (Msb @('exec', $smoke, '--no-tty', '--', 'cat', "$guest/from-host.txt")) -join ''
    Step 'smoke shared folder host->VM' ($r -match 'hello-from-windows') "($smokeMount)"
    Msb @('exec', $smoke, '--no-tty', '--', 'sh', '-c', "echo hello-from-vm > $guest/from-vm.txt") | Out-Null
    $b = if (Test-Path (Join-Path $shared 'from-vm.txt')) { Get-Content (Join-Path $shared 'from-vm.txt') } else { '' }
    Step 'smoke shared folder VM->host' ($b -match 'hello-from-vm') ''
  } else { Step 'smoke shared folder' $false '(no mount spelling accepted)' }
  Msb @('exec', $smoke, '--no-tty', '--', 'sh', '-c', 'mkdir -p /www && echo smoke-ok > /www/index.html && (busybox httpd -p 8080 -h /www &) ; sleep 1') | Out-Null
  $hp = & curl.exe -s --noproxy "*" --max-time 5 "http://127.0.0.1:$smokePort/"
  Step 'port forward host->VM' ($hp -match 'smoke-ok') ''
  $net = (Msb @('exec', $smoke, '--no-tty', '--', 'sh', '-c', 'wget -q -O /dev/null -T 10 https://www.bing.com && echo net-ok')) -join ''
  Step 'VM internet access' ($net -match 'net-ok') ''
  Msb @('metrics', $smoke) | Select-Object -First 6
  Msb @('rm', '-f', '-q', $smoke) | Out-Null
}
if ($SkipAio) {
  Write-Host "== Summary" -ForegroundColor Cyan
  $results.GetEnumerator() | ForEach-Object { Write-Host ("{0,-34} {1}" -f $_.Key, $_.Value) }
  Stop-Transcript | Out-Null; Write-Host "Log saved to: $log"; exit 0
}

Write-Host "== Pull AIO image (first time: ~3.6 GB download)" -ForegroundColor Cyan
$t0 = Get-Date
$pulled = $false
for ($try = 1; $try -le 3 -and -not $pulled; $try++) {
  if ($try -gt 1) { Write-Host "retry $try/3 (finished layers are kept)…" -ForegroundColor Yellow }
  Msb @('pull', $Image)
  $pulled = $LASTEXITCODE -eq 0
}
Step 'image pull' $pulled ("({0:N0}s)" -f ((Get-Date) - $t0).TotalSeconds)

# Shared folder, translated the WSL way: C:\Users\me\x -> /mnt/c/Users/me/x
$shared = Join-Path $env:USERPROFILE 'dsh-computer-check-share'
New-Item -ItemType Directory -Force -Path $shared | Out-Null
Set-Content -Path (Join-Path $shared 'from-host.txt') -Value 'hello-from-windows'
$guest = '/mnt/' + $shared.Substring(0,1).ToLower() + ($shared.Substring(2) -replace '\\','/')

$name = 'dsh-computer-check'
$base = "http://127.0.0.1:$Port"
# Windows paths contain a drive-letter colon, which may clash with SOURCE:DEST parsing,
# so several spellings are tried; "none" still validates the VM itself.
$mountVariants = @(
  @{ label = 'backslash path';     spec = "${shared}:${guest}:uid=1000,gid=1000" },
  @{ label = 'forward-slash path'; spec = (($shared -replace '\\','/') + ":${guest}:uid=1000,gid=1000") },
  @{ label = 'no shared folder';   spec = $null }
)
$initVariants = @(
  @{ label = 'image entrypoint'; extra = @() },
  @{ label = 'init auto';        extra = @('--init', 'auto') }
)
$booted = $false
$mounted = $null
foreach ($init in $initVariants) {
  foreach ($m in $mountVariants) {
    Write-Host ("== Boot VM ({0}, {1})" -f $init.label, $m.label) -ForegroundColor Cyan
    Msb @('rm', '-f', '-q', $name) 2>$null | Out-Null
    $createArgs = @('create', '--name', $name, '--hostname', 'dsh-computer', '-m', $Memory, '-c', "$Cpus",
                    '-p', "127.0.0.1:${Port}:8080",
                    '-e', 'DISABLE_JUPYTER=true', '-e', 'DISABLE_CODE_SERVER=true', '-e', 'DISABLE_NODEJS_REPL=true')
    if ($m.spec) { $createArgs += @('--mount-dir', $m.spec) }
    $createArgs += $init.extra + @($Image)
    $t0 = Get-Date
    Msb $createArgs
    if ($LASTEXITCODE -ne 0) { Write-Host ("create failed with {0}; trying next variant" -f $m.label) -ForegroundColor Yellow; continue }
    $healthy = WaitFor "$base/v1/sandbox" 240
    Step ("boot ({0}, {1})" -f $init.label, $m.label) $healthy ("({0:N0}s)" -f ((Get-Date) - $t0).TotalSeconds)
    if ($healthy) { $booted = $true; $mounted = $m.spec; break }
    Write-Host "-- last VM logs:" -ForegroundColor Yellow
    Msb @('logs', '--tail', '40', $name) 2>&1
    break  # created but unhealthy: the mount spelling is not the problem, try the next init mode
  }
  if ($booted) { break }
}

if ($booted) {
  Write-Host "== Checks" -ForegroundColor Cyan
  $who = (Msb @('exec', $name, '-u', 'gem', '--no-tty', '--', 'sh', '-c', 'whoami; hostname')) -join ' '
  Step 'shell exec as gem' ($who -match 'gem') "($who)"
  if (-not $mounted) { Step 'shared folder' $false '(no mount spelling was accepted)' } else {
  $read = (Msb @('exec', $name, '-u', 'gem', '--no-tty', '--', 'cat', "$guest/from-host.txt")) -join ''
  Step 'shared folder host->VM' ($read -match 'hello-from-windows') "($guest)"
  Msb @('exec', $name, '-u', 'gem', '--no-tty', '--', 'sh', '-c', "echo hello-from-vm > $guest/from-vm.txt") | Out-Null
  $back = if (Test-Path (Join-Path $shared 'from-vm.txt')) { Get-Content (Join-Path $shared 'from-vm.txt') } else { '' }
  Step 'shared folder VM->host' ($back -match 'hello-from-vm') ''
  }
  Step 'browser CDP' (WaitFor "$base/cdp/json/version" 60) ''
  $body = Join-Path $work 'mcp-init.json'
  Set-Content -Path $body -Encoding ascii -Value '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"check","version":"1"}}}'
  $mcp = & curl.exe -s --noproxy "*" --max-time 10 -X POST -H "content-type: application/json" -H "accept: application/json, text/event-stream" --data-binary "@$body" "$base/mcp"
  Step 'browser MCP' ($mcp -match 'protocolVersion') ''
  Step 'live view (noVNC page)' ((Code "$base/vnc/index.html") -eq '200') ''
  $net = (Msb @('exec', $name, '--no-tty', '--', 'sh', '-c', 'curl -s -o /dev/null -w "%{http_code}" --max-time 10 https://www.bing.com')) -join ''
  Step 'VM internet access' ($net -match '^(200|301|302)$') "($net)"
  Write-Host "== Resource usage" -ForegroundColor Cyan
  Msb @('metrics', $name) 2>&1 | Select-Object -First 15
  Write-Host ""
  Write-Host "Live view (open in your browser): $base/vnc/index.html?autoconnect=true&resize=scale" -ForegroundColor Green
}

Write-Host "== Summary" -ForegroundColor Cyan
$results.GetEnumerator() | ForEach-Object { Write-Host ("{0,-34} {1}" -f $_.Key, $_.Value) }
if ($booted -and -not $KeepVm) {
  Write-Host "VM left running for you to look at. Remove later with:  `"$msb`" rm -f $name" -ForegroundColor Yellow
}
Stop-Transcript | Out-Null
Write-Host "Log saved to: $log"
