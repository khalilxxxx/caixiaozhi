import { z } from 'zod';
import {
  BusinessObjectFieldsSchema,
  ResourceRefSchema,
  VersionSchema,
} from './common.js';
export const FileProfileSchema = z.enum(['invoice-v1', 'policy-text-v1']);
export const FileRegisterSchema = z
  .strictObject({
    filename: z
      .string()
      .min(1)
      .max(120)
      .refine((s) => !/[\\/\u0000-\u001f]/u.test(s)),
    mime_type: z.enum([
      'application/pdf',
      'image/png',
      'image/jpeg',
      'text/plain',
      'text/markdown',
    ]),
    size_bytes: z.number().int().positive().max(20_971_520),
    profile: FileProfileSchema,
    parent_ref: ResourceRefSchema.nullable().optional(),
  })
  .superRefine((v, ctx) => {
    const allowed =
      v.profile === 'invoice-v1'
        ? ['application/pdf', 'image/png', 'image/jpeg']
        : ['text/plain', 'text/markdown'];
    if (!allowed.includes(v.mime_type))
      ctx.addIssue({
        code: 'custom',
        path: ['mime_type'],
        message: '文件格式不符合上传用途',
      });
    if (v.profile === 'policy-text-v1' && v.size_bytes > 10_485_760)
      ctx.addIssue({
        code: 'custom',
        path: ['size_bytes'],
        message: '制度文本不得超过10MiB',
      });
  });
export const FileFinalizeSchema = z.strictObject({
  expected_version: VersionSchema,
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});
export const FileViewSchema = BusinessObjectFieldsSchema.extend({
  owner_id: z.string().min(1),
  filename: z.string(),
  mime_type: z.string(),
  size_bytes: z.number().int().positive().nullable(),
  sha256: z.string().nullable(),
  status: z.enum(['registered', 'uploaded', 'validated', 'rejected']),
  profile: FileProfileSchema,
  parent_ref: ResourceRefSchema.nullable(),
});
export type FileRegistration = z.infer<typeof FileRegisterSchema>;
export type FileFinalize = z.infer<typeof FileFinalizeSchema>;
export type FileView = z.infer<typeof FileViewSchema>;
