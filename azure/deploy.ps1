# Deploys the site + the data-refresh function to the Azure resources created by
# azure/provision.ps1. Run after provisioning, and again after any UI or fetcher change.
#
# Two independent halves, mirroring the GitHub setup:
#   site     -> uploads cloud/web/* into the storage account's $web container
#   function -> zip-deploys azure/functions (built remotely by Oryx)
#
# Usage:
#   ./azure/deploy.ps1                       # both
#   ./azure/deploy.ps1 -SiteOnly             # UI/CSS change
#   ./azure/deploy.ps1 -FunctionOnly         # fetcher/config change

[CmdletBinding()]
param(
  [string]$NamePrefix = "mtgpricerunner",
  [string]$ResourceGroup = "rg-mtg-pricerunner",
  [switch]$SiteOnly,
  [switch]$FunctionOnly
)

$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot

$storage = ($NamePrefix -replace '[^a-z0-9]', '').ToLower()
if ($storage.Length -gt 24) { $storage = $storage.Substring(0, 24) }
$funcApp = "$NamePrefix-fn"

$doSite = -not $FunctionOnly
$doFunc = -not $SiteOnly

if ($doSite) {
  Write-Host "==> Staging site into cloud/web"
  $web = Join-Path $repo "cloud/web"
  foreach ($f in "ui.css", "render.js", "app.js", "favicon.svg", "cardmarket-parse.js", "cardmarket-client.js") {
    Copy-Item (Join-Path $repo "shared/$f") (Join-Path $web $f) -Force
  }

  # Same cache-bust contract as the Pages deploy: stamp the asset URLs with the commit
  # SHA so fresh HTML can never pull stale JS/CSS. Unlike Pages, we also control
  # index.html's own Cache-Control below, so the ~20 min staleness window goes away.
  $sha = (git -C $repo rev-parse HEAD).Trim()
  $index = Join-Path $web "index.html"
  $html = Get-Content $index -Raw
  $assetPattern = '(href="ui\.css|href="favicon\.svg|src="render\.js|src="cardmarket-parse\.js|src="cardmarket-client\.js|src="app\.js)"'
  $html = [regex]::Replace($html, $assetPattern, "`$1?v=$sha`"")
  $stamped = ([regex]::Matches($html, [regex]::Escape("?v=$sha"))).Count
  if ($stamped -ne 6) { throw "expected to stamp 6 asset links, stamped $stamped" }
  Set-Content -Path $index -Value $html -Encoding utf8 -NoNewline

  # Assets are content-addressed by the ?v=<sha> query string, so they can be cached
  # hard. index.html must NOT be, or a deploy stays invisible until the edge expires.
  Write-Host "==> Uploading assets (immutable)"
  az storage blob upload-batch `
    --account-name $storage --auth-mode login `
    --destination '$web' --source $web `
    --pattern "*" --overwrite `
    --content-cache-control "public, max-age=31536000, immutable" `
    --exclude-pattern "index.html" --output none

  Write-Host "==> Uploading index.html (no-cache)"
  az storage blob upload `
    --account-name $storage --auth-mode login `
    --container-name '$web' --name "index.html" --file $index --overwrite `
    --content-cache-control "no-cache" --content-type "text/html; charset=utf-8" --output none

  # Undo the stamp so the working tree stays clean (cloud/web/index.html is committed).
  git -C $repo checkout -- "cloud/web/index.html"
}

if ($doFunc) {
  Write-Host "==> Staging function app"
  $fn = Join-Path $repo "azure/functions"
  # Mirror the repo's directory layout inside the function app so the relative
  # requires in cloud/*.js resolve unchanged.
  New-Item -ItemType Directory -Force -Path (Join-Path $fn "shared") | Out-Null
  New-Item -ItemType Directory -Force -Path (Join-Path $fn "cloud") | Out-Null
  Copy-Item (Join-Path $repo "config.json")   (Join-Path $fn "config.json") -Force
  foreach ($f in "cards.js", "cardmarket-parse.js") {
    Copy-Item (Join-Path $repo "shared/$f") (Join-Path $fn "shared/$f") -Force
  }
  foreach ($f in "build-data.js", "cardtrader-core.js", "cardmarket-core.js") {
    Copy-Item (Join-Path $repo "cloud/$f") (Join-Path $fn "cloud/$f") -Force
  }

  $zip = Join-Path ([System.IO.Path]::GetTempPath()) "pricerunner-fn.zip"
  if (Test-Path $zip) { Remove-Item $zip -Force }
  Write-Host "==> Zipping"
  # node_modules is intentionally not shipped: Oryx runs npm install server-side
  # (SCM_DO_BUILD_DURING_DEPLOYMENT=true, set by provision.ps1).
  $items = Get-ChildItem -Path $fn -Exclude "node_modules", "local.settings.json"
  Compress-Archive -Path $items -DestinationPath $zip -Force

  Write-Host "==> Deploying function app"
  az functionapp deployment source config-zip `
    --name $funcApp --resource-group $ResourceGroup --src $zip --build-remote true --output none
}

$siteUrl = az storage account show `
  --name $storage --resource-group $ResourceGroup `
  --query "primaryEndpoints.web" --output tsv

Write-Host ""
Write-Host "Deployed." -ForegroundColor Green
Write-Host "Site: $siteUrl"
