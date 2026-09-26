# StreamFlix — Rebuild in a New AWS Account

Old account is gone, so this is a clean rebuild, not a migration — no coexistence, no
decommission step. Every value the app depends on (account ID, bucket names, role ARNs,
CloudFront IDs) will simply be new. Nothing in the Terraform/Helm **source files** needs
editing — they're already account-agnostic. What needs changing is the **generated
config** (`values-dev.yaml`) and a handful of places outside the repo (GitHub secrets,
your local machine). This guide lists every one of them.

---

## Part 1 — New AWS account setup

### 1.1 Set a budget alert first — this is the whole reason for the rebuild
AWS Console → Billing → Budgets → Create budget → monthly threshold + email alert.

### 1.2 Create an IAM admin user, configure the CLI
```bash
aws configure
```
Enter the new account's access key, secret key, and `ap-south-1` (or your chosen region).

**Verify:**
```bash
aws sts get-caller-identity
```
Note the new `Account` ID — you'll see it echoed throughout the rest of this process.

---

## Part 2 — Re-bootstrap the Terraform state backend

The old state bucket/lock table were destroyed with the old account — there's nothing to
reuse, this is a from-scratch create:

```bash
cd infra/terraform/global
terraform init
terraform apply
```

**Verify:**
```bash
aws s3 ls | grep streamflix-terraform-state
aws dynamodb list-tables | grep streamflix-terraform-locks
```
Both exist. No file changes needed — `infra/terragrunt/terragrunt.hcl` already points at
these bucket/table names generically.

---

## Part 3 — Regenerate the CloudFront signing key pair

```bash
mkdir -p infra/.secrets
openssl genrsa -out infra/.secrets/cloudfront-private.pem 2048
openssl rsa -in infra/.secrets/cloudfront-private.pem -pubout -out infra/.secrets/cloudfront-public.pem
```
(If you still have the old `.pem` files locally and want to reuse them, that's fine too —
the keys themselves aren't account-bound. Skip this step in that case.)

**Verify `.gitignore` still excludes them:**
```bash
grep -qxF "infra/.secrets/" .gitignore || echo "infra/.secrets/" >> .gitignore
```

---

## Part 4 — Apply all infrastructure

```bash
cd infra/terragrunt/live/dev
terragrunt run-all apply
```
Run it a second time as cheap insurance (some outputs only resolve once a dependent
module has already applied once):
```bash
terragrunt run-all apply
```

**Verify everything came up clean:**
```bash
terragrunt run-all output
```
No errors, every module prints outputs. If any single module errors, `cd` into that
module's directory and `terragrunt apply` it directly, then re-run `run-all apply` from
`live/dev`.

---

## Part 5 — Collect the new account's values

Run these and keep the output handy — you'll paste them into Part 6:

```bash
cd infra/terragrunt/live/dev

echo "--- Account ---"
aws sts get-caller-identity --query Account --output text

echo "--- ECR registry ---"
cd ecr && terragrunt output repository_urls && cd ..

echo "--- IRSA role ARNs ---"
cd iam-irsa && terragrunt output api_irsa_role_arn worker_irsa_role_arn && cd ..

echo "--- MediaConvert role ---"
cd iam-cluster && terragrunt output mediaconvert_role_arn && cd ..

echo "--- MediaConvert endpoint ---"
aws mediaconvert describe-endpoints --region ap-south-1 --query "Endpoints[0].Url" --output text

echo "--- S3 bucket names ---"
cd s3 && terragrunt output bucket_names && cd ..

echo "--- CloudFront ---"
cd cloudfront && terragrunt output app_distribution_domain_name app_distribution_id media_distribution_domain_name && cd ..

echo "--- CloudFront signing key pair ID ---"
aws cloudfront list-public-keys --query "PublicKeyList.Items[?starts_with(Name, 'streamflix-dev-media-signing')].Id" --output text

echo "--- GitHub Actions IAM role ---"
cd iam-cluster && terragrunt output github_actions_role_arn && cd ..
```

---

## Part 6 — Update every place with the old account's values

### 6.1 `infra/helm/streamflix/values-dev.yaml` — replace every one of these keys
```yaml
image:
  repository: "<new ECR registry>/streamflix-dev"        # e.g. <new-account-id>.dkr.ecr.ap-south-1.amazonaws.com/streamflix-dev
api:
  serviceAccount:
    irsaRoleArn: "<new api_irsa_role_arn>"
worker:
  serviceAccount:
    irsaRoleArn: "<new worker_irsa_role_arn>"
env:
  S3_BUCKET_RAW: "<new bucket_names.raw>"
  S3_BUCKET_PROCESSED: "<new bucket_names.processed>"
  S3_BUCKET_THUMBNAILS: "<new bucket_names.thumbs>"
  MEDIACONVERT_ENDPOINT: "<new MediaConvert endpoint>"
  MEDIACONVERT_ROLE_ARN: "<new mediaconvert_role_arn>"
  CLOUDFRONT_DOMAIN: "<new media_distribution_domain_name>"
  CLOUDFRONT_KEY_PAIR_ID: "<new signing key pair ID>"
  CORS_ORIGINS: "https://<new app_distribution_domain_name>"
```
Nothing else in this file changes (replicaCount, autoscaling settings, `NODE_ENV`,
`LOG_LEVEL`, `podDisruptionBudget` all stay as they were).

### 6.2 GitHub repository secrets
Settings → Secrets and variables → Actions → update these four:
| Secret | New value |
|---|---|
| `AWS_DEPLOY_ROLE_ARN` | new `github_actions_role_arn` |
| `AWS_PLAN_ROLE_ARN` | same value |
| `AWS_APPLY_ROLE_ARN` | same value |
| `ECR_REGISTRY` | new ECR registry hostname |
| `CLOUDFRONT_DISTRIBUTION_ID` | new `app_distribution_id` |

### 6.3 Your local `kubeconfig`
```bash
aws eks update-kubeconfig --name streamflix-dev-eks --region ap-south-1
```

**Verify:**
```bash
kubectl get nodes
```
Shows the new cluster's nodes.

### 6.4 Docker/ECR login
```bash
aws ecr get-login-password --region ap-south-1 | docker login --username AWS --password-stdin <new ECR registry>
```

### 6.5 `deploy.sh`
No edit needed — it reads everything live from `terragrunt output`. Just run it with your
new AWS credentials active (`aws configure` from Part 1.2 already set that as default).

---

## Part 7 — Deploy the application

Either run the automation script end-to-end:
```bash
./deploy.sh dev
```

Or do it manually, same order as before:

```bash
# ESO
helm repo add external-secrets https://charts.external-secrets.io
helm repo update
helm install external-secrets external-secrets/external-secrets \
  --namespace external-secrets --create-namespace --wait --timeout 5m

# AWS Load Balancer Controller (new cluster — this was never carried over, needs fresh install)
# Follow your original controller install steps here (IRSA role + helm install eks/aws-load-balancer-controller)

# Build + push images
docker build --target runtime -t <new ECR registry>/streamflix-dev/api:latest backend
docker push <new ECR registry>/streamflix-dev/api:latest
docker build --target worker -t <new ECR registry>/streamflix-dev/worker:latest backend
docker push <new ECR registry>/streamflix-dev/worker:latest

# Pre-sync secrets before the migrate hook needs them (avoids the ordering issue hit last time)
helm template streamflix infra/helm/streamflix -f infra/helm/streamflix/values-dev.yaml \
  --show-only templates/externalsecrets.yaml | kubectl apply -f -

# Deploy
helm upgrade --install streamflix infra/helm/streamflix \
  -f infra/helm/streamflix/values-dev.yaml \
  --namespace streamflix --create-namespace --wait --timeout 15m

# Frontend
cd frontend
npm install
VITE_API_BASE_URL="https://<new app_distribution_domain_name>/api/v1" npm run build
aws s3 sync dist s3://<new frontend bucket> --delete
aws cloudfront create-invalidation --distribution-id <new app_distribution_id> --paths "/*"
```

**Verify at each stage, same checks as the original build:**
```bash
kubectl -n streamflix get pods
kubectl -n streamflix get externalsecret
curl -s -o /dev/null -w "%{http_code}\n" https://<new app_distribution_domain_name>/api/v1/subscriptions/plans
curl -s -o /dev/null -w "%{http_code}\n" https://<new app_distribution_domain_name>/
```
Then log in via the browser (`demo@streamflix.local` / `Demo@12345`), upload+transcode a
test video, confirm playback.

---

## Quick-reference: everything that needed a new value

| Item | New source |
|---|---|
| AWS account ID | `aws sts get-caller-identity` |
| Terraform state bucket/table | Recreated in Part 2 |
| CloudFront signing keys | Regenerated in Part 3 (or reused) |
| ECR registry URL | Part 5 `repository_urls` |
| IRSA role ARNs (api/worker) | Part 5 `iam-irsa` outputs |
| MediaConvert role + endpoint | Part 5 |
| S3 bucket names | Part 5 `s3` outputs |
| CloudFront domains + IDs | Part 5 `cloudfront` outputs |
| GitHub Actions role ARN | Part 5 `iam-cluster` output |
| `values-dev.yaml` | Manually edited, Part 6.1 |
| GitHub secrets | Manually edited, Part 6.2 |
| `kubeconfig` | Re-run `update-kubeconfig`, Part 6.3 |
| Docker login | Re-login, Part 6.4 |
| ESO / ALB Controller on cluster | Reinstall, Part 7 (fresh cluster has neither) |