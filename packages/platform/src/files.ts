import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { DatabaseExecutor } from './database.js';
import { uploadedFiles } from './schema.js';

const fileRegistrationSchema = z
  .object({
    id: z.string().min(1).optional(),
    tenantId: z.string().min(1),
    ownerId: z.string().min(1),
    objectKey: z.string().min(1),
    originalFilename: z
      .string()
      .min(1)
      .max(120)
      .refine((value) => !/[\\/\u0000-\u001f]/u.test(value)),
    mimeType: z.string().min(1),
    expectedSizeBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    uploadExpiresAt: z.date(),
  })
  .strict();

export type RegisterFileInput = z.input<typeof fileRegistrationSchema>;
export type UploadedFile = typeof uploadedFiles.$inferSelect;

export async function registerFile(
  database: DatabaseExecutor,
  input: RegisterFileInput,
): Promise<UploadedFile> {
  const parsed = fileRegistrationSchema.parse(input);
  const [file] = await database
    .insert(uploadedFiles)
    .values({ ...parsed, id: parsed.id ?? randomUUID() })
    .returning();
  if (!file) throw new Error('文件登记未返回记录。');
  return file;
}

export async function findFile(
  database: DatabaseExecutor,
  input: { tenantId: string; id: string },
): Promise<UploadedFile | null> {
  const [file] = await database
    .select()
    .from(uploadedFiles)
    .where(
      and(
        eq(uploadedFiles.tenantId, input.tenantId),
        eq(uploadedFiles.id, input.id),
      ),
    )
    .limit(1);
  return file ?? null;
}

const transitionSchema = z.discriminatedUnion('status', [
  z
    .object({
      tenantId: z.string().min(1),
      id: z.string().min(1),
      expectedVersion: z.number().int().positive(),
      status: z.literal('uploaded'),
      sha256: z.string().regex(/^[a-f0-9]{64}$/u),
      sizeBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
      mimeType: z.string().min(1),
    })
    .strict(),
  z
    .object({
      tenantId: z.string().min(1),
      id: z.string().min(1),
      expectedVersion: z.number().int().positive(),
      status: z.literal('validated'),
    })
    .strict(),
  z
    .object({
      tenantId: z.string().min(1),
      id: z.string().min(1),
      expectedVersion: z.number().int().positive(),
      status: z.literal('rejected'),
      rejectionReason: z.string().min(1),
    })
    .strict(),
]);

/** 仅提交领域已核验的元数据。实际字节、MIME 与内容校验由文件领域服务完成。 */
export async function transitionFile(
  database: DatabaseExecutor,
  input: z.input<typeof transitionSchema>,
): Promise<UploadedFile> {
  const parsed = transitionSchema.parse(input);
  const previousStatus =
    parsed.status === 'uploaded' ? 'registered' : 'uploaded';
  const updates =
    parsed.status === 'uploaded'
      ? {
          sha256: parsed.sha256,
          sizeBytes: parsed.sizeBytes,
          mimeType: parsed.mimeType,
        }
      : {};
  const [file] = await database
    .update(uploadedFiles)
    .set({
      ...updates,
      status: parsed.status,
      rejectionReason:
        parsed.status === 'rejected' ? parsed.rejectionReason : null,
      version: sql`${uploadedFiles.version} + 1`,
      updatedAt: sql`clock_timestamp()`,
    })
    .where(
      and(
        eq(uploadedFiles.tenantId, parsed.tenantId),
        eq(uploadedFiles.id, parsed.id),
        eq(uploadedFiles.version, parsed.expectedVersion),
        eq(uploadedFiles.status, previousStatus),
      ),
    )
    .returning();
  if (!file) throw new Error('文件版本或状态不匹配。');
  return file;
}
