# ECR module — Phase 9 (CI/CD). One repository per deployable image: api, worker, web.
# Vulnerability scan on push (feeds the "Security Scan" stage in the doc's CI pipeline),
# and a lifecycle policy so old CI builds don't accumulate forever.

terraform {
  required_version = ">= 1.7.0"
  required_providers {
    aws = { source = "hashicorp/aws", version = ">= 5.40" }
  }
}

locals {
  name  = "${var.project}-${var.environment}"
  repos = toset(["api", "worker", "web"])
}

resource "aws_ecr_repository" "this" {
  for_each             = local.repos
  name                 = "${local.name}/${each.key}"
  image_tag_mutability = "IMMUTABLE"
  image_scanning_configuration { scan_on_push = true }
  encryption_configuration { encryption_type = "KMS" }
}

resource "aws_ecr_lifecycle_policy" "this" {
  for_each   = local.repos
  repository = aws_ecr_repository.this[each.key].name
  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "Keep last ${var.keep_last_n_images} images"
      selection = {
        tagStatus   = "any"
        countType   = "imageCountMoreThan"
        countNumber = var.keep_last_n_images
      }
      action = { type = "expire" }
    }]
  })
}
