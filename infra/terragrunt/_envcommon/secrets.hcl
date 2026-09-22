locals {
  env = read_terragrunt_config(find_in_parent_folders("env.hcl"))
}

terraform {
  source = "${get_repo_root()}/infra/terraform/modules/secrets"
}

inputs = {
  environment = local.env.locals.environment
  cloudfront_private_key_pem = file("${get_repo_root()}/infra/.secrets/cloudfront-private.pem")
}
