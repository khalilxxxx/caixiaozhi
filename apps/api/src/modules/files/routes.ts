import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { FileService } from '@caixiaozhi/files';
import {
  FileRegisterSchema,
  FileFinalizeSchema,
} from '@caixiaozhi/contracts/files';
import { AppError } from '@caixiaozhi/platform/errors';
import type { HttpIdentity } from '../identity/routes.js';
import { dataResponse } from '../../http.js';

export function registerFileRoutes(
  app: FastifyInstance,
  deps: {
    files: FileService;
    identity: HttpIdentity;
    dataMode?: 'demo' | 'production';
  },
) {
  const mode = deps.dataMode ?? 'demo';
  const key = (headers: Record<string, unknown>) =>
    z.string().min(1).max(200).parse(headers['idempotency-key']);
  const id = (params: unknown) =>
    z.strictObject({ id: z.string().min(1) }).parse(params).id;
  app.post('/api/v1/files', async (request, reply) => {
    const actor = await deps.identity.requireActor(request);
    await deps.identity.assertCsrf(request);
    reply.code(201);
    return dataResponse(
      request,
      await deps.files.registerUpload(
        actor,
        FileRegisterSchema.parse(request.body),
        key(request.headers),
      ),
      mode,
    );
  });
  app.post('/api/v1/files/:id/finalize', async (request) => {
    const actor = await deps.identity.requireActor(request);
    await deps.identity.assertCsrf(request);
    return dataResponse(
      request,
      await deps.files.finalizeUpload(
        actor,
        id(request.params),
        FileFinalizeSchema.parse(request.body),
        key(request.headers),
      ),
      mode,
    );
  });
  app.get('/api/v1/files/:id', async (request) =>
    dataResponse(
      request,
      await deps.files.getFile(
        await deps.identity.requireActor(request),
        id(request.params),
      ),
      mode,
    ),
  );
  app.get('/api/v1/files/:id/content', async (request, reply) => {
    const { file, bytes } = await deps.files.readFile(
      await deps.identity.requireActor(request),
      id(request.params),
    );
    reply
      .header('cache-control', 'no-store')
      .header('x-content-type-options', 'nosniff')
      .header(
        'content-disposition',
        `inline; filename*=UTF-8''${encodeURIComponent(file.filename)}`,
      )
      .type(file.mime_type);
    return reply.send(Buffer.from(bytes));
  });
  app.register(async (scope) => {
    scope.addContentTypeParser(
      'application/octet-stream',
      { parseAs: 'buffer', bodyLimit: 20_971_520 },
      (_request, body, done) => done(null, body),
    );
    scope.put(
      '/api/v1/files/:id/content',
      { bodyLimit: 20_971_520 },
      async (request) => {
        const actor = await deps.identity.requireActor(request);
        await deps.identity.assertCsrf(request);
        key(request.headers);
        if (!Buffer.isBuffer(request.body))
          throw new AppError('VALIDATION_ERROR', '上传内容必须为文件字节。');
        const uploadToken = z
          .string()
          .min(1)
          .parse(request.headers['x-upload-token']);
        const expectedVersion = z.coerce
          .number()
          .int()
          .positive()
          .parse(request.headers['x-expected-version']);
        return dataResponse(
          request,
          await deps.files.upload(actor, id(request.params), request.body, {
            uploadToken,
            expectedVersion,
          }),
          mode,
        );
      },
    );
  });
}
