# Migrating StreamFlix to a New AWS Account

Switching accounts is not just new credentials — every ARN in this repo
(`340529311120`) is account-specific: IAM roles, trust policies, OIDC
provider, ECR registry, Secrets Manager ARNs. This is effectively a fresh
provision. Follow this in order.

---

## 0. Before you start

- [ ] Create the new AWS account (or have it ready) and note its **12-digit account ID**.
- [ ] Decide: are you moving `dev` only, or `dev`+`stage`+`prod`? (Assume `dev` below; repeat per env.)
- [ ] Keep the old account live and read-only until the new one is fully verified — don't delete anything yet.

---

## 1. Local AWS CLI credentials

```bash
aws configure --profile streamflix-new
# AWS Access Key ID, Secret Access Key, region: ap-south-1
```

Point your shell at it for the rest of this guide:
```bash
export AWS_PROFILE=streamflix-new
aws sts get-caller-identity   # confirm it shows the NEW account ID
```

---

## 2. Terraform remote state backend (bootstrap)

The old S3 state bucket + DynamoDB lock table live in the **old** account.
You need fresh ones in the new account — state cannot simply "follow" you.

```bash
cd infra/terraform/global
terraform init
terraform apply
```

Note the new bucket name / lock table name from the output. Confirm
`infra/terragrunt/terragrunt.hcl` (the root config) points at these new
names — update the `remote_state` block if the names differ from before.

> Since every module's state will be brand new, you will need to `terragrunt
> apply` everything from scratch in step 5 — nothing carries over
> automatically. If you'd rather **migrate existing state** instead of
> rebuilding, that's a separate, more advanced path (`terraform state pull`
> from old backend → `terraform state push` to new backend, per module) —
> ask if you want that instead of a clean rebuild.

---

## 3. Update account-specific values in the repo

Search for every hardcoded reference to the old account ID and replace it:

```bash
grep -rn "340529311120" infra/ .github/
```

Replace each with the new account ID. Pay special attention to:
- `infra/terragrunt/live/dev/env.hcl` — any account ID or ARN
- IAM trust policies / role ARNs referenced anywhere
- `.github/workflows/*.yml` — `ECR_REGISTRY` env var format

---

## 4. GitHub OIDC provider + IAM roles (new account)

The OIDC provider (`token.actions.githubusercontent.com`) and every IAM
role built on it (`streamflix-dev-github-actions`, `AWSLoadBalancerControllerIAMPolicy`
role, etc.) exist only in the old account. Re-create via Terraform:

```bash
cd infra/terragrunt/live/dev/iam-cluster
terragrunt apply
```

This recreates the OIDC provider + `streamflix-dev-github-actions` role
(confirm `enable_github_oidc = true` and `github_repo` are still set
correctly — see `_envcommon/iam-cluster.hcl`).

---

## 5. Provision the full stack in the new account

From `infra/terragrunt/live/dev`:
```bash
terragrunt run-all apply
```
Expect some modules to fail on the first pass due to the known
`iam` ↔ `eks` OIDC dependency cycle (see `infra/README.md`). Once `eks`
exists, re-apply:
```bash
cd iam-cluster && terragrunt apply
cd ../iam-irsa && terragrunt apply
```

This creates fresh (new-account) versions of: VPC, EKS, RDS, ElastiCache,
S3 buckets, ECR repos, DynamoDB table, Secrets Manager secrets, WAF, CloudFront.

---

## 6. CloudFront signing key pair

This was never Terraform-managed (AWS doesn't expose it as a resource) —
you already have the key pair locally at `infra/.secrets/cloudfront-private.pem`.
Reuse the same key pair; just re-register the **public** key in the new
account by passing it to the `cloudfront` module's
`cloudfront_signing_public_key_pem` input (already wired if you filled
`env.hcl` before running step 5).

---

## 7. GitHub repo secrets — update to new-account values

After step 5 finishes, get the new ARNs:
```bash
cd infra/terragrunt/live/dev/iam-cluster
terragrunt output github_actions_role_arn
```

Update GitHub (Settings → Secrets and variables → Actions):
```bash
gh secret set AWS_DEPLOY_ROLE_ARN --repo naveenkumaryeti/streamflix --body "<new arn>"
gh secret set AWS_PLAN_ROLE_ARN   --repo naveenkumaryeti/streamflix --body "<new arn>"
gh secret set AWS_APPLY_ROLE_ARN  --repo naveenkumaryeti/streamflix --body "<new arn>"
gh secret set ECR_REGISTRY        --repo naveenkumaryeti/streamflix --body "<new-account-id>.dkr.ecr.ap-south-1.amazonaws.com"
gh secret set CLOUDFRONT_PRIVATE_KEY_PEM --repo naveenkumaryeti/streamflix < infra/.secrets/cloudfront-private.pem
```

Also update the repo variable:
```bash
gh variable set API_BASE_URL --repo naveenkumaryeti/streamflix --body "<new CloudFront domain>/api/v1"
```

---

## 8. EKS access (aws-auth) — redo the GitHub Actions RBAC mapping

New cluster = empty `aws-auth` ConfigMap again. Re-apply the mapping we
did before (adjust role ARN to new account):

```bash
aws eks update-kubeconfig --name streamflix-dev-eks --region ap-south-1
kubectl -n kube-system patch configmap aws-auth --type merge -p '{"data":{"mapRoles":"- rolearn: arn:aws:iam::<new-account-id>:role/streamflix-dev-eks-nodes\n  groups:\n  - system:bootstrappers\n  - system:nodes\n  username: system:node:{{EC2PrivateDNSName}}\n- rolearn: arn:aws:iam::<new-account-id>:role/streamflix-dev-github-actions\n  groups:\n  - system:masters\n  username: github-actions\n"}}'
```

---

## 9. AWS Load Balancer Controller

Not Terraform-managed — reinstall it fresh (same steps as original setup):
1. Create the IAM policy from `docs/install/iam_policy.json` (AWS Load Balancer Controller repo)
2. Create IRSA role trusting the new cluster's OIDC provider
3. `kubectl create serviceaccount` + annotate with new role ARN
4. `helm install aws-load-balancer-controller eks/aws-load-balancer-controller ...` with the new `clusterName`/`vpcId`

---

## 10. ECR images

New account = empty ECR repos. Trigger the CD workflow (or push a commit)
to rebuild and push images — nothing to migrate manually here.

---

## 11. Application secrets / data

- Re-run the Helm deploy (CD workflow) — this creates the K8s Secrets from
  the new Secrets Manager entries via ExternalSecrets.
- The **database is empty** in the new account (fresh RDS instance) — run
  the seed job (Helm's migrate hook already does this) to get demo/admin data.
- If you need to preserve **existing production data**, that's a separate
  RDS snapshot/restore + DynamoDB export/import task — say so and I'll
  detail that instead of a fresh seed.

---

## 12. Frontend

Rebuild and sync to the new S3 bucket + invalidate the new CloudFront
distribution (CD workflow's `deploy-frontend` job handles this once
`ECR_REGISTRY`/`API_BASE_URL` point at the new account).

---

## 13. Verify end-to-end

- [ ] `kubectl -n streamflix get pods` — all healthy
- [ ] API reachable via new CloudFront domain
- [ ] Frontend loads, login works, posters load
- [ ] CD workflow runs green end-to-end

---

## 14. Decommission the old account (only after full verification)

- [ ] `terragrunt run-all destroy` in the old account's `live/dev` (or just
      delete the account via AWS Organizations, which force-closes billing)
- [ ] Revoke old IAM users/keys
- [ ] Remove old account references from any remaining docs/README

---

### If this feels like too much manual work

Given the number of interdependent pieces (OIDC, IRSA, ALB controller,
CloudFront signing, ECR, DNS), consider whether the actual cost driver is
something narrower (e.g., NAT Gateway, RDS instance size, MediaConvert) that
could be fixed **in the current account** instead of a full account
migration. Full migrations are usually only necessary for organizational/
billing-boundary reasons (e.g., moving to an AWS Organizations sub-account
with consolidated billing), not pure cost optimization — happy to help
figure out the actual cost driver first if you want a cheaper path.