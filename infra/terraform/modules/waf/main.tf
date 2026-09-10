# WAF module — Phase 11 (Security). Regional WebACL attached to CloudFront: AWS managed
# rule groups for common exploits + a straightforward rate limit per IP.

terraform {
  required_version = ">= 1.7.0"
  required_providers {
    aws = { source = "hashicorp/aws", version = ">= 5.40", configuration_aliases = [aws.us_east_1] }
  }
}

locals {
  name = "${var.project}-${var.environment}"
}

# CloudFront WAF associations must live in us-east-1 regardless of where everything else
# runs — hence the aliased provider passed in from the caller.
resource "aws_wafv2_web_acl" "this" {
  provider    = aws.us_east_1
  name        = "${local.name}-waf"
  description = "StreamFlix ${var.environment} edge protection"
  scope       = "CLOUDFRONT"

  default_action { allow {} }

  rule {
    name     = "AWS-CommonRuleSet"
    priority = 1
    override_action { none {} }
    statement {
      managed_rule_group_statement {
        name        = "AWSManagedRulesCommonRuleSet"
        vendor_name = "AWS"
      }
    }
    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${local.name}-common"
      sampled_requests_enabled   = true
    }
  }

  rule {
    name     = "AWS-KnownBadInputs"
    priority = 2
    override_action { none {} }
    statement {
      managed_rule_group_statement {
        name        = "AWSManagedRulesKnownBadInputsRuleSet"
        vendor_name = "AWS"
      }
    }
    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${local.name}-bad-inputs"
      sampled_requests_enabled   = true
    }
  }

  rule {
    name     = "RateLimitPerIp"
    priority = 3
    action { block {} }
    statement {
      rate_based_statement {
        limit              = var.rate_limit_per_5min
        aggregate_key_type = "IP"
      }
    }
    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${local.name}-rate-limit"
      sampled_requests_enabled   = true
    }
  }

  visibility_config {
    cloudwatch_metrics_enabled = true
    metric_name                = "${local.name}-waf"
    sampled_requests_enabled   = true
  }

  tags = { Name = "${local.name}-waf" }
}
