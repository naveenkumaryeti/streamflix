variable "project" {
	type    = string
	default = "streamflix"
}
variable "environment"       { type = string }
variable "namespace" {
	type    = string
	default = "streamflix"
}
// EKS's OIDC provider doesn't exist until the eks module has applied, and eks needs this
// module's cluster/node role ARNs first — a genuine cycle. Defaults let `iam` apply standalone
// on the first pass (skipping IRSA role creation); re-apply `iam` once `eks` exists to wire
// the two together. See terragrunt/_envcommon/iam.hcl for the dependency + mock_outputs.
variable "oidc_provider_arn" {
	type    = string
	default = ""
}
variable "oidc_provider_url" {
	type    = string
	default = ""
} # without the https:// scheme
variable "media_bucket_arns" { type = list(string) }
variable "dynamodb_table_arn"{ type = string }
variable "secret_arns" {
	type    = list(string)
	default = []
}
variable "enable_github_oidc" {
	type    = bool
	default = false
}
variable "github_repo" {
	type    = string
	default = "naveenkumaryeti/streamflix"
}
