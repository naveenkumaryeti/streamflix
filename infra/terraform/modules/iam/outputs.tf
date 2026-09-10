output "eks_cluster_role_arn" { value = aws_iam_role.eks_cluster.arn }
output "eks_nodes_role_arn"   { value = aws_iam_role.eks_nodes.arn }
output "api_irsa_role_arn"    { value = try(aws_iam_role.app["api"].arn, null) }
output "worker_irsa_role_arn" { value = try(aws_iam_role.app["worker"].arn, null) }
output "mediaconvert_role_arn"{ value = aws_iam_role.mediaconvert.arn }
output "github_actions_role_arn" { value = try(aws_iam_role.github_actions[0].arn, "") }
