locals {
  environment         = "dev"
  aws_region          = "ap-south-1"
  vpc_cidr            = "10.0.0.0/16"
  single_nat_gateway  = true
  eks_node_types      = ["t3.medium"]
  eks_desired_size    = 2
  eks_min_size        = 1
  eks_max_size        = 4
  eks_capacity_type   = "SPOT"
  rds_instance_class  = "db.t4g.micro"
  rds_multi_az        = false
  redis_node_type     = "cache.t4g.micro"
  domain_name         = "streamflix-dev.local"
  app_domain          = ""
  media_domain        = ""
  create_dns_zone     = false
  deletion_protection = false
}
