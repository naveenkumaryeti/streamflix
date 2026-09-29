locals {
  env = read_terragrunt_config(find_in_parent_folders("env.hcl"))
}

terraform {
  source = "${get_repo_root()}/infra/terraform/modules/security-group-rules"
}

dependency "vpc" {
  config_path = "../vpc"

  mock_outputs_allowed_terraform_commands = ["validate", "plan"]

  mock_outputs = {
    data_tier_sg_id = "sg-00000000000000000"
    eks_nodes_sg_id = "sg-00000000000000000"
  }
}

dependency "eks" {
  config_path = "../eks"

  mock_outputs_allowed_terraform_commands = ["validate", "plan"]

  mock_outputs = {
    cluster_name = "streamflix-dev-eks"
  }
}

inputs = {
  data_tier_sg_id = dependency.vpc.outputs.data_tier_sg_id
  eks_nodes_sg_id = dependency.vpc.outputs.eks_nodes_sg_id
  cluster_name    = dependency.eks.outputs.cluster_name
}