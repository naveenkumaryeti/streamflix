output "app_distribution_domain_name"   { value = aws_cloudfront_distribution.app.domain_name }
output "app_distribution_id"            { value = aws_cloudfront_distribution.app.id }
output "app_distribution_arn"           { value = aws_cloudfront_distribution.app.arn }
output "media_distribution_domain_name" { value = aws_cloudfront_distribution.media.domain_name }
output "media_distribution_arn"         { value = aws_cloudfront_distribution.media.arn }
output "signing_key_group_id"           { value = try(aws_cloudfront_key_group.signing[0].id, "") }
