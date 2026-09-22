terraform {
  required_version = ">= 1.7.0"
  required_providers {
    aws = { source = "hashicorp/aws", version = ">= 5.40" }
  }
}

locals {
  name = "${var.project}-${var.environment}"
}

data "aws_iam_policy_document" "irsa_trust" {
  for_each = toset(["api", "worker"])
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRoleWithWebIdentity"]
    principals {
      type        = "Federated"
      identifiers = [var.oidc_provider_arn]
    }
    condition {
      test     = "StringEquals"
      variable = "${var.oidc_provider_url}:sub"
      values   = ["system:serviceaccount:${var.namespace}:streamflix-${each.key}"]
    }
    condition {
      test     = "StringEquals"
      variable = "${var.oidc_provider_url}:aud"
      values   = ["sts.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "app" {
  for_each           = toset(["api", "worker"])
  name               = "${local.name}-${each.key}-irsa"
  assume_role_policy = data.aws_iam_policy_document.irsa_trust[each.key].json
}

data "aws_iam_policy_document" "app_permissions" {
  statement {
    sid     = "S3Media"
    effect  = "Allow"
    actions = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:ListBucket"]
    resources = flatten([for b in var.media_bucket_arns : [b, "${b}/*"]])
  }
  statement {
    sid       = "DynamoWatchProgress"
    effect    = "Allow"
    actions   = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem", "dynamodb:Query"]
    resources = [var.dynamodb_table_arn, "${var.dynamodb_table_arn}/index/*"]
  }
  statement {
    sid       = "MediaConvertSubmit"
    effect    = "Allow"
    actions   = ["mediaconvert:CreateJob", "mediaconvert:GetJob", "mediaconvert:ListJobs"]
    resources = ["*"]
  }
  statement {
    sid       = "PassMediaConvertRole"
    effect    = "Allow"
    actions   = ["iam:PassRole"]
    resources = [var.mediaconvert_role_arn]
  }
  dynamic "statement" {
    for_each = length(var.secret_arns) > 0 ? [1] : []
    content {
      sid       = "SecretsRead"
      effect    = "Allow"
      actions   = ["secretsmanager:GetSecretValue"]
      resources = var.secret_arns
    }
  }
}

resource "aws_iam_policy" "app_permissions" {
  name   = "${local.name}-app-permissions"
  policy = data.aws_iam_policy_document.app_permissions.json
}

resource "aws_iam_role_policy_attachment" "app_permissions" {
  for_each   = aws_iam_role.app
  role       = each.value.name
  policy_arn = aws_iam_policy.app_permissions.arn
}