variable "project"            { type = string  default = "streamflix" }
variable "environment"        { type = string }
variable "vpc_cidr"           { type = string  default = "10.0.0.0/16" }
variable "az_count"           { type = number  default = 3 }
variable "single_nat_gateway" { type = bool    default = true }
