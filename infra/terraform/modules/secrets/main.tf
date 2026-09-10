# Secrets module — app-level secrets that aren't owned by another module (rds/elasticache
# already publish their own connection secrets). Covers JWT signing keys and the CloudFront
# signed-URL private key, matching JWT_ACCESS_SECRET/JWT_REFRESH_SECRET/CLOUDFRONT_PRIVATE_KEY
# in the backend's config/env.js. External Secrets Operator (deployed via the Helm chart)
# syncs these into Kubernetes Secrets — nothing is ever written to a ConfigMap in plaintext.

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

resource "random_password" "jwt_access" {
  length  = 48
  special = false
}
resource "random_password" "jwt_refresh" {
  length  = 48
  special = false
}

resource "aws_secretsmanager_secret" "jwt" {
  name = "${local.name}/jwt"
}
resource "aws_secretsmanager_secret_version" "jwt" {
  secret_id = aws_secretsmanager_secret.jwt.id
  secret_string = jsonencode({
    JWT_ACCESS_SECRET  = random_password.jwt_access.result
    JWT_REFRESH_SECRET = random_password.jwt_refresh.result
  })
}

# The CloudFront signing private key is generated out-of-band (`aws cloudfront` doesn't
# create key pairs via Terraform) and pasted in here — see infra/README.md "Signed URLs".
resource "aws_secretsmanager_secret" "cloudfront_signing_key" {
  count = var.cloudfront_private_key_pem != "" ? 1 : 0
  name  = "${local.name}/cloudfront-signing-key"
}
resource "aws_secretsmanager_secret_version" "cloudfront_signing_key" {
  count     = var.cloudfront_private_key_pem != "" ? 1 : 0
  secret_id = aws_secretsmanager_secret.cloudfront_signing_key[0].id
  secret_string = jsonencode({
    CLOUDFRONT_PRIVATE_KEY = var.cloudfront_private_key_pem
  })
}

resource "aws_secretsmanager_secret" "seed_credentials" {
  name = "${local.name}/seed-credentials"
}
resource "random_password" "seed_admin" {
  length  = 16
  special = true
}
resource "random_password" "seed_user" {
  length  = 16
  special = true
}
resource "aws_secretsmanager_secret_version" "seed_credentials" {
  secret_id = aws_secretsmanager_secret.seed_credentials.id
  secret_string = jsonencode({
    SEED_ADMIN_EMAIL    = "admin@streamflix.local"
    SEED_ADMIN_PASSWORD = random_password.seed_admin.result
    SEED_USER_EMAIL     = "demo@streamflix.local"
    SEED_USER_PASSWORD  = random_password.seed_user.result
  })
}
