output "bucket_names" { value = { for k, b in aws_s3_bucket.this : k => b.bucket } }
output "bucket_arns"  { value = { for k, b in aws_s3_bucket.this : k => b.arn } }
output "bucket_regional_domain_names" {
  value = { for k, b in aws_s3_bucket.this : k => b.bucket_regional_domain_name }
}
