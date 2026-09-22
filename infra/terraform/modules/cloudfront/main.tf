# CloudFront module — Phase 10 (Video Streaming) + frontend CDN. Two origins:
#   - S3 frontend bucket (default behavior, OAC-secured, SPA-friendly 404->index.html)
#   - ALB (the API, path pattern /api/*) so the browser only ever talks to one hostname
# Processed video + thumbnails are served from a second distribution pointed straight at
# their S3 buckets — matches backend's CLOUDFRONT_DOMAIN config for signed URLs.

terraform {
  required_version = ">= 1.7.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 5.40"
    }
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

# ============================================================
# CORS policy for the media distribution
# hls.js fetches manifests/segments via XMLHttpRequest from the app's own domain
# (a different CloudFront distribution), so the media distribution must answer
# with Access-Control-Allow-Origin or the browser blocks the response entirely.
# ============================================================

resource "aws_cloudfront_response_headers_policy" "media_cors" {
  name = "${local.name}-media-cors"

  cors_config {
    access_control_allow_credentials = false

    access_control_allow_headers {
      items = ["*"]
    }

    access_control_allow_methods {
      items = ["GET", "HEAD"]
    }

    access_control_allow_origins {
      items = var.app_domain != "" ? ["https://${var.app_domain}"] : ["*"]
    }

    origin_override = true
  }
}

# ============================================================
# App distribution: Frontend S3 + API ALB
# ============================================================

resource "aws_cloudfront_distribution" "app" {
  enabled             = true
  is_ipv6_enabled     = true
  default_root_object = "index.html"
  price_class         = var.price_class

  aliases = var.app_domain != "" ? [var.app_domain] : []

  web_acl_id = var.waf_web_acl_arn != "" ? var.waf_web_acl_arn : null

  # ----------------------------------------------------------
  # Origin 1: Frontend S3
  # ----------------------------------------------------------

  origin {
    domain_name              = var.frontend_bucket_regional_domain_name
    origin_id                = "frontend-s3"
    origin_access_control_id = aws_cloudfront_origin_access_control.this.id
  }

  # ----------------------------------------------------------
  # Origin 2: API ALB
  # CloudFront -> ALB uses HTTP for dev
  # ----------------------------------------------------------

  dynamic "origin" {
    for_each = var.alb_dns_name != "" ? [1] : []

    content {
      domain_name = var.alb_dns_name
      origin_id   = "api-alb"

      custom_origin_config {
        http_port              = 80
        https_port              = 443
        origin_protocol_policy = "http-only"
        origin_ssl_protocols   = ["TLSv1.2"]
      }
    }
  }

  # ==========================================================
  # Default behavior -> Frontend S3
  # ==========================================================

  default_cache_behavior {
    target_origin_id       = "frontend-s3"
    viewer_protocol_policy = "redirect-to-https"

    allowed_methods = [
      "GET",
      "HEAD",
      "OPTIONS"
    ]

    cached_methods = [
      "GET",
      "HEAD"
    ]

    compress        = true
    cache_policy_id = data.aws_cloudfront_cache_policy.optimized.id
  }

  # ==========================================================
  # API behavior -> ALB
  #
  # Browser:
  #   https://CloudFront/api/v1/auth/login
  #
  # CloudFront:
  #   /api/* -> api-alb
  #
  # CloudFront -> ALB:
  #   HTTP
  # ==========================================================

  dynamic "ordered_cache_behavior" {
    for_each = var.alb_dns_name != "" ? [1] : []

    content {
      path_pattern           = "/api/*"
      target_origin_id       = "api-alb"
      viewer_protocol_policy = "redirect-to-https"

      allowed_methods = [
        "DELETE",
        "GET",
        "HEAD",
        "OPTIONS",
        "PATCH",
        "POST",
        "PUT"
      ]

      cached_methods = [
        "GET",
        "HEAD"
      ]

      compress = true

      # Never cache API responses such as login/auth responses.
      cache_policy_id = data.aws_cloudfront_cache_policy.disabled.id

      # Forward query strings, headers and cookies to the ALB/backend.
      # Important for authentication/session cookies.
      origin_request_policy_id = data.aws_cloudfront_origin_request_policy.all_viewer.id
    }
  }

  # ==========================================================
  # SPA error handling
  # ==========================================================

  custom_error_response {
    error_code         = 404
    response_code      = 200
    response_page_path = "/index.html"
  }

  custom_error_response {
    error_code         = 403
    response_code      = 200
    response_page_path = "/index.html"
  }

  # ==========================================================
  # Restrictions
  # ==========================================================

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  # ==========================================================
  # SSL/TLS
  # ==========================================================

  viewer_certificate {
    cloudfront_default_certificate = var.acm_certificate_arn == ""

    acm_certificate_arn = var.acm_certificate_arn != "" ? var.acm_certificate_arn : null

    ssl_support_method = var.acm_certificate_arn != "" ? "sni-only" : null

    minimum_protocol_version = "TLSv1.2_2021"
  }

  # ==========================================================
  # CloudFront logging
  # ==========================================================

  logging_config {
    bucket = var.logs_bucket_domain_name
    prefix = "cloudfront/app/"
  }

  tags = {
    Name = "${local.name}-app-cdn"
  }
}

# ============================================================
# Media distribution
# Processed video + thumbnails
# ============================================================

resource "aws_cloudfront_distribution" "media" {
  enabled         = true
  is_ipv6_enabled = true
  price_class     = var.price_class

  aliases = var.media_domain != "" ? [var.media_domain] : []

  web_acl_id = var.waf_web_acl_arn != "" ? var.waf_web_acl_arn : null

  # ----------------------------------------------------------
  # Processed media S3 origin
  # ----------------------------------------------------------

  origin {
    domain_name              = var.processed_bucket_regional_domain_name
    origin_id                = "processed-s3"
    origin_access_control_id = aws_cloudfront_origin_access_control.this.id
  }

  # ----------------------------------------------------------
  # Media default behavior
  # ----------------------------------------------------------

  default_cache_behavior {
    target_origin_id       = "processed-s3"
    viewer_protocol_policy = "redirect-to-https"

    allowed_methods = [
      "GET",
      "HEAD",
      "OPTIONS"
    ]

    cached_methods = [
      "GET",
      "HEAD"
    ]

    compress                   = true
    cache_policy_id            = data.aws_cloudfront_cache_policy.optimized.id
    response_headers_policy_id = aws_cloudfront_response_headers_policy.media_cors.id

    # HLS manifests/segments are signed so only entitled,
    # authenticated playback sessions can pull them.
    trusted_key_groups = var.cloudfront_key_group_id != "" ? [
      var.cloudfront_key_group_id
    ] : null
  }

  # ----------------------------------------------------------
  # Restrictions
  # ----------------------------------------------------------

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  # ----------------------------------------------------------
  # SSL/TLS
  # ----------------------------------------------------------

  viewer_certificate {
    cloudfront_default_certificate = var.acm_certificate_arn == ""

    acm_certificate_arn = var.acm_certificate_arn != "" ? var.acm_certificate_arn : null

    ssl_support_method = var.acm_certificate_arn != "" ? "sni-only" : null

    minimum_protocol_version = "TLSv1.2_2021"
  }

  # ----------------------------------------------------------
  # CloudFront logging
  # ----------------------------------------------------------

  logging_config {
    bucket = var.logs_bucket_domain_name
    prefix = "cloudfront/media/"
  }

  tags = {
    Name = "${local.name}-media-cdn"
  }
}

# ============================================================
# CloudFront cache policies
# ============================================================

data "aws_cloudfront_cache_policy" "optimized" {
  name = "Managed-CachingOptimized"
}

data "aws_cloudfront_cache_policy" "disabled" {
  name = "Managed-CachingDisabled"
}

# ============================================================
# Origin request policy
# ============================================================

data "aws_cloudfront_origin_request_policy" "all_viewer" {
  name = "Managed-AllViewer"
}

# ============================================================
# CloudFront public key
# Used for signed URLs/cookies on media distribution
# ============================================================

resource "aws_cloudfront_public_key" "signing" {
  count = var.cloudfront_signing_public_key_pem != "" ? 1 : 0

  name_prefix = "${local.name}-media-signing"
  encoded_key = var.cloudfront_signing_public_key_pem
  lifecycle {
    create_before_destroy = true
  }
}

# ============================================================
# CloudFront key group
# ============================================================

resource "aws_cloudfront_key_group" "signing" {
  count = var.cloudfront_signing_public_key_pem != "" ? 1 : 0

  name = "${local.name}-media-signing"

  items = [
    aws_cloudfront_public_key.signing[0].id
  ]
}