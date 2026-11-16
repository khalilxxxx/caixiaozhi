import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { config as loadDotEnv } from 'dotenv';
import { z } from 'zod';

loadDotEnv({
  path: fileURLToPath(new URL('../../../.env', import.meta.url)),
  quiet: true,
});

const developmentSessionSecret = randomBytes(32).toString('hex');

const ConfigSchema = z.object({
  SESSION_SECRET: z.string().min(32).optional(),
  DEMO_ENVIRONMENT_ID: z.string().min(1).max(100).default('demo-default'),
  DEMO_TENANT_ID: z.string().min(1).max(100).default('t-demo'),
  DEMO_ACCESS_ENABLED: z.enum(['true', 'false']).default('false'),
  APP_ORIGIN: z.url().default('http://127.0.0.1:5173'),
  COOKIE_SECURE: z.enum(['true', 'false']).default('true'),
  DSH_API_KEY: z.string().min(1).optional(),
  DSH_MODEL: z.string().min(1).optional(),
  DSH_BASE_URL: z.url().optional(),
  DSH_CONTEXT_WINDOW: z.coerce.number().int().min(1024).optional(),
  DSH_API_PROTOCOL: z
    .enum(['openai-completions', 'openai-responses', 'anthropic-messages'])
    .default('openai-completions'),
  APP_MODE: z.enum(['demo', 'test', 'production']).default('demo'),
  DATABASE_URL: z.url().refine((value) => /^postgres(?:ql)?:/.test(value)),
  S3_ENDPOINT: z.url().refine((value) => /^https?:/.test(value)),
  S3_REGION: z.string().min(1).default('us-east-1'),
  S3_BUCKET: z
    .string()
    .min(3)
    .max(63)
    .regex(/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/),
  S3_ACCESS_KEY_ID: z.string().min(1),
  S3_SECRET_ACCESS_KEY: z.string().min(1),
  S3_FORCE_PATH_STYLE: z.enum(['true', 'false']).default('true'),
  API_HOST: z.string().min(1).default('127.0.0.1'),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),
  BUSINESS_TIMEZONE: z
    .string()
    .default('Asia/Shanghai')
    .refine((value) => {
      try {
        new Intl.DateTimeFormat('zh-CN', { timeZone: value });
        return true;
      } catch {
        return false;
      }
    }),
});

export function loadConfig(source: NodeJS.ProcessEnv = process.env) {
  const result = ConfigSchema.safeParse(source);
  if (!result.success) {
    const fields = [
      ...new Set(result.error.issues.map((issue) => issue.path.join('.'))),
    ];
    throw new Error(`环境配置无效，请检查字段 ${fields.join('、')}。`);
  }
  const values = result.data;
  if (
    values.APP_MODE === 'production' &&
    (!values.SESSION_SECRET ||
      values.COOKIE_SECURE !== 'true' ||
      values.DEMO_ACCESS_ENABLED === 'true')
  ) {
    throw new Error(
      '环境配置无效，请检查 production 的 SESSION_SECRET、COOKIE_SECURE 与 DEMO_ACCESS_ENABLED。',
    );
  }
  return {
    appMode: values.APP_MODE,
    sessionSecret: values.SESSION_SECRET ?? developmentSessionSecret,
    demoEnvironmentId: values.DEMO_ENVIRONMENT_ID,
    demoTenantId: values.DEMO_TENANT_ID,
    demoAccessEnabled:
      values.DEMO_ACCESS_ENABLED === 'true' && values.APP_MODE === 'demo',
    appOrigin: values.APP_ORIGIN,
    cookieSecure: values.COOKIE_SECURE === 'true',
    dsh: {
      apiKey: values.DSH_API_KEY,
      model: values.DSH_MODEL,
      baseURL: values.DSH_BASE_URL,
      contextWindow: values.DSH_CONTEXT_WINDOW,
      apiProtocol: values.DSH_API_PROTOCOL,
    },
    databaseUrl: values.DATABASE_URL,
    s3: {
      endpoint: values.S3_ENDPOINT,
      region: values.S3_REGION,
      bucket: values.S3_BUCKET,
      accessKeyId: values.S3_ACCESS_KEY_ID,
      secretAccessKey: values.S3_SECRET_ACCESS_KEY,
      forcePathStyle: values.S3_FORCE_PATH_STYLE === 'true',
    },
    apiHost: values.API_HOST,
    apiPort: values.API_PORT,
    logLevel: values.LOG_LEVEL,
    businessTimezone: values.BUSINESS_TIMEZONE,
  };
}

export type AppConfig = ReturnType<typeof loadConfig>;
