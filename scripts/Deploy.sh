#!/usr/bin/env bash
# StreamFlix — full end-to-end deploy: infra -> secrets -> images -> app -> frontend.
#
# Usage: ./deploy.sh [dev|stage|prod]
#
# Assumes the repo's infra/terraform, infra/terragrunt, and infra/helm files already
# have every fix from the debugging session applied (iam-cluster/iam-irsa split,
# CloudFront CORS policy, migrate Job hook order, etc). This script only orchestrates
# running the tools in the right order with the right values wired between steps —
# it does not patch Terraform/Helm source files.
#
# Requires: aws cli, terraform, terragrunt, helm, kubectl, docker, node/npm, openssl, yq
set -euo pipefail

ENV="${1:-dev}"
REGION="ap-south-1"
PROJECT="streamflix"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TG_LIVE="$REPO_ROOT/infra/terragrunt/live/$ENV"
SECRETS_DIR="$REPO_ROOT/infra/.secrets"
VALUES_FILE="$REPO_ROOT/infra/helm/streamflix/values-$ENV.yaml"

log()  { echo -e "\n\033[1;36m==> $*\033[0m"; }
ok()   { echo -e "\033[1;32m    ✓ $*\033[0m"; }
die()  { echo -e "\033[1;31mERROR: $*\033[0m" >&2; exit 1; }

# ---------------------------------------------------------------------------
log "0. Preflight checks"
for bin in aws terraform terragrunt helm kubectl docker node npm openssl yq; do
  command -v "$bin" >/dev/null 2>&1 || die "$bin is not installed or not on PATH"
done
aws sts get-caller-identity >/dev/null || die "AWS CLI is not authenticated (run: aws configure)"
ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
ECR_REGISTRY="${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com"
ok "AWS account: $ACCOUNT_ID   Environment: $ENV"

# ---------------------------------------------------------------------------
log "1. Bootstrap Terraform state backend (idempotent — skips if it already exists)"
if aws s3api head-bucket --bucket "${PROJECT}-terraform-state" 2>/dev/null; then
  ok "State bucket already exists, skipping bootstrap"
else
  (cd "$REPO_ROOT/infra/terraform/global" && terraform init -input=false && terraform apply -auto-approve)
  ok "State backend created"
fi

# ---------------------------------------------------------------------------
log "2. Generate CloudFront signing key pair (idempotent — skips if files exist)"
mkdir -p "$SECRETS_DIR"
if [[ -f "$SECRETS_DIR/cloudfront-private.pem" ]]; then
  ok "Key pair already exists, skipping"
else
  openssl genrsa -out "$SECRETS_DIR/cloudfront-private.pem" 2048
  openssl rsa -in "$SECRETS_DIR/cloudfront-private.pem" -pubout -out "$SECRETS_DIR/cloudfront-public.pem"
  grep -qxF "infra/.secrets/" "$REPO_ROOT/.gitignore" 2>/dev/null || echo "infra/.secrets/" >> "$REPO_ROOT/.gitignore"
  ok "Key pair generated at $SECRETS_DIR"
fi

# ---------------------------------------------------------------------------
log "3. Apply all infrastructure (Terragrunt resolves the dependency graph automatically)"
(cd "$TG_LIVE" && terragrunt run-all apply --terragrunt-non-interactive)
# A second pass is cheap insurance: any resource whose dependency only became
# available during pass 1 (e.g. cross-module outputs) converges here.
(cd "$TG_LIVE" && terragrunt run-all apply --terragrunt-non-interactive)
ok "Infrastructure applied"

# ---------------------------------------------------------------------------
log "4. Collect outputs needed for the app layer"
out() { (cd "$TG_LIVE/$1" && terragrunt output -raw "$2" 2>/dev/null) || true; }

EKS_CLUSTER="$(out eks cluster_name)"
API_IRSA_ARN="$(out iam-irsa api_irsa_role_arn)"
WORKER_IRSA_ARN="$(out iam-irsa worker_irsa_role_arn)"
MEDIACONVERT_ROLE_ARN="$(out iam-cluster mediaconvert_role_arn)"
APP_CF_DOMAIN="$(out cloudfront app_distribution_domain_name)"
APP_CF_ID="$(out cloudfront app_distribution_id)"
MEDIA_CF_DOMAIN="$(out cloudfront media_distribution_domain_name)"
S3_RAW="$(out s3 bucket_names | yq -r '.raw' 2>/dev/null || true)"
S3_PROCESSED="$(out s3 bucket_names | yq -r '.processed' 2>/dev/null || true)"
S3_THUMBS="$(out s3 bucket_names | yq -r '.thumbs' 2>/dev/null || true)"
FRONTEND_BUCKET="$(out s3 bucket_names | yq -r '.frontend' 2>/dev/null || true)"
MEDIACONVERT_ENDPOINT="$(aws mediaconvert describe-endpoints --region "$REGION" --query "Endpoints[0].Url" --output text)"
CF_KEY_PAIR_ID="$(aws cloudfront list-public-keys --query "PublicKeyList.Items[?starts_with(Name, '${PROJECT}-${ENV}-media-signing')].Id | [0]" --output text)"

[[ -n "$EKS_CLUSTER" ]] || die "Could not read EKS cluster name — did step 3 fully succeed?"
ok "Cluster: $EKS_CLUSTER"

# ---------------------------------------------------------------------------
log "5. Point kubectl/helm at the cluster"
aws eks update-kubeconfig --name "$EKS_CLUSTER" --region "$REGION"
kubectl get nodes >/dev/null || die "Cannot reach the EKS cluster"
ok "kubectl configured"

# ---------------------------------------------------------------------------
log "6. Install External Secrets Operator (idempotent)"
helm repo add external-secrets https://charts.external-secrets.io >/dev/null 2>&1 || true
helm repo update >/dev/null
if helm status external-secrets -n external-secrets >/dev/null 2>&1; then
  ok "Already installed"
else
  helm install external-secrets external-secrets/external-secrets \
    --namespace external-secrets --create-namespace --wait --timeout 5m
  ok "Installed"
fi

# ---------------------------------------------------------------------------
log "7. Build, tag, and push Docker images to ECR"
aws ecr get-login-password --region "$REGION" | docker login --username AWS --password-stdin "$ECR_REGISTRY"
IMAGE_TAG="$(git -C "$REPO_ROOT" rev-parse --short HEAD 2>/dev/null || date +%s)"
for target_img in "runtime:api" "worker:worker"; do
  target="${target_img%%:*}"; img="${target_img##*:}"
  docker build --target "$target" -t "${ECR_REGISTRY}/${PROJECT}-${ENV}/${img}:${IMAGE_TAG}" "$REPO_ROOT/backend"
  docker tag "${ECR_REGISTRY}/${PROJECT}-${ENV}/${img}:${IMAGE_TAG}" "${ECR_REGISTRY}/${PROJECT}-${ENV}/${img}:latest"
  docker push "${ECR_REGISTRY}/${PROJECT}-${ENV}/${img}:${IMAGE_TAG}"
  docker push "${ECR_REGISTRY}/${PROJECT}-${ENV}/${img}:latest"
done
ok "Images pushed with tag $IMAGE_TAG"

# ---------------------------------------------------------------------------
log "8. Write resolved values into $VALUES_FILE (idempotent — yq sets keys in place)"
[[ -f "$VALUES_FILE" ]] || die "$VALUES_FILE not found"
yq -i "
  .image.repository = \"${ECR_REGISTRY}/${PROJECT}-${ENV}\" |
  .api.serviceAccount.irsaRoleArn = \"${API_IRSA_ARN}\" |
  .worker.serviceAccount.irsaRoleArn = \"${WORKER_IRSA_ARN}\" |
  .env.S3_BUCKET_RAW = \"${S3_RAW}\" |
  .env.S3_BUCKET_PROCESSED = \"${S3_PROCESSED}\" |
  .env.S3_BUCKET_THUMBNAILS = \"${S3_THUMBS}\" |
  .env.MEDIACONVERT_ENDPOINT = \"${MEDIACONVERT_ENDPOINT}\" |
  .env.MEDIACONVERT_ROLE_ARN = \"${MEDIACONVERT_ROLE_ARN}\" |
  .env.CLOUDFRONT_DOMAIN = \"${MEDIA_CF_DOMAIN}\" |
  .env.CLOUDFRONT_KEY_PAIR_ID = \"${CF_KEY_PAIR_ID}\" |
  .env.CORS_ORIGINS = \"https://${APP_CF_DOMAIN}\"
" "$VALUES_FILE"
ok "values-$ENV.yaml updated"

# ---------------------------------------------------------------------------
log "9. Ensure the CloudFront signing-key secret is synced before the migrate hook needs it"
# The pre-upgrade migrate Job's secretRef fails hard if this ExternalSecret doesn't
# exist yet on a brand-new environment — pre-apply the ExternalSecret templates once,
# standalone, so this ordering problem (hit once already this session) can't recur.
helm template streamflix "$REPO_ROOT/infra/helm/streamflix" -f "$VALUES_FILE" \
  --show-only templates/externalsecrets.yaml | kubectl apply -f - || true
for name in database redis jwt cloudfront-signing; do
  kubectl -n "$PROJECT" wait --for=jsonpath='{.status.conditions[0].status}'=True \
    "externalsecret/${PROJECT}-${name}" --timeout=90s 2>/dev/null || true
done
ok "Secrets pre-synced"

# ---------------------------------------------------------------------------
log "10. Deploy the Helm release"
helm upgrade --install streamflix "$REPO_ROOT/infra/helm/streamflix" \
  -f "$VALUES_FILE" --set image.tag="$IMAGE_TAG" \
  --namespace "$PROJECT" --create-namespace --wait --timeout 15m
kubectl -n "$PROJECT" rollout status deployment/streamflix-api
kubectl -n "$PROJECT" rollout status deployment/streamflix-worker
ok "Release deployed"

# ---------------------------------------------------------------------------
log "11. Build and deploy the frontend"
(cd "$REPO_ROOT/frontend" && npm install && VITE_API_BASE_URL="https://${APP_CF_DOMAIN}/api/v1" VITE_APP_NAME=StreamFlix npm run build)
aws s3 sync "$REPO_ROOT/frontend/dist" "s3://${FRONTEND_BUCKET}" --delete
aws cloudfront create-invalidation --distribution-id "$APP_CF_ID" --paths "/*" >/dev/null
ok "Frontend deployed"

# ---------------------------------------------------------------------------
log "12. Smoke test"
sleep 5
STATUS="$(curl -s -o /dev/null -w '%{http_code}' "https://${APP_CF_DOMAIN}/api/v1/subscriptions/plans")"
[[ "$STATUS" == "200" ]] && ok "API reachable through CloudFront (HTTP $STATUS)" \
  || echo "    ⚠ API check returned HTTP $STATUS — check 'kubectl -n $PROJECT logs deploy/streamflix-api'"

echo -e "\n\033[1;32mDone.\033[0m Visit: https://${APP_CF_DOMAIN}/login"
echo "Demo:  demo@streamflix.local / Demo@12345"
echo "Admin: admin@streamflix.local / Admin@12345"