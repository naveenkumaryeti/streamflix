locals {
  environment         = "stage"
  aws_region          = "ap-south-1"
  vpc_cidr            = "10.1.0.0/16"
  single_nat_gateway  = true
  eks_node_types      = ["t3.medium"]
  eks_desired_size    = 2
  eks_min_size        = 2
  eks_max_size        = 6
  eks_capacity_type   = "ON_DEMAND"
  rds_instance_class  = "db.t4g.small"
  rds_multi_az        = false
  redis_node_type     = "cache.t4g.small"
  domain_name         = "streamflix.com"
  app_domain          = "stage.streamflix.com"
  media_domain        = "media-stage.streamflix.com"
  create_dns_zone     = false
  deletion_protection = false
}
