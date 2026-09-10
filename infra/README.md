# StreamFlix Infrastructure

Terraform modules (`terraform/modules/*`) + Terragrunt environments (`terragrunt/live/{dev,stage,prod}`)
implementing Phases 3–14 of `docs/Phase_01_Architecture & Planning.md`: AWS foundation, VPC,
database/cache, EKS, CI/CD wiring, video streaming (S3 + MediaConvert + CloudFront), security
(IAM/WAF/Secrets Manager), and monitoring.

## One-time setup

```bash
# 1. Create the remote state bucket + lock table (only once, ever, per AWS account)
cd terraform/global
terraform init && terraform apply

# 2. Point Terragrunt at that backend — already wired in terragrunt/terragrunt.hcl,
#    just confirm the bucket/table names match what step 1 created.
```

## Applying an environment

```bash
cd terragrunt/live/dev
terragrunt run-all plan
terragrunt run-all apply
```

Terragrunt resolves the dependency graph automatically (`vpc` → `iam`/`rds`/`elasticache` →
`eks` → `cloudfront` → `route53`/`monitoring`), **except for one real cycle**:

> `iam` creates IRSA roles trusted by the EKS cluster's OIDC provider, but that provider
> doesn't exist until `eks` has applied — and `eks`'s node/cluster roles come from `iam`.
>
> **Fix:** `run-all apply` will succeed on the first pass with IRSA roles skipped (see the
> comment in `terraform/modules/iam/variables.tf`). Once `eks` exists, re-apply just `iam`:
> ```bash
> cd terragrunt/live/dev/iam && terragrunt apply
> ```

To promote to `stage` or `prod`, repeat inside that env's directory — `_envcommon/*.hcl`
keeps every module's Terraform source and wiring identical across environments; only
`live/<env>/env.hcl` differs (instance sizes, replica counts, domains).

## Signed URLs (CloudFront)

`modules/secrets` generates JWT and seed-credential secrets automatically, but the
CloudFront signing key pair is **not** created by Terraform (AWS doesn't expose that as a
resource). Generate it once with `openssl genrsa -out private.pem 2048 && openssl rsa -in
private.pem -pubout -out public.pem`, then pass `public.pem`'s contents as
`cloudfront_signing_public_key_pem` to the `cloudfront` module and `private.pem`'s contents
as `cloudfront_private_key_pem` to the `secrets` module — that private key is what the
backend's `CLOUDFRONT_PRIVATE_KEY` env var expects.

## CI/CD (`.github/workflows/`)

`ci.yml` lints, runs backend tests against real Postgres/Redis/DynamoDB-local containers,
builds the frontend, and Trivy-scans the three Docker images (api/worker/web) — no AWS
access needed. `cd.yml` and `terraform.yml` do need AWS access, via GitHub's OIDC provider
(no static keys in the repo):

1. Set `enable_github_oidc = true` for exactly one env's `iam` module (already done for
   `dev` in `_envcommon/iam.hcl` — it's a singleton per AWS account) and set `github_repo`
   to `your-org/your-repo`, then apply.
2. Take the `github_actions_role_arn` output and add it as repo secrets:
   `AWS_DEPLOY_ROLE_ARN`, `AWS_PLAN_ROLE_ARN`, `AWS_APPLY_ROLE_ARN` (same role to start;
   split into narrower roles before this touches a real prod account — see the comment in
   `modules/iam/main.tf`).
3. Also set `ECR_REGISTRY` (secret) and `API_BASE_URL` (repo variable, per environment).
4. For `stage`/`prod`, add required reviewers on those GitHub Environments so
   `terraform.yml`'s apply job and `cd.yml`'s deploy need a manual approval click.

## What's intentionally out of scope

- ACM certificate issuance/validation (bring your own `acm_certificate_arn`, or add a
  `aws_acm_certificate` + DNS validation records once `route53` owns a real zone).
- SNS subscriptions on the `monitoring` module's alert topic (email/Slack/PagerDuty) — wire
  those to your team's actual on-call tooling rather than hardcoding one here.
- Multi-region / DR (Phase 14) — the architecture doc flags this as a later exercise once
  the single-region stack above is solid.
