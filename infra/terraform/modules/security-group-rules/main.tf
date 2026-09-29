terraform {
  required_version = ">= 1.7.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 5.40"
    }
  }
}

data "aws_eks_cluster" "this" {
  name = var.cluster_name
}

resource "aws_vpc_security_group_ingress_rule" "postgres_eks_nodes" {
  security_group_id            = var.data_tier_sg_id
  referenced_security_group_id = var.eks_nodes_sg_id

  ip_protocol = "tcp"
  from_port   = 5432
  to_port     = 5432
}

resource "aws_vpc_security_group_ingress_rule" "redis_eks_nodes" {
  security_group_id            = var.data_tier_sg_id
  referenced_security_group_id = var.eks_nodes_sg_id

  ip_protocol = "tcp"
  from_port   = 6379
  to_port     = 6379
}

resource "aws_vpc_security_group_ingress_rule" "postgres_eks_cluster" {
  security_group_id = var.data_tier_sg_id

  referenced_security_group_id = (
    data.aws_eks_cluster.this.vpc_config[0].cluster_security_group_id
  )

  ip_protocol = "tcp"
  from_port   = 5432
  to_port     = 5432
}

resource "aws_vpc_security_group_ingress_rule" "redis_eks_cluster" {
  security_group_id = var.data_tier_sg_id

  referenced_security_group_id = (
    data.aws_eks_cluster.this.vpc_config[0].cluster_security_group_id
  )

  ip_protocol = "tcp"
  from_port   = 6379
  to_port     = 6379
}