locals {
  env = read_terragrunt_config(find_in_parent_folders("env.hcl"))
}
terraform {
  source = "${get_repo_root()}/infra/terraform/modules/iam"
}
dependency "s3" {
  config_path = "../s3"
}
dependency "dynamodb" {
  config_path = "../dynamodb"
}
inputs = {
  environment        = local.env.locals.environment
  enable_github_oidc = true   # this unit only creates cluster/node roles
  media_bucket_arns  = [dependency.s3.outputs.bucket_arns.raw, dependency.s3.outputs.bucket_arns.processed, dependency.s3.outputs.bucket_arns.thumbs]
  dynamodb_table_arn = dependency.dynamodb.outputs.table_arn
  github_repo = local.env.locals.github_repo
}