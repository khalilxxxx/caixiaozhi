#!/bin/sh
set -eu

endpoint=http://object-store:9000
attempt=0
until aws --endpoint-url "$endpoint" s3api list-buckets >/dev/null 2>&1; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 60 ]; then
    printf '%s\n' '私有对象存储启动超时。' >&2
    exit 1
  fi
  sleep 2
done

if ! aws --endpoint-url "$endpoint" s3api head-bucket --bucket "$S3_BUCKET" >/dev/null 2>&1; then
  aws --endpoint-url "$endpoint" s3api create-bucket --bucket "$S3_BUCKET" >/dev/null
fi

# 开发桶使用默认私有权限，每次启动移除可能遗留的公开 bucket policy。
aws --endpoint-url "$endpoint" s3api delete-bucket-policy --bucket "$S3_BUCKET"
probe_key=_infra/private-bucket-probe
printf '%s\n' 'private-bucket-probe' > /tmp/private-bucket-probe
aws --endpoint-url "$endpoint" s3api put-object --bucket "$S3_BUCKET" --key "$probe_key" --body /tmp/private-bucket-probe >/dev/null
aws --endpoint-url "$endpoint" s3api head-object --bucket "$S3_BUCKET" --key "$probe_key" >/dev/null
if aws --endpoint-url "$endpoint" --no-sign-request s3api get-object --bucket "$S3_BUCKET" --key "$probe_key" /tmp/anonymous-probe >/dev/null 2>/tmp/anonymous-error; then
  printf '%s\n' '对象存储拒绝初始化，匿名请求读取到了私有对象。' >&2
  exit 1
fi
if ! grep -Eq 'AccessDenied|Forbidden|403' /tmp/anonymous-error; then
  printf '%s\n' '匿名读取验证未得到明确的拒绝响应。' >&2
  exit 1
fi
aws --endpoint-url "$endpoint" s3api delete-object --bucket "$S3_BUCKET" --key "$probe_key" >/dev/null
printf '%s\n' '私有桶已初始化，匿名读取已确认被拒绝。'
