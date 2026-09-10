# DynamoDB module — watch-progress table. Backend expects DYNAMODB_TABLE_WATCH_PROGRESS
# (see config/env.js). Access pattern is single-item get/put keyed by userId+titleId with a
# GSI to list a user's in-progress titles for "Continue Watching" — on-demand billing since
# traffic is spiky per-title, not steady.

terraform {
  required_version = ">= 1.7.0"
  required_providers {
    aws = { source = "hashicorp/aws", version = ">= 5.40" }
  }
}

locals {
  table_name = "${var.project}-${var.environment}-watch-progress"
}

resource "aws_dynamodb_table" "watch_progress" {
  name         = local.table_name
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "userId"
  range_key    = "titleId"

  attribute {
    name = "userId"
    type = "S"
  }
  attribute {
    name = "titleId"
    type = "S"
  }
  attribute {
    name = "updatedAt"
    type = "S"
  }

  global_secondary_index {
    name            = "byUserRecency"
    hash_key        = "userId"
    range_key       = "updatedAt"
    projection_type = "ALL"
  }

  ttl {
    attribute_name = "expiresAt"
    enabled        = true
  }

  point_in_time_recovery { enabled = var.environment == "prod" }

  server_side_encryption { enabled = true }

  tags = { Name = local.table_name }
}
