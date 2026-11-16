import { bigint, integer, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

export const uploadedFiles = pgTable('uploaded_files', {
  id: text('id').primaryKey(),
  tenantId: text('tenant_id').notNull(),
  ownerId: text('owner_id').notNull(),
  version: integer('version').notNull().default(1),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  status: text('status', {
    enum: ['registered', 'uploaded', 'validated', 'rejected'],
  })
    .notNull()
    .default('registered'),
  objectKey: text('object_key').notNull().unique(),
  originalFilename: text('original_filename').notNull(),
  mimeType: text('mime_type').notNull(),
  expectedSizeBytes: bigint('expected_size_bytes', {
    mode: 'number',
  }).notNull(),
  sizeBytes: bigint('size_bytes', { mode: 'number' }),
  sha256: text('sha256'),
  uploadExpiresAt: timestamp('upload_expires_at', {
    withTimezone: true,
  }).notNull(),
  rejectionReason: text('rejection_reason'),
});
