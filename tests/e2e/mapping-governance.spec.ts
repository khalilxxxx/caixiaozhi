import { expect, test } from '@playwright/test';

test('映射人工样例、正式发布与版本切换真实影响预审，普通员工无入口', async ({
  page,
  request,
}, testInfo) => {
  test.setTimeout(120000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  const origin = new URL(page.url()).origin;
  const identityCatalog = (
    await (await request.get('/api/v1/auth/demo/identities')).json()
  ).data;
  const login = await request.post('/api/v1/auth/demo/login', {
    headers: { origin, 'idempotency-key': crypto.randomUUID() },
    data: {
      selected_user_id: 'u-zhang',
      demo_environment_id: identityCatalog.demo_environment_id,
      generation: identityCatalog.generation,
    },
  });
  expect(login.ok(), await login.text()).toBe(true);
  const manager = (await (await request.get('/api/v1/me')).json()).data;
  const preaudit = async () => {
    const started = await request.post('/api/v1/preaudit/tasks', {
      headers: {
        origin,
        'x-csrf-token': manager.csrf_token,
        'idempotency-key': crypto.randomUUID(),
      },
      data: {
        purpose: 'manager_review',
        documents: [{ type: 'expense_claim', id: 'clm-005', version: 1 }],
      },
    });
    expect(started.status(), await started.text()).toBe(202);
    const task = (await started.json()).data;
    let view: any;
    await expect
      .poll(
        async () => {
          const response = await request.get(
            `/api/v1/preaudit/tasks/${task.task_id}`,
          );
          expect(response.ok(), await response.text()).toBe(true);
          view = (await response.json()).data;
          return view.task.status;
        },
        { timeout: 30000 },
      )
      .toBe('completed');
    expect(view.items[0].result).toBeTruthy();
    return view.items[0].result;
  };
  const baseline = await preaudit();
  expect(baseline.group).toBe('low');
  await page.getByRole('button', { name: /刘敏.*财务部/ }).click();
  await expect(page.getByLabel('切换演示身份')).toHaveValue('u-liu');
  await expect(page.getByLabel('切换演示身份')).toBeEnabled();
  const catalog = (
    await (await page.request.get('/api/v1/rule-mappings')).json()
  ).data;
  expect(
    catalog.items.filter(
      (item: any) =>
        item.provider === 'demo-expenses' &&
        item.source_schema_version === 'expense-v1' &&
        item.module === 'expense_claim',
    ),
    '请在无既有治理配置的隔离Demo代运行；测试最后保留完整规范映射。',
  ).toHaveLength(0);
  await page.getByRole('button', { name: '制度与规则', exact: true }).click();
  await page.getByRole('tab', { name: '字段映射', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: '字段映射治理', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: '创建字段映射', exact: true }).click();
  const editor = page.getByRole('dialog', {
    name: '字段映射配置',
    exact: true,
  });
  const draftPayload = JSON.parse(
    await editor.getByLabel('映射草稿（JSON）').inputValue(),
  );
  const name = `规范字段映射-${Date.now()}`;
  draftPayload.name = name;
  draftPayload.mapping_json.fields = draftPayload.mapping_json.fields.filter(
    (field: any) => field.target_field !== 'invoices[].verified',
  );
  await editor
    .getByLabel('映射草稿（JSON）')
    .fill(JSON.stringify(draftPayload, null, 2));
  const save = async (method: 'POST' | 'PATCH', path: string) => {
    const response = page.waitForResponse(
      (r) =>
        r.request().method() === method && new URL(r.url()).pathname === path,
    );
    await editor
      .getByRole('button', { name: '保存映射草稿', exact: true })
      .click();
    const saved = await response;
    expect(saved.ok(), await saved.text()).toBe(true);
    return (await saved.json()).data;
  };
  const first = await save('POST', '/api/v1/rule-mappings');
  const firstDraft = first.versions.find(
    (version: any) => version.id === first.draft_version_id,
  );
  await expect(
    editor.getByRole('button', { name: '核对并发布映射', exact: true }),
  ).toBeDisabled();
  await editor
    .getByRole('button', { name: '载入合成样例模板', exact: true })
    .click();
  await expect(editor.getByLabel('人工映射样例（JSON）')).not.toHaveValue('');
  const samples = JSON.parse(
    await editor.getByLabel('人工映射样例（JSON）').inputValue(),
  );
  expect(samples[0].source.snapshot.provenance.input_hash).toMatch(
    /^[a-f0-9]{64}$/,
  );
  samples[0].expected[0].value = '人工故意错误的预期';
  await editor
    .getByLabel('人工映射样例（JSON）')
    .fill(JSON.stringify(samples, null, 2));
  const run = async (passed: boolean) => {
    const response = page.waitForResponse(
      (r) =>
        r.request().method() === 'POST' &&
        new URL(r.url()).pathname === `/api/v1/rule-mappings/${first.id}/tests`,
    );
    await editor
      .getByRole('button', { name: '验证人工映射样例', exact: true })
      .click();
    const checked = await response;
    expect(checked.ok(), await checked.text()).toBe(true);
    const proof = (await checked.json()).data;
    expect(proof.passed).toBe(passed);
    await expect(
      editor.getByRole('heading', {
        name: passed ? '映射样例通过' : '映射样例尚未通过',
        exact: true,
      }),
    ).toBeVisible();
    return proof;
  };
  const failed = await run(false);
  await expect(
    editor.getByRole('button', { name: '核对并发布映射', exact: true }),
  ).toBeDisabled();
  await editor
    .getByRole('button', { name: '载入合成样例模板', exact: true })
    .click();
  await expect(
    editor.getByRole('heading', { name: '映射样例尚未通过', exact: true }),
  ).toHaveCount(0);
  const firstProof = await run(true);
  expect(firstProof.draft_id).toBe(firstDraft.id);
  expect(firstProof.draft_hash).toBe(firstDraft.content_hash);
  const publish = async (expectedDraft: any) => {
    await editor
      .getByRole('button', { name: '核对并发布映射', exact: true })
      .click();
    const confirm = page.getByRole('dialog', {
      name: '确认本次操作',
      exact: true,
    });
    await expect(confirm).toContainText(name);
    await expect(confirm).toContainText(expectedDraft.content_hash);
    const response = page.waitForResponse(
      (r) =>
        r.request().method() === 'POST' &&
        /\/confirmations\/[^/]+\/confirm$/.test(new URL(r.url()).pathname),
    );
    await confirm
      .getByRole('button', { name: '确认并执行', exact: true })
      .click();
    const result = await response;
    expect(result.ok(), await result.text()).toBe(true);
    const action = (await result.json()).data;
    expect(action.operation).toBe('rule.mapping.publish');
    expect(action.state).toBe('succeeded');
    expect(action.resource_refs).toEqual([]);
    expect(action.items[0].resource_ref).toBeNull();
    expect(action.items[0].receipt.outcome).toBe('succeeded');
    expect(action.items[0].receipt.external_receipt_id).toBe(expectedDraft.id);
    await expect(
      page.getByRole('dialog', { name: '操作回执', exact: true }),
    ).toBeVisible();
    await page
      .getByRole('dialog', { name: '操作回执', exact: true })
      .getByRole('button', { name: '返回', exact: true })
      .click();
    await expect(
      editor.getByRole('button', { name: '核对并发布映射', exact: true }),
    ).toBeDisabled();
    return action;
  };
  const firstAction = await publish(firstDraft),
    partial = await preaudit();
  expect(partial.group).toBe('incomplete');
  expect(partial.locked_versions.mapping_versions).toEqual([
    { id: firstDraft.id, version: 1 },
  ]);
  const old = (
    await (
      await request.get(`/api/v1/preaudit/results/${baseline.result_id}`)
    ).json()
  ).data;
  expect(old.status).toBe('stale');
  const current = (
    await (await page.request.get(`/api/v1/rule-mappings/${first.id}`)).json()
  ).data;
  expect(current.active_version_id).toBe(firstDraft.id);
  expect(current.draft_version_id).toBeNull();
  const complete = {
    ...draftPayload,
    mapping_json: {
      ...draftPayload.mapping_json,
      fields: catalog.identity_fields,
    },
  };
  await editor
    .getByLabel('映射草稿（JSON）')
    .fill(JSON.stringify(complete, null, 2));
  const second = await save('PATCH', `/api/v1/rule-mappings/${first.id}/draft`),
    secondDraft = second.versions.find(
      (version: any) => version.id === second.draft_version_id,
    );
  expect(second.active_version_id).toBe(firstDraft.id);
  expect(secondDraft.version_number).toBe(2);
  await expect(editor.getByRole('status')).toContainText('旧发布版继续生效');
  await expect(
    editor.getByRole('button', { name: '核对并发布映射', exact: true }),
  ).toBeDisabled();
  await editor
    .getByRole('button', { name: '载入合成样例模板', exact: true })
    .click();
  const secondProof = await run(true);
  expect(secondProof.draft_id).toBe(secondDraft.id);
  await editor
    .getByRole('heading', { name: '映射样例通过', exact: true })
    .scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('映射治理-桌面.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await editor
    .getByRole('heading', { name: '映射样例通过', exact: true })
    .scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('映射治理-窄屏.png') });
  expect(
    await editor.evaluate(
      (element) => element.scrollWidth <= element.clientWidth,
    ),
  ).toBe(true);
  await editor
    .getByRole('button', { name: '核对并发布映射', exact: true })
    .focus();
  await expect(
    editor.getByRole('button', { name: '核对并发布映射', exact: true }),
  ).toBeFocused();
  await page.keyboard.press('Tab');
  await page.setViewportSize({ width: 1280, height: 720 });
  const secondAction = await publish(secondDraft),
    completeResult = await preaudit();
  expect(completeResult.group).toBe('low');
  expect(completeResult.amount).toEqual(baseline.amount);
  expect(completeResult.locked_versions.mapping_versions).toEqual([
    { id: secondDraft.id, version: 2 },
  ]);
  const final = (
    await (await page.request.get(`/api/v1/rule-mappings/${first.id}`)).json()
  ).data;
  expect(final.active_version_id).toBe(secondDraft.id);
  expect(
    final.versions.find((version: any) => version.id === firstDraft.id),
  ).toEqual({ ...firstDraft, publication_state: 'published' });
  await editor.getByRole('button', { name: '关闭详情', exact: true }).click();
  await page.getByLabel('切换演示身份').selectOption('u-li');
  await expect(page.getByLabel('切换演示身份')).toHaveValue('u-li');
  await expect(page.getByLabel('切换演示身份')).toBeEnabled();
  await page.getByRole('button', { name: '制度与规则', exact: true }).click();
  await expect(
    page.getByRole('tab', { name: '字段映射', exact: true }),
  ).toHaveCount(0);
  expect(
    (await page.request.get(`/api/v1/rule-mappings/${first.id}`)).status(),
  ).toBe(404);
  expect(errors).toEqual([]);
  await testInfo.attach('映射治理真实浏览器证据', {
    body: JSON.stringify(
      {
        mapping_id: first.id,
        failed_proof: failed.test_run_id,
        first_proof: firstProof.test_run_id,
        second_proof: secondProof.test_run_id,
        first_action: firstAction.id,
        second_action: secondAction.id,
        versions: [firstDraft.id, secondDraft.id],
        groups: [baseline.group, partial.group, completeResult.group],
      },
      null,
      2,
    ),
    contentType: 'application/json',
  });
});
