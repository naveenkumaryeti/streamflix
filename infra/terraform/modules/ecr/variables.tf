variable "project" {
	type    = string
	default = "streamflix"
}
variable "environment"        { type = string }
variable "keep_last_n_images" {
	type    = number
	default = 20
}
