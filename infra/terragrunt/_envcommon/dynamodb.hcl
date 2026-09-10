locals {
  env = read_terragrunt_config(find_in_parent_folders("env.hcl"))
}

terraform {
  source = "${get_repo_root()}/infra/terraform/modules/dynamodb"
}

inputs = {
  environment = local.env.locals.environment
}
