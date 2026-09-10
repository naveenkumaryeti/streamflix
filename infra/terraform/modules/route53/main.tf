# Route53 module — Phase 4/11. Hosted zone (or reuse an existing one) plus alias records
# pointing streamflix.com / media.streamflix.com at the two CloudFront distributions.

terraform {
  required_version = ">= 1.7.0"
  required_providers {
    aws = { source = "hashicorp/aws", version = ">= 5.40" }
  }
}

resource "aws_route53_zone" "this" {
  count = var.create_zone ? 1 : 0
  name  = var.domain_name
}

data "aws_route53_zone" "existing" {
  count = var.create_zone ? 0 : 1
  name  = var.domain_name
}

locals {
  zone_id = var.create_zone ? aws_route53_zone.this[0].zone_id : data.aws_route53_zone.existing[0].zone_id
}

resource "aws_route53_record" "app" {
  count   = var.app_domain != "" ? 1 : 0
  zone_id = local.zone_id
  name    = var.app_domain
  type    = "A"
  alias {
    name                   = var.app_distribution_domain_name
    zone_id                = var.cloudfront_hosted_zone_id
    evaluate_target_health = false
  }
}

resource "aws_route53_record" "media" {
  count   = var.media_domain != "" ? 1 : 0
  zone_id = local.zone_id
  name    = var.media_domain
  type    = "A"
  alias {
    name                   = var.media_distribution_domain_name
    zone_id                = var.cloudfront_hosted_zone_id
    evaluate_target_health = false
  }
}
