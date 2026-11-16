import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';

export type StorageConfig = {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
};

export function createStorage(config: StorageConfig) {
  const client = new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
    forcePathStyle: config.forcePathStyle,
    maxAttempts: 2,
  });

  return {
    async checkReady(): Promise<void> {
      await client.send(new HeadBucketCommand({ Bucket: config.bucket }), {
        abortSignal: AbortSignal.timeout(5_000),
      });
    },
    async putObject(input: {
      key: string;
      body: Uint8Array;
      contentType: string;
    }): Promise<{ etag: string | null }> {
      const result = await client.send(
        new PutObjectCommand({
          Bucket: config.bucket,
          Key: input.key,
          Body: input.body,
          ContentType: input.contentType,
        }),
        { abortSignal: AbortSignal.timeout(30_000) },
      );
      return { etag: result.ETag ?? null };
    },
    async getObject(key: string): Promise<{
      body: Uint8Array;
      contentType: string | null;
      etag: string | null;
    }> {
      const result = await client.send(
        new GetObjectCommand({ Bucket: config.bucket, Key: key }),
        { abortSignal: AbortSignal.timeout(30_000) },
      );
      if (!result.Body) throw new Error('对象存储未返回文件内容。');
      return {
        body: await result.Body.transformToByteArray(),
        contentType: result.ContentType ?? null,
        etag: result.ETag ?? null,
      };
    },
    async deleteObject(key: string): Promise<void> {
      await client.send(
        new DeleteObjectCommand({ Bucket: config.bucket, Key: key }),
        { abortSignal: AbortSignal.timeout(30_000) },
      );
    },
    close(): void {
      client.destroy();
    },
  };
}

export type Storage = ReturnType<typeof createStorage>;
