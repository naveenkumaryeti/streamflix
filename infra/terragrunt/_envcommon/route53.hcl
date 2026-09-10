locals {
  env = read_terragrunt_config(find_in_parent_folders("env.hcl"))
}

terraform {
  source = "${get_repo_root()}/infra/terraform/modules/route53"
}

dependency "cloudfront" {
  config_path = "../cloudfront"
  mock_outputs = { app_distribution_domain_name = "mock.cloudfront.net", media_distribution_domain_name = "mock.cloudfront.net" }
  mock_outputs_allowed_terraform_commands = ["validate", "plan", "init"]
}

inputs = {
  domain_name                    = local.env.locals.domain_name
  create_zone                    = local.env.locals.create_dns_zone
  app_domain                     = local.env.locals.app_domain
  media_domain                   = local.env.locals.media_domain
  app_distribution_domain_name   = dependency.cloudfront.outputs.app_distribution_domain_name
  media_distribution_domain_name = dependency.cloudfront.outputs.media_distribution_domain_name
}
