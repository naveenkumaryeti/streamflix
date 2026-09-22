variable "project" {
	type    = string
	default = "streamflix"
}
variable "environment"               { type = string }
variable "cloudfront_private_key_pem" {
	type      = string
	default   = ""
	sensitive = true
}
