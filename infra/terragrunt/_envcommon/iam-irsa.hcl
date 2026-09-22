locals {
  env = read_terragrunt_config(find_in_parent_folders("env.hcl"))
}

terraform {
  source = "${get_repo_root()}/infra/terraform/modules/iam-irsa"
}

dependency "iam" {
  config_path = "../iam-cluster"
  mock_outputs = { mediaconvert_role_arn = "arn:aws:iam::000000000000:role/mock" }
  mock_outputs_allowed_terraform_commands = ["validate", "plan", "init"]
}

dependency "eks" {
  config_path = "../eks"
  mock_outputs = { oidc_provider_arn = "", oidc_provider_url = "" }
  mock_outputs_allowed_terraform_commands = ["validate", "plan", "init", "apply"]
}

dependency "s3" {
  config_path = "../s3"
  mock_outputs = {
    bucket_arns = {
      raw = "arn:aws:s3:::mock-raw", processed = "arn:aws:s3:::mock-processed", thumbs = "arn:aws:s3:::mock-thumbs"
    }
  }
  mock_outputs_allowed_terraform_commands = ["validate", "plan", "init"]
}

dependency "dynamodb" {
  config_path = "../dynamodb"
  mock_outputs = { table_arn = "arn:aws:dynamodb:ap-south-1:000000000000:table/mock" }
  mock_outputs_allowed_terraform_commands = ["validate", "plan", "init"]
}

dependency "rds" {
  config_path = "../rds"
  mock_outputs = { secret_arn = "arn:aws:secretsmanager:ap-south-1:000000000000:secret:mock" }
  mock_outputs_allowed_terraform_commands = ["validate", "plan", "init"]
}

dependency "elasticache" {
  config_path = "../elasticache"
  mock_outputs = { secret_arn = "arn:aws:secretsmanager:ap-south-1:000000000000:secret:mock" }
  mock_outputs_allowed_terraform_commands = ["validate", "plan", "init"]
}

dependency "secrets" {
  config_path = "../secrets"
  mock_outputs = {
    jwt_secret_arn                = "arn:aws:secretsmanager:ap-south-1:000000000000:secret:mock"
    cloudfront_signing_secret_arn = "arn:aws:secretsmanager:ap-south-1:000000000000:secret:mock"
  }
  mock_outputs_allowed_terraform_commands = ["validate", "plan", "init"]
}

inputs = {
  environment           = local.env.locals.environment
  oidc_provider_arn      = dependency.eks.outputs.oidc_provider_arn
  oidc_provider_url      = dependency.eks.outputs.oidc_provider_url
  mediaconvert_role_arn  = dependency.iam.outputs.mediaconvert_role_arn
  media_bucket_arns      = [dependency.s3.outputs.bucket_arns.raw, dependency.s3.outputs.bucket_arns.processed, dependency.s3.outputs.bucket_arns.thumbs]
  dynamodb_table_arn     = dependency.dynamodb.outputs.table_arn
  secret_arns = [
  dependency.rds.outputs.secret_arn,
  dependency.elasticache.outputs.secret_arn,
  dependency.secrets.outputs.jwt_secret_arn,
  dependency.secrets.outputs.cloudfront_signing_secret_arn,
  ]
}