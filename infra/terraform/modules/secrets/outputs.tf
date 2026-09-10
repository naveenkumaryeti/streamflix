output "jwt_secret_arn"               { value = aws_secretsmanager_secret.jwt.arn }
output "cloudfront_signing_secret_arn"{ value = try(aws_secretsmanager_secret.cloudfront_signing_key[0].arn, "") }
output "seed_credentials_secret_arn"  { value = aws_secretsmanager_secret.seed_credentials.arn }
