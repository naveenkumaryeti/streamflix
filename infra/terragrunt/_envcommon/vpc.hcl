locals {
  env = read_terragrunt_config(find_in_parent_folders("env.hcl"))
}

terraform {
  source = "${get_repo_root()}/infra/terraform/modules/vpc"
}

inputs = {
  environment        = local.env.locals.environment
  vpc_cidr           = local.env.locals.vpc_cidr
  single_nat_gateway = local.env.locals.single_nat_gateway
}
