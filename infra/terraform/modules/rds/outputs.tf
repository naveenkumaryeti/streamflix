output "endpoint"        { value = aws_db_instance.this.address }
output "port"            { value = aws_db_instance.this.port }
output "db_name"         { value = aws_db_instance.this.db_name }
output "secret_arn"      { value = aws_secretsmanager_secret.db.arn }
output "instance_arn"    { value = aws_db_instance.this.arn }
