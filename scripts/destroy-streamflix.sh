#!/usr/bin/env bash
#
# Destroys the entire StreamFlix dev environment in the current AWS account.
# Run from the repo root: ./destroy-streamflix.sh
#
# Order matters:
#   1. Remove Kubernetes-installed, non-Terraform-managed things first (ALB Controller,
#      External Secrets Operator) — these create AWS resources (ALBs, target groups,
#      security groups) that Terraform doesn't know about and that would otherwise block
#      VPC/EKS destroy.
#   2. Empty S3 buckets (they're versioned + force_destroy=false, so `terraform destroy`
#      cannot delete them while they hold objects/versions).
#   3. terragrunt destroy everything in live/dev — terragrunt figures out the reverse
#      dependency order itself.
#   4. Optionally tear down the Terraform state backend bootstrap (S3 bucket + DynamoDB
#      lock table) — off by default since destroying your own state store is a one-way door.
#
# Safe to re-run: every step no-ops cleanly if the resource is already gone.

set -euo pipefail

REGION="ap-south-1"
ENV_DIR="infra/terragrunt/live/dev"
PROJECT_PREFIX="streamflix"   # used to find S3 buckets by prefix

read -p "This will DESTROY all StreamFlix dev AWS resources in account $(aws sts get-caller-identity --query Account --output text). Type 'yes' to continue: " CONFIRM
if [[ "$CONFIRM" != "yes" ]]; then
  echo "Aborted."
  exit 1
fi

echo "==> Step 1: Removing cluster-installed add-ons (ALB Controller, ESO) if present"
if kubectl get deployment aws-load-balancer-controller -n kube-system >/dev/null 2>&1; then
  helm uninstall aws-load-balancer-controller -n kube-system || true
else
  echo "  aws-load-balancer-controller not found, skipping"
fi

if kubectl get deployment external-secrets -n external-secrets >/dev/null 2>&1; then
  helm uninstall external-secrets -n external-secrets || true
else
  echo "  external-secrets not found, skipping"
fi

echo "  Waiting 30s for AWS to finish deprovisioning any ALBs/target groups those created..."
sleep 30

echo "==> Step 2: Emptying S3 buckets (required before terraform destroy — versioned + force_destroy=false)"
BUCKETS=$(aws s3api list-buckets --query "Buckets[?starts_with(Name, '${PROJECT_PREFIX}')].Name" --output text)
if [[ -z "$BUCKETS" ]]; then
  echo "  No matching buckets found, skipping"
else
  for BUCKET in $BUCKETS; do
    echo "  Emptying bucket: $BUCKET"
    # Delete all object versions
    aws s3api list-object-versions --bucket "$BUCKET" --output json \
      --query '{Objects: Versions[].{Key:Key,VersionId:VersionId}}' 2>/dev/null | \
      python3 -c "
import json, sys
data = json.load(sys.stdin)
objs = data.get('Objects') or []
for i in range(0, len(objs), 1000):
    batch = {'Objects': objs[i:i+1000], 'Quiet': True}
    print(json.dumps(batch))
" > /tmp/versions_batch.json 2>/dev/null || true

    if [[ -s /tmp/versions_batch.json ]]; then
      while IFS= read -r batch; do
        echo "$batch" > /tmp/delete_batch.json
        aws s3api delete-objects --bucket "$BUCKET" --delete file:///tmp/delete_batch.json >/dev/null 2>&1 || true
      done < /tmp/versions_batch.json
    fi

    # Delete all delete markers
    aws s3api list-object-versions --bucket "$BUCKET" --output json \
      --query '{Objects: DeleteMarkers[].{Key:Key,VersionId:VersionId}}' 2>/dev/null | \
      python3 -c "
import json, sys
data = json.load(sys.stdin)
objs = data.get('Objects') or []
for i in range(0, len(objs), 1000):
    batch = {'Objects': objs[i:i+1000], 'Quiet': True}
    print(json.dumps(batch))
" > /tmp/markers_batch.json 2>/dev/null || true

    if [[ -s /tmp/markers_batch.json ]]; then
      while IFS= read -r batch; do
        echo "$batch" > /tmp/delete_batch.json
        aws s3api delete-objects --bucket "$BUCKET" --delete file:///tmp/delete_batch.json >/dev/null 2>&1 || true
      done < /tmp/markers_batch.json
    fi

    echo "  Bucket $BUCKET emptied"
  done
fi
rm -f /tmp/versions_batch.json /tmp/markers_batch.json /tmp/delete_batch.json

echo "==> Step 3: Force-deleting ECR repository images (repos have images, plain destroy will fail)"
REPOS=$(aws ecr describe-repositories --region "$REGION" \
  --query "repositories[?starts_with(repositoryName, '${PROJECT_PREFIX}-dev')].repositoryName" \
  --output text 2>/dev/null || true)
if [[ -z "$REPOS" ]]; then
  echo "  No matching ECR repos found, skipping"
else
  for REPO in $REPOS; do
    IMAGE_IDS=$(aws ecr list-images --repository-name "$REPO" --region "$REGION" \
      --query 'imageIds[*]' --output json 2>/dev/null || echo "[]")
    if [[ "$IMAGE_IDS" != "[]" ]]; then
      echo "  Deleting images in $REPO"
      aws ecr batch-delete-image --repository-name "$REPO" --region "$REGION" \
        --image-ids "$IMAGE_IDS" >/dev/null 2>&1 || true
    fi
  done
fi

echo "==> Step 4: terragrunt destroy (all modules, reverse dependency order)"
pushd "$ENV_DIR" >/dev/null
terragrunt run --all destroy --non-interactive
popd >/dev/null

echo "==> Step 5 (optional): Destroy Terraform state backend (S3 state bucket + DynamoDB lock table)"
read -p "Also destroy the Terraform state backend itself? This is unrecoverable. (yes/no): " DESTROY_BACKEND
if [[ "$DESTROY_BACKEND" == "yes" ]]; then
  pushd infra/terraform/global >/dev/null
  # Empty the state bucket first (also versioned)
  STATE_BUCKET=$(terraform output -raw state_bucket 2>/dev/null || true)
  if [[ -n "$STATE_BUCKET" ]]; then
    aws s3api list-object-versions --bucket "$STATE_BUCKET" --output json \
      --query '{Objects: Versions[].{Key:Key,VersionId:VersionId}}' 2>/dev/null | \
      python3 -c "
import json, sys
data = json.load(sys.stdin)
objs = data.get('Objects') or []
if objs:
    print(json.dumps({'Objects': objs, 'Quiet': True}))
" > /tmp/state_delete.json 2>/dev/null || true
    if [[ -s /tmp/state_delete.json ]]; then
      aws s3api delete-objects --bucket "$STATE_BUCKET" --delete file:///tmp/state_delete.json >/dev/null 2>&1 || true
    fi
    rm -f /tmp/state_delete.json
  fi
  terraform destroy -var="project=streamflix-$(aws sts get-caller-identity --query Account --output text)" -auto-approve
  popd >/dev/null
else
  echo "  Skipped — state backend left in place."
fi

echo ""
echo "==> Done. Verify manually with:"
echo "    aws eks list-clusters --region $REGION"
echo "    aws rds describe-db-instances --region $REGION"
echo "    aws s3 ls | grep ${PROJECT_PREFIX}"
echo "    aws ecr describe-repositories --region $REGION"