variable "project"                     { type = string default = "streamflix" }
variable "environment"                 { type = string }
variable "raw_video_retention_days"    { type = number default = 90 }
variable "log_retention_days"          { type = number default = 180 }
# Left empty on first apply (chicken/egg with cloudfront module); re-apply once CloudFront
# exists to lock the bucket policies down to that distribution.
variable "cloudfront_distribution_arn" { type = string default = "" }
