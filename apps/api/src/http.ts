import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { DataMode } from '@caixiaozhi/contracts';

const modes = new WeakMap<FastifyInstance, DataMode>();
export function setHttpDataMode(app: FastifyInstance, mode: DataMode) {
  modes.set(app, mode);
}
export function dataResponse<T>(
  request: Pick<FastifyRequest, 'id'> & Partial<Pick<FastifyRequest, 'server'>>,
  data: T,
  dataMode?: DataMode,
) {
  return {
    data,
    meta: {
      request_id: request.id,
      trace_id: request.id,
      server_time: new Date().toISOString(),
      data_mode:
        dataMode ??
        (request.server ? modes.get(request.server) : undefined) ??
        'demo',
    },
  };
}
