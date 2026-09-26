# ============================================================
# STREAMFLIX DEV - COMPLETE AWS CLEANUP
# ============================================================
#
# PURPOSE:
#   Destroy StreamFlix DEV infrastructure and clean orphaned
#   AWS resources left outside Terraform state.
#
# REGION:
#   ap-south-1
#
# IMPORTANT:
#   This script is DESTRUCTIVE.
#
#   It assumes the AWS account is being used for StreamFlix DEV.
#
#   It DOES NOT delete:
#       - AWS account
#       - current IAM user
#       - default VPC
#
# ============================================================

$ErrorActionPreference = "Continue"

$REGION = "ap-south-1"
$PROJECT = "streamflix-dev"

$ROOT = Resolve-Path "$PSScriptRoot\.."
$TERRAGRUNT_DIR = Join-Path $ROOT "infra\terragrunt\live\dev"

Write-Host ""
Write-Host "============================================================" -ForegroundColor Red
Write-Host "       STREAMFLIX DEV - COMPLETE AWS CLEANUP" -ForegroundColor Red
Write-Host "============================================================" -ForegroundColor Red
Write-Host ""

# ============================================================
# AWS ACCOUNT CHECK
# ============================================================

Write-Host "[1] Checking AWS account..." -ForegroundColor Cyan

$identity = aws sts get-caller-identity `
    --output json 2>$null | ConvertFrom-Json

if (-not $identity) {
    Write-Host "AWS authentication failed." -ForegroundColor Red
    exit 1
}

Write-Host ""
Write-Host "AWS Account : $($identity.Account)" -ForegroundColor Yellow
Write-Host "AWS User    : $($identity.Arn)" -ForegroundColor Yellow
Write-Host "Region      : $REGION" -ForegroundColor Yellow
Write-Host ""

# ============================================================
# SAFETY CONFIRMATION
# ============================================================

Write-Host "THIS WILL DELETE STREAMFLIX DEV RESOURCES." -ForegroundColor Red
Write-Host ""
Write-Host "Expected resources include:" -ForegroundColor Yellow
Write-Host ""
Write-Host "  EKS"
Write-Host "  EC2"
Write-Host "  ALB"
Write-Host "  Target Groups"
Write-Host "  VPC"
Write-Host "  Subnets"
Write-Host "  NAT Gateways"
Write-Host "  Internet Gateway"
Write-Host "  Route Tables"
Write-Host "  Elastic IPs"
Write-Host "  Security Groups"
Write-Host "  RDS"
Write-Host "  ElastiCache / Redis"
Write-Host "  ECR"
Write-Host "  S3"
Write-Host "  CloudFront"
Write-Host "  WAF"
Write-Host "  Route53 resources"
Write-Host "  DynamoDB"
Write-Host "  Secrets Manager"
Write-Host "  IAM roles/policies created for StreamFlix"
Write-Host "  CloudWatch log groups"
Write-Host "  OIDC provider"
Write-Host "  Load Balancer Controller resources"
Write-Host ""

$confirm = Read-Host "Type DELETE-EVERYTHING-STREAMFLIX to continue"

if ($confirm -ne "DELETE-EVERYTHING-STREAMFLIX") {
    Write-Host ""
    Write-Host "Cleanup cancelled." -ForegroundColor Green
    exit 0
}

# ============================================================
# HELPER
# ============================================================

function Run-Aws {
    param(
        [string[]]$Arguments
    )

    Write-Host "aws $($Arguments -join ' ')" -ForegroundColor DarkGray

    & aws @Arguments

    return $LASTEXITCODE
}

function Delete-S3Bucket {
    param(
        [string]$Bucket
    )

    Write-Host "Deleting S3 bucket: $Bucket" -ForegroundColor Yellow

    aws s3 rm "s3://$Bucket" `
        --recursive `
        --region $REGION 2>$null

    aws s3api delete-bucket `
        --bucket $Bucket `
        --region $REGION 2>$null

    if ($LASTEXITCODE -eq 0) {
        Write-Host "Deleted S3 bucket: $Bucket" -ForegroundColor Green
    }
    else {
        Write-Host "Could not delete S3 bucket: $Bucket" -ForegroundColor DarkYellow
    }
}

# ============================================================
# 1. HELM / KUBERNETES CLEANUP
# ============================================================

Write-Host ""
Write-Host "============================================================"
Write-Host "[2] Removing Kubernetes / Helm resources"
Write-Host "============================================================"

helm uninstall streamflix `
    --namespace streamflix `
    2>$null

if ($LASTEXITCODE -eq 0) {
    Write-Host "Helm release removed." -ForegroundColor Green
}
else {
    Write-Host "Helm release already removed/not found." -ForegroundColor DarkYellow
}

# Remove namespace if still present
kubectl delete namespace streamflix `
    --ignore-not-found `
    --wait=false `
    2>$null

Start-Sleep -Seconds 20

# ============================================================
# 2. TERRAGRUNT DESTROY
# ============================================================

Write-Host ""
Write-Host "============================================================"
Write-Host "[3] Terragrunt complete destroy"
Write-Host "============================================================"

if (Test-Path $TERRAGRUNT_DIR) {

    Push-Location $TERRAGRUNT_DIR

    Write-Host ""
    Write-Host "Running Terragrunt destroy..." -ForegroundColor Yellow
    Write-Host ""

    terragrunt run-all destroy `
        --terragrunt-non-interactive

    Pop-Location
}
else {
    Write-Host "Terragrunt DEV directory not found." -ForegroundColor Red
}

# ============================================================
# 3. EKS CLUSTERS
# ============================================================

Write-Host ""
Write-Host "============================================================"
Write-Host "[4] Removing EKS clusters"
Write-Host "============================================================"

$clusters = aws eks list-clusters `
    --region $REGION `
    --query "clusters[?contains(@, 'streamflix')]" `
    --output text

foreach ($cluster in $clusters -split "\s+") {

    if ($cluster) {

        Write-Host "Deleting EKS cluster: $cluster" -ForegroundColor Yellow

        aws eks delete-cluster `
            --name $cluster `
            --region $REGION `
            2>$null
    }
}

# ============================================================
# 4. LOAD BALANCERS
# ============================================================

Write-Host ""
Write-Host "============================================================"
Write-Host "[5] Removing Load Balancers"
Write-Host "============================================================"

$lbs = aws elbv2 describe-load-balancers `
    --region $REGION `
    --query "LoadBalancers[?contains(LoadBalancerName, 'streamfl')].LoadBalancerArn" `
    --output text

foreach ($lb in $lbs -split "\s+") {

    if ($lb) {

        Write-Host "Deleting ALB: $lb" -ForegroundColor Yellow

        aws elbv2 delete-load-balancer `
            --load-balancer-arn $lb `
            --region $REGION `
            2>$null
    }
}

# ============================================================
# 5. TARGET GROUPS
# ============================================================

Write-Host ""
Write-Host "============================================================"
Write-Host "[6] Removing Target Groups"
Write-Host "============================================================"

$targetGroups = aws elbv2 describe-target-groups `
    --region $REGION `
    --query "TargetGroups[?contains(TargetGroupName, 'streamfl')].TargetGroupArn" `
    --output text

foreach ($tg in $targetGroups -split "\s+") {

    if ($tg) {

        Write-Host "Deleting Target Group: $tg" -ForegroundColor Yellow

        aws elbv2 delete-target-group `
            --target-group-arn $tg `
            --region $REGION `
            2>$null
    }
}

# ============================================================
# 6. ECR
# ============================================================

Write-Host ""
Write-Host "============================================================"
Write-Host "[7] Removing ECR repositories"
Write-Host "============================================================"

$repos = aws ecr describe-repositories `
    --region $REGION `
    --query "repositories[?contains(repositoryName, 'streamflix')].repositoryName" `
    --output text

foreach ($repo in $repos -split "\s+") {

    if ($repo) {

        Write-Host "Deleting ECR repository: $repo" -ForegroundColor Yellow

        aws ecr delete-repository `
            --repository-name $repo `
            --region $REGION `
            --force `
            2>$null
    }
}

# ============================================================
# 7. S3
# ============================================================

Write-Host ""
Write-Host "============================================================"
Write-Host "[8] Removing StreamFlix S3 buckets"
Write-Host "============================================================"

$buckets = aws s3api list-buckets `
    --query "Buckets[].Name" `
    --output text

foreach ($bucket in $buckets -split "\s+") {

    if ($bucket -and $bucket -match "streamflix") {

        Delete-S3Bucket $bucket
    }
}

# ============================================================
# 8. CLOUDFRONT
# ============================================================

Write-Host ""
Write-Host "============================================================"
Write-Host "[9] Removing CloudFront distributions"
Write-Host "============================================================"

$distributions = aws cloudfront list-distributions `
    --query "DistributionList.Items[?contains(Comment, 'streamflix') || contains(DomainName, 'streamflix')].[Id,DomainName,Enabled]" `
    --output text

$cfData = $distributions -split "`n"

foreach ($line in $cfData) {

    if ($line.Trim()) {

        $parts = $line -split "\s+"

        $id = $parts[0]

        if ($id) {

            Write-Host "Processing CloudFront distribution: $id" -ForegroundColor Yellow

            $config = aws cloudfront get-distribution-config `
                --id $id `
                --output json 2>$null

            if ($config) {

                $json = $config | ConvertFrom-Json

                if ($json.DistributionConfig.Enabled -eq $true) {

                    $json.DistributionConfig.Enabled = $false

                    $json.DistributionConfig |
                        ConvertTo-Json -Depth 50 |
                        Set-Content "$env:TEMP\cf-$id.json"

                    aws cloudfront update-distribution `
                        --id $id `
                        --if-match $json.ETag `
                        --distribution-config file://$env:TEMP\cf-$id.json `
                        2>$null

                    Write-Host "Disabled CloudFront: $id" -ForegroundColor Green
                }
            }
        }
    }
}

Write-Host ""
Write-Host "CloudFront distributions require propagation after disabling." -ForegroundColor Yellow
Write-Host "They may need to be deleted in a second pass once status becomes Disabled." -ForegroundColor Yellow

# ============================================================
# 9. WAF
# ============================================================

Write-Host ""
Write-Host "============================================================"
Write-Host "[10] Removing WAF resources"
Write-Host "============================================================"

$wafs = aws wafv2 list-web-acls `
    --scope CLOUDFRONT `
    --region us-east-1 `
    --query "WebACLs[?contains(Name, 'streamflix')].[Name,Id,ARN]" `
    --output text 2>$null

foreach ($line in $wafs -split "`n") {

    if ($line.Trim()) {

        $parts = $line -split "\s+"

        if ($parts.Count -ge 2) {

            $name = $parts[0]
            $id = $parts[1]

            $lock = aws wafv2 get-web-acl `
                --name $name `
                --id $id `
                --scope CLOUDFRONT `
                --region us-east-1 `
                --query "LockToken" `
                --output text 2>$null

            if ($lock) {

                Write-Host "Deleting WAF: $name" -ForegroundColor Yellow

                aws wafv2 delete-web-acl `
                    --name $name `
                    --id $id `
                    --scope CLOUDFRONT `
                    --region us-east-1 `
                    --lock-token $lock `
                    2>$null
            }
        }
    }
}

# ============================================================
# 10. RDS
# ============================================================

Write-Host ""
Write-Host "============================================================"
Write-Host "[11] Removing RDS instances"
Write-Host "============================================================"

$rds = aws rds describe-db-instances `
    --region $REGION `
    --query "DBInstances[?contains(DBInstanceIdentifier, 'streamflix')].DBInstanceIdentifier" `
    --output text

foreach ($db in $rds -split "\s+") {

    if ($db) {

        Write-Host "Deleting RDS: $db" -ForegroundColor Yellow

        aws rds delete-db-instance `
            --db-instance-identifier $db `
            --skip-final-snapshot `
            --delete-automated-backups `
            --region $REGION `
            2>$null
    }
}

# ============================================================
# 11. ELASTICACHE
# ============================================================

Write-Host ""
Write-Host "============================================================"
Write-Host "[12] Removing ElastiCache"
Write-Host "============================================================"

$cache = aws elasticache describe-cache-clusters `
    --region $REGION `
    --query "CacheClusters[?contains(CacheClusterId, 'streamflix')].CacheClusterId" `
    --output text

foreach ($cluster in $cache -split "\s+") {

    if ($cluster) {

        Write-Host "Deleting ElastiCache: $cluster" -ForegroundColor Yellow

        aws elasticache delete-cache-cluster `
            --cache-cluster-id $cluster `
            --region $REGION `
            2>$null
    }
}

# ============================================================
# 12. DYNAMODB
# ============================================================

Write-Host ""
Write-Host "============================================================"
Write-Host "[13] Removing DynamoDB"
Write-Host "============================================================"

$tables = aws dynamodb list-tables `
    --region $REGION `
    --query "TableNames[?contains(@, 'streamflix')]" `
    --output text

foreach ($table in $tables -split "\s+") {

    if ($table) {

        Write-Host "Deleting DynamoDB table: $table" -ForegroundColor Yellow

        aws dynamodb delete-table `
            --table-name $table `
            --region $REGION `
            2>$null
    }
}

# ============================================================
# 13. SECRETS MANAGER
# ============================================================

Write-Host ""
Write-Host "============================================================"
Write-Host "[14] Removing Secrets Manager secrets"
Write-Host "============================================================"

$secrets = aws secretsmanager list-secrets `
    --region $REGION `
    --query "SecretList[?contains(Name, 'streamflix')].ARN" `
    --output text

foreach ($secret in $secrets -split "\s+") {

    if ($secret) {

        Write-Host "Deleting secret: $secret" -ForegroundColor Yellow

        aws secretsmanager delete-secret `
            --secret-id $secret `
            --force-delete-without-recovery `
            --region $REGION `
            2>$null
    }
}

# ============================================================
# 14. CLOUDWATCH LOG GROUPS
# ============================================================

Write-Host ""
Write-Host "============================================================"
Write-Host "[15] Removing CloudWatch log groups"
Write-Host "============================================================"

$logs = aws logs describe-log-groups `
    --region $REGION `
    --query "logGroups[?contains(logGroupName, 'streamflix')].logGroupName" `
    --output text

foreach ($log in $logs -split "\s+") {

    if ($log) {

        Write-Host "Deleting log group: $log" -ForegroundColor Yellow

        aws logs delete-log-group `
            --log-group-name $log `
            --region $REGION `
            2>$null
    }
}

# ============================================================
# 15. EC2 INSTANCES
# ============================================================

Write-Host ""
Write-Host "============================================================"
Write-Host "[16] Removing StreamFlix EC2 instances"
Write-Host "============================================================"

$instances = aws ec2 describe-instances `
    --region $REGION `
    --filters `
        "Name=tag:Name,Values=*streamflix*" `
    --query "Reservations[].Instances[?State.Name!='terminated'].InstanceId" `
    --output text

if ($instances) {

    Write-Host "Stopping/terminating instances..." -ForegroundColor Yellow

    aws ec2 terminate-instances `
        --instance-ids $instances `
        --region $REGION `
        2>$null
}

# ============================================================
# 16. NAT GATEWAYS
# ============================================================

Write-Host ""
Write-Host "============================================================"
Write-Host "[17] Removing NAT Gateways"
Write-Host "============================================================"

$natGateways = aws ec2 describe-nat-gateways `
    --region $REGION `
    --filter "Name=tag:Name,Values=*streamflix*" `
    --query "NatGateways[?State!='deleted'].NatGatewayId" `
    --output text

foreach ($nat in $natGateways -split "\s+") {

    if ($nat) {

        Write-Host "Deleting NAT Gateway: $nat" -ForegroundColor Yellow

        aws ec2 delete-nat-gateway `
            --nat-gateway-id $nat `
            --region $REGION `
            2>$null
    }
}

# ============================================================
# 17. EIPs
# ============================================================

Write-Host ""
Write-Host "============================================================"
Write-Host "[18] Releasing StreamFlix Elastic IPs"
Write-Host "============================================================"

$addresses = aws ec2 describe-addresses `
    --region $REGION `
    --query "Addresses[?Tags[?Key=='Name' && contains(Value, 'streamflix')]].AllocationId" `
    --output text

foreach ($allocation in $addresses -split "\s+") {

    if ($allocation) {

        Write-Host "Releasing EIP: $allocation" -ForegroundColor Yellow

        aws ec2 release-address `
            --allocation-id $allocation `
            --region $REGION `
            2>$null
    }
}

# ============================================================
# 18. IAM ROLES
# ============================================================

Write-Host ""
Write-Host "============================================================"
Write-Host "[19] Removing StreamFlix IAM roles"
Write-Host "============================================================"

$roles = aws iam list-roles `
    --query "Roles[?contains(RoleName, 'streamflix-dev')].RoleName" `
    --output text

foreach ($role in $roles -split "\s+") {

    if ($role) {

        Write-Host "Processing IAM role: $role" -ForegroundColor Yellow

        $policies = aws iam list-role-policies `
            --role-name $role `
            --query "PolicyNames[]" `
            --output text

        foreach ($policy in $policies -split "\s+") {

            if ($policy) {

                aws iam delete-role-policy `
                    --role-name $role `
                    --policy-name $policy `
                    2>$null
            }
        }

        $attached = aws iam list-attached-role-policies `
            --role-name $role `
            --query "AttachedPolicies[].PolicyArn" `
            --output text

        foreach ($policyArn in $attached -split "\s+") {

            if ($policyArn) {

                aws iam detach-role-policy `
                    --role-name $role `
                    --policy-arn $policyArn `
                    2>$null
            }
        }

        aws iam delete-role `
            --role-name $role `
            2>$null
    }
}

# ============================================================
# 19. IAM POLICIES
# ============================================================

Write-Host ""
Write-Host "============================================================"
Write-Host "[20] Removing StreamFlix IAM policies"
Write-Host "============================================================"

$policies = aws iam list-policies `
    --scope Local `
    --query "Policies[?contains(PolicyName, 'streamflix-dev')].Arn" `
    --output text

foreach ($policy in $policies -split "\s+") {

    if ($policy) {

        Write-Host "Deleting IAM policy: $policy" -ForegroundColor Yellow

        $versions = aws iam list-policy-versions `
            --policy-arn $policy `
            --query "Versions[?IsDefaultVersion==``false``].VersionId" `
            --output text

        foreach ($version in $versions -split "\s+") {

            if ($version) {

                aws iam delete-policy-version `
                    --policy-arn $policy `
                    --version-id $version `
                    2>$null
            }
        }

        aws iam delete-policy `
            --policy-arn $policy `
            2>$null
    }
}

# ============================================================
# 20. EKS OIDC PROVIDERS
# ============================================================

Write-Host ""
Write-Host "============================================================"
Write-Host "[21] Removing StreamFlix OIDC provider"
Write-Host "============================================================"

$oidcProviders = aws iam list-open-id-connect-providers `
    --query "OpenIDConnectProviderList[].Arn" `
    --output text

foreach ($provider in $oidcProviders -split "\s+") {

    if ($provider -and $provider -match "streamflix") {

        Write-Host "Deleting OIDC provider: $provider" -ForegroundColor Yellow

        aws iam delete-open-id-connect-provider `
            --open-id-connect-provider-arn $provider `
            2>$null
    }
}

# ============================================================
# 21. ROUTE53 STREAMFLIX HOSTED ZONES
# ============================================================

Write-Host ""
Write-Host "============================================================"
Write-Host "[22] Checking Route53"
Write-Host "============================================================"

$zones = aws route53 list-hosted-zones `
    --query "HostedZones[?contains(Name, 'streamflix')].[Id,Name]" `
    --output text

foreach ($line in $zones -split "`n") {

    if ($line.Trim()) {

        $parts = $line -split "\s+"

        $zoneId = $parts[0] -replace "/hostedzone/",""

        if ($zoneId) {

            Write-Host "Deleting Route53 hosted zone: $zoneId" -ForegroundColor Yellow

            aws route53 list-resource-record-sets `
                --hosted-zone-id $zoneId `
                --query "ResourceRecordSets[?Type!='NS' && Type!='SOA']" `
                --output json |
                Out-Null

            # Terraform-managed records should already be gone.
            # Zone deletion may fail if records remain.
            aws route53 delete-hosted-zone `
                --id $zoneId `
                2>$null
        }
    }
}

# ============================================================
# 22. FINAL REPORT
# ============================================================

Write-Host ""
Write-Host "============================================================" -ForegroundColor Green
Write-Host "          CLEANUP COMMANDS / FINAL CHECK" -ForegroundColor Green
Write-Host "============================================================"
Write-Host ""

Write-Host "EKS clusters:" -ForegroundColor Cyan
aws eks list-clusters --region $REGION

Write-Host ""
Write-Host "Load Balancers:" -ForegroundColor Cyan
aws elbv2 describe-load-balancers `
    --region $REGION `
    --query "LoadBalancers[].LoadBalancerName" `
    --output table

Write-Host ""
Write-Host "NAT Gateways:" -ForegroundColor Cyan
aws ec2 describe-nat-gateways `
    --region $REGION `
    --query "NatGateways[?State!='deleted'].[NatGatewayId,State]" `
    --output table

Write-Host ""
Write-Host "RDS:" -ForegroundColor Cyan
aws rds describe-db-instances `
    --region $REGION `
    --query "DBInstances[].DBInstanceIdentifier" `
    --output table

Write-Host ""
Write-Host "ElastiCache:" -ForegroundColor Cyan
aws elasticache describe-cache-clusters `
    --region $REGION `
    --query "CacheClusters[].CacheClusterId" `
    --output table

Write-Host ""
Write-Host "ECR:" -ForegroundColor Cyan
aws ecr describe-repositories `
    --region $REGION `
    --query "repositories[].repositoryName" `
    --output table

Write-Host ""
Write-Host "S3 StreamFlix buckets:" -ForegroundColor Cyan
aws s3api list-buckets `
    --query "Buckets[?contains(Name, 'streamflix')].Name" `
    --output table

Write-Host ""
Write-Host "Secrets:" -ForegroundColor Cyan
aws secretsmanager list-secrets `
    --region $REGION `
    --query "SecretList[?contains(Name, 'streamflix')].Name" `
    --output table

Write-Host ""
Write-Host "CloudFront:" -ForegroundColor Cyan
aws cloudfront list-distributions `
    --query "DistributionList.Items[].[Id,DomainName,Status]" `
    --output table

Write-Host ""
Write-Host "============================================================"
Write-Host "             CLEANUP SCRIPT FINISHED"
Write-Host "============================================================"
Write-Host ""

Write-Host "NOTE:" -ForegroundColor Yellow
Write-Host "CloudFront, RDS, NAT Gateway and some AWS resources may"
Write-Host "take several minutes to finish deleting."
Write-Host ""