locals {
  env = read_terragrunt_config(find_in_parent_folders("env.hcl"))
}

terraform {
  source = "${get_repo_root()}/infra/terraform/modules/monitoring"
}

dependency "rds" {
  config_path = "${get_repo_root()}/infra/terragrunt/live/${local.env.locals.environment}/rds"
  mock_outputs = { instance_arn = "arn:aws:rds:ap-south-1:000000000000:db:mock" }
  mock_outputs_allowed_terraform_commands = ["validate", "plan", "init"]
}
dependency "elasticache" {
  config_path = "${get_repo_root()}/infra/terragrunt/live/${local.env.locals.environment}/elasticache"
  mock_outputs = { primary_endpoint = "mock.cache.amazonaws.com" }
  mock_outputs_allowed_terraform_commands = ["validate", "plan", "init"]
}
dependency "eks" {
  config_path = "${get_repo_root()}/infra/terragrunt/live/${local.env.locals.environment}/eks"
  mock_outputs = { cluster_name = "mock-cluster" }
  mock_outputs_allowed_terraform_commands = ["validate", "plan", "init"]
}
dependency "cloudfront" {
  config_path = "${get_repo_root()}/infra/terragrunt/live/${local.env.locals.environment}/cloudfront"
  mock_outputs = { app_distribution_id = "MOCKID" }
  mock_outputs_allowed_terraform_commands = ["validate", "plan", "init"]
}

inputs = {
  environment                 = local.env.locals.environment
  aws_region                  = local.env.locals.aws_region
  rds_instance_id             = "streamflix-${local.env.locals.environment}-postgres"
  redis_replication_group_id  = "streamflix-${local.env.locals.environment}-redis"
  eks_cluster_name            = dependency.eks.outputs.cluster_name
  cloudfront_distribution_id  = dependency.cloudfront.outputs.app_distribution_id
}
