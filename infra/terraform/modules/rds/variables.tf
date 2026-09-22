variable "project" {
	type    = string
	default = "streamflix"
}
variable "environment"             { type = string }
variable "private_subnet_ids"      { type = list(string) }
variable "security_group_id"       { type = string }
variable "instance_class" {
	type    = string
	default = "db.t4g.micro"
}
variable "allocated_storage_gb" {
	type    = number
	default = 20
}
variable "max_allocated_storage_gb" {
	type    = number
	default = 100
}
variable "multi_az" {
	type    = bool
	default = false
}
variable "deletion_protection" {
	type    = bool
	default = false
}
variable "backup_retention_days" {
	type    = number
	default = 7
}
