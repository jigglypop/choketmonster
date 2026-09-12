[CmdletBinding()]
param(
  [string]$StackName = 'choketmonster-web',
  [string]$Region = 'ap-northeast-2',
  [string]$ExpectedAccount = '960243570517',
  [string]$ReceiptPath,
  [string]$OutputPath
)

$ErrorActionPreference = 'Stop'
$env:AWS_PAGER = ''
Add-Type -AssemblyName System.Net.Http
$projectRoot = Split-Path -Parent $PSScriptRoot
if (-not $OutputPath) { $OutputPath = Join-Path $projectRoot 'artifacts/aws-deploy-verification.json' }

$account = (& aws sts get-caller-identity --query Account --output text).Trim()
if ($LASTEXITCODE -ne 0 -or $account -ne $ExpectedAccount) { throw "AWS account mismatch; expected $ExpectedAccount." }
$stack = & aws cloudformation describe-stacks --region $Region --stack-name $StackName --query 'Stacks[0]' --output json | ConvertFrom-Json
if ($LASTEXITCODE -ne 0 -or $stack.StackStatus -notin @('CREATE_COMPLETE', 'UPDATE_COMPLETE')) { throw "Stack is not ready: $($stack.StackStatus)" }
$outputs = @{}; foreach ($item in $stack.Outputs) { $outputs[$item.OutputKey] = $item.OutputValue }
$distribution = & aws cloudfront get-distribution --id $outputs.DistributionId --output json | ConvertFrom-Json
if ($LASTEXITCODE -ne 0 -or $distribution.Distribution.Status -ne 'Deployed' -or -not $distribution.Distribution.DistributionConfig.Enabled) { throw 'CloudFront distribution is not deployed and enabled.' }
$bucketAccess = & aws s3api get-public-access-block --bucket $outputs.BucketName --region $Region --output json | ConvertFrom-Json
if ($LASTEXITCODE -ne 0) { throw 'Unable to inspect S3 public access settings.' }
$block = $bucketAccess.PublicAccessBlockConfiguration
if (-not ($block.BlockPublicAcls -and $block.IgnorePublicAcls -and $block.BlockPublicPolicy -and $block.RestrictPublicBuckets)) { throw 'S3 public access block is incomplete.' }

$checked = @()
$client = [Net.Http.HttpClient]::new()
try {
  if ($ReceiptPath) {
    $receipt = Get-Content -LiteralPath $ReceiptPath -Raw | ConvertFrom-Json
    foreach ($entry in $receipt.files) {
      if ($entry.path -match '^(models/pokemon/\d+\.glb|pokemon/(back/)?[^/]+\.png)$' -or $entry.path -match '(?i)(^|/)[^/]+\.(gb|gbc|gba|rom)$') { throw "Excluded binary is listed in receipt: $($entry.path)" }
      $uri = "$($outputs.SiteUrl)/$($entry.path)"
      $response = $client.GetAsync($uri).GetAwaiter().GetResult()
      $response.EnsureSuccessStatusCode() | Out-Null
      $bytes = $response.Content.ReadAsByteArrayAsync().GetAwaiter().GetResult()
      $sha = [Security.Cryptography.SHA256]::Create()
      try { $actual = ([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-', '').ToLowerInvariant() }
      finally { $sha.Dispose() }
      if ($actual -ne $entry.sha256) { throw "Published checksum mismatch: $($entry.path)" }
      $checked += [ordered]@{ path = $entry.path; bytes = $bytes.Length; sha256 = $actual }
    }
  }
  $request = [Net.Http.HttpRequestMessage]::new([Net.Http.HttpMethod]::Head, "$($outputs.SiteUrl)/missing-model.glb")
  $missing = $client.SendAsync($request).GetAwaiter().GetResult()
  $missingStatus = [int]$missing.StatusCode
  $missingContentType = if ($missing.Content.Headers.ContentType) { $missing.Content.Headers.ContentType.ToString() } else { '' }
} finally {
  $client.Dispose()
}
if ($missingStatus -eq 200 -or $missingContentType -like 'text/html*') { throw 'Missing binary route incorrectly returned application HTML.' }
$result = [ordered]@{
  verifiedAt = [DateTime]::UtcNow.ToString('o')
  account = $account
  stack = $StackName
  stackStatus = $stack.StackStatus
  bucket = $outputs.BucketName
  distributionId = $outputs.DistributionId
  distributionStatus = $distribution.Distribution.Status
  siteUrl = $outputs.SiteUrl
  filesChecked = $checked.Count
  files = $checked
  missingBinaryStatus = $missingStatus
}
$outputDirectory = Split-Path -Parent ([IO.Path]::GetFullPath($OutputPath))
New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null
$result | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $OutputPath -Encoding utf8
$result | ConvertTo-Json -Depth 4
