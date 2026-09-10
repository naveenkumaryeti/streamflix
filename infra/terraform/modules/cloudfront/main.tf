# CloudFront module — Phase 10 (Video Streaming) + frontend CDN. Two origins:
#   - S3 frontend bucket (default behavior, OAC-secured, SPA-friendly 404->index.html)
#   - ALB (the API, path pattern /api/*) so the browser only ever talks to one hostname
# Processed video + thumbnails are served from a second distribution pointed straight at
# their S3 buckets — matches backend's CLOUDFRONT_DOMAIN config for signed URLs.

terraform {
  required_version = ">= 1.7.0"
  required_providers {
    aws = { source = "hashicorp/aws", version = ">= 5.40" }
  }
}

locals {
  name = "${var.project}-${var.environment}"
}

resource "aws_cloudfront_origin_access_control" "this" {
  name                              = "${local.name}-oac"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

# ---- App distribution: frontend (default) + API (/api/*) ----
resource "aws_cloudfront_distribution" "app" {
  enabled             = true
  is_ipv6_enabled     = true
  default_root_object = "index.html"
  price_class         = var.price_class
  aliases             = var.app_domain != "" ? [var.app_domain] : []
  web_acl_id          = var.waf_web_acl_arn != "" ? var.waf_web_acl_arn : null

  origin {
    domain_name              = var.frontend_bucket_regional_domain_name
    origin_id                = "frontend-s3"
    origin_access_control_id = aws_cloudfront_origin_access_control.this.id
  }

  dynamic "origin" {
    for_each = var.alb_dns_name != "" ? [1] : []
    content {
      domain_name = var.alb_dns_name
      origin_id   = "api-alb"
      custom_origin_config {
        http_port              = 80
        https_port              = 443
        origin_protocol_policy   = "https-only"
        origin_ssl_protocols     = ["TLSv1.2"]
      }
    }
  }

  default_cache_behavior {
    target_origin_id       = "frontend-s3"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods         = ["GET", "HEAD", "OPTIONS"]
    cached_methods           = ["GET", "HEAD"]
    compress                = true
    cache_policy_id          = data.aws_cloudfront_cache_policy.optimized.id
  }

  dynamic "ordered_cache_behavior" {
    for_each = var.alb_dns_name != "" ? [1] : []
    content {
      path_pattern             = "/api/*"
      target_origin_id         = "api-alb"
      viewer_protocol_policy   = "redirect-to-https"
      allowed_methods           = ["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"]
      cached_methods            = ["GET", "HEAD"]
      compress                 = true
      cache_policy_id           = data.aws_cloudfront_cache_policy.disabled.id
      origin_request_policy_id  = data.aws_cloudfront_origin_request_policy.all_viewer.id
    }
  }

  custom_error_response {
    error_code         = 404
    response_code      = 200
    response_page_path = "/index.html"
  }

  restrictions {
    geo_restriction { restriction_type = "none" }
  }

  viewer_certificate {
    cloudfront_default_certificate = var.acm_certificate_arn == ""
    acm_certificate_arn            = var.acm_certificate_arn != "" ? var.acm_certificate_arn : null
    ssl_support_method             = var.acm_certificate_arn != "" ? "sni-only" : null
    minimum_protocol_version       = "TLSv1.2_2021"
  }

  logging_config {
    bucket = var.logs_bucket_domain_name
    prefix = "cloudfront/app/"
  }

  tags = { Name = "${local.name}-app-cdn" }
}

# ---- Media distribution: processed video + thumbnails, signed-URL capable ----
resource "aws_cloudfront_distribution" "media" {
  enabled         = true
  is_ipv6_enabled = true
  price_class     = var.price_class
  aliases         = var.media_domain != "" ? [var.media_domain] : []
  web_acl_id      = var.waf_web_acl_arn != "" ? var.waf_web_acl_arn : null

  origin {
    domain_name              = var.processed_bucket_regional_domain_name
    origin_id                = "processed-s3"
    origin_access_control_id = aws_cloudfront_origin_access_control.this.id
  }

  default_cache_behavior {
    target_origin_id       = "processed-s3"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods         = ["GET", "HEAD", "OPTIONS"]
    cached_methods           = ["GET", "HEAD"]
    compress                = true
    cache_policy_id          = data.aws_cloudfront_cache_policy.optimized.id

    # HLS manifests/segments are signed so only entitled, authenticated playback sessions
    # can pull them — see backend cdn.js which mints these with the key pair below.
    trusted_key_groups = var.cloudfront_key_group_id != "" ? [var.cloudfront_key_group_id] : null
  }

  restrictions {
    geo_restriction { restriction_type = "none" }
  }

  viewer_certificate {
    cloudfront_default_certificate = var.acm_certificate_arn == ""
    acm_certificate_arn            = var.acm_certificate_arn != "" ? var.acm_certificate_arn : null
    ssl_support_method             = var.acm_certificate_arn != "" ? "sni-only" : null
    minimum_protocol_version       = "TLSv1.2_2021"
  }

  logging_config {
    bucket = var.logs_bucket_domain_name
    prefix = "cloudfront/media/"
  }

  tags = { Name = "${local.name}-media-cdn" }
}

data "aws_cloudfront_cache_policy" "optimized" {
  name = "Managed-CachingOptimized"
}
data "aws_cloudfront_cache_policy" "disabled" {
  name = "Managed-CachingDisabled"
}
data "aws_cloudfront_origin_request_policy" "all_viewer" {
  name = "Managed-AllViewer"
}

# Public key + key group for signed URLs/cookies on the media distribution. The private key
# is generated out of band (never in state) and its PEM handed to CLOUDFRONT_PRIVATE_KEY.
resource "aws_cloudfront_public_key" "signing" {
  count       = var.cloudfront_signing_public_key_pem != "" ? 1 : 0
  name        = "${local.name}-media-signing"
  encoded_key = var.cloudfront_signing_public_key_pem
}

resource "aws_cloudfront_key_group" "signing" {
  count   = var.cloudfront_signing_public_key_pem != "" ? 1 : 0
  name    = "${local.name}-media-signing"
  items   = [aws_cloudfront_public_key.signing[0].id]
}
