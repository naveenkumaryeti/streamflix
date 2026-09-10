variable "project"             { type = string default = "streamflix" }
variable "environment"         { type = string }
variable "cluster_role_arn"    { type = string }
variable "node_role_arn"       { type = string }
variable "private_subnet_ids"  { type = list(string) }
variable "public_subnet_ids"   { type = list(string) }
variable "kubernetes_version"  { type = string default = "1.30" }
variable "node_instance_types" { type = list(string) default = ["t3.medium"] }
variable "capacity_type"       { type = string default = "ON_DEMAND" }
variable "desired_size"        { type = number default = 2 }
variable "min_size"            { type = number default = 2 }
variable "max_size"            { type = number default = 6 }
variable "public_access_cidrs" { type = list(string) default = ["0.0.0.0/0"] }
variable "log_retention_days"  { type = number default = 30 }
