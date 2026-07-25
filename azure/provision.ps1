# One-time Azure provisioning for the MTG Pricerunner site + data refresh.
#
# Creates:
#   - a Storage Account with static website hosting  -> serves the site AND data.json
#   - a Function App (Consumption/Flex, Node 22)     -> timer-refreshes data.json
#   - a managed identity + "Storage Blob Data Contributor" role so the function can
#     write $web/data.json without any storage key or SAS token
#
# Idempotent: safe to re-run. Nothing here deploys code — that's azure/deploy.ps1
# or .github/workflows/azure-deploy.yml.
#
# Prereqs: Azure CLI (`winget install Microsoft.AzureCLI`) and `az login`.
#
# Usage:
#   ./azure/provision.ps1 -CardTraderToken '<token>'
#   ./azure/provision.ps1 -CardTraderToken '<token>' -Location westeurope -NamePrefix mtgprices

[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$CardTraderToken,
  # Storage account names are global and must be 3-24 chars, lowercase letters/digits only.
  [string]$NamePrefix = "mtgpricerunner",
  [string]$ResourceGroup = "rg-mtg-pricerunner",
  [string]$Location = "westeurope",
  # NCRONTAB: {sec} {min} {hour} {day} {month} {day-of-week}. Default: every 5 minutes.
  [string]$RefreshCron = "0 */5 * * * *"
)

$ErrorActionPreference = "Stop"

$storage  = ($NamePrefix -replace '[^a-z0-9]', '').ToLower()
if ($storage.Length -gt 24) { $storage = $storage.Substring(0, 24) }
$funcApp  = "$NamePrefix-fn"

Write-Host "Resource group : $ResourceGroup ($Location)"
Write-Host "Storage account: $storage"
Write-Host "Function app   : $funcApp"
Write-Host ""

Write-Host "==> Resource group"
az group create --name $ResourceGroup --location $Location --output none

Write-Host "==> Storage account"
az storage account create `
  --name $storage --resource-group $ResourceGroup --location $Location `
  --sku Standard_LRS --kind StorageV2 --min-tls-version TLS1_2 --output none

# Enables the $web container and the public static-website endpoint. Content in $web is
# public by design (it's a website); the account's other containers stay private.
Write-Host "==> Static website hosting"
az storage blob service-properties update `
  --account-name $storage --auth-mode login `
  --static-website --index-document index.html --404-document index.html --output none

Write-Host "==> Function app (Node 22, Functions v4)"
az functionapp create `
  --name $funcApp --resource-group $ResourceGroup `
  --storage-account $storage --consumption-plan-location $Location `
  --runtime node --runtime-version 22 --functions-version 4 --os-type Linux `
  --output none

Write-Host "==> Managed identity"
$principalId = az functionapp identity assign `
  --name $funcApp --resource-group $ResourceGroup --query principalId --output tsv

$storageId = az storage account show `
  --name $storage --resource-group $ResourceGroup --query id --output tsv

# Lets the function write $web/data.json. Role assignments can take a minute to
# propagate; a first timer run may 403 before it lands.
Write-Host "==> Role assignment (Storage Blob Data Contributor)"
az role assignment create `
  --assignee-object-id $principalId --assignee-principal-type ServicePrincipal `
  --role "Storage Blob Data Contributor" --scope $storageId --output none 2>$null

Write-Host "==> App settings"
az functionapp config appsettings set `
  --name $funcApp --resource-group $ResourceGroup `
  --settings "CARDTRADER_TOKEN=$CardTraderToken" `
             "STORAGE_ACCOUNT_NAME=$storage" `
             "DATA_REFRESH_CRON=$RefreshCron" `
             "CARDMARKET_FETCH=off" `
             "SCM_DO_BUILD_DURING_DEPLOYMENT=true" `
             "ENABLE_ORYX_BUILD=true" `
  --output none

$siteUrl = az storage account show `
  --name $storage --resource-group $ResourceGroup `
  --query "primaryEndpoints.web" --output tsv

Write-Host ""
Write-Host "Provisioned." -ForegroundColor Green
Write-Host "Site URL: $siteUrl"
Write-Host ""
Write-Host "Next: push the code with  ./azure/deploy.ps1 -NamePrefix $NamePrefix"
