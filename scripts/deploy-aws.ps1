[CmdletBinding()]
param(
  [string]$StackName = 'choketmonster-web',
  [string]$Region = 'ap-northeast-2',
  [string]$BucketName = 'choketmonster-960243570517-apne2',
  [string]$ExpectedAccount = '960243570517',
  [string]$ReceiptPath,
  [switch]$ProvisionOnly,
  [switch]$SkipBuild
)

$ErrorActionPreference = 'Stop'
$env:AWS_PAGER = ''
$projectRoot = Split-Path -Parent $PSScriptRoot
$template = Join-Path $projectRoot 'infra/aws-static.yaml'
if (-not $ReceiptPath) { $ReceiptPath = Join-Path $projectRoot 'artifacts/deploy-latest.json' }
$receiptPath = [IO.Path]::GetFullPath($ReceiptPath)

function Invoke-Aws {
  param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Arguments)
  & aws @Arguments
  if ($LASTEXITCODE -ne 0) { throw "AWS CLI failed: aws $($Arguments -join ' ')" }
}

$account = (& aws sts get-caller-identity --query Account --output text).Trim()
if ($LASTEXITCODE -ne 0) { throw 'Unable to read the current AWS identity.' }
if ($account -ne $ExpectedAccount) { throw "Refusing deployment to AWS account $account; expected $ExpectedAccount." }

Push-Location $projectRoot
try {
  Invoke-Aws cloudformation validate-template --region $Region --template-body "file://$template" | Out-Null
  $existingWebAcl = (& aws cloudformation describe-stacks --region $Region --stack-name $StackName --query "Stacks[0].Parameters[?ParameterKey=='WebAclArn'].ParameterValue | [0]" --output text 2>$null).Trim()
  $overrides = @("BucketName=$BucketName")
  if ($existingWebAcl -and $existingWebAcl -ne 'None') { $overrides += "WebAclArn=$existingWebAcl" }
  Invoke-Aws cloudformation deploy --region $Region --stack-name $StackName --template-file $template --parameter-overrides @overrides --no-fail-on-empty-changeset --tags application=choketmonster

  $status = (& aws cloudformation describe-stacks --region $Region --stack-name $StackName --query 'Stacks[0].StackStatus' --output text).Trim()
  if ($LASTEXITCODE -ne 0 -or $status -notin @('CREATE_COMPLETE', 'UPDATE_COMPLETE')) { throw "CloudFormation stack is not ready: $status" }
  $outputs = & aws cloudformation describe-stacks --region $Region --stack-name $StackName --query 'Stacks[0].Outputs' --output json
  if ($LASTEXITCODE -ne 0) { throw 'Unable to read CloudFormation outputs.' }
  Write-Host "Stack status: $status"
  Write-Output $outputs

  if ($ProvisionOnly) { return }
  if (-not $SkipBuild) {
    & npm run build
    if ($LASTEXITCODE -ne 0) { throw 'Application build failed.' }
    & npx tsx scripts/prepare-deploy.ts
    if ($LASTEXITCODE -ne 0) { throw 'Deployment payload preparation failed.' }
  }
  if (-not (Test-Path -LiteralPath $receiptPath)) { throw 'Deployment receipt is missing. Run without -SkipBuild or pass -ReceiptPath.' }
  $receipt = Get-Content -LiteralPath $receiptPath -Raw | ConvertFrom-Json
  $dist = [IO.Path]::GetFullPath($receipt.directory)
  $artifactRoot = [IO.Path]::GetFullPath((Join-Path $projectRoot 'artifacts')) + [IO.Path]::DirectorySeparatorChar
  if (-not $dist.StartsWith($artifactRoot, [StringComparison]::OrdinalIgnoreCase)) { throw 'Payload must stay inside project artifacts.' }
  if (-not (Test-Path -LiteralPath (Join-Path $dist 'index.html'))) { throw 'Payload index.html is missing.' }
  foreach ($entry in $receipt.files) {
    if ($entry.path -match '^(models/pokemon/\d+\.glb|pokemon/(back/)?\d+\.png)$' -or $entry.path -match '(?i)(^|/)[^/]+\.(gb|gbc|gba|rom)$') { throw 'Excluded Pokemon or Game Boy binary entered deployment payload.' }
    $file = [IO.Path]::GetFullPath((Join-Path $dist $entry.path))
    if (-not $file.StartsWith($dist + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Invalid payload file path.' }
    if ((Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant() -ne $entry.sha256) { throw "Payload checksum mismatch: $($entry.path)" }
  }

  # Publish the verified payload; retain previous hashed chunks for open browser tabs.
  Invoke-Aws s3 sync $dist "s3://$BucketName" --region $Region --exclude 'index.html' --exclude 'assets/*' --exclude 'models/pokemon/*.glb' --exclude 'pokemon/*.png' --exclude 'pokemon/back/*.png' --cache-control 'public,max-age=300' --no-progress
  $assets = Join-Path $dist 'assets'
  if (Test-Path -LiteralPath $assets) {
    Invoke-Aws s3 cp $assets "s3://$BucketName/assets" --region $Region --recursive --cache-control 'public,max-age=31536000,immutable' --no-progress
  }
  Invoke-Aws s3 cp (Join-Path $dist 'index.html') "s3://$BucketName/index.html" --region $Region --cache-control 'no-cache,max-age=0,must-revalidate' --content-type 'text/html; charset=utf-8' --no-progress

  $distributionId = (& aws cloudformation describe-stacks --region $Region --stack-name $StackName --query "Stacks[0].Outputs[?OutputKey=='DistributionId'].OutputValue | [0]" --output text).Trim()
  if ($LASTEXITCODE -ne 0 -or -not $distributionId) { throw 'Unable to resolve the CloudFront distribution ID.' }
  $invalidation = & aws cloudfront create-invalidation --distribution-id $distributionId --paths '/*' --output json | ConvertFrom-Json
  if ($LASTEXITCODE -ne 0) { throw 'Unable to create the CloudFront invalidation.' }
  Invoke-Aws cloudfront wait invalidation-completed --distribution-id $distributionId --id $invalidation.Invalidation.Id
  $siteUrl = (& aws cloudformation describe-stacks --region $Region --stack-name $StackName --query "Stacks[0].Outputs[?OutputKey=='SiteUrl'].OutputValue | [0]" --output text).Trim()
  $receipt | Add-Member -Force NoteProperty deployment ([ordered]@{
    account = $account
    region = $Region
    stackName = $StackName
    bucketName = $BucketName
    distributionId = $distributionId
    siteUrl = $siteUrl
    invalidationId = $invalidation.Invalidation.Id
    invalidationStatus = 'Completed'
    deployedAt = [DateTime]::UtcNow.ToString('o')
  })
  $deployedReceiptPath = "$dist.deployed.json"
  $receipt | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $receiptPath -Encoding utf8
  $receipt | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $deployedReceiptPath -Encoding utf8
  & (Join-Path $PSScriptRoot 'verify-aws-deploy.ps1') -ReceiptPath $receiptPath -StackName $StackName -Region $Region -ExpectedAccount $ExpectedAccount
  if ($LASTEXITCODE -ne 0) { throw 'Post-deployment verification failed.' }
  Write-Host "Verified static payload uploaded. Deployment receipt: $deployedReceiptPath"
} finally {
  Pop-Location
}
