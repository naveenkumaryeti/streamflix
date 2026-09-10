locals {
  env = read_terragrunt_config(find_in_parent_folders("env.hcl"))
}

terraform {
  source = "${get_repo_root()}/infra/terraform/modules/iam"
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

# The EKS OIDC provider doesn't exist until `eks` has applied at least once — see the note
# in modules/iam/variables.tf. mock_outputs lets `plan`/`validate` succeed before that;
# `apply` picks up the real value once `eks` has been applied and this module is re-run.
dependency "eks" {
  config_path = "../eks"
  mock_outputs = { oidc_provider_arn = "", oidc_provider_url = "" }
  mock_outputs_allowed_terraform_commands = ["validate", "plan", "init", "apply"]
}

inputs = {
  environment        = local.env.locals.environment
  media_bucket_arns  = [dependency.s3.outputs.bucket_arns.raw, dependency.s3.outputs.bucket_arns.processed, dependency.s3.outputs.bucket_arns.thumbs]
  dynamodb_table_arn = dependency.dynamodb.outputs.table_arn
  oidc_provider_arn  = dependency.eks.outputs.oidc_provider_arn
  oidc_provider_url  = dependency.eks.outputs.oidc_provider_url
  # Only one env should own the (account-wide, singleton) GitHub OIDC provider — dev is it.
  enable_github_oidc = local.env.locals.environment == "dev"
  github_repo        = "your-org/streamflix"
}
