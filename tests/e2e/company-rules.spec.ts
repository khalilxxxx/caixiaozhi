import { expect, test } from '@playwright/test';

test('公司规则真实来源、持久边界测试与本人确认发布，旧发布版保持不变', async ({
  page,
}, testInfo) => {
  test.setTimeout(90000);
  await page.goto('/');
  await page.getByRole('button', { name: /刘敏.*财务部/ }).click();
  await expect(page.getByLabel('切换演示身份')).toHaveValue('u-liu');
  await expect(page.getByLabel('切换演示身份')).toBeEnabled();
  await page.getByRole('button', { name: '制度与规则', exact: true }).click();
  await page.getByRole('tab', { name: '审核规则' }).click();
  await page.getByRole('button', { name: '创建公司规则', exact: true }).click();
  const editor = page.getByRole('dialog', {
    name: '公司审核规则',
    exact: true,
  });
  const name = `公司金额边界-${Date.now()}`;
  await editor.getByLabel('规则名称').fill(name);
  await editor.getByLabel('单据总额不得超过（元）').fill('10000000.00');
  await expect(
    editor.getByRole('button', { name: '保存公司草稿' }),
  ).toBeDisabled();
  await editor.getByLabel('查找公司规则依据').fill('住宿标准');
  const searchResponse = page.waitForResponse(
    (r) =>
      r.request().method() === 'POST' &&
      new URL(r.url()).pathname === '/api/v1/knowledge/search',
  );
  await editor.getByRole('button', { name: '检索可引用原文' }).click();
  const search = await searchResponse;
  expect(search.ok()).toBe(true);
  const { data: retrieval } = await search.json();
  expect(retrieval.hits.length).toBeGreaterThan(0);
  const first = retrieval.hits[0];
  await editor
    .getByRole('checkbox', { name: /选择此条原文/ })
    .first()
    .check();
  await editor
    .getByRole('button', { name: '查看来源与上下文' })
    .first()
    .click();
  const source = page.getByRole('dialog', { name: '制度来源', exact: true });
  await expect(source).toContainText(first.quote);
  await source
    .getByRole('button', { name: '关闭详情' })
    .click({ timeout: 5000 });
  await expect(editor.getByLabel('规则名称')).toHaveValue(name);
  const savedResponse = page.waitForResponse(
    (r) =>
      r.request().method() === 'POST' &&
      new URL(r.url()).pathname === '/api/v1/rules',
  );
  await editor.getByRole('button', { name: '保存公司草稿' }).click();
  const saved = await savedResponse;
  expect(saved.ok(), await saved.text()).toBe(true);
  const { data: draft } = await saved.json();
  expect(draft.level).toBe('company');
  const draftContent = draft.versions.find(
    (v: { id: string }) => v.id === draft.draft_version_id,
  );
  expect(draftContent.dsl_json.outcome_mode).toBe('mandatory_check');
  expect(draftContent.source_citation_ids).toEqual([first.citation_id]);
  expect(draftContent.source_kind).toBe('policy');
  expect(draftContent.dsl_json.applicability.department_ids).toEqual([
    'dept-sales',
    'dept-tech',
  ]);
  const acceptedResponse = page.waitForResponse(
    (r) =>
      r.request().method() === 'POST' &&
      /\/api\/v1\/rules\/[^/]+\/tests$/.test(new URL(r.url()).pathname),
  );
  await editor.getByRole('button', { name: '验证金额边界' }).click();
  const accepted = await acceptedResponse;
  expect(accepted.status()).toBe(202);
  const { data: task } = await accepted.json();
  await expect(
    editor.getByRole('heading', { name: '边界样例通过' }),
  ).toBeVisible({ timeout: 30000 });
  await expect(editor.getByRole('status')).toContainText('4/4');
  await expect(editor.getByText('检查不通过', { exact: true })).toBeVisible();
  const proofResponse = await page.request.get(
    `/api/v1/rules/${draft.id}/tests/${task.task_id}`,
  );
  const { data: completed } = await proofResponse.json();
  expect(completed.status).toBe('completed');
  expect(completed.proof.passed).toBe(true);
  expect(
    completed.proof.results.map((r: { truth: string }) => r.truth),
  ).toEqual(['true', 'true', 'false', 'unknown']);
  await editor.getByRole('button', { name: '核对并发布公司规则' }).click();
  const confirm = page.getByRole('dialog', {
    name: '确认本次操作',
    exact: true,
  });
  await expect(confirm).toContainText('刘敏');
  await expect(confirm).toContainText(name);
  const confirmResponse = page.waitForResponse(
    (r) =>
      r.request().method() === 'POST' &&
      /\/confirmations\/[^/]+\/confirm$/.test(new URL(r.url()).pathname),
  );
  await confirm
    .getByRole('button', { name: '确认并执行', exact: true })
    .click();
  const result = await confirmResponse;
  expect(result.ok(), await result.text()).toBe(true);
  const { data: action } = await result.json();
  expect(action.state).toBe('succeeded');
  expect(action.items[0].receipt.outcome).toBe('succeeded');
  const actionResponse = await page.request.get(`/api/v1/actions/${action.id}`);
  expect((await actionResponse.json()).data.operation).toBe('rule.publish');
  const publishedResponse = await page.request.get(`/api/v1/rules/${draft.id}`);
  const { data: published } = await publishedResponse.json();
  expect(published.active_version_id).toBe(draft.draft_version_id);
  expect(published.draft_version_id).toBeNull();
  await page
    .getByRole('dialog', { name: '操作回执' })
    .getByRole('button', { name: '返回', exact: true })
    .click();
  await page
    .locator('.finance-rule')
    .filter({ hasText: name })
    .getByRole('button', { name: '查看与编辑' })
    .click();
  const originalDsl = await editor
    .getByLabel('检查条件（声明式 JSON）')
    .inputValue();
  const editedDsl = JSON.parse(originalDsl);
  editedDsl.predicate.right.value.amount_minor = '1000000100';
  await editor
    .getByLabel('检查条件（声明式 JSON）')
    .fill(JSON.stringify(editedDsl, null, 2));
  const network = await page.context().newCDPSession(page);
  await network.send('Network.enable');
  await network.send('Network.emulateNetworkConditions', {
    offline: false,
    latency: 700,
    downloadThroughput: -1,
    uploadThroughput: -1,
  });
  const delayedSave = page.waitForResponse(
    (r) =>
      r.request().method() === 'PATCH' &&
      new URL(r.url()).pathname === `/api/v1/rules/${draft.id}/draft`,
  );
  await editor.getByRole('button', { name: '保存公司草稿' }).click();
  await expect(editor.getByLabel('检查条件（声明式 JSON）')).toBeDisabled({
    timeout: 500,
  });
  await expect(editor.getByLabel('规则名称')).toBeDisabled();
  expect((await delayedSave).ok()).toBe(true);
  await network.send('Network.emulateNetworkConditions', {
    offline: false,
    latency: 0,
    downloadThroughput: -1,
    uploadThroughput: -1,
  });
  await network.detach();
  await expect(
    editor.getByText('公司草稿已保存，已发布版本继续生效。'),
  ).toBeVisible();
  await expect(
    editor.getByRole('region', { name: '公司规则版本变化' }),
  ).toContainText('金额阈值由');
  await expect(
    editor.getByRole('region', { name: '公司规则版本变化' }),
  ).toContainText('10000001.00');
  await editor
    .getByRole('region', { name: '公司规则版本变化' })
    .scrollIntoViewIfNeeded();
  await page.screenshot({
    path: testInfo.outputPath('公司规则版本变化-桌面.png'),
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await editor
    .getByRole('region', { name: '公司规则版本变化' })
    .scrollIntoViewIfNeeded();
  await page.screenshot({
    path: testInfo.outputPath('公司规则版本变化-窄屏.png'),
  });
  await page.setViewportSize({ width: 1280, height: 720 });
  const updatedResponse = await page.request.get(`/api/v1/rules/${draft.id}`);
  const { data: updated } = await updatedResponse.json();
  expect(updated.level).toBe('company');
  expect(updated.active_version_id).toBe(published.active_version_id);
  expect(updated.draft_version_id).not.toBe(updated.active_version_id);
  expect(
    updated.versions.find(
      (v: { id: string }) => v.id === published.active_version_id,
    ),
  ).toEqual(
    published.versions.find(
      (v: { id: string }) => v.id === published.active_version_id,
    ),
  );
  await editor.getByRole('button', { name: '关闭详情' }).click();
  await page.getByLabel('切换演示身份').selectOption('u-li');
  await expect(page.getByLabel('切换演示身份')).toBeEnabled();
  await page.getByRole('button', { name: '制度与规则', exact: true }).click();
  await page.getByRole('tab', { name: '审核规则' }).click();
  await expect(page.getByRole('button', { name: '创建公司规则' })).toHaveCount(
    0,
  );
  await expect(page.getByRole('button', { name: '停用公司规则' })).toHaveCount(
    0,
  );
  await page
    .locator('.finance-rule')
    .filter({ hasText: name })
    .getByRole('button', { name: '查看依据' })
    .click();
  await expect(
    editor.getByRole('button', { name: '保存公司草稿' }),
  ).toHaveCount(0);
  await expect(
    editor.getByRole('button', { name: '验证金额边界' }),
  ).toHaveCount(0);
  await expect(
    editor.getByRole('button', { name: '核对并发布公司规则' }),
  ).toHaveCount(0);
  const me = (await (await page.request.get('/api/v1/me')).json()).data;
  const denied = await page.request.patch(`/api/v1/rules/${draft.id}/draft`, {
    headers: {
      origin: new URL(page.url()).origin,
      'x-csrf-token': me.csrf_token,
      'idempotency-key': crypto.randomUUID(),
    },
    data: {
      expected_version: updated.version,
      name,
      level: 'company',
      category: 'general',
      dsl_json: editedDsl,
      source_kind: 'policy',
      source_citation_ids: [first.citation_id],
    },
  });
  expect(denied.status()).toBe(403);
  await testInfo.attach('公司规则真实发布证据', {
    body: JSON.stringify(
      {
        rule_id: draft.id,
        source_citation_id: first.citation_id,
        source_kind: draftContent.source_kind,
        task_id: task.task_id,
        test_status: completed.status,
        test_passed: completed.proof.passed,
        test_truths: completed.proof.results.map(
          (item: { truth: string }) => item.truth,
        ),
        action_id: action.id,
        operation: 'rule.publish',
        action_state: action.state,
        published_version_id: published.active_version_id,
        new_draft_version_id: updated.draft_version_id,
        published_version_preserved:
          updated.active_version_id === published.active_version_id,
        ordinary_employee_write_status: denied.status(),
      },
      null,
      2,
    ),
    contentType: 'application/json',
  });
});

test('既有公司规则保留复杂结构，个人模式和越权组织不能保存', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: /刘敏.*财务部/ }).click();
  await expect(page.getByLabel('切换演示身份')).toBeEnabled();
  const response = await page.request.get('/api/v1/rules/rule-company-lodging');
  expect(response.ok()).toBe(true);
  const before = (await response.json()).data;
  const version = before.versions.find(
    (v: { id: string }) =>
      v.id === (before.draft_version_id ?? before.active_version_id),
  );
  await page.getByRole('button', { name: '制度与规则', exact: true }).click();
  await page.getByRole('tab', { name: '审核规则' }).click();
  await page
    .locator('.finance-rule')
    .filter({ hasText: '住宿每间夜800元上限' })
    .getByRole('button', { name: '查看与编辑' })
    .click();
  const editor = page.getByRole('dialog', {
    name: '公司审核规则',
    exact: true,
  });
  const condition = editor.getByLabel('检查条件（声明式 JSON）');
  expect(JSON.parse(await condition.inputValue())).toEqual(version.dsl_json);
  expect(version.dsl_json.predicate.op).toBe('for_each');
  const personal = { ...version.dsl_json, outcome_mode: 'attention_trigger' };
  delete personal.failure_kind;
  await condition.fill(JSON.stringify(personal));
  await editor.getByRole('button', { name: '保存公司草稿' }).click();
  await expect(editor.getByRole('alert')).toContainText(
    '公司规则必须保留必查模式',
  );
  const outside = structuredClone(version.dsl_json);
  outside.applicability.department_ids = ['dept-it'];
  await condition.fill(JSON.stringify(outside));
  await editor.getByRole('button', { name: '保存公司草稿' }).click();
  await expect(editor.getByRole('alert')).toContainText(
    '适用部门必须在当前公司规则管理授权范围内',
  );
  const executable = structuredClone(version.dsl_json);
  executable.predicate = { op: 'script', code: 'return true' };
  await condition.fill(JSON.stringify(executable));
  await editor.getByRole('button', { name: '保存公司草稿' }).click();
  await expect(editor.getByRole('alert')).toContainText(
    '检查条件不符合声明式规则格式',
  );
  const after = (
    await (await page.request.get('/api/v1/rules/rule-company-lodging')).json()
  ).data;
  expect(after).toEqual(before);
});

test('复杂公司规则人工专用样例真实失败后阻断，修正样例并确认发布v2', async ({
  page,
}, testInfo) => {
  test.setTimeout(120000);
  await page.goto('/');
  await page.getByRole('button', { name: /刘敏.*财务部/ }).click();
  await expect(page.getByLabel('切换演示身份')).toBeEnabled();
  const me = (await (await page.request.get('/api/v1/me')).json()).data;
  const write = async (path: string, body: unknown) =>
    page.request.post(`/api/v1${path}`, {
      headers: {
        origin: new URL(page.url()).origin,
        'x-csrf-token': me.csrf_token,
        'idempotency-key': crypto.randomUUID(),
      },
      data: body,
    });
  const search = await write('/knowledge/search', {
    query: '住宿标准',
    business_date: '2026-11-05',
    top_k: 1,
  });
  expect(search.ok()).toBe(true);
  const citation = (await search.json()).data.hits[0];
  expect(citation.citation_id).toEqual(expect.any(String));
  const baseline = (
    await (await page.request.get('/api/v1/rules/rule-company-lodging')).json()
  ).data;
  const dsl = structuredClone(
    baseline.versions.find(
      (v: { id: string }) => v.id === baseline.active_version_id,
    ).dsl_json,
  );
  const name = `复杂住宿人工样例-${Date.now()}`;
  const createdResponse = await write('/rules', {
    name,
    level: 'company',
    category: 'lodging',
    dsl_json: dsl,
    source_kind: 'policy',
    source_citation_ids: [citation.citation_id],
  });
  expect(createdResponse.ok(), await createdResponse.text()).toBe(true);
  const created = (await createdResponse.json()).data;
  await page.getByRole('button', { name: '制度与规则', exact: true }).click();
  await page.getByRole('tab', { name: '审核规则' }).click();
  await page
    .locator('.finance-rule')
    .filter({ hasText: name })
    .getByRole('button', { name: '查看与编辑' })
    .click();
  const editor = page.getByRole('dialog', {
    name: '公司审核规则',
    exact: true,
  });
  await expect(
    editor.getByText('高级：人工专用样例集', { exact: true }),
  ).toBeVisible({ timeout: 5000 });
  await editor.getByText('高级：人工专用样例集', { exact: true }).click();
  const input = (amount: string, nights: string | null) => ({
    schema_version: 1,
    document: {
      type: 'expense_claim',
      id: 'synthetic-lodging-test',
      version: 1,
    },
    business_date: '2026-11-05',
    applicant_id: 'synthetic-applicant',
    department_id: 'dept-sales',
    total_amount: { amount_minor: amount, currency: 'CNY' },
    expense_items: [
      {
        id: 'synthetic-room',
        category: 'lodging',
        source_expense_type: '住宿费',
        amount: { amount_minor: amount, currency: 'CNY' },
        invoice_refs: [],
        spent_on: '2026-11-05',
        room_nights: nights,
        oa_request_ref: null,
      },
    ],
    invoices: [],
    external_facts: {},
    field_states: {},
  });
  // 人工固定预期，不调用规则解释器推导答案。
  const cases = [
    {
      name: '两间夜少一分',
      input: input('159999', '2'),
      expected_truth: 'true',
    },
    {
      name: '两间夜恰等上限',
      input: input('160000', '2'),
      expected_truth: 'true',
    },
    {
      name: '两间夜超过一分',
      input: input('160001', '2'),
      expected_truth: 'false',
    },
    {
      name: '间夜数缺失',
      input: input('160000', null),
      expected_truth: 'unknown',
    },
  ];
  const register = async (setName: string, samples: typeof cases) => {
    await editor.getByLabel('样例集名称').fill(setName);
    await editor
      .getByLabel('人工样例（JSON）')
      .fill(JSON.stringify(samples, null, 2));
    const response = page.waitForResponse(
      (r) =>
        r.request().method() === 'POST' &&
        new URL(r.url()).pathname === `/api/v1/rules/${created.id}/test-sets`,
    );
    await editor.getByRole('button', { name: '登记当前草稿样例集' }).click();
    const registered = await response;
    expect(registered.status(), await registered.text()).toBe(201);
    const set = (await registered.json()).data;
    expect(set.case_count).toBe(4);
    expect(set.status).toBe('current');
    await expect(editor.getByLabel('测试样例集')).toHaveValue(set.id);
    return set;
  };
  const run = async (setId: string, passed: boolean) => {
    const response = page.waitForResponse(
      (r) =>
        r.request().method() === 'POST' &&
        new URL(r.url()).pathname === `/api/v1/rules/${created.id}/tests`,
    );
    await editor.getByRole('button', { name: '运行所选样例测试' }).click();
    const started = await response;
    expect(started.status()).toBe(202);
    const task = (await started.json()).data;
    await expect(
      editor.getByRole('heading', {
        name: passed ? '专用样例通过' : '样例尚未全部通过',
        exact: true,
      }),
    ).toBeVisible({ timeout: 30000 });
    await expect(editor.getByRole('status')).toContainText('4/4');
    const result = (
      await (
        await page.request.get(
          `/api/v1/rules/${created.id}/tests/${task.task_id}`,
        )
      ).json()
    ).data;
    expect(result.status).toBe('completed');
    expect(result.test_set_id).toBe(setId);
    expect(result.proof.passed).toBe(passed);
    expect(result.proof.results.map((r: { truth: string }) => r.truth)).toEqual(
      ['true', 'true', 'false', 'unknown'],
    );
    return result;
  };
  const publish = async () => {
    await editor.getByRole('button', { name: '核对并发布公司规则' }).click();
    const confirm = page.getByRole('dialog', {
      name: '确认本次操作',
      exact: true,
    });
    await expect(confirm).toContainText(name);
    const response = page.waitForResponse(
      (r) =>
        r.request().method() === 'POST' &&
        /\/confirmations\/[^/]+\/confirm$/.test(new URL(r.url()).pathname),
    );
    await confirm
      .getByRole('button', { name: '确认并执行', exact: true })
      .click();
    const actionResponse = await response;
    expect(actionResponse.ok()).toBe(true);
    const action = (await actionResponse.json()).data;
    expect(action.operation).toBe('rule.publish');
    expect(action.state).toBe('succeeded');
    expect(action.items[0].receipt.outcome).toBe('succeeded');
    const saved = (
      await (await page.request.get(`/api/v1/rules/${created.id}`)).json()
    ).data;
    expect(saved.draft_version_id).toBeNull();
    await page
      .getByRole('dialog', { name: '操作回执' })
      .getByRole('button', { name: '返回', exact: true })
      .click();
    return { saved, action };
  };
  const firstSet = await register('人工住宿四项-v1', cases);
  await run(firstSet.id, true);
  const firstPublished = await publish();
  await page
    .locator('.finance-rule')
    .filter({ hasText: name })
    .getByRole('button', { name: '查看与编辑' })
    .click();
  const nextDsl = structuredClone(dsl);
  nextDsl.predicate = {
    op: 'all',
    args: [
      dsl.predicate,
      { op: 'exists', value: { op: 'field', path: 'total_amount' } },
    ],
  };
  await editor
    .getByLabel('检查条件（声明式 JSON）')
    .fill(JSON.stringify(nextDsl, null, 2));
  const savedResponse = page.waitForResponse(
    (r) =>
      r.request().method() === 'PATCH' &&
      new URL(r.url()).pathname === `/api/v1/rules/${created.id}/draft`,
  );
  await editor.getByRole('button', { name: '保存公司草稿' }).click();
  const secondSaved = await savedResponse;
  expect(secondSaved.ok(), await secondSaved.text()).toBe(true);
  const secondDraft = (await secondSaved.json()).data;
  expect(secondDraft.active_version_id).toBe(
    firstPublished.saved.active_version_id,
  );
  expect(secondDraft.draft_version_id).not.toBe(
    firstPublished.saved.active_version_id,
  );
  await expect(editor.getByLabel('测试样例集')).toHaveValue('boundary-v1');
  await expect(
    editor
      .getByLabel('测试样例集')
      .getByRole('option', { name: /人工住宿四项-v1/ }),
  ).toHaveCount(0);
  await editor.getByText('高级：人工专用样例集', { exact: true }).click();
  const wrongCases = structuredClone(cases);
  wrongCases[2]!.expected_truth = 'true';
  const wrongSet = await register('人工错误预期-v2', wrongCases);
  const failed = await run(wrongSet.id, false);
  await expect(
    editor.getByRole('button', { name: '核对并发布公司规则' }),
  ).toBeDisabled();
  const denied = await write('/confirmations', {
    action: 'rule.publish',
    resource_refs: [
      { type: 'rule', id: created.id, version: secondDraft.version },
    ],
    args: {
      rule_id: created.id,
      expected_version: secondDraft.version,
      draft_hash: failed.proof.draft_hash,
      test_run_id: failed.proof.test_run_id,
    },
  });
  expect(denied.ok()).toBe(false);
  const stillPublished = (
    await (await page.request.get(`/api/v1/rules/${created.id}`)).json()
  ).data;
  expect(stillPublished.active_version_id).toBe(
    firstPublished.saved.active_version_id,
  );
  const finalSet = await register('人工正确预期-v2', cases);
  const passed = await run(finalSet.id, true);
  await expect(
    editor.getByRole('region', { name: '公司规则版本变化' }),
  ).toContainText('语义或依赖变化');
  await page.setViewportSize({ width: 390, height: 844 });
  await editor
    .getByRole('heading', { name: '专用样例通过' })
    .scrollIntoViewIfNeeded();
  await page.screenshot({
    path: testInfo.outputPath('复杂规则专用样例-窄屏.png'),
  });
  const overflow = await editor.evaluate(
    (element) => element.scrollWidth > element.clientWidth,
  );
  expect(overflow).toBe(false);
  await editor.getByRole('button', { name: '核对并发布公司规则' }).focus();
  await expect(
    editor.getByRole('button', { name: '核对并发布公司规则' }),
  ).toBeFocused();
  await page.keyboard.press('Tab');
  await page.setViewportSize({ width: 1280, height: 720 });
  await editor
    .getByRole('heading', { name: '专用样例通过' })
    .scrollIntoViewIfNeeded();
  await page.screenshot({
    path: testInfo.outputPath('复杂规则专用样例-桌面.png'),
  });
  const finalPublished = await publish();
  expect(finalPublished.saved.active_version_id).toBe(
    secondDraft.draft_version_id,
  );
  expect(
    finalPublished.saved.versions.find(
      (v: { id: string }) => v.id === firstPublished.saved.active_version_id,
    ),
  ).toEqual(
    firstPublished.saved.versions.find(
      (v: { id: string }) => v.id === firstPublished.saved.active_version_id,
    ),
  );
  await page
    .locator('.finance-rule')
    .filter({ hasText: name })
    .getByRole('button', { name: '停用公司规则' })
    .click();
  const disableConfirm = page.getByRole('dialog', {
    name: '确认本次操作',
    exact: true,
  });
  await expect(disableConfirm).toContainText('停用审核规则');
  await expect(disableConfirm).toContainText('停用后必查覆盖');
  const disableResponse = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      /\/confirmations\/[^/]+\/confirm$/.test(new URL(response.url()).pathname),
  );
  await disableConfirm
    .getByRole('button', { name: '确认并执行', exact: true })
    .click();
  const disabledAction = (await (await disableResponse).json()).data;
  expect(disabledAction.operation).toBe('rule.disable');
  expect(disabledAction.state).toBe('succeeded');
  expect(disabledAction.items[0].receipt.outcome).toBe('succeeded');
  const disabledRule = (
    await (await page.request.get(`/api/v1/rules/${created.id}`)).json()
  ).data;
  expect(disabledRule.active_version_id).toBeNull();
  expect(disabledRule.lifecycle).toBe('disabled');
  await testInfo.attach('复杂公司规则专用样例证据', {
    body: JSON.stringify(
      {
        rule_id: created.id,
        first_published: firstPublished.saved.active_version_id,
        failed_set: wrongSet.id,
        failed_proof_passed: failed.proof.passed,
        failed_publish_status: denied.status(),
        passed_set: finalSet.id,
        passed_proof_passed: passed.proof.passed,
        final_published: finalPublished.saved.active_version_id,
        action_id: finalPublished.action.id,
      },
      null,
      2,
    ),
    contentType: 'application/json',
  });
});

test('本人个人提醒可明确核对停用并获得统一账本回执', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /李娜.*销售部/ }).click();
  await expect(page.getByLabel('切换演示身份')).toBeEnabled();
  await page.getByRole('button', { name: '制度与规则', exact: true }).click();
  await page.getByRole('tab', { name: '审核规则' }).click();
  await page.getByRole('button', { name: '创建个人提醒' }).click();
  const editor = page.getByRole('dialog', {
    name: '个人餐饮费用提醒',
    exact: true,
  });
  const name = `个人停用验证-${Date.now()}`;
  await editor.getByLabel('规则名称').fill(name);
  await editor.getByLabel('每张单据餐饮合计严格超过（元）').fill('10000000.00');
  const savedResponse = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      new URL(response.url()).pathname === '/api/v1/rules',
  );
  await editor.getByRole('button', { name: '保存草稿', exact: true }).click();
  const rule = (await (await savedResponse).json()).data;
  await editor.getByRole('button', { name: '验证金额边界' }).click();
  await expect(
    editor.getByRole('heading', { name: '边界样例通过' }),
  ).toBeVisible({ timeout: 30000 });
  await editor.getByRole('button', { name: '核对并启用' }).click();
  await page
    .getByRole('dialog', { name: '确认本次操作', exact: true })
    .getByRole('button', { name: '确认并执行', exact: true })
    .click();
  const receipt = page.getByRole('dialog', { name: '操作回执', exact: true });
  await expect(receipt).toContainText('已完成');
  await receipt.getByRole('button', { name: '返回', exact: true }).click();
  await page
    .locator('.finance-rule')
    .filter({ hasText: name })
    .getByRole('button', { name: '停用个人提醒' })
    .click();
  const confirm = page.getByRole('dialog', {
    name: '确认本次操作',
    exact: true,
  });
  await expect(confirm).toContainText('停用本人提醒，不改变公司必查要求。');
  const response = page.waitForResponse(
    (result) =>
      result.request().method() === 'POST' &&
      /\/confirmations\/[^/]+\/confirm$/.test(new URL(result.url()).pathname),
  );
  await confirm
    .getByRole('button', { name: '确认并执行', exact: true })
    .click();
  const actionResponse = await response;
  expect(actionResponse.ok()).toBe(true);
  const action = (await actionResponse.json()).data;
  expect(action.operation).toBe('rule.disable');
  expect(action.state).toBe('succeeded');
  expect(action.items[0].receipt.outcome).toBe('succeeded');
  const current = (
    await (await page.request.get(`/api/v1/rules/${rule.id}`)).json()
  ).data;
  expect(current.lifecycle).toBe('disabled');
  expect(current.active_version_id).toBeNull();
});
