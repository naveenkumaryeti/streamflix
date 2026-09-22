# RDS module — Phase 6 (Database + Cache). Postgres, matching backend's DATABASE_URL usage
# (pg client, see db/postgres.js). Private-subnet only, encrypted at rest, credentials in
# Secrets Manager (never in state as plain vars) with a fixed random master password.

terraform {
  required_version = ">= 1.7.0"
  required_providers {
    aws    = { source = "hashicorp/aws", version = ">= 5.40" }
    random = { source = "hashicorp/random", version = ">= 3.6" }
  }
}

locals {
  name = "${var.project}-${var.environment}"
}

resource "random_password" "master" {
  length  = 24
  special = false
}

resource "aws_db_subnet_group" "this" {
  name       = "${local.name}-db"
  subnet_ids = var.private_subnet_ids
  tags       = { Name = "${local.name}-db-subnet-group" }
}

resource "aws_db_parameter_group" "this" {
  name   = "${local.name}-pg16"
  family = "postgres16"
  parameter {
    name  = "log_min_duration_statement"
    value = "500"
  }
}

resource "aws_db_instance" "this" {
  identifier     = "${local.name}-postgres"
  engine         = "postgres"
  engine_version = "16"
  instance_class = var.instance_class

  allocated_storage     = var.allocated_storage_gb
  max_allocated_storage = var.max_allocated_storage_gb
  storage_type          = "gp3"
  storage_encrypted     = true

  db_name  = "streamflix"
  username = "streamflix"
  password = random_password.master.result
  port     = 5432

  db_subnet_group_name   = aws_db_subnet_group.this.name
  vpc_security_group_ids = [var.security_group_id]
  parameter_group_name   = aws_db_parameter_group.this.name

  multi_az                = var.multi_az
  publicly_accessible     = false
  deletion_protection     = var.deletion_protection
  skip_final_snapshot     = !var.deletion_protection
  final_snapshot_identifier = var.deletion_protection ? "${local.name}-postgres-final" : null
  backup_retention_period = var.backup_retention_days
  backup_window           = "03:00-04:00"
  maintenance_window      = "mon:04:30-mon:05:30"

  performance_insights_enabled = var.environment == "prod"

  tags = { Name = "${local.name}-postgres" }
}

resource "aws_secretsmanager_secret" "db" {
  name = "${local.name}/database-url"
}

resource "aws_secretsmanager_secret_version" "db" {
  secret_id = aws_secretsmanager_secret.db.id
  secret_string = jsonencode({
    DATABASE_URL = "postgres://${aws_db_instance.this.username}:${random_password.master.result}@${aws_db_instance.this.address}:${aws_db_instance.this.port}/${aws_db_instance.this.db_name}"
    host         = aws_db_instance.this.address
    port         = aws_db_instance.this.port
    username     = aws_db_instance.this.username
    password     = random_password.master.result
    dbname       = aws_db_instance.this.db_name
  })
}
