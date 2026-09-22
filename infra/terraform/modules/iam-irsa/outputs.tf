output "api_irsa_role_arn"    { value = aws_iam_role.app["api"].arn }
output "worker_irsa_role_arn" { value = aws_iam_role.app["worker"].arn }