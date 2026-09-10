variable "project"                              { type = string default = "streamflix" }
variable "environment"                          { type = string }
variable "price_class"                          { type = string default = "PriceClass_100" }
variable "app_domain"                           { type = string default = "" }
variable "media_domain"                         { type = string default = "" }
variable "acm_certificate_arn"                  { type = string default = "" }
variable "waf_web_acl_arn"                       { type = string default = "" }
variable "frontend_bucket_regional_domain_name"  { type = string }
variable "processed_bucket_regional_domain_name" { type = string }
variable "logs_bucket_domain_name"               { type = string }
variable "alb_dns_name"                          { type = string default = "" }
variable "cloudfront_signing_public_key_pem"     { type = string default = "" }
variable "cloudfront_key_group_id"               { type = string default = "" }
