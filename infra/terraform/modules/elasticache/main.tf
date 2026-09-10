# ElastiCache module — Redis, matching backend's REDIS_URL (see db/redis.js). Used for
# session/rate-limit state and catalog caching. Single node group; prod gets a replica
# for failover, dev/stage run cheaper single-node.

terraform {
  required_version = ">= 1.7.0"
  required_providers {
    aws = { source = "hashicorp/aws", version = ">= 5.40" }
  }
}

locals {
  name = "${var.project}-${var.environment}"
}

resource "aws_elasticache_subnet_group" "this" {
  name       = "${local.name}-redis"
  subnet_ids = var.private_subnet_ids
}

resource "aws_elasticache_replication_group" "this" {
  replication_group_id = "${local.name}-redis"
  description           = "StreamFlix ${var.environment} Redis"

  engine         = "redis"
  engine_version = "7.1"
  node_type      = var.node_type
  port           = 6379

  subnet_group_name = aws_elasticache_subnet_group.this.name
  security_group_ids = [var.security_group_id]

  num_cache_clusters         = var.environment == "prod" ? 2 : 1
  automatic_failover_enabled = var.environment == "prod"
  multi_az_enabled           = var.environment == "prod"

  at_rest_encryption_enabled = true
  transit_encryption_enabled = true

  snapshot_retention_limit = var.environment == "prod" ? 5 : 0

  tags = { Name = "${local.name}-redis" }
}

resource "aws_secretsmanager_secret" "redis" {
  name = "${local.name}/redis-url"
}

resource "aws_secretsmanager_secret_version" "redis" {
  secret_id = aws_secretsmanager_secret.redis.id
  secret_string = jsonencode({
    REDIS_URL = "rediss://${aws_elasticache_replication_group.this.primary_endpoint_address}:6379"
  })
}
