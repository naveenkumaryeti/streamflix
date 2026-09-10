locals {
  env = read_terragrunt_config(find_in_parent_folders("env.hcl"))
}

terraform {
  source = "${get_repo_root()}/infra/terraform/modules/cloudfront"
}

dependency "s3" {
  config_path = "../s3"
  mock_outputs = {
    bucket_regional_domain_names = { frontend = "mock.s3.amazonaws.com", processed = "mock.s3.amazonaws.com" }
    bucket_names                 = { logs = "mock-logs" }
  }
  mock_outputs_allowed_terraform_commands = ["validate", "plan", "init"]
}

dependency "waf" {
  config_path = "../waf"
  mock_outputs = { web_acl_arn = "" }
  mock_outputs_allowed_terraform_commands = ["validate", "plan", "init"]
}

inputs = {
  environment                            = local.env.locals.environment
  app_domain                             = local.env.locals.app_domain
  media_domain                           = local.env.locals.media_domain
  waf_web_acl_arn                        = dependency.waf.outputs.web_acl_arn
  frontend_bucket_regional_domain_name   = dependency.s3.outputs.bucket_regional_domain_names.frontend
  processed_bucket_regional_domain_name  = dependency.s3.outputs.bucket_regional_domain_names.processed
  logs_bucket_domain_name                = "${dependency.s3.outputs.bucket_names.logs}.s3.amazonaws.com"
}
