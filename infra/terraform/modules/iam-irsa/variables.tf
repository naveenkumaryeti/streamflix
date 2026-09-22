variable "project" {
	type    = string
	default = "streamflix"
}
variable "environment"          { type = string }
variable "namespace" {
	type    = string
	default = "streamflix"
}
variable "oidc_provider_arn"    { type = string }
variable "oidc_provider_url"    { type = string }
variable "media_bucket_arns"    { type = list(string) }
variable "dynamodb_table_arn"   { type = string }
variable "mediaconvert_role_arn"{ type = string }
variable "secret_arns" {
	type    = list(string)
	default = []
}