locals {
  env = read_terragrunt_config(find_in_parent_folders("env.hcl"))
}

terraform {
  source = "${get_repo_root()}/infra/terraform/modules/eks"
}

dependency "vpc" {
  config_path = "../vpc"
  mock_outputs = {
    private_subnet_ids = ["subnet-mock1", "subnet-mock2"]
    public_subnet_ids  = ["subnet-mock3", "subnet-mock4"]
  }
  mock_outputs_allowed_terraform_commands = ["validate", "plan", "init"]
}

dependency "iam" {
  config_path = "../iam-cluster"
  mock_outputs = { eks_cluster_role_arn = "arn:aws:iam::000000000000:role/mock", eks_nodes_role_arn = "arn:aws:iam::000000000000:role/mock" }
  mock_outputs_allowed_terraform_commands = ["validate", "plan", "init"]
}

inputs = {
  environment          = local.env.locals.environment
  cluster_role_arn     = dependency.iam.outputs.eks_cluster_role_arn
  node_role_arn        = dependency.iam.outputs.eks_nodes_role_arn
  private_subnet_ids   = dependency.vpc.outputs.private_subnet_ids
  public_subnet_ids    = dependency.vpc.outputs.public_subnet_ids
  node_instance_types  = local.env.locals.eks_node_types
  capacity_type        = local.env.locals.eks_capacity_type
  desired_size         = local.env.locals.eks_desired_size
  min_size             = local.env.locals.eks_min_size
  max_size             = local.env.locals.eks_max_size
}
