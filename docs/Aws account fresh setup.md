# StreamFlix: Fresh Setup in a New AWS Account

The old account (`340529311120`) is already deleted, so there is nothing to
migrate or preserve — this is a clean rebuild in the new account. Follow in order.

---

## 0. Before you start

- [ ] Have the new AWS account ready, note its **12-digit account ID**.
- [ ] `aws configure --profile streamflix-new` with the new account's access key/secret, region `ap-south-1`.
- [ ] `export AWS_PROFILE=streamflix-new` for the rest of this guide.
- [ ] `aws sts get-caller-identity` — confirm it shows the new account ID.

---

## 1. Terraform remote state backend (bootstrap)

The old state bucket + lock table are gone with the account. Create fresh ones:

```bash
cd infra/terraform/global
terraform init
terraform apply
```

Confirm `infra/terragrunt/terragrunt.hcl` (root config) points at whatever
bucket/table names this just created — update the `remote_state` block if needed.

---

## 2. Replace every hardcoded old-account reference in the repo

```bash
grep -rn "340529311120" infra/ .github/
```

Replace each hit with the new account ID. Check especially:
- `infra/terragrunt/live/dev/env.hcl`
- Any IAM role ARNs typed literally anywhere
- `.github/workflows/*.yml`

---

## 3. Provision the full stack

From `infra/terragrunt/live/dev`:
```bash
terragrunt run-all apply
```

Known issue: `iam-cluster`/`iam-irsa` depend on EKS's OIDC provider, which
doesn't exist until `eks` applies — first pass will show errors for those
two modules only. Once `eks` is up, re-apply them:
```bash
cd iam-cluster && terragrunt apply
cd ../iam-irsa  && terragrunt apply
```

This creates fresh: VPC, EKS, RDS, ElastiCache, S3 buckets, ECR repos,
DynamoDB table, Secrets Manager secrets, WAF, CloudFront — all empty/new,
nothing to import.

---

## 4. CloudFront signing key pair

Reuse the same key pair you already have at
`infra/.secrets/cloudfront-private.pem` (losing the AWS account doesn't
invalidate the key itself). Confirm `env.hcl` passes its public key via
`cloudfront_signing_public_key_pem` — step 3 will register it fresh in the
new account.

---

## 5. Update GitHub repo secrets/variables to new-account values

```bash
cd infra/terragrunt/live/dev/iam-cluster
terragrunt output github_actions_role_arn
```

```bash
gh secret set AWS_DEPLOY_ROLE_ARN --repo naveenkumaryeti/streamflix --body "<new arn>"
gh secret set AWS_PLAN_ROLE_ARN   --repo naveenkumaryeti/streamflix --body "<new arn>"
gh secret set AWS_APPLY_ROLE_ARN  --repo naveenkumaryeti/streamflix --body "<new arn>"
gh secret set ECR_REGISTRY        --repo naveenkumaryeti/streamflix --body "<new-account-id>.dkr.ecr.ap-south-1.amazonaws.com"
gh secret set CLOUDFRONT_PRIVATE_KEY_PEM --repo naveenkumaryeti/streamflix < infra/.secrets/cloudfront-private.pem
gh variable set API_BASE_URL --repo naveenkumaryeti/streamflix --body "<new CloudFront domain>/api/v1"
```

---

## 6. EKS access (aws-auth ConfigMap)

Fresh cluster = empty `aws-auth`. Map both roles again:
```bash
aws eks update-kubeconfig --name streamflix-dev-eks --region ap-south-1
kubectl -n kube-system patch configmap aws-auth --type merge -p '{"data":{"mapRoles":"- rolearn: arn:aws:iam::<new-account-id>:role/streamflix-dev-eks-nodes\n  groups:\n  - system:bootstrappers\n  - system:nodes\n  username: system:node:{{EC2PrivateDNSName}}\n- rolearn: arn:aws:iam::<new-account-id>:role/streamflix-dev-github-actions\n  groups:\n  - system:masters\n  username: github-actions\n"}}'
```

---

## 7. AWS Load Balancer Controller (not Terraform-managed)

1. Create IAM policy from the AWS Load Balancer Controller repo's `iam_policy.json`
2. Create IRSA role trusting the new cluster's OIDC provider
3. `kubectl create serviceaccount aws-load-balancer-controller -n kube-system` + annotate with the new role ARN
4. `helm install aws-load-balancer-controller eks/aws-load-balancer-controller` with the new `clusterName`/`vpcId`

---

## 8. Rebuild and deploy

Trigger the CD workflow (push a commit or `gh workflow run CD.yml`) — this
builds fresh images into the new (empty) ECR repos, runs Helm, and seeds
the database via the migrate hook's seed step.

---

## 9. Frontend

CD workflow's `deploy-frontend` job rebuilds and syncs to the new S3
bucket + invalidates the new CloudFront distribution automatically, once
`API_BASE_URL` (step 5) points at the new domain.

---

## 10. Verify

- [ ] `kubectl -n streamflix get pods` — all healthy
- [ ] API reachable via new CloudFront domain
- [ ] Frontend loads, login works, posters load
- [ ] CD workflow green end-to-end

---

### Note on cost

Since this is a from-scratch rebuild anyway, this is a good moment to size
things smaller for `dev` if cost was the concern — e.g., `single_nat_gateway`,
smaller RDS/ElastiCache instance classes, `SPOT` node capacity — check
`infra/terragrunt/live/dev/env.hcl`'s `locals` block, most of these knobs are
already there.