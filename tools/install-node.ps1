# install-node.ps1 - download a portable Node.js into <project>\node
#
# Called by 安装便携Node.bat on machines that have NO Node.js at all.
# Everything here is deliberately small and pipe-free: a previous attempt put
# this logic inline in the .bat, where cmd mangled the quoting and the version
# array collapsed into one long string, producing a malformed download URL.
#
# All messages are ASCII on purpose: this script runs before we know anything
# about the console code page, and mojibake here would confuse the user more
# than plain English ever could. The Chinese guidance is printed by the .bat
# wrapper and by tools\deploy.js once Node is available.

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'          # the progress bar makes downloads crawl

$projectRoot = Split-Path -Parent $PSScriptRoot   # tools\ -> project root
$nodeDir = Join-Path $projectRoot 'node'
$target = Join-Path $nodeDir 'node.exe'

if (Test-Path $target) {
    Write-Host '   node\node.exe already present - nothing to do.'
    exit 0
}

try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
} catch {
    # older Windows may not need or support this; ignore
}

$arch = 'x86'
if ([Environment]::Is64BitOperatingSystem) { $arch = 'x64' }
Write-Host ('   architecture: ' + $arch)

# --- 1. ask nodejs.org for the version list -------------------------------
$list = $null
try {
    $list = Invoke-RestMethod -Uri 'https://nodejs.org/dist/index.json' -TimeoutSec 30
} catch {
    Write-Host ('   [X] cannot reach nodejs.org: ' + $_.Exception.Message)
    exit 1
}

# --- 2. newest LTS (fall back to newest overall) ---------------------------
# NOTE: $list is an array. Wrapping in @() and taking the FIRST element with
# Select-Object keeps it a single object; doing this with a pipe inline in a
# .bat is what broke before.
$lts = @($list | Where-Object { $_.lts })
$pick = $null
if ($lts.Count -gt 0) { $pick = $lts[0] } else { $pick = @($list)[0] }
if ($null -eq $pick) {
    Write-Host '   [X] the version list came back empty'
    exit 1
}
$version = [string]$pick.version
Write-Host ('   version: ' + $version)

# --- 3. download ----------------------------------------------------------
$name = 'node-' + $version + '-win-' + $arch
$url = 'https://nodejs.org/dist/' + $version + '/' + $name + '.zip'
$zip = Join-Path $env:TEMP ($name + '.zip')
$stage = Join-Path $env:TEMP ($name + '-unzip')

Write-Host ('   downloading ' + $url)
try {
    Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing -TimeoutSec 600
} catch {
    Write-Host ('   [X] download failed: ' + $_.Exception.Message)
    exit 1
}
$sizeMb = [math]::Round((Get-Item $zip).Length / 1MB, 1)
Write-Host ('   got ' + $sizeMb + ' MB')

# --- 4. unpack ------------------------------------------------------------
if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
Write-Host '   unpacking ...'
try {
    Expand-Archive -LiteralPath $zip -DestinationPath $stage -Force
} catch {
    Write-Host ('   [X] unpack failed: ' + $_.Exception.Message)
    exit 1
} finally {
    if (Test-Path $zip) { Remove-Item $zip -Force -ErrorAction SilentlyContinue }
}

$inner = Join-Path $stage $name
if (-not (Test-Path $inner)) { $inner = $stage }

# --- 5. move into <project>\node -----------------------------------------
if (Test-Path $nodeDir) { Remove-Item $nodeDir -Recurse -Force }
Move-Item -LiteralPath $inner -Destination $nodeDir -Force
if (Test-Path $stage) { Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue }

if (-not (Test-Path $target)) {
    Write-Host '   [X] unpacked, but node.exe is not where it should be'
    exit 1
}

# --- 6. prove it runs ----------------------------------------------------
$check = & $target -v 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Host '   [X] node.exe was placed but does not run'
    exit 1
}
Write-Host ('   done - ' + $target + '  (' + ([string]$check).Trim() + ')')
exit 0
