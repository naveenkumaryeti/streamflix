# Bootstrap-only: creates the S3 bucket + DynamoDB lock table that Terragrunt's remote_state
# block (see terragrunt/terragrunt.hcl) expects to already exist. Applied once, by hand,
# before any `terragrunt run-all`:
#
#   cd infra/terraform/global && terraform init && terraform apply
#
# Deliberately NOT managed by Terragrunt itself — you can't store your own state backend's
# state in the backend it's creating.

terraform {
  required_version = ">= 1.7.0"
  required_providers {
    aws = { source = "hashicorp/aws", version = ">= 5.40" }
  }
}

variable "project" {
  type    = string
  default = "streamflix"
}

variable "aws_region" {
  type    = string
  default = "ap-south-1"
}

provider "aws" {
  region = var.aws_region
}

resource "aws_s3_bucket" "tf_state" {
  bucket = "${var.project}-terraform-state"
}

resource "aws_s3_bucket_versioning" "tf_state" {
  bucket = aws_s3_bucket.tf_state.id
  versioning_configuration { status = "Enabled" }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "tf_state" {
  bucket = aws_s3_bucket.tf_state.id
  rule {
    apply_server_side_encryption_by_default { sse_algorithm = "AES256" }
  }
}

resource "aws_s3_bucket_public_access_block" "tf_state" {
  bucket                  = aws_s3_bucket.tf_state.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_dynamodb_table" "tf_lock" {
  name         = "${var.project}-terraform-locks"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "LockID"
  attribute {
    name = "LockID"
    type = "S"
  }
}

output "state_bucket"  { value = aws_s3_bucket.tf_state.bucket }
output "lock_table"    { value = aws_dynamodb_table.tf_lock.name }
