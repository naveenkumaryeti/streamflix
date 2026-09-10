output "primary_endpoint" { value = aws_elasticache_replication_group.this.primary_endpoint_address }
output "secret_arn"       { value = aws_secretsmanager_secret.redis.arn }
