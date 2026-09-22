# StreamFlix — Step-by-Step Usage Guide

## Part 1: Run it locally (Docker Compose)

1. **Prerequisites:** Docker + Docker Compose installed.
2. **Copy env file:**
   ```bash
   cd streamflix
   cp .env.example .env
   ```
3. **Start everything:**
   ```bash
   make up
   ```
   (or `docker compose up --build -d` if you don't have `make`)
4. **Wait for the `migrate` service to finish** (runs SQL migrations + seeds plans/genres/demo
   accounts). Check with:
   ```bash
   make logs
   ```
5. **Open the app:**
   - Web: http://localhost:3000
   - API: http://localhost:8080/api/v1
6. **Log in with a seeded account:**
   - Customer: `demo@streamflix.local` / `Demo@12345`
   - Admin: `admin@streamflix.local` / `Admin@12345`
7. **Try the customer flow:** browse → search → open a title → play → check "Continue
   Watching" on the home page → add to My List → Subscription page to view plans.
8. **Try the admin flow:** log in as admin → sidebar shows "Admin" → Titles → New title →
   fill metadata → Save → generate a test video and upload it:
   ```bash
   make sample-video          # writes ./sample-video.mp4
   ```
   Then in the title's edit page: Video section → choose `sample-video.mp4` → Upload &
   transcode → wait for job status to reach "Completed" → Publish. It now appears on the
   customer home page.
9. **Useful commands:**
   ```bash
   make logs        # tail api + worker logs
   make psql         # open a DB shell
   make down         # stop (keeps data)
   make reset         # wipe all local data and rebuild
   ```

## Part 2: Run the backend test suite

```bash
make test     # npm test, against your running docker-compose services
make lint     # lint both workspaces
```

## Part 3: Deploy real AWS infrastructure (optional — costs money)

1. **Prerequisites:** an AWS account, AWS CLI configured, Terraform ≥1.7, Terragrunt
   installed.
2. **One-time: create the Terraform state backend** (S3 bucket + DynamoDB lock table):
   ```bash
   cd infra/terraform/global
   terraform init
   terraform apply
   ```
3. **Pick an environment** (`dev`, `stage`, or `prod`) and review/edit its settings in
   `infra/terragrunt/live/<env>/env.hcl` (instance sizes, domain names, etc).
4. **Plan, then apply:**
   ```bash
   cd infra/terragrunt/live/dev
   terragrunt run-all plan
   terragrunt run-all apply
   ```
5. **Re-apply `iam`** — it creates IAM roles trusted by EKS's OIDC provider, which doesn't
   exist until step 4 finishes:
   ```bash
   cd iam && terragrunt apply
   ```
6. **Generate a CloudFront signing key pair** (used to sign private video URLs):
   ```bash
   openssl genrsa -out private.pem 2048
   openssl rsa -in private.pem -pubout -out public.pem
   ```
   Paste `public.pem`'s contents into the `cloudfront` module's
   `cloudfront_signing_public_key_pem` input, and `private.pem`'s contents into the
   `secrets` module's `cloudfront_private_key_pem` input, then re-apply those two modules.

## Part 4: Deploy the application onto that infrastructure

1. **Lint/preview the Helm chart:**
   ```bash
   make helm-lint ENV=dev
   make helm-template ENV=dev
   ```
2. **Fill in the placeholders** in `infra/helm/streamflix/values-dev.yaml` (ECR repo URL,
   IRSA role ARNs) using the `terragrunt output` values from Part 3.
3. **Build and push images to ECR**, then deploy — normally done by CI/CD (Part 5), but by
   hand:
   ```bash
   aws ecr get-login-password | docker login --username AWS --password-stdin <ECR_REGISTRY>
   docker build --target runtime -t <ECR_REGISTRY>/streamflix-dev/api:latest backend && docker push $_
   docker build --target worker  -t <ECR_REGISTRY>/streamflix-dev/worker:latest backend && docker push $_
   docker build --target runtime -t <ECR_REGISTRY>/streamflix-dev/web:latest frontend && docker push $_

   aws eks update-kubeconfig --name streamflix-dev-eks
   helm upgrade --install streamflix infra/helm/streamflix \
     -f infra/helm/streamflix/values-dev.yaml --namespace streamflix --create-namespace
   ```
4. **Deploy the frontend to S3 + CloudFront:**
   ```bash
   cd frontend && npm install && npm run build
   aws s3 sync dist s3://streamflix-dev-frontend --delete
   aws cloudfront create-invalidation --distribution-id <ID> --paths "/*"
   ```

## Part 5: Set up CI/CD (GitHub Actions)

1. In `infra/terragrunt/_envcommon/iam.hcl`, confirm `enable_github_oidc = true` is set for
   exactly one environment (already `dev`), and set `github_repo = "your-org/your-repo"` —
   then apply that `iam` module.
2. Copy the `github_actions_role_arn` output and add these **GitHub repo secrets**:
   - `AWS_DEPLOY_ROLE_ARN`, `AWS_PLAN_ROLE_ARN`, `AWS_APPLY_ROLE_ARN` (same ARN to start)
   - `ECR_REGISTRY` (e.g. `123456789012.dkr.ecr.ap-south-1.amazonaws.com`)
   - `CLOUDFRONT_DISTRIBUTION_ID`
3. Add a **repo variable** `API_BASE_URL` per environment (e.g.
   `https://api-dev.streamflix.local/api/v1`).
4. Push to `main` → `ci.yml` runs automatically (lint, tests, build, scan) → `cd.yml`
   auto-deploys to `dev`.
5. To deploy `stage`/`prod`: GitHub → Actions → **CD** → Run workflow → pick environment.
   Add required reviewers on those GitHub Environments to gate promotion behind approval.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `docker compose up` fails building `api`/`worker` | Check `backend/Dockerfile` exists and Docker has internet access to `registry.npmjs.org` |
| Video won't play after upload | Check job status on the title's edit page; if "Failed", check `make logs` for the `worker` container |
| Terragrunt `apply` fails on `iam` | Expected on the *first* run — apply once, apply `eks`, then re-apply `iam` (see Part 3, step 5) |
| Helm deploy stuck on migration Job | `kubectl -n streamflix logs job/streamflix-migrate-<N>` — usually a DB connectivity/secret issue |
