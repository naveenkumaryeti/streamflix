# S3 module — Phase 3/4 (AWS Foundation). Buckets per doc section 1.3:
# frontend, raw-videos, processed-videos, thumbnails, logs.
# Video buckets block all public access; CloudFront reaches them via Origin Access Control.
# The frontend bucket is also OAC-only — nobody hits S3 directly, only through CloudFront.

terraform {
  required_version = ">= 1.7.0"
  required_providers {
    aws = { source = "hashicorp/aws", version = ">= 5.40" }
  }
}

locals {
  name = "${var.project}-${var.environment}"
  buckets = {
    frontend  = "${local.name}-frontend"
    raw       = "${local.name}-raw-videos"
    processed = "${local.name}-processed-videos"
    thumbs    = "${local.name}-thumbnails"
    logs      = "${local.name}-logs"
  }
}

resource "aws_s3_bucket" "this" {
  for_each = local.buckets
  bucket   = each.value
  tags     = { Name = each.value, Purpose = each.key }
}

resource "aws_s3_bucket_versioning" "this" {
  for_each = local.buckets
  bucket   = aws_s3_bucket.this[each.key].id
  versioning_configuration { status = "Enabled" }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "this" {
  for_each = local.buckets
  bucket   = aws_s3_bucket.this[each.key].id
  rule {
    apply_server_side_encryption_by_default { sse_algorithm = "aws:kms" }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_public_access_block" "this" {
  for_each                = local.buckets
  bucket                  = aws_s3_bucket.this[each.key].id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# Raw uploads are large and short-lived once transcoded — age them out of standard storage,
# then delete after a retention window (admins keep the original off-box if they need it longer).
resource "aws_s3_bucket_lifecycle_configuration" "raw" {
  bucket = aws_s3_bucket.this["raw"].id
  rule {
    id     = "expire-raw-after-retention"
    status = "Enabled"
    filter {}
    transition {
      days          = 30
      storage_class = "STANDARD_IA"
    }
    expiration { days = var.raw_video_retention_days }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "logs" {
  bucket = aws_s3_bucket.this["logs"].id
  rule {
    id     = "expire-logs"
    status = "Enabled"
    filter {}
    expiration { days = var.log_retention_days }
  }
}

resource "aws_s3_bucket_cors_configuration" "frontend" {
  bucket = aws_s3_bucket.this["frontend"].id
  cors_rule {
    allowed_methods = ["GET", "HEAD"]
    allowed_origins = ["*"]
    allowed_headers = ["*"]
  }
}

# CloudFront (OAC) is the only allowed reader/writer of these buckets — enforced via the
# bucket policies below, granted to the CloudFront distribution's service principal.
data "aws_iam_policy_document" "oac_read" {
  for_each = toset(["frontend", "processed", "thumbs"])
  statement {
    sid       = "AllowCloudFrontServicePrincipalRead"
    effect    = "Allow"
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.this[each.key].arn}/*"]
    principals {
      type        = "Service"
      identifiers = ["cloudfront.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "AWS:SourceArn"
      values   = [var.cloudfront_distribution_arn]
    }
  }
}

resource "aws_s3_bucket_policy" "oac_read" {
  for_each   = var.cloudfront_distribution_arn != "" ? toset(["frontend", "processed", "thumbs"]) : []
  bucket     = aws_s3_bucket.this[each.key].id
  policy     = data.aws_iam_policy_document.oac_read[each.key].json
}
