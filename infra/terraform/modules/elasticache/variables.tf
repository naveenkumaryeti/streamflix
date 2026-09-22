variable "project" {
	type    = string
	default = "streamflix"
}
variable "environment"        { type = string }
variable "private_subnet_ids" { type = list(string) }
variable "security_group_id"  { type = string }
variable "node_type" {
	type    = string
	default = "cache.t4g.micro"
}
