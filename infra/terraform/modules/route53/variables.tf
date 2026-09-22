variable "domain_name"                   { type = string }
variable "create_zone" {
	type    = bool
	default = false
}
variable "app_domain" {
	type    = string
	default = ""
}
variable "media_domain" {
	type    = string
	default = ""
}
variable "app_distribution_domain_name" {
	type    = string
	default = ""
}
variable "media_distribution_domain_name" {
	type    = string
	default = ""
}
variable "cloudfront_hosted_zone_id" {
	type    = string
	default = "Z2FDTNDATAQYW2"
}
