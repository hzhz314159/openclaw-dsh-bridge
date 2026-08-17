# @deepseek-ai/dsh-openclaw-bridge/scripts/upload-github.ps1
# 纯 REST 上传（无 git/gh CLI 依赖）：建仓 -> Contents API 传源码 -> 创建 Release + 资产。
# 用法：
#   $env:GH_PAT='ghp_...' ; powershell -ExecutionPolicy Bypass -File scripts/upload-github.ps1 -RepoName openclaw-dsh-bridge -Private
param(
  [string]$RepoName = "openclaw-dsh-bridge",
  [switch]$Private,
  [string]$Tag = "",
  [string]$Desktop = ""
)
$ErrorActionPreference = "Stop"
if (-not $env:GH_PAT) { throw "GH_PAT env var required" }
$token = $env:GH_PAT
$repoRoot = Split-Path -Parent $PSScriptRoot
if (-not $Desktop) { $Desktop = Join-Path $env:USERPROFILE "Desktop" }
$pkg = Get-Content (Join-Path $repoRoot "package.json") -Raw | ConvertFrom-Json
if (-not $Tag) { $Tag = "v" + $pkg.version }
$api = "https://api.github.com"
$headers = @{ Authorization = "Bearer $token"; "User-Agent" = "dsh-openclaw-bridge-uploader"; Accept = "application/vnd.github+json" }
function Invoke-GH([string]$Method, [string]$Path, $Body = $null, [bool]$AllowFail = $false) {
  $Params = @{ Uri = $api + $Path; Method = $Method; Headers = $headers }
  if ($null -ne $Body) { $Params.ContentType = "application/json"; $Params.Body = ($Body | ConvertTo-Json -Depth 20 -Compress) }
  try { return Invoke-RestMethod @Params } catch {
    if ($AllowFail) { return $null }
    Write-Host ("REST FAIL " + $Method + " " + $Path + " : " + $_.Exception.Message) -ForegroundColor Red
    if ($_.ErrorDetails) { Write-Host $_.ErrorDetails.Message }
    throw
  }
}
Write-Host "== 连接 api.github.com =="
$me = Invoke-GH GET "/user"
$owner = $me.login
Write-Host ("user: " + $owner)
Write-Host "== 建仓 " + $RepoName + " (private=" + [bool]$Private + ") =="
$existing = Invoke-GH GET "/repos/$owner/$RepoName" -AllowFail $true
if ($null -eq $existing) {
  $created = Invoke-GH POST "/user/repos" @{ name = $RepoName; private = [bool]$Private; description = "DSH plugin bridging WeChat / Feishu / QQ official channels into DSH agent sessions, with an IM bridge settings section" }
  Write-Host ("repo created: " + $created.html_url)
} else {
  Write-Host ("repo exists: " + $existing.html_url)
}
$fullName = "$owner/$RepoName"
Write-Host "== 上传源码（Contents API）=="
$skipDirs = @("node_modules", ".git", "dist")
$count = 0
function Upload-Tree([string]$Dir, [string]$Prefix) {
  foreach ($item in Get-ChildItem $Dir -Force) {
    if ($item.PSIsContainer) {
      if ($item.Name -in $skipDirs) { continue }
      Upload-Tree $item.FullName ($Prefix + $item.Name + "/")
    } else {
      if ($item.Name -like "*.tgz" -or $item.Name -like "*.zip") { continue }
      if ($item.Name -in @("pack.mjs", "upload-github.ps1")) { continue }
      $path = ($Prefix + $item.Name).TrimEnd("/")
      $b64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes($item.FullName))
      $uri = "/repos/$fullName/contents/$path"
      $payload = @{ message = "chore: upload $path (v$($pkg.version))"; content = $b64 }
      try {
        Invoke-GH PUT $uri $payload | Out-Null
        $script:count++
        Write-Host ("  uploaded " + $path)
      } catch {
        Write-Host ("  SKIP " + $path + " : " + $_.Exception.Message) -ForegroundColor Yellow
      }
    }
  }
}
Upload-Tree $repoRoot ""
Write-Host ("uploaded files: " + $count)
Write-Host "== Release " + $Tag + " =="
$notes = @()
$cl = Get-Content (Join-Path $repoRoot "CHANGELOG.md") -Raw
$m = [regex]::Match($cl, "(?s)## \[([^\]]+)\].*?### 修复(.*?)(?=## |\z)")
if ($m.Success) { $notes = "CHANGELOG 见仓库内 CHANGELOG.md；本版本修复摘要：`n" + ($m.Groups[2].Value.Trim() -replace "\r|\n+", "`n").Substring(0, [Math]::Min(1500, ($m.Groups[2].Value.Trim()).Length)) }
$rel = Invoke-GH POST "/repos/$fullName/releases" @{ tag_name = $Tag; name = $Tag; body = ($notes | Out-String) }
Write-Host ("release: " + $rel.html_url)
Write-Host "== 上传资产（tgz / zip）=="
$tgz = Join-Path $Desktop ("dsh-openclaw-bridge-" + $pkg.version + ".tgz")
$zip = Join-Path $Desktop ("dsh-openclaw-bridge-" + $pkg.version + "-src.zip")
foreach ($asset in @($tgz, $zip)) {
  if (-not (Test-Path $asset)) { Write-Host ("  missing " + $asset) -ForegroundColor Yellow; continue }
  $upUrl = $rel.upload_url -replace "\{.*$", ""
  $upHeaders = @{ Authorization = "Bearer $token"; "User-Agent" = "dsh-openclaw-bridge-uploader" }
  $r = Invoke-RestMethod -Uri ($upUrl + "?name=" + [uri]::EscapeDataString([IO.Path]::GetFileName($asset))) -Method POST -Headers $upHeaders -ContentType "application/octet-stream" -InFile $asset
  Write-Host ("  asset: " + $r.browser_download_url)
}
Write-Host "== DONE =="
Write-Host ("repo: https://github.com/" + $fullName)
Write-Host ("release: " + $rel.html_url)