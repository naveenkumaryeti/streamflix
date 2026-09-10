# Root Terragrunt config, included by every live/<env>/<module>/terragrunt.hcl. Owns:
#   - remote state (S3 + DynamoDB lock, one state file per module per env — the key is
#     derived from each child's path, so envs/modules never collide)
#   - the AWS provider generated into every module, plus the us-east-1 alias CloudFront/WAF
#     need (those resources must live there regardless of the main region)
#
# Per-environment values (region, env name) live in live/<env>/env.hcl and are read by the
# _envcommon/*.hcl files, NOT here — this file is a parent of every env, so it can't see
# any single one of them at generate-time.
#
# Bucket/table names must match infra/terraform/global/backend-bootstrap.tf's outputs.

locals {
  project    = "streamflix"
  aws_region = "ap-south-1"
}

remote_state {
  backend = "s3"
  generate = {
    path      = "backend.tf"
    if_exists = "overwrite"
  }
  config = {
    bucket         = "${local.project}-terraform-state"
    key            = "${path_relative_to_include()}/terraform.tfstate"
    region         = local.aws_region
    dynamodb_table = "${local.project}-terraform-locks"
    encrypt        = true
  }
}

generate "provider" {
  path      = "provider.tf"
  if_exists = "overwrite"
  contents  = <<-EOF2
    provider "aws" {
      region = "${local.aws_region}"
      default_tags {
        tags = {
          Project   = "${local.project}"
          ManagedBy = "terragrunt"
        }
      }
    }

    provider "aws" {
      alias  = "us_east_1"
      region = "us-east-1"
      default_tags {
        tags = {
          Project   = "${local.project}"
          ManagedBy = "terragrunt"
        }
      }
    }
  EOF2
}
