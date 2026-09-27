# StreamFlix — IAM Roles & Permissions Reference

Three categories: (1) the **human identity** you personally use to run Terraform/kubectl/
Docker, (2) roles **Terraform creates automatically** — nothing to set up, just a
reference of what exists and why, and (3) roles that need **manual setup** because they
aren't in Terraform yet.

---

## 1. Your own IAM user/role (the one running `terraform apply`, `kubectl`, `docker push`)

### The honest answer
Bootstrapping this project means creating IAM roles and policies via Terraform, which
itself requires broad IAM permissions — plus this stack touches nearly every AWS service
(VPC, EKS, RDS, ElastiCache, S3, CloudFront, Route53, WAF, Secrets Manager, MediaConvert,
CloudWatch, SNS, ECR, DynamoDB). Scoping a custom policy tightly enough to cover all of
that while still being meaningfully narrower than admin access isn't worth the effort for
a personal/dev account.

**Recommended:** attach the AWS managed policy `AdministratorAccess` to your IAM user for
setup and day-to-day `terraform apply` work. Tighten this only if this account will be
shared with other people or used for anything beyond your own dev/test environment.

### If you want a scoped policy anyway
Attach `AdministratorAccess` for the **first** `terragrunt apply` (creating IAM roles
requires `iam:*` regardless), then you can switch to this narrower list for routine
day-to-day changes once the account is bootstrapped:

| Service | Why |
|---|---|
| `ec2:*` | VPC, subnets, security groups, NAT gateways |
| `eks:*` | Cluster, node group, addons |
| `iam:*Role*`, `iam:*Policy*`, `iam:*OpenIDConnect*` | Every module creates roles/policies |
| `rds:*` | Postgres instance |
| `elasticache:*` | Redis |
| `s3:*` | 5 buckets + policies + lifecycle rules |
| `dynamodb:*` | Watch-progress table |
| `ecr:*` | 3 repositories |
| `cloudfront:*` | 2 distributions, OAC, signing keys, response headers policy |
| `route53:*` | Hosted zone + records |
| `wafv2:*` | Web ACL (note: must run in `us-east-1` for CloudFront scope) |
| `secretsmanager:*` | 5 app secrets |
| `mediaconvert:*` | Endpoint discovery, job submission |
| `cloudwatch:*`, `logs:*`, `sns:*` | Alarms, dashboard, log groups, alert topic |
| `sts:GetCallerIdentity`, `sts:AssumeRole*` | Used throughout, and by the GitHub OIDC role |

---

## 2. Roles Terraform creates for you (already automated — nothing to do)

These exist the moment `terragrunt run-all apply` succeeds. Listed for reference/audit —
you don't create or attach anything here yourself.

| Role name | Created by module | Trusted by | Purpose |
|---|---|---|---|
| `streamflix-dev-eks-cluster` | `iam-cluster` | `eks.amazonaws.com` | EKS control plane |
| `streamflix-dev-eks-nodes` | `iam-cluster` | `ec2.amazonaws.com` | Worker nodes — has `AmazonEKSWorkerNodePolicy`, `AmazonEKS_CNI_Policy`, `AmazonEC2ContainerRegistryReadOnly` attached |
| `streamflix-dev-mediaconvert` | `iam-cluster` | `mediaconvert.amazonaws.com` | Lets MediaConvert itself read/write the media S3 buckets |
| `streamflix-dev-api-irsa` | `iam-irsa` | EKS OIDC provider, scoped to `system:serviceaccount:streamflix:streamflix-api` | What the `api` pod actually runs as — S3, DynamoDB, MediaConvert submit, Secrets Manager read |
| `streamflix-dev-worker-irsa` | `iam-irsa` | Same OIDC provider, scoped to `streamflix-worker` | Same permission set, for the transcode worker pod |
| `streamflix-dev-github-actions` | `iam-cluster` (only when `enable_github_oidc = true`) | GitHub's OIDC provider, scoped to your repo | CI/CD — currently has `PowerUserAccess` attached (broad on purpose for a learning project; tighten before production use, see the comment in `modules/iam-cluster/main.tf`) |

**Policies these roles carry** (also auto-created, listed for completeness):
- `streamflix-dev-app-permissions` — attached to both IRSA roles: S3 read/write/delete on
  the raw/processed/thumbnails buckets, DynamoDB CRUD on the watch-progress table,
  MediaConvert job submission, `iam:PassRole` on the MediaConvert role, and
  `secretsmanager:GetSecretValue` on exactly the 4 app secrets (database, redis, jwt,
  cloudfront-signing) — nothing broader.
- `streamflix-dev-mediaconvert-permissions` — attached to the MediaConvert role: S3
  read/write on the media buckets only.

---

## 3. What still needs manual setup (not in Terraform yet)

### AWS Load Balancer Controller's IRSA role
This is the one real gap — the ALB Ingress Controller needs its own IAM role, and it was
set up by hand during this project rather than through Terraform. On a new account you'll
need to redo this manually:

```bash
eksctl utils associate-iam-oidc-provider --cluster streamflix-dev-eks --region ap-south-1 --approve

curl -O https://raw.githubusercontent.com/kubernetes-sigs/aws-load-balancer-controller/v2.8.1/docs/install/iam_policy.json
aws iam create-policy --policy-name AWSLoadBalancerControllerIAMPolicy --policy-document file://iam_policy.json

eksctl create iamserviceaccount \
  --cluster streamflix-dev-eks --region ap-south-1 \
  --namespace kube-system --name aws-load-balancer-controller \
  --attach-policy-arn arn:aws:iam::<account-id>:policy/AWSLoadBalancerControllerIAMPolicy \
  --approve
```
**Verify:**
```bash
aws iam get-role --role-name eksctl-streamflix-dev-eks-addon-iamserviceaccount-*
```
A real role prints. Then install the controller itself via Helm as you did originally.

### External Secrets Operator
Doesn't need its own IAM role by default in this setup — it assumes the `streamflix-api`
ServiceAccount's IRSA role (see `SecretStore`'s `serviceAccountRef` in
`templates/externalsecrets.yaml`), which is already covered in section 2 above. Nothing
extra to grant here.

---

## Quick checklist for a brand-new account

- [ ] Your IAM user has `AdministratorAccess` (or the scoped list in Section 1)
- [ ] Run `terragrunt run-all apply` — Section 2's roles appear automatically
- [ ] Manually create the AWS Load Balancer Controller's IRSA role (Section 3)
- [ ] Confirm `enable_github_oidc = true` is still set for `dev` in
      `_envcommon/iam-cluster.hcl` so the GitHub Actions role gets created
- [ ] Nothing else — External Secrets Operator rides on the existing `api` IRSA role