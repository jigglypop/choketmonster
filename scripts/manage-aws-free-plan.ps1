[CmdletBinding()]
param(
  [string]$StackName = 'choketmonster-web',
  [string]$PlanStackName = 'choketmonster-free-plan',
  [string]$Region = 'ap-northeast-2',
  [string]$ExpectedAccount = '960243570517',
  [switch]$Apply
)

$ErrorActionPreference = 'Stop'
$env:AWS_PAGER = ''
$projectRoot = Split-Path -Parent $PSScriptRoot
$siteTemplate = Join-Path $projectRoot 'infra/aws-static.yaml'
$planTemplate = Join-Path $projectRoot 'infra/aws-free-plan.yaml'
$account = (& aws sts get-caller-identity --query Account --output text).Trim()
if ($LASTEXITCODE -ne 0 -or $account -ne $ExpectedAccount) { throw "AWS account mismatch; expected $ExpectedAccount." }
$stack = & aws cloudformation describe-stacks --region $Region --stack-name $StackName --query 'Stacks[0]' --output json | ConvertFrom-Json
if ($LASTEXITCODE -ne 0) { throw 'Unable to read the existing site stack.' }
$outputs = @{}; foreach ($item in $stack.Outputs) { $outputs[$item.OutputKey] = $item.OutputValue }
$distributionArn = if ($outputs.DistributionArn) { $outputs.DistributionArn } else { "arn:aws:cloudfront::$account`:distribution/$($outputs.DistributionId)" }
$subscriptionList = & aws cloudcontrol list-resources --region us-east-1 --type-name AWS::PricingPlanManager::Subscription --output json | ConvertFrom-Json
if ($LASTEXITCODE -ne 0) { throw 'Unable to inspect existing flat-rate subscriptions.' }
$subscriptions = @($subscriptionList.ResourceDescriptions | ForEach-Object { $_.Properties | ConvertFrom-Json })
$currentSubscription = @($subscriptions | Where-Object { $_.ResourceArns -contains $distributionArn })

aws cloudformation validate-template --region $Region --template-body "file://$siteTemplate" | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Static site template validation failed.' }
aws cloudformation validate-template --region us-east-1 --template-body "file://$planTemplate" | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Free plan template validation failed.' }

$preview = [ordered]@{
  mode = if ($Apply) { 'apply-free-plan' } else { 'preview-only' }
  account = $account
  siteStack = $StackName
  distributionArn = $distributionArn
  plan = 'CloudFront FREE (USD 0/month; 1M requests and 100GB transfer allowance)'
  existingSubscriptionCount = $subscriptions.Count
  distributionAlreadySubscribed = ($currentSubscription.Count -gt 0)
  changes = @('create a CLOUDFRONT-scope WAF web ACL in us-east-1', 'attach it and use PriceClass_All with AWS managed policies', 'activate an AWS::PricingPlanManager::Subscription fixed to FREE')
}
$preview | ConvertTo-Json -Depth 4
if (-not $Apply) { return }
if ($currentSubscription.Count -gt 0) {
  $activeFree = @($currentSubscription | Where-Object { $_.Status -eq 'ACTIVE' -and $_.CurrentPlanTier -eq 'FREE' })
  if ($activeFree.Count -eq 1) {
    Write-Host "CloudFront FREE flat-rate plan is already active: $($activeFree[0].Arn)"
    return
  }
  throw 'This distribution already has a flat-rate subscription, but it is not ACTIVE on the FREE tier.'
}
if ($subscriptions.Count -ge 3) { throw 'The account already has the maximum three FREE flat-rate subscriptions.' }

$planActivated = $false
try {
  aws cloudformation deploy --region us-east-1 --stack-name $PlanStackName --template-file $planTemplate --parameter-overrides "DistributionArn=$distributionArn" 'ActivateSubscription=false' --no-fail-on-empty-changeset --tags application=choketmonster
  if ($LASTEXITCODE -ne 0) { throw 'Unable to create the global WAF prerequisite.' }
  $webAclArn = (& aws cloudformation describe-stacks --region us-east-1 --stack-name $PlanStackName --query "Stacks[0].Outputs[?OutputKey=='WebAclArn'].OutputValue | [0]" --output text).Trim()
  aws cloudformation deploy --region $Region --stack-name $StackName --template-file $siteTemplate --parameter-overrides "BucketName=$($outputs.BucketName)" "WebAclArn=$webAclArn" --no-fail-on-empty-changeset --tags application=choketmonster
  if ($LASTEXITCODE -ne 0) { throw 'Unable to associate the WAF web ACL with the distribution.' }
  aws cloudformation deploy --region us-east-1 --stack-name $PlanStackName --template-file $planTemplate --parameter-overrides "DistributionArn=$distributionArn" 'ActivateSubscription=true' --no-fail-on-empty-changeset --tags application=choketmonster
  if ($LASTEXITCODE -ne 0) { throw 'Unable to activate the FREE pricing plan.' }
  $afterList = & aws cloudcontrol list-resources --region us-east-1 --type-name AWS::PricingPlanManager::Subscription --output json | ConvertFrom-Json
  if ($LASTEXITCODE -ne 0) { throw 'Unable to verify the FREE pricing plan.' }
  $afterSubscriptions = @($afterList.ResourceDescriptions | ForEach-Object { $_.Properties | ConvertFrom-Json })
  $activeForDistribution = @($afterSubscriptions | Where-Object { $_.Status -eq 'ACTIVE' -and $_.CurrentPlanTier -eq 'FREE' -and $_.ResourceArns -contains $distributionArn })
  if ($activeForDistribution.Count -ne 1) { throw 'FREE subscription creation returned without an ACTIVE subscription for the distribution.' }
  $planActivated = $true
  Write-Host "CloudFront FREE flat-rate plan activated: $($activeForDistribution[0].Arn)"
}
finally {
  if (-not $planActivated) {
    Write-Warning 'FREE activation failed. Restoring pay-as-you-go distribution settings and deleting the temporary WAF stack.'
    aws cloudformation deploy --region $Region --stack-name $StackName --template-file $siteTemplate --parameter-overrides "BucketName=$($outputs.BucketName)" 'WebAclArn=' --no-fail-on-empty-changeset --tags application=choketmonster
    if ($LASTEXITCODE -ne 0) { throw 'FREE activation failed and the distribution rollback also failed; inspect the WAF association immediately.' }
    aws cloudformation delete-stack --region us-east-1 --stack-name $PlanStackName
    if ($LASTEXITCODE -ne 0) { throw 'FREE activation failed and the temporary WAF stack could not be deleted.' }
    aws cloudformation wait stack-delete-complete --region us-east-1 --stack-name $PlanStackName
    if ($LASTEXITCODE -ne 0) { throw 'FREE activation failed and the temporary WAF stack deletion did not complete.' }
  }
}
