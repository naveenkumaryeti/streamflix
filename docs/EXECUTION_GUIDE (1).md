# StreamFlix — Detailed Execution Guide

Every command below is necessary; none are optional filler. Each step explains **why** it
exists, and is followed by a **verification** you can run before moving to the next step.
If a verification fails, stop and fix that step — don't proceed.

---

## Part 1 — Prerequisites

### Step 1.1: Install Docker and Docker Compose

**Why:** The entire local stack (Postgres, Redis, DynamoDB Local, the API, the transcode
worker, and the web frontend) runs as containers defined in `docker-compose.yml`. Nothing
in Part 1–2 works without a working Docker daemon.

```bash
docker --version
docker compose version
```

**Verify:** Both commands print a version number (Docker ≥ 24, Compose ≥ v2). If either
errors with "command not found," install Docker Desktop (Mac/Windows) or Docker Engine +
the compose plugin (Linux) before continuing.

### Step 1.2: Confirm ports are free

**Why:** The stack binds host ports `3000` (web), `8080` (api), `9090` (worker health),
`5432` (postgres), `6379` (redis), `8000` (dynamodb-local). If something else on your
machine already uses one of these, the corresponding container will fail to start.

```bash
lsof -i :3000 -i :8080 -i :9090 -i :5432 -i :6379 -i :8000
```

**Verify:** No output means all six ports are free — good. If a port shows up, stop
whatever's using it, or edit the `ports:` mapping for that service in `docker-compose.yml`
before Step 2.2.

---

## Part 2 — Run the app locally

### Step 2.1: Copy the environment file

**Why:** The API, worker, and Postgres containers all read configuration from `.env`
(database credentials, JWT signing secrets, CORS origins, etc.) via `env_file: [.env]` in
`docker-compose.yml`. `.env` itself is git-ignored (so real secrets never get committed);
`.env.example` is the checked-in template with safe local-dev defaults.

```bash
cd streamflix
cp .env.example .env
```

**Verify:**
```bash
test -f .env && echo "OK: .env exists"
```

### Step 2.2: Build and start every service

**Why:** `docker compose up --build` builds the images (postgres/redis/dynamodb are pulled,
not built; `migrate`/`api` reuse the backend's `runtime` build target, `worker` uses the
`worker` target with ffmpeg baked in, `web` builds the Vite frontend and serves it via
nginx) and starts them in dependency order — `depends_on` in the compose file makes
Postgres/Redis/DynamoDB come up before `migrate`, and `migrate` finish before `api`/`worker`
start, so the API never boots against a database with no schema yet.

```bash
make up
```
This is a shortcut for `docker compose up --build -d`. If you don't have `make` installed,
run that command directly instead.

**Why `-d` (detached):** so the containers run in the background and you get your terminal
back for the verification commands below.

**Verify — all containers running:**
```bash
docker compose ps
```
Expect `postgres`, `redis`, `dynamodb`, `api`, `worker`, `web` all with a `State` of
`running` (or `healthy`, once their healthchecks pass — give it ~20–30 seconds). The
`migrate` container should show `Exited (0)` — that's correct, it's a one-shot job that
runs the SQL migrations and seed data, then exits successfully.

**Verify — migration actually succeeded (don't skip this):**
```bash
docker compose logs migrate
```
Look for a line indicating migrations applied and seed data loaded, with no stack trace at
the end. If `migrate` exited non-zero, `api` will still be running but every request will
fail — check this log before debugging anything downstream.

**Verify — API is healthy:**
```bash
curl -s http://localhost:8080/healthz
curl -s http://localhost:8080/readyz
```
**Why two checks:** `/healthz` only confirms the Node process is alive (no external calls);
`/readyz` actually checks the Postgres connection. Expect both to return HTTP 200 with a
small JSON body. If `/readyz` fails but `/healthz` passes, the API is up but can't reach the
database — recheck Step 2.2's `migrate` step and your `.env` database credentials.

**Verify — frontend is being served:**
```bash
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000
```
Expect `200`.

### Step 2.3: Open the app and log in

**Why log in with a seeded account:** the `migrate` step (Step 2.2) seeds two accounts
specifically so you don't have to register manually to test the app:
- Customer: `demo@streamflix.local` / `Demo@12345`
- Admin: `admin@streamflix.local` / `Admin@12345`

1. Open **http://localhost:3000** in a browser.
2. Sign in as the customer account above.

**Verify:** After login you land on the home page with hero + rows of titles. If you see an
empty catalogue, the seed step didn't load sample titles — re-check `docker compose logs
migrate`.

### Step 2.4: Exercise the customer flow

**Why:** confirms the frontend, API, Postgres, and Redis are all actually wired together
correctly, not just individually "up."

1. **Search:** type a title name in the top search bar. **Verify:** results render below.
2. **Play:** click a title → "Play". **Verify:** video starts playing (HLS via hls.js).
3. **Pause partway through**, navigate back to Home. **Verify:** the title now appears
   under "Continue Watching" with a progress bar — this confirms the DynamoDB-backed
   playback-progress feature is working.
4. **My List:** open a title, click "+ My List", then visit the "My List" nav link.
   **Verify:** the title appears there.
5. **Subscription:** open the Subscription page. **Verify:** plans load with prices — this
   confirms the subscriptions module and its Postgres tables are seeded correctly.

### Step 2.5: Exercise the admin flow (upload → transcode → publish)

**Why this is the important end-to-end test:** it exercises the worker container, ffmpeg,
the shared Docker volume between `api` and `worker`, and the full media pipeline — the part
most likely to break if something's misconfigured.

1. Log out, log back in as the **admin** account (Step 2.3).
2. Generate a test video:
   ```bash
   make sample-video
   ```
   **Why:** you need a real video file to upload; this runs
   `scripts/generate-sample-video.sh`, which uses ffmpeg to synthesize a 30-second test clip
   at `./sample-video.mp4` — no external asset or internet access required.

   **Verify:**
   ```bash
   ls -lh sample-video.mp4
   ```
   Expect a file a few hundred KB to a few MB in size.
3. In the app: **Admin → Titles → New title**. Fill in slug/title/type, click **Create
   title**.
4. On the title's edit page, scroll to **Video** → choose `sample-video.mp4` → **Upload &
   transcode**.

   **Why this step matters:** this triggers the exact pipeline documented in
   `infra/README.md` and the backend's `media.service.js`: the browser PUTs the file to the
   API, the API hands it to the worker via a Redis queue, the worker (ffmpeg) transcodes it
   into HLS renditions and writes them to the shared volume.

   **Verify — watch the job progress in the UI:** the page polls automatically; status
   should move `queued` → `processing` → `completed` within roughly 10–30 seconds for the
   30-second sample clip.

   **Verify — from the worker's logs, if the UI seems stuck:**
   ```bash
   docker compose logs -f worker
   ```
   Look for ffmpeg output and a final success message; a stack trace here means the
   transcode failed — the sample video is a good known-good baseline, so a failure here
   usually points at a resource or ffmpeg-binary issue in the `worker` container, not your
   data.
5. Once the job shows "Completed," click **Publish**.
6. Log back in as the customer (or open a new incognito window) and confirm the new title
   now appears on the home page and plays.

**Verify (end-to-end confirmation):**
```bash
curl -s http://localhost:8080/api/v1/titles | grep -o '"slug":"[^"]*"'
```
Your new title's slug should be in the list.

---

## Part 3 — Run the backend test suite

**Why run tests separately from the running app:** `npm test` exercises the backend's own
Postgres/Redis/DynamoDB connections directly (bypassing the API layer) to verify business
logic in isolation — it's a different kind of check than "does the UI work."

```bash
make test
```
This runs `npm test` at the repo root, which delegates to the `backend` workspace's Jest
suite. It uses the same running `postgres`/`redis`/`dynamodb` containers from Part 2 (via
the `DATABASE_URL`/`REDIS_URL`/`DYNAMODB_ENDPOINT` defaults in `.env`), so **the stack from
Part 2 must still be running.**

**Verify:** the test runner's summary line shows `0 failed`. If tests report they were
skipped rather than run, the suite couldn't reach a database — confirm `docker compose ps`
still shows `postgres`/`redis`/`dynamodb` as running.

```bash
make lint
```
**Why:** runs ESLint across both workspaces to catch obvious style/correctness issues before
you commit. **Verify:** no fatal errors printed (warnings are fine).

---

## Part 4 — Tear down or reset

### Stop the stack, keep your data

**Why keep volumes:** so your test titles, uploaded videos, and accounts survive a restart —
useful when you're just pausing for the day.

```bash
make down
```
**Verify:**
```bash
docker compose ps
```
No containers listed.

### Full reset — wipe everything and start clean

**Why you'd need this:** if the database schema changed, or the local state got into a
broken/inconsistent condition and you want a guaranteed-clean slate.

```bash
make reset
```
This runs `docker compose down -v` (the `-v` deletes the named volumes — `pgdata`,
`redisdata`, `dynamodata`, `media` — which is what actually erases the data, not just the
containers) followed by `docker compose up --build -d`.

**Verify:** repeat Step 2.2's verification steps; you should land back at an empty,
freshly-migrated database (seeded accounts will exist again, your test uploads will not).

---

## Part 5 — Deploy real AWS infrastructure (optional, costs money)

Only do this if you actually want a live AWS deployment — everything in Parts 1–4 runs
entirely locally with no AWS account needed.

### Step 5.1: Install the AWS CLI, Terraform, and Terragrunt

**Why:** Terraform executes the actual resource creation; Terragrunt is a thin orchestration
layer on top that keeps the `dev`/`stage`/`prod` configs DRY (see `infra/README.md`) and
resolves the dependency order between modules (`vpc` before `rds`, `iam`+`eks` before
`cloudfront`, etc.) automatically.

```bash
aws --version
terraform version
terragrunt --version
```
**Verify:** all three print version numbers. Terraform must be ≥ 1.7.0 (declared in every
module's `required_version`).

### Step 5.2: Authenticate the AWS CLI

**Why:** every `terraform apply` call needs valid AWS credentials with permission to create
VPCs, IAM roles, RDS instances, EKS clusters, etc.

```bash
aws configure
```
**Verify:**
```bash
aws sts get-caller-identity
```
Expect a JSON block with your account ID, user/role ARN — no error.

### Step 5.3: Bootstrap the Terraform state backend (once, ever, per AWS account)

**Why this is a separate, manual step:** Terragrunt's `remote_state` block (in
`infra/terragrunt/terragrunt.hcl`) expects an S3 bucket and DynamoDB lock table to already
exist — you can't store the state of "the thing that creates your state backend" inside
that same backend, so this one piece is applied directly with plain Terraform, not
Terragrunt.

```bash
cd infra/terraform/global
terraform init
terraform apply
```
Type `yes` when prompted after reviewing the plan.

**Verify:**
```bash
aws s3 ls | grep streamflix-terraform-state
aws dynamodb list-tables | grep streamflix-terraform-locks
```
Both should show up.

### Step 5.4: Review environment-specific settings

**Why:** `infra/terragrunt/live/dev/env.hcl` (and the `stage`/`prod` equivalents) set
instance sizes, node counts, and domain names per environment — check these match what you
actually want before creating billable resources (e.g. `dev` defaults to small/cheap
instances and a single NAT gateway; `prod` defaults to Multi-AZ RDS and larger nodes).

```bash
cat infra/terragrunt/live/dev/env.hcl
```
**Verify:** you've read it and the values (region, instance classes) are acceptable to you.

### Step 5.5: Plan, then apply the `dev` environment

**Why plan first:** `terragrunt run-all plan` shows exactly what will be created across all
13 modules without creating anything — always review this before `apply` on real
infrastructure.

```bash
cd infra/terragrunt/live/dev
terragrunt run --all apply
```
**Verify:** read through the output; it should show a list of resources to add, with no
errors. (`make tf-plan ENV=dev` from the repo root does the same thing.)

```bash
terragrunt run-all apply
```
Type `yes` when prompted. This takes 15–25 minutes (EKS cluster creation is the slowest
part).

**Verify:**
```bash
terragrunt run --all output
```
Should print outputs from every module (VPC ID, RDS endpoint, EKS cluster name, ECR repo
URLs, etc.) with no errors.

### Step 5.6: Re-apply `iam` (required — not optional)

**Why:** this is a genuine, documented circular dependency (see `infra/README.md`): the
`iam` module creates IAM roles trusted by EKS's OIDC provider, but that provider doesn't
exist until `eks` has already been created in Step 5.5. The first `iam` apply silently
skips creating those roles; this second apply picks them up now that `eks` exists.

```bash
cd iam
terragrunt apply
```
**Verify:**
```bash
terragrunt output api_irsa_role_arn worker_irsa_role_arn
```
Both should now print a real ARN (not empty).

---

## Part 6 — Deploy the application onto that infrastructure

### Step 6.1: Lint and preview the Helm chart

**Why:** catches YAML/templating mistakes before they hit a real cluster.

```bash
cd streamflix   # repo root
make helm-lint ENV=dev
```
**Verify:** output ends with `0 chart(s) failed`.

```bash
make helm-template ENV=dev
```
**Verify:** valid Kubernetes YAML prints to stdout with no template errors — skim it for
sanity.

### Step 6.2: Fill in the generated placeholder values

**Why:** `values-dev.yaml` ships with `REPLACE_WITH_...` placeholders for values that only
exist after Part 5's `terragrunt apply` (ECR repo URL, IRSA role ARNs) — Terraform can't
pre-fill a file that didn't know those values yet when it was written.

```bash
cd infra/terragrunt/live/dev
terragrunt output   # lists every output name available; find the ECR/IRSA ones
```
Edit `infra/helm/streamflix/values-dev.yaml` and replace each `REPLACE_WITH_...` placeholder
with the corresponding real value.

**Verify:**
```bash
grep REPLACE_WITH infra/helm/streamflix/values-dev.yaml
```
No output — every placeholder has been filled in.

### Step 6.3: Build and push images to ECR
```bash
helm repo add external-secrets https://charts.external-secrets.io
helm repo update
helm install external-secrets external-secrets/external-secrets \
  --namespace external-secrets --create-namespace --wait --timeout 5m
  ```
```bash
  kubectl get crd | grep external-secrets
```
```bash
curl -o /tmp/rds-ca-bundle.pem https://truststore.pki.rds.amazonaws.com/ap-south-1/ap-south-1-bundle.pem
kubectl -n streamflix create configmap rds-ca-bundle --from-file=ca-bundle.pem=/tmp/rds-ca-bundle.pem
```
**Why manually here (vs. letting CI/CD do it):** useful for a first manual deploy to prove
the pipeline before wiring up GitHub Actions in Part 7.

```bash
aws ecr get-login-password --region ap-south-1 | docker login --username AWS --password-stdin <ECR_REGISTRY>

docker build --target runtime -t <ECR_REGISTRY>/streamflix-dev/api:latest backend
docker push <ECR_REGISTRY>/streamflix-dev/api:latest

docker build --target worker -t <ECR_REGISTRY>/streamflix-dev/worker:latest backend
docker push <ECR_REGISTRY>/streamflix-dev/worker:latest

docker build --target runtime -t <ECR_REGISTRY>/streamflix-dev/web:latest frontend
docker push <ECR_REGISTRY>/streamflix-dev/web:latest
```
Replace `<ECR_REGISTRY>` with the value from Step 6.2.

**Verify:**
```bash
aws ecr list-images --repository-name streamflix-dev/api
```
Shows an image tagged `latest`.

### Step 6.4: Deploy to EKS

```bash
aws eks update-kubeconfig --name streamflix-dev-eks --region ap-south-1
```
**Why:** points your local `kubectl`/`helm` at the new cluster.

**Verify:**
```bash
kubectl get nodes
```
Lists the EKS worker nodes with `STATUS: Ready`.

```bash
helm upgrade --install streamflix infra/helm/streamflix \
  -f infra/helm/streamflix/values-dev.yaml \
  --namespace streamflix --create-namespace --wait --timeout 10m
```
**Why `--wait`:** blocks until pods are actually ready rather than just "scheduled," so a
failure surfaces here instead of silently later.

**Verify:**
```bash
kubectl -n streamflix get pods
kubectl -n streamflix rollout status deployment/streamflix-api
kubectl -n streamflix rollout status deployment/streamflix-worker
```
All pods `Running`, both rollouts report `successfully rolled out`.

**Verify migration ran:**
```bash
kubectl -n streamflix get jobs
kubectl -n streamflix logs job/streamflix-migrate-1
```
Job shows `COMPLETIONS: 1/1`.

### Step 6.5: Deploy the frontend to S3 + CloudFront

```bash
cd frontend
npm install
npm run build
aws s3 sync dist s3://streamflix-dev-frontend --delete
```
**Why `--delete`:** removes old build artifacts from the bucket so stale JS/CSS chunks
don't linger and get served alongside the new build.

```bash
aws cloudfront create-invalidation --distribution-id <DISTRIBUTION_ID> --paths "/*"
```
**Why:** CloudFront caches aggressively; without invalidating, visitors would keep getting
the old cached build for up to a day.

**Verify:**
```bash
curl -s -o /dev/null -w "%{http_code}\n" https://<your-app-domain>/
```
Expect `200`.

---

## Part 7 — Set up CI/CD (GitHub Actions)

### Step 7.1: Confirm the GitHub OIDC IAM role exists

**Why:** lets GitHub Actions authenticate to AWS without storing long-lived AWS access keys
as repo secrets — more secure, and the keys can't leak from a compromised workflow log.

```bash
cd infra/terragrunt/live/dev/iam
terragrunt output github_actions_role_arn
```
**Verify:** prints a real ARN. If empty, confirm `enable_github_oidc = true` is set in
`infra/terragrunt/_envcommon/iam.hcl` and re-run `terragrunt apply` in this directory.

### Step 7.2: Add repository secrets and variables

**Why:** the workflows in `.github/workflows/` reference these by name — they must exist or
the workflow fails at the AWS-auth step.

In your GitHub repo → Settings → Secrets and variables → Actions, add:
- **Secrets:** `AWS_DEPLOY_ROLE_ARN`, `AWS_PLAN_ROLE_ARN`, `AWS_APPLY_ROLE_ARN` (the ARN
  from Step 7.1, same value for all three to start), `ECR_REGISTRY`,
  `CLOUDFRONT_DISTRIBUTION_ID`
- **Variables:** `API_BASE_URL` (e.g. `https://api-dev.streamflix.local/api/v1`)

**Verify:** the Settings page lists all six names.

### Step 7.3: Push to trigger CI

```bash
git push origin main
```
**Verify:** GitHub → Actions tab → the **CI** workflow run turns green (lint, backend tests
against real service containers, frontend build, Trivy scan). This must pass before CD runs.

### Step 7.4: Confirm CD deployed automatically

**Why it's automatic for `dev` only:** `cd.yml` triggers on CI's success on `main` and
defaults to `dev` — `stage`/`prod` require the manual dispatch in Step 7.5, deliberately, so
a routine merge can't accidentally push to production.

**Verify:** Actions tab → **CD** workflow run is green; then re-run Step 6.4's/6.5's
verification commands against the newly-deployed version.

### Step 7.5: Promote to stage or prod

```bash
# via GitHub UI: Actions -> CD -> Run workflow -> choose "stage" or "prod"
```
**Why manual:** promoting to a customer-facing environment should be a deliberate action.

**Verify:** if you set up required reviewers on the `stage`/`prod` GitHub Environments (see
`infra/README.md`), the run pauses for approval — confirm it's waiting, approve it, then
recheck the deployment as in Step 6.4/6.5.

---Fix — widen the trust policy condition to match the actual format being sent:

aws iam update-assume-role-policy --role-name streamflix-dev-github-actions --policy-document '{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Federated": "arn:aws:iam::340529311120:oidc-provider/token.actions.githubusercontent.com"
      },
      "Action": "sts:AssumeRoleWithWebIdentity",
      "Condition": {
        "StringEquals": {
          "token.actions.githubusercontent.com:aud": "sts.amazonaws.com"
        },
        "StringLike": {
          "token.actions.githubusercontent.com:sub": ["repo:naveenkumaryeti/streamflix:*", "repo:naveenkumaryeti@*/streamflix@*:*"]
        }
      }
    }
  ]
}'

aws ecr put-image-tag-mutability --repository-name streamflix-dev/api --image-tag-mutability MUTABLE
aws ecr put-image-tag-mutability --repository-name streamflix-dev/worker --image-tag-mutability MUTABLE
aws ecr put-image-tag-mutability --repository-name streamflix-dev/web --image-tag-mutability MUTABLE
## Quick-reference command summary

| Goal | Command |
|---|---|
| Start local stack | `make up` |
| Check container status | `docker compose ps` |
| Tail api/worker logs | `make logs` |
| Open a DB shell | `make psql` |
| Generate a test video | `make sample-video` |
| Run backend tests | `make test` |
| Lint | `make lint` |
| Stop (keep data) | `make down` |
| Full wipe + rebuild | `make reset` |
| Plan infra changes | `make tf-plan ENV=dev` |
| Apply infra changes | `make tf-apply ENV=dev` |
| Lint Helm chart | `make helm-lint ENV=dev` |
| Preview rendered manifests | `make helm-template ENV=dev` |
