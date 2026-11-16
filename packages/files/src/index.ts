import {
  createHash,
  createHmac,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import { extname } from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { PNG } from 'pngjs';
import jpeg from 'jpeg-js';
import { sql } from 'drizzle-orm';
import type { ActorContext, ResourceRef } from '@caixiaozhi/contracts/common';
import {
  FileRegisterSchema,
  FileFinalizeSchema,
  FileViewSchema,
  type FileRegistration,
  type FileFinalize,
  type FileView,
} from '@caixiaozhi/contracts/files';
import type {
  DatabaseConnection,
  DatabaseExecutor,
} from '@caixiaozhi/platform/database';
import type { Storage } from '@caixiaozhi/platform/storage';
import { AppError } from '@caixiaozhi/platform/errors';
import { canonicalHash } from '@caixiaozhi/platform/hash';
import type { IdentityService } from '@caixiaozhi/identity';

type FileRow = {
  id: string;
  tenant_id: string;
  owner_id: string;
  version: number;
  status: FileView['status'];
  object_key: string;
  original_filename: string;
  mime_type: string;
  expected_size_bytes: string;
  size_bytes: string | null;
  sha256: string | null;
  upload_expires_at: Date;
  created_at: Date;
  updated_at: Date;
  profile: FileView['profile'];
  parent_ref: ResourceRef | null;
  upload_token_hash: string;
};
const sha256 = (bytes: Uint8Array | string) =>
  createHash('sha256').update(bytes).digest('hex');
const notFound = () => new AppError('NOT_FOUND', '请求的文件不存在。');
export const FILE_PROFILES = {
  'invoice-v1': {
    max_bytes: 20_971_520,
    mime_types: ['application/pdf', 'image/png', 'image/jpeg'],
    upload_ttl_seconds: 600,
  },
  'policy-text-v1': {
    max_bytes: 10_485_760,
    mime_types: ['text/plain', 'text/markdown'],
    upload_ttl_seconds: 600,
  },
} as const;
export type FileParentAccess = { write: boolean };
export type FileParentAuthorizer = (
  ctx: ActorContext,
  ref: ResourceRef,
  access?: FileParentAccess,
) => Promise<void>;
export class FileService {
  private parentAuthorizers = new Map<string, FileParentAuthorizer>();
  constructor(
    readonly database: DatabaseConnection,
    readonly storage: Storage,
    readonly options: { identity: IdentityService },
  ) {}
  registerParentAuthorizer(type: string, authorize: FileParentAuthorizer) {
    this.parentAuthorizers.set(type, authorize);
  }
  private token(id: string, tenantId: string, ownerId: string) {
    return createHmac('sha256', this.options.identity.options.sessionSecret)
      .update(`file-upload-v1:${tenantId}:${ownerId}:${id}`)
      .digest('base64url');
  }
  private async row(
    ctx: ActorContext,
    id: string,
    tx: DatabaseExecutor = this.database.db,
  ): Promise<FileRow> {
    const result = await tx.execute(
      sql`SELECT f.*,s.profile,s.parent_ref,s.upload_token_hash FROM uploaded_files f JOIN file_security s ON s.tenant_id=f.tenant_id AND s.file_id=f.id WHERE f.tenant_id=${ctx.tenant_id} AND f.id=${id}`,
    );
    const row = result.rows[0] as FileRow | undefined;
    if (!row) throw notFound();
    return {
      ...row,
      created_at: new Date(row.created_at),
      updated_at: new Date(row.updated_at),
      upload_expires_at: new Date(row.upload_expires_at),
    };
  }
  private view(row: FileRow): FileView {
    return FileViewSchema.parse({
      id: row.id,
      tenant_id: row.tenant_id,
      owner_id: row.owner_id,
      version: row.version,
      created_at: row.created_at.toISOString(),
      updated_at: row.updated_at.toISOString(),
      filename: row.original_filename,
      mime_type: row.mime_type,
      size_bytes: row.size_bytes === null ? null : Number(row.size_bytes),
      sha256: row.sha256,
      status: row.status,
      profile: row.profile,
      parent_ref: row.parent_ref,
    });
  }
  private async authorize(ctx: ActorContext, row: FileRow, write = false) {
    const current = await this.options.identity.requireCurrentActor(ctx);
    if (row.tenant_id !== current.tenant_id) throw notFound();
    if (
      write &&
      (row.owner_id !== current.user_id ||
        current.invocation_origin !== 'interactive')
    )
      throw notFound();
    if (row.parent_ref) {
      const authorizer = this.parentAuthorizers.get(row.parent_ref.type);
      if (authorizer) await authorizer(current, row.parent_ref, { write });
      else
        await this.options.identity.assertResourceAccess(
          current,
          write ? 'write' : 'read',
          row.parent_ref,
        );
    } else if (row.owner_id !== current.user_id) throw notFound();
    if (write)
      await this.options.identity.assertPermission(
        current,
        row.profile === 'invoice-v1' ? 'expense.write.own' : 'knowledge.manage',
      );
    return current;
  }
  async registerUpload(
    ctx: ActorContext,
    input: FileRegistration,
    key: string,
  ) {
    const current = await this.options.identity.requireCurrentActor(ctx);
    const parsed = FileRegisterSchema.parse(input);
    if (current.invocation_origin !== 'interactive')
      throw new AppError('FORBIDDEN', '后台任务不能注册文件上传。');
    await this.options.identity.assertPermission(
      current,
      parsed.profile === 'invoice-v1'
        ? 'expense.write.own'
        : 'knowledge.manage',
    );
    if (parsed.parent_ref) {
      const authorizer = this.parentAuthorizers.get(parsed.parent_ref.type);
      if (authorizer)
        await authorizer(current, parsed.parent_ref, { write: true });
      else
        await this.options.identity.assertResourceAccess(
          current,
          'write',
          parsed.parent_ref,
        );
    }
    if (!key) throw new AppError('VALIDATION_ERROR', '文件登记需要请求编号。');
    const payloadHash = canonicalHash(parsed);
    const fileId = await this.database.db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${`${current.tenant_id}:${current.user_id}:file.register:${key}`}))`,
      );
      const previous = await tx.execute(
        sql`SELECT payload_hash,result FROM file_command_ledger WHERE tenant_id=${current.tenant_id} AND actor_id=${current.user_id} AND operation='register' AND idempotency_key=${key}`,
      );
      const found = previous.rows[0] as
        { payload_hash: string; result: { file_id: string } } | undefined;
      if (found) {
        if (found.payload_hash !== payloadHash)
          throw new AppError(
            'IDEMPOTENCY_CONFLICT',
            '上传请求编号已用于其他文件。',
          );
        return found.result.file_id;
      }
      const id = randomUUID(),
        objectKey = `temporary/${encodeURIComponent(current.tenant_id)}/${id}`;
      const expires = new Date(Date.now() + 600_000);
      const token = this.token(id, current.tenant_id, current.user_id);
      await tx.execute(
        sql`INSERT INTO uploaded_files(id,tenant_id,owner_id,object_key,original_filename,mime_type,expected_size_bytes,upload_expires_at) VALUES(${id},${current.tenant_id},${current.user_id},${objectKey},${parsed.filename},${parsed.mime_type},${parsed.size_bytes},${expires})`,
      );
      await tx.execute(
        sql`INSERT INTO file_security(tenant_id,file_id,profile,upload_token_hash,parent_ref) VALUES(${current.tenant_id},${id},${parsed.profile},${sha256(token)},${parsed.parent_ref ? JSON.stringify(parsed.parent_ref) : null}::jsonb)`,
      );
      await tx.execute(
        sql`INSERT INTO file_command_ledger(tenant_id,actor_id,operation,idempotency_key,payload_hash,result) VALUES(${current.tenant_id},${current.user_id},'register',${key},${payloadHash},${JSON.stringify({ file_id: id })}::jsonb)`,
      );
      return id;
    });
    const row = await this.row(current, fileId);
    return {
      file: this.view(row),
      upload_target: {
        url: `/api/v1/files/${fileId}/content`,
        method: 'PUT' as const,
        headers: {
          'x-upload-token': this.token(
            fileId,
            current.tenant_id,
            current.user_id,
          ),
          'x-expected-version': String(row.version),
          'content-type': 'application/octet-stream',
        },
      },
      expires_at: row.upload_expires_at.toISOString(),
    };
  }
  async upload(
    ctx: ActorContext,
    id: string,
    bytes: Uint8Array,
    input: { uploadToken: string; expectedVersion: number },
  ): Promise<FileView> {
    return this.database.db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT id FROM uploaded_files WHERE tenant_id=${ctx.tenant_id} AND id=${id} FOR UPDATE`,
      );
      const row = await this.row(ctx, id, tx);
      await this.authorize(ctx, row, true);
      const tokenHash = sha256(input.uploadToken);
      if (
        tokenHash.length !== row.upload_token_hash.length ||
        !timingSafeEqual(
          Buffer.from(tokenHash),
          Buffer.from(row.upload_token_hash),
        )
      )
        throw new AppError('FORBIDDEN', '上传凭据无效。');
      if (row.upload_expires_at.getTime() <= Date.now())
        throw new AppError('INVALID_STATE', '上传凭据已过期，请重新登记文件。');
      if (row.version !== input.expectedVersion || row.status !== 'registered')
        throw new AppError(
          'VERSION_CONFLICT',
          '文件状态已更新，请刷新后重试。',
        );
      if (
        bytes.byteLength !== Number(row.expected_size_bytes) ||
        bytes.byteLength > FILE_PROFILES[row.profile].max_bytes
      )
        throw new AppError(
          'VALIDATION_ERROR',
          '实际文件大小与登记信息不一致。',
        );
      await this.storage.putObject({
        key: row.object_key,
        body: bytes,
        contentType: row.mime_type,
      });
      const hash = sha256(bytes);
      const updated = await tx.execute(
        sql`UPDATE uploaded_files SET status='uploaded',sha256=${hash},size_bytes=${bytes.byteLength},version=version+1,updated_at=clock_timestamp() WHERE tenant_id=${ctx.tenant_id} AND id=${id} AND version=${input.expectedVersion} AND status='registered' RETURNING id`,
      );
      if (!updated.rows[0])
        throw new AppError(
          'VERSION_CONFLICT',
          '文件状态已更新，请刷新后重试。',
        );
      return this.view(await this.row(ctx, id, tx));
    });
  }
  private async validateContent(
    row: FileRow,
    bytes: Uint8Array,
  ): Promise<void> {
    const extension = extname(row.original_filename).toLowerCase();
    const buffer = Buffer.from(bytes);
    if (row.profile === 'policy-text-v1') {
      if (
        !['.txt', '.md'].includes(extension) ||
        row.mime_type !== (extension === '.md' ? 'text/markdown' : 'text/plain')
      )
        throw new AppError(
          'VALIDATION_ERROR',
          '制度导入仅支持UTF-8的txt或md文件。',
          { details: { reason: 'UNSUPPORTED_FORMAT' } },
        );
      let text: string;
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      } catch {
        throw new AppError('VALIDATION_ERROR', '文件不是有效UTF-8文本。', {
          details: { reason: 'INVALID_ENCODING' },
        });
      }
      if (
        !text.trim() ||
        text.includes('\0') ||
        Array.from(text).length > 2_000_000 ||
        /[\u0001-\u0008\u000b\u000c\u000e-\u001f]/u.test(text)
      )
        throw new AppError(
          'VALIDATION_ERROR',
          '文本为空、含二进制控制字符或超过字符上限。',
        );
      return;
    }
    try {
      if (row.mime_type === 'application/pdf') {
        if (
          extension !== '.pdf' ||
          buffer.subarray(0, 5).toString() !== '%PDF-' ||
          !buffer
            .subarray(Math.max(0, buffer.length - 1024))
            .includes(Buffer.from('%%EOF'))
        )
          throw new Error('signature');
        const pdf = await PDFDocument.load(bytes, {
          ignoreEncryption: false,
          throwOnInvalidObject: true,
        });
        if (
          pdf.isEncrypted ||
          pdf.getPageCount() < 1 ||
          pdf.getPageCount() > 50
        )
          throw new Error('pages');
      } else if (row.mime_type === 'image/png') {
        if (
          extension !== '.png' ||
          buffer.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a'
        )
          throw new Error('signature');
        const width = buffer.readUInt32BE(16),
          height = buffer.readUInt32BE(20);
        if (width * height > 30_000_000) throw new Error('dimensions');
        const image = PNG.sync.read(buffer, { checkCRC: true });
        if (!image.width || !image.height) throw new Error('dimensions');
      } else if (row.mime_type === 'image/jpeg') {
        if (
          !['.jpg', '.jpeg'].includes(extension) ||
          buffer[0] !== 0xff ||
          buffer[1] !== 0xd8 ||
          buffer.at(-2) !== 0xff ||
          buffer.at(-1) !== 0xd9
        )
          throw new Error('signature');
        const image = jpeg.decode(buffer, {
          maxResolutionInMP: 30,
          maxMemoryUsageInMB: 160,
          tolerantDecoding: false,
        });
        if (!image.width || !image.height) throw new Error('dimensions');
      } else throw new Error('format');
    } catch {
      throw new AppError(
        'VALIDATION_ERROR',
        '文件签名、格式或内容无效；不支持加密PDF，PDF最多50页。',
        { details: { reason: 'INVALID_FILE_CONTENT' } },
      );
    }
  }
  async finalizeUpload(
    ctx: ActorContext,
    id: string,
    input: FileFinalize,
    key: string,
  ): Promise<FileView> {
    const parsed = FileFinalizeSchema.parse(input);
    const initial = await this.row(ctx, id);
    await this.authorize(ctx, initial, true);
    if (!key)
      throw new AppError('VALIDATION_ERROR', '文件完成校验需要请求编号。');
    const payloadHash = canonicalHash({ id, ...parsed });
    const outcome = await this.database.db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${`${ctx.tenant_id}:${ctx.user_id}:file.finalize:${key}`}))`,
      );
      const previous = await tx.execute(
        sql`SELECT payload_hash,result FROM file_command_ledger WHERE tenant_id=${ctx.tenant_id} AND actor_id=${ctx.user_id} AND operation='finalize' AND idempotency_key=${key}`,
      );
      const prior = previous.rows[0] as
        { payload_hash: string; result: FileView } | undefined;
      if (prior) {
        if (prior.payload_hash !== payloadHash)
          throw new AppError(
            'IDEMPOTENCY_CONFLICT',
            '文件完成请求编号已被使用。',
          );
        return { file: FileViewSchema.parse(prior.result) };
      }
      await tx.execute(
        sql`SELECT id FROM uploaded_files WHERE tenant_id=${ctx.tenant_id} AND id=${id} FOR UPDATE`,
      );
      const row = await this.row(ctx, id, tx);
      await this.authorize(ctx, row, true);
      if (row.version !== parsed.expected_version || row.status !== 'uploaded')
        throw new AppError(
          'VERSION_CONFLICT',
          '文件状态已更新，请刷新后重试。',
        );
      if (row.upload_expires_at.getTime() <= Date.now())
        throw new AppError('INVALID_STATE', '上传已过期，请重新登记。');
      const stored = await this.storage.getObject(row.object_key);
      const actualHash = sha256(stored.body);
      if (
        stored.body.byteLength !== Number(row.expected_size_bytes) ||
        stored.body.byteLength !== Number(row.size_bytes) ||
        actualHash !== parsed.sha256 ||
        actualHash !== row.sha256 ||
        stored.contentType !== row.mime_type
      )
        throw new AppError(
          'VALIDATION_ERROR',
          '文件大小、类型或校验和不一致，请重新上传。',
        );
      try {
        await this.validateContent(row, stored.body);
      } catch (error) {
        await tx.execute(
          sql`UPDATE uploaded_files SET status='rejected',rejection_reason='文件内容校验未通过',version=version+1,updated_at=now() WHERE tenant_id=${ctx.tenant_id} AND id=${id} AND version=${parsed.expected_version}`,
        );
        return { error };
      }
      const changed = await tx.execute(
        sql`UPDATE uploaded_files SET status='validated',version=version+1,updated_at=now() WHERE tenant_id=${ctx.tenant_id} AND id=${id} AND version=${parsed.expected_version} AND status='uploaded' RETURNING id`,
      );
      if (!changed.rows[0])
        throw new AppError(
          'VERSION_CONFLICT',
          '文件状态已更新，请刷新后重试。',
        );
      const result = this.view(await this.row(ctx, id, tx));
      await tx.execute(
        sql`INSERT INTO file_command_ledger(tenant_id,actor_id,operation,idempotency_key,payload_hash,result) VALUES(${ctx.tenant_id},${ctx.user_id},'finalize',${key},${payloadHash},${JSON.stringify(result)}::jsonb)`,
      );
      return { file: result };
    });
    if ('error' in outcome) throw outcome.error;
    return outcome.file;
  }
  async getFile(ctx: ActorContext, id: string): Promise<FileView> {
    const row = await this.row(ctx, id);
    await this.authorize(ctx, row);
    return this.view(row);
  }
  async readFile(
    ctx: ActorContext,
    id: string,
  ): Promise<{ file: FileView; bytes: Uint8Array }> {
    const row = await this.row(ctx, id);
    await this.authorize(ctx, row);
    if (row.status !== 'validated')
      throw new AppError('INVALID_STATE', '文件尚未完成校验。');
    const object = await this.storage.getObject(row.object_key);
    if (
      sha256(object.body) !== row.sha256 ||
      object.body.byteLength !== Number(row.size_bytes)
    )
      throw new AppError(
        'DEPENDENCY_UNAVAILABLE',
        '文件完整性校验失败，请联系维护人员。',
      );
    await this.authorize(ctx, row);
    return { file: this.view(row), bytes: object.body };
  }
  async bindParent(
    ctx: ActorContext,
    id: string,
    parent: ResourceRef,
    tx: DatabaseExecutor = this.database.db,
  ): Promise<void> {
    await tx.execute(
      sql`SELECT file_id FROM file_security WHERE tenant_id=${ctx.tenant_id} AND file_id=${id} FOR UPDATE`,
    );
    const row = await this.row(ctx, id, tx);
    await this.authorize(ctx, row, true);
    const custom = this.parentAuthorizers.get(parent.type);
    if (custom) await custom(ctx, parent, { write: true });
    else await this.options.identity.assertResourceAccess(ctx, 'write', parent);
    if (
      row.parent_ref &&
      (row.parent_ref.type !== parent.type || row.parent_ref.id !== parent.id)
    )
      throw new AppError('INVALID_STATE', '文件已关联其他业务对象。');
    await tx.execute(
      sql`UPDATE file_security SET parent_ref=${JSON.stringify(parent)}::jsonb WHERE tenant_id=${ctx.tenant_id} AND file_id=${id}`,
    );
  }
}
export function createFileService(
  database: DatabaseConnection,
  storage: Storage,
  options: { identity: IdentityService },
) {
  return new FileService(database, storage, options);
}
