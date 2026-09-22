# IAM module — Phase 11 (Security).
#
# Least-privilege roles for: EKS cluster control plane, EKS node group, and IRSA roles
# (IAM Roles for Service Accounts) that let the api/worker pods assume AWS permissions
# without static credentials baked into the container — one role per Kubernetes ServiceAccount,
# trust-scoped to the cluster's OIDC provider.

terraform {
  required_version = ">= 1.7.0"
  required_providers {
    aws = { source = "hashicorp/aws", version = ">= 5.40" }
  }
}

locals {
  name = "${var.project}-${var.environment}"
}

# ---- EKS cluster role ----
resource "aws_iam_role" "eks_cluster" {
  name = "${local.name}-eks-cluster"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "eks.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy_attachment" "eks_cluster_policy" {
  role       = aws_iam_role.eks_cluster.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonEKSClusterPolicy"
}

# ---- EKS node group role ----
resource "aws_iam_role" "eks_nodes" {
  name = "${local.name}-eks-nodes"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "ec2.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy_attachment" "eks_worker" {
  role       = aws_iam_role.eks_nodes.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonEKSWorkerNodePolicy"
}
resource "aws_iam_role_policy_attachment" "eks_cni" {
  role       = aws_iam_role.eks_nodes.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonEKS_CNI_Policy"
}
resource "aws_iam_role_policy_attachment" "ecr_readonly" {
  role       = aws_iam_role.eks_nodes.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonEC2ContainerRegistryReadOnly"
}



# ---- MediaConvert service role: lets MediaConvert itself read the raw bucket / write processed ----
resource "aws_iam_role" "mediaconvert" {
  name = "${local.name}-mediaconvert"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "mediaconvert.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

data "aws_iam_policy_document" "mediaconvert_permissions" {
  statement {
    effect  = "Allow"
    actions = ["s3:GetObject", "s3:PutObject", "s3:ListBucket"]
    resources = flatten([
      for b in var.media_bucket_arns : [b, "${b}/*"]
    ])
  }
}

resource "aws_iam_policy" "mediaconvert_permissions" {
  name   = "${local.name}-mediaconvert-permissions"
  policy = data.aws_iam_policy_document.mediaconvert_permissions.json
}

resource "aws_iam_role_policy_attachment" "mediaconvert_permissions" {
  role       = aws_iam_role.mediaconvert.name
  policy_arn = aws_iam_policy.mediaconvert_permissions.arn
}

# ---- GitHub Actions OIDC: lets CI/CD assume an AWS role with no static access keys ----
# Guarded by var.enable_github_oidc — only one env needs to actually own this provider (it's
# a single per-account resource), so leave it off for stage/prod and only true it up in dev
# (or wherever you run `terragrunt apply` first).
resource "aws_iam_openid_connect_provider" "github" {
  count           = var.enable_github_oidc ? 1 : 0
  url             = "https://token.actions.githubusercontent.com"
  client_id_list  = ["sts.amazonaws.com"]
  thumbprint_list = ["6938fd4d98bab03faadb97b34396831e3780aea1"]
}

data "aws_iam_policy_document" "github_actions_trust" {
  count = var.enable_github_oidc ? 1 : 0
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRoleWithWebIdentity"]
    principals {
      type        = "Federated"
      identifiers = [aws_iam_openid_connect_provider.github[0].arn]
    }
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }
    condition {
      test     = "StringLike"
      variable = "token.actions.githubusercontent.com:sub"
      values   = ["repo:${var.github_repo}:*"]
    }
  }
}

# One role, broad enough to plan/apply Terraform and push/deploy to EKS+ECR+S3+CloudFront.
# Split into narrower plan-only / apply-only / deploy-only roles before using this against a
# real prod account — see infra/README.md.
resource "aws_iam_role" "github_actions" {
  count              = var.enable_github_oidc ? 1 : 0
  name               = "${local.name}-github-actions"
  assume_role_policy = data.aws_iam_policy_document.github_actions_trust[0].json
}

resource "aws_iam_role_policy_attachment" "github_actions_admin" {
  count = var.enable_github_oidc ? 1 : 0
  role  = aws_iam_role.github_actions[0].name
  # Deliberately broad for a learning project's CI role. Tighten to a scoped custom policy
  # (ECR push, EKS describe/access-entry, S3 sync on the frontend bucket, CloudFront
  # invalidation, terraform state bucket/lock table RW) before this touches a real account.
  policy_arn = "arn:aws:iam::aws:policy/PowerUserAccess"
}