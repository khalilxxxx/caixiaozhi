import { WORKSPACE_ROOT } from '@caixiaozhi/platform/paths';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { sql } from 'drizzle-orm';
import type { DatabaseConnection } from '@caixiaozhi/platform/database';
import { InvoiceFieldsSchema } from '@caixiaozhi/contracts/expenses';
import { makeSyntheticInvoice } from './business.js';

/** 合成字节与识别夹具绑定；文件名不参与 OCR 选择。 */
export async function seedInvoiceSamples(
  database: DatabaseConnection,
  tenantId: string,
) {
  const money = (amount: string) => ({
    amount_minor: amount,
    currency: 'CNY' as const,
  });
  const base = {
    invoice_code: null,
    invoice_date: '2026-11-03',
    seller_name: '演示交通服务',
    buyer_name: '演示公司',
    seller_tax_id: null,
    buyer_tax_id: null,
    tax_amount: money('0'),
    invoice_kind: 'transport_ticket' as const,
    expense_type: 'transport' as const,
  };
  const transport = InvoiceFieldsSchema.parse({
    ...base,
    invoice_number: 'DEMO-TR-9001',
    gross_amount: money('18000'),
    net_amount: money('18000'),
  });
  const ambiguous = InvoiceFieldsSchema.parse({
    ...base,
    invoice_number: 'DEMO-ME-9002',
    invoice_date: '2026-11-04',
    seller_name: '演示商户',
    gross_amount: money('20000'),
    net_amount: money('20000'),
    invoice_kind: 'other',
    expense_type: null,
  });
  const missing = InvoiceFieldsSchema.parse({
    ...base,
    invoice_number: null,
    gross_amount: null,
    net_amount: null,
    expense_type: null,
    invoice_kind: 'other',
  });
  const transportBytes = await makeSyntheticInvoice('DEMO-TR-9001', '18000');
  const samples = [
    {
      name: 'invoice_transport_demo.pdf',
      bytes: transportBytes,
      fields: transport,
    },
    {
      name: 'invoice_ambiguous_demo.pdf',
      bytes: await makeSyntheticInvoice('DEMO-ME-9002', '20000'),
      fields: ambiguous,
    },
    {
      name: 'invoice_duplicate_demo.pdf',
      bytes: transportBytes,
      fields: transport,
    },
    {
      name: 'invoice_missing_demo.pdf',
      bytes: await makeSyntheticInvoice(
        'DEMO-MISSING',
        'unknown',
        'Synthetic missing-fields sample, not a valid tax invoice',
      ),
      fields: missing,
    },
  ];
  const directory = resolve(WORKSPACE_ROOT, 'docs/demo-invoices');
  await mkdir(directory, { recursive: true });
  for (const sample of samples) {
    await writeFile(resolve(directory, sample.name), sample.bytes);
    const sha = createHash('sha256').update(sample.bytes).digest('hex');
    await database.db.execute(
      sql`INSERT INTO demo_ocr_fixtures(tenant_id,sha256,provider_version,candidates,synthetic) VALUES(${tenantId},${sha},'demo-ocr-v1',${JSON.stringify([sample.fields])}::jsonb,true) ON CONFLICT DO NOTHING`,
    );
    if (sample.fields.invoice_number)
      await database.db.execute(
        sql`INSERT INTO demo_verification_fixtures(tenant_id,sha256,verified,provider_version,synthetic) VALUES(${tenantId},${sha},true,'demo-verification-v1',true) ON CONFLICT DO NOTHING`,
      );
  }
  return Object.fromEntries(
    samples.map((sample) => [
      sample.name,
      createHash('sha256').update(sample.bytes).digest('hex'),
    ]),
  );
}
