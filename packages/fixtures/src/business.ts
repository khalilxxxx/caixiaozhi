import { createHash } from 'node:crypto';
import {
  PDFDocument,
  StandardFonts,
  PDFString,
  PDFHexString,
  beginText,
  endText,
  moveText,
  setFontAndSize,
  showText,
} from 'pdf-lib';
import { sql } from 'drizzle-orm';
import type { DatabaseConnection } from '@caixiaozhi/platform/database';
import type { Storage } from '@caixiaozhi/platform/storage';
import type {
  ExpenseItem,
  InvoiceFields,
} from '@caixiaozhi/contracts/expenses';
import { registerFile, transitionFile } from '@caixiaozhi/platform/files';

const CNY = (amount: string) => ({
  amount_minor: amount,
  currency: 'CNY' as const,
});
export async function makeSyntheticInvoice(
  number: string,
  amount: string,
  caption = 'Synthetic demonstration material, not a valid tax invoice',
) {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const page = pdf.addPage([595, 400]);
  page.drawText(caption, { x: 35, y: 345, size: 12, font });
  page.drawText(`Invoice ${number}`, { x: 35, y: 305, size: 18, font });
  page.drawText(`Amount minor units CNY ${amount}`, {
    x: 35,
    y: 270,
    size: 14,
    font,
  });
  const descriptor = pdf.context.register(
    pdf.context.obj({
      Type: 'FontDescriptor',
      FontName: 'STSong-Light',
      Flags: 6,
      FontBBox: [0, -200, 1000, 900],
      ItalicAngle: 0,
      Ascent: 880,
      Descent: -120,
      CapHeight: 700,
      StemV: 80,
    }),
  );
  const descendant = pdf.context.register(
    pdf.context.obj({
      Type: 'Font',
      Subtype: 'CIDFontType0',
      BaseFont: 'STSong-Light',
      CIDSystemInfo: {
        Registry: PDFString.of('Adobe'),
        Ordering: PDFString.of('GB1'),
        Supplement: 4,
      },
      FontDescriptor: descriptor,
      DW: 1000,
    }),
  );
  const fontRef = pdf.context.register(
    pdf.context.obj({
      Type: 'Font',
      Subtype: 'Type0',
      BaseFont: 'STSong-Light',
      Encoding: 'UniGB-UCS2-H',
      DescendantFonts: [descendant],
    }),
  );
  const fontName = page.node.newFontDictionary('DemoCJK', fontRef);
  const label = '合成演示材料，不是有效税务发票';
  const encoded = [...label]
    .map((character) => character.charCodeAt(0).toString(16).padStart(4, '0'))
    .join('');
  page.pushOperators(
    beginText(),
    setFontAndSize(fontName, 14),
    moveText(35, 370),
    showText(PDFHexString.of(encoded)),
    endText(),
  );
  pdf.setCreationDate(new Date('2026-11-05T03:00:00Z'));
  pdf.setModificationDate(new Date('2026-11-05T03:00:00Z'));
  pdf.setSubject('合成演示材料，不是有效税务发票');
  pdf.setTitle('财小智合成演示票据');
  return pdf.save({ useObjectStreams: false });
}
type SeedOptions = {
  database: DatabaseConnection;
  storage: Storage;
  tenantId?: string;
};
const pending = [
  {
    id: 'clm-001',
    owner: 'u-wang',
    dept: 'dept-sales',
    amounts: [['transport', '68000']],
    state: 'pending_manager',
    verified: true,
  },
  {
    id: 'clm-002',
    owner: 'u-li',
    dept: 'dept-sales',
    amounts: [['meals', '120000']],
    state: 'pending_manager',
    verified: true,
  },
  {
    id: 'clm-003',
    owner: 'u-wang',
    dept: 'dept-sales',
    amounts: [['lodging', '220000']],
    state: 'pending_manager',
    verified: true,
  },
  {
    id: 'clm-004',
    owner: 'u-li',
    dept: 'dept-sales',
    amounts: [['transport', '90000']],
    state: 'pending_manager',
    verified: false,
  },
  {
    id: 'clm-005',
    owner: 'u-wang',
    dept: 'dept-sales',
    amounts: [['office', '56000']],
    state: 'pending_manager',
    verified: true,
  },
  {
    id: 'clm-006',
    owner: 'u-chen',
    dept: 'dept-tech',
    amounts: [['transport', '30000']],
    state: 'pending_manager',
    verified: true,
  },
  {
    id: 'clm-007',
    owner: 'u-li',
    dept: 'dept-sales',
    amounts: [
      ['lodging', '150000'],
      ['transport', '100000'],
      ['meals', '50000'],
      ['office', '50000'],
    ],
    state: 'completed',
    verified: true,
  },
  {
    id: 'clm-008',
    owner: 'u-wang',
    dept: 'dept-sales',
    amounts: [
      ['transport', '60000'],
      ['meals', '180000'],
    ],
    state: 'completed',
    verified: true,
  },
  {
    id: 'clm-009',
    owner: 'u-li',
    dept: 'dept-sales',
    amounts: [
      ['transport', '40000'],
      ['lodging', '60000'],
    ],
    state: 'completed',
    verified: true,
  },
  {
    id: 'clm-010',
    owner: 'u-wang',
    dept: 'dept-sales',
    amounts: [['meals', '80000']],
    state: 'completed',
    verified: true,
  },
  {
    id: 'clm-011',
    owner: 'u-chen',
    dept: 'dept-tech',
    amounts: [
      ['lodging', '300000'],
      ['transport', '200000'],
    ],
    state: 'completed',
    verified: true,
  },
] as const;
export async function seedBusiness(options: SeedOptions) {
  const tenant = options.tenantId ?? 't-demo';
  const db = options.database;
  await db.db.transaction(async (tx) => {
    await tx.execute(
      sql`INSERT INTO entertainment_requests(tenant_id,id,owner_id,department_id,state,title,entertainment_date,entertained_party,purpose,budget_minor,reserved_minor,approved_at) VALUES(${tenant},'oa-001','u-li','dept-sales','approved','演示客户业务招待','2026-11-04','合成演示客户','市场业务交流',150000,120000,'2026-11-03T03:00:00Z') ON CONFLICT DO NOTHING`,
    );
    await tx.execute(
      sql`INSERT INTO travel_requests(tenant_id,id,owner_id,department_id,state,title,purpose,cost_center_id,project_id,total_minor) VALUES(${tenant},'trv-001','u-li','dept-sales','draft','杭州客户拜访','演示客户沟通','cc-sales','prj-market',0) ON CONFLICT DO NOTHING`,
    );
    const leg = {
      leg_id: 'leg-trv-001-1',
      ordinal: 1,
      from_city_id: 'city-beijing',
      to_city_id: 'city-hangzhou',
      from_place_text: '北京',
      to_place_text: '杭州',
      departure_date: '2026-11-10',
      end_date: '2026-11-12',
      transport_mode: 'train',
      transport_budget: CNY('0'),
      lodging_required: false,
      check_in: null,
      check_out: null,
      room_count: null,
      nightly_room_budget: null,
      other_budget: CNY('0'),
      other_reason: '',
    };
    await tx.execute(
      sql`INSERT INTO travel_legs(tenant_id,travel_id,id,ordinal,data) VALUES(${tenant},'trv-001',${leg.leg_id},1,${JSON.stringify(leg)}::jsonb) ON CONFLICT DO NOTHING`,
    );
  });
  for (const claim of pending) {
    const month = ['clm-009', 'clm-010'].includes(claim.id) ? '10' : '11';
    const historical = claim.state === 'completed';
    const spent = claim.id === 'clm-002' ? '2026-11-04' : `2026-${month}-03`;
    const total = claim.amounts
      .reduce((sum, item) => sum + BigInt(item[1]), 0n)
      .toString();
    const submitted = historical
      ? `2026-${month}-02T03:00:00Z`
      : '2026-11-04T03:00:00Z';
    const completed = historical ? `2026-${month}-05T02:00:00Z` : null;
    const submission = `submission-${claim.id}-1`;
    await db.db.execute(
      sql`INSERT INTO expense_claims(tenant_id,id,owner_id,department_id,state,title,purpose,cost_center_id,total_minor,submission_id,submitted_at,completed_at) VALUES(${tenant},${claim.id},${claim.owner},${claim.dept},${claim.state},${'演示报销 ' + claim.id},'合成业务费用',${claim.dept === 'dept-sales' ? 'cc-sales' : 'cc-tech'},${total},${submission},${submitted},${completed}) ON CONFLICT DO NOTHING`,
    );
    for (const [index, [type, amount]] of claim.amounts.entries()) {
      const suffix = claim.id.slice(4);
      const invoiceId =
        claim.amounts.length === 1
          ? `inv-${suffix}`
          : `inv-${suffix}-${index + 1}`;
      const itemId =
        claim.amounts.length === 1
          ? `ei-${suffix}`
          : `ei-${suffix}-${index + 1}`;
      const fileId = `file-${tenant}-${invoiceId}`;
      const bytes = await makeSyntheticInvoice('DEMO-' + invoiceId, amount);
      const sha = createHash('sha256').update(bytes).digest('hex');
      const existing = await db.pool.query(
        'SELECT id FROM uploaded_files WHERE tenant_id=$1 AND id=$2',
        [tenant, fileId],
      );
      if (!existing.rowCount) {
        const file = await registerFile(db.db, {
          id: fileId,
          tenantId: tenant,
          ownerId: claim.owner,
          objectKey: `fixtures/${tenant}/${invoiceId}.pdf`,
          originalFilename: `${invoiceId}_demo.pdf`,
          mimeType: 'application/pdf',
          expectedSizeBytes: bytes.length,
          uploadExpiresAt: new Date(Date.now() + 600000),
        });
        await options.storage.putObject({
          key: file.objectKey,
          body: bytes,
          contentType: 'application/pdf',
        });
        await transitionFile(db.db, {
          tenantId: tenant,
          id: fileId,
          expectedVersion: 1,
          status: 'uploaded',
          sha256: sha,
          sizeBytes: bytes.length,
          mimeType: 'application/pdf',
        });
        await transitionFile(db.db, {
          tenantId: tenant,
          id: fileId,
          expectedVersion: 2,
          status: 'validated',
        });
      }
      await db.db.execute(
        sql`INSERT INTO file_security(tenant_id,file_id,profile,upload_token_hash,parent_ref) VALUES(${tenant},${fileId},'invoice-v1',${'0'.repeat(64)},${JSON.stringify({ type: 'expense_claim', id: claim.id, version: 1 })}::jsonb) ON CONFLICT DO NOTHING`,
      );
      const fields: InvoiceFields = {
        invoice_number: 'DEMO-' + invoiceId,
        invoice_code: null,
        invoice_date: spent,
        seller_name: '合成演示商户',
        buyer_name: '演示公司',
        seller_tax_id: null,
        buyer_tax_id: null,
        gross_amount: CNY(amount),
        tax_amount: CNY('0'),
        net_amount: CNY(amount),
        invoice_kind: type === 'transport' ? 'transport_ticket' : 'other',
        expense_type: type,
      };
      let oaId: string | null = null;
      if (type === 'meals') {
        oaId = claim.id === 'clm-002' ? 'oa-001' : `oa-history-${claim.id}`;
        if (oaId !== 'oa-001')
          await db.db.execute(
            sql`INSERT INTO entertainment_requests(tenant_id,id,owner_id,department_id,state,title,entertainment_date,entertained_party,purpose,budget_minor,consumed_minor,approved_at) VALUES(${tenant},${oaId},${claim.owner},${claim.dept},'approved','历史合成招待申请',${spent},'合成演示客户','历史夹具额度',${amount},${amount},${submitted}) ON CONFLICT DO NOTHING`,
          );
      }
      const nights =
        claim.id === 'clm-003'
          ? 2
          : claim.id === 'clm-007'
            ? 3
            : claim.id === 'clm-011'
              ? 5
              : 1;
      const item: ExpenseItem = {
        item_id: itemId,
        invoice_id: invoiceId,
        invoice_version: 1,
        expense_type: type,
        expense_subtype: type === 'meals' ? 'business_entertainment' : null,
        type_confirmation: 'confirmed',
        incurred_date: spent,
        claim_amount: CNY(amount),
        reduction_reason: null,
        travel_ref: null,
        oa_ref: oaId ? { type: 'oa_request', id: oaId, version: 1 } : null,
        lodging_details:
          type === 'lodging'
            ? {
                check_in: `2026-${month}-${String(4 - nights).padStart(2, '0')}`,
                check_out: `2026-${month}-04`,
                room_count: '1',
              }
            : null,
        transport_details: null,
      };
      if (claim.id === 'clm-011' && item.lodging_details)
        item.lodging_details = {
          check_in: '2026-10-30',
          check_out: '2026-11-04',
          room_count: '1',
        };
      await db.db.transaction(async (tx) => {
        await tx.execute(
          sql`INSERT INTO invoices(tenant_id,id,owner_id,file_id,fields,confirmation_state,verification_state,verification_evidence,gross_minor,source_fields) VALUES(${tenant},${invoiceId},${claim.owner},${fileId},${JSON.stringify(fields)}::jsonb,'confirmed',${claim.verified ? 'verified' : 'pending'},${JSON.stringify({ provider: 'controlled-demo-fixture', synthetic: true, verified: claim.verified ? true : null })}::jsonb,${amount},${JSON.stringify({ source: 'finance-agent-v1.0', synthetic: true })}::jsonb) ON CONFLICT DO NOTHING`,
        );
        await tx.execute(
          sql`INSERT INTO expense_items(tenant_id,claim_id,id,invoice_id,data,amount_minor,expense_type) VALUES(${tenant},${claim.id},${itemId},${invoiceId},${JSON.stringify(item)}::jsonb,${amount},${type}) ON CONFLICT DO NOTHING`,
        );
        await tx.execute(
          sql`INSERT INTO invoice_reservations(tenant_id,invoice_id,claim_id) VALUES(${tenant},${invoiceId},${claim.id}) ON CONFLICT DO NOTHING`,
        );
      });
    }
    if (!historical)
      await db.db.execute(
        sql`INSERT INTO approval_tasks(tenant_id,id,resource_type,resource_id,resource_version,owner_id,department_id,assigned_to,node,state,submission_id) VALUES(${tenant},${'at-' + claim.id.slice(4)},'expense_claim',${claim.id},1,${claim.owner},${claim.dept},${claim.dept === 'dept-sales' ? 'u-zhang' : 'u-sun'},'manager','pending',${submission}) ON CONFLICT DO NOTHING`,
      );
  }
  await db.db.execute(
    sql`INSERT INTO oa_budget_reservations(tenant_id,id,oa_id,claim_id,submission_id,reservation_key,amount_minor,state) VALUES(${tenant},'reserve-oa001-clm002','oa-001','clm-002','submission-clm-002-1','clm-002:submission-clm-002-1:oa-001',120000,'reserved') ON CONFLICT DO NOTHING`,
  );
  return { tenant_id: tenant, claims: 11, seed_version: 'finance-agent-v1.0' };
}
