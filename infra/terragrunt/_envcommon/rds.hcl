locals {
  env = read_terragrunt_config(find_in_parent_folders("env.hcl"))
}

terraform {
  source = "${get_repo_root()}/infra/terraform/modules/rds"
}

dependency "vpc" {
  config_path = "../vpc"
  mock_outputs = { private_subnet_ids = ["subnet-mock1", "subnet-mock2"], data_tier_sg_id = "sg-mock" }
  mock_outputs_allowed_terraform_commands = ["validate", "plan", "init"]
}

inputs = {
  environment          = local.env.locals.environment
  private_subnet_ids   = dependency.vpc.outputs.private_subnet_ids
  security_group_id    = dependency.vpc.outputs.data_tier_sg_id
  instance_class       = local.env.locals.rds_instance_class
  multi_az             = local.env.locals.rds_multi_az
  deletion_protection  = local.env.locals.deletion_protection
}
