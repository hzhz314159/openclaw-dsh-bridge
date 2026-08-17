# Run protocol-level unit tests without touching the DSH install.
# Builds a temp node_modules that junctions every dependency of the DSH tree,
# plus the plugin repo itself, then runs the test with a temp USERPROFILE.
# Works on any machine with a DSH Desktop install (no node.exe on PATH required:
# falls back to the bundled C:\Program Files\DSH Desktop\resources\node\node.exe).
# NOTE: keep this file pure ASCII (comments in English) - PowerShell 5.1 decodes
# byte streams without a UTF-8 BOM as GBK, which corrupts non-ASCII comments.
# NOTE: Windows PowerShell 5.1 Format-Hex has no -Count; use Get-Content -Encoding Byte.
param([string]$Desktop = "")
$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot

if (-not $Desktop) {
  $candidates = @(
    "C:\Program Files\DSH Desktop\resources\app",
    "D:\app\dsh\DSH Desktop\resources\app",
    (Join-Path $env:LOCALAPPDATA "Programs\dsh-desktop\resources\app"),
    (Join-Path $env:ProgramFiles "dsh-desktop\resources\app")
  )
  $Desktop = $candidates | Where-Object { Test-Path (Join-Path $_ "main.js") } | Select-Object -First 1
}
if (-not $Desktop -or -not (Test-Path (Join-Path $Desktop "main.js"))) {
  throw "DSH Desktop install not found. Pass -Desktop pointing at its resources\app directory."
}

$node = "C:\Program Files\DSH Desktop\resources\node\node.exe"
if (-not (Test-Path $node)) { $node = (Get-Command node -ErrorAction SilentlyContinue).Source }
if (-not $node -or -not (Test-Path $node)) { throw "node.exe not found (expected bundled DSH node or node on PATH)" }

$nm = Join-Path $Desktop "node_modules"
$tmp = Join-Path $env:TEMP ("dsh-bridge-test-run-" + [guid]::NewGuid().ToString("N"))
$tmpNm = Join-Path $tmp "node_modules"
$tmpHome = Join-Path $tmp "home"

function New-Junction([string]$Link, [string]$Target) {
  New-Item -ItemType Junction -Path $Link -Target $Target | Out-Null
}

try {
  New-Item -ItemType Directory -Force -Path (Join-Path $tmpNm "@deepseek-ai") | Out-Null
  # Top-level deps (except the @deepseek-ai scope) get a junction each.
  Get-ChildItem $nm -Directory | ForEach-Object {
    if ($_.Name -eq "@deepseek-ai") { return }
    New-Junction (Join-Path $tmpNm $_.Name) $_.FullName
  }
  # Inside @deepseek-ai, junction every package except the plugin itself.
  Get-ChildItem (Join-Path $nm "@deepseek-ai") -Directory | ForEach-Object {
    if ($_.Name -eq "dsh-openclaw-bridge") { return }
    New-Junction (Join-Path $tmpNm "@deepseek-ai\$($_.Name)") $_.FullName
  }
  # The plugin itself is COPIED (not junctioned): ESM resolves through the symlink
  # realpath, so a junction would make it look for deps at the repo's real path
  # instead of the temp tree's node_modules; a copy keeps subpath imports correct.
  New-Item -ItemType Directory -Force -Path (Join-Path $tmpNm "@deepseek-ai\dsh-openclaw-bridge\lib") | Out-Null
  Copy-Item (Join-Path $repo "package.json") (Join-Path $tmpNm "@deepseek-ai\dsh-openclaw-bridge\package.json") -Force
  Copy-Item (Join-Path $repo "lib\*") (Join-Path $tmpNm "@deepseek-ai\dsh-openclaw-bridge\lib") -Recurse -Force
  Copy-Item (Join-Path $repo "test\bridge.test.mjs") (Join-Path $tmp "bridge.test.mjs") -Force

  $env:USERPROFILE = $tmpHome
  # PS 5.1: with $ErrorActionPreference=Stop, native stderr lines (expected log
  # output from negative test cases) become terminating errors. Capture with
  # Continue and judge the run by $LASTEXITCODE only.
  $ErrorActionPreference = "Continue"
  $out = & $node (Join-Path $tmp "bridge.test.mjs") 2>&1
  $ErrorActionPreference = "Stop"
  $code = $LASTEXITCODE
  $out | Out-String | Write-Host
  if ($code -ne 0) { throw "tests failed (exit $code)" }
  Write-Host "Tests passed"
} finally {
  Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
}