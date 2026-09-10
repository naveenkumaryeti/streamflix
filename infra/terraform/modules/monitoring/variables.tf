variable "project"                       { type = string default = "streamflix" }
variable "environment"                   { type = string }
variable "aws_region"                    { type = string }
variable "rds_instance_id"               { type = string }
variable "rds_max_connections_threshold"{ type = number default = 80 }
variable "redis_replication_group_id"    { type = string }
variable "eks_cluster_name"              { type = string }
variable "cloudfront_distribution_id"    { type = string }
