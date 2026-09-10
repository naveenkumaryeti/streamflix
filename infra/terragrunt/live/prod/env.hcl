locals {
  environment         = "prod"
  aws_region          = "ap-south-1"
  vpc_cidr            = "10.2.0.0/16"
  single_nat_gateway  = false
  eks_node_types      = ["m6i.large"]
  eks_desired_size    = 3
  eks_min_size        = 3
  eks_max_size         = 20
  eks_capacity_type   = "ON_DEMAND"
  rds_instance_class  = "db.r6g.large"
  rds_multi_az        = true
  redis_node_type     = "cache.r6g.large"
  domain_name         = "streamflix.com"
  app_domain          = "streamflix.com"
  media_domain        = "media.streamflix.com"
  create_dns_zone     = true
  deletion_protection = true
}
