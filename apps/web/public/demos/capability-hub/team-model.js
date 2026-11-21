(() => {
  'use strict';

  const skills = [
    { key: 'materials', name: '材料完整性检查', description: '核对报销费用对应的票据和附件。', source: '报销单据', icon: 'checklist', color: '', connectors: ['bills'] },
    { key: 'policy', name: '差旅标准核对', description: '比对住宿费用与本次差旅适用的标准。', source: '报销单据、差旅制度库', icon: 'policy', color: 'gold', connectors: ['bills', 'rules'] },
    { key: 'supplier', name: '供应商主体核验', description: '核对供应商登记名称和经营状态。', source: '企查查', icon: 'building', color: 'mint', connectors: ['qcc'] }
  ];
  const connectors = [
    { key: 'bills', name: '报销单据', description: '费用明细与随单附件目录', icon: 'file' },
    { key: 'rules', name: '差旅制度库', description: '已发布的差旅住宿标准', icon: 'policy' },
    { key: 'qcc', name: '企查查', description: '供应商登记名称与经营状态的合成快照', icon: 'building' }
  ];
  const team = {
    name: '财务核验专家团',
    description: '根据任务核对报销材料、差旅标准或供应商主体。',
    skills: ['materials', 'policy', 'supplier'],
    connectors: ['bills', 'rules', 'qcc']
  };
  const lodgingRule = { title: '差旅住宿标准', source: '差旅制度库 · 示例制度第 4 条', limit: 500, quote: '本次差旅适用每人每晚 500.00 元标准。超出标准须补充说明，交由人工复核。' };

  function allowed(id, role) {
    if (role !== 'finance' && role !== 'employee') return false;
    return id === 'bills' || id === 'rules' || (id === 'qcc' && role === 'finance');
  }

  function scope(id, role) {
    if (!allowed(id, role)) return id === 'qcc' ? '当前身份无企查查查询权限。' : '当前身份无此数据连接的查询权限。';
    if (id === 'bills') return role === 'finance' ? '授权部门的示例报销单' : '本人的示例报销单';
    return id === 'qcc' ? '授权供应商的登记名称和经营状态' : '已发布的示例差旅制度';
  }

  function emptyResult() {
    return { status: 'clarify', message: '', usedSkills: [], usedConnectors: [], blocked: [], findings: [], missing: [], followup: [] };
  }

  const materialIntent = /附件|材料|票据|发票|车票|机票|行程单|缺票|缺件|缺什么票|缺哪些票|缺了?哪[^。]{0,4}票|漏票|补票|少票|缺不缺票|报销.{0,4}(?:还缺什么|缺什么|缺不缺材料)/;
  const policyIntent = /住宿|房费|酒店.{0,6}(?:费用|标准|限额|超标|报销)|差旅标准|差旅制度|差旅.{0,4}限额|每晚.{0,8}(?:限额|标准)|超标/;
  const supplierFields = /主体|登记名|企业名|公司名|供应商.{0,4}名称|工商|经营状态|登记状态|经营状况|是否存续|是否注销/;
  const broadReview = /预审|初审|审一下.{0,7}报销|报销.{0,5}(?:有没有问题|是否合规)|全面(?:检查|核对|审核)|整单(?:检查|核对|审核)|完整(?:检查|核对)|(?:合规|整体)(?:检查|核对|审查)|(?:审核|检查|核对)(?:整张|整笔|整份|整单|全部)(?:报销|单据)?/;
  const excluded = /不(?:需要|必|用|要|想|看|查|核|审|含|包含|包括|涉及|考虑|管|做|处理)|无需|无须|(?<!分)别(?:看|查|核|审|管|做|付款|打款|提交|转账|审批)|跳过|排除|忽略|略过|暂缓|除去/;
  const exclusive = /仅(?:需|要|查|看|核|做|考虑|检查|限)?|只(?:需|要|查|看|核|做|考虑|检查|想|处理|关心)/;

  function classify(clause) {
    const selected = [];
    if (materialIntent.test(clause)) selected.push('materials');
    if (policyIntent.test(clause)) selected.push('policy');
    if (supplierFields.test(clause) || /(?:和|与|及|还有)供应商|供应商(?:核验|检查|核对|和|与|及)/.test(clause) || (!selected.length && /供应商|企查查/.test(clause))) selected.push('supplier');
    if (broadReview.test(clause) && (!selected.length || /(?:预审|初审).{0,7}报销|报销.{0,4}(?:预审|初审)/.test(clause))) {
      selected.push('materials', 'policy');
    }
    return selected;
  }

  function unsupported(clause) {
    if (/付款|支付|打款|转账|放款|汇款|扣款/.test(clause)) return '付款操作须由有权限的经办人在支付流程中办理。';
    if (/审批|批准|代签|提交|驳回|退回|同意报销|审核通过/.test(clause)) return '提交和审批须在对应单据的办理流程中完成。';
    if (/订(?:酒店|房|票)|预订|预定(?:酒店|房)|购买|开具?发票/.test(clause)) return '此专家团仅处理核验业务。';
    if (/(?:推荐|好评|有哪些好|预订价格|查酒店价格|酒店推荐)/.test(clause)) return '此专家团提供报销与供应商核验。';
    if (/真伪|验真|真不真|异常经营名录|经营异常名录|发票查验|发票抬头|税率|银行账户|开户行|股权|征信|法人电话|黑名单/.test(clause)) return '所需字段超出已连接的数据范围。';
    if (/机票|餐补|伙食|餐饮|补助|交通/.test(clause) && /限额|补贴标准|报销标准|超标|上限/.test(clause) && !/住宿/.test(clause)) {
      return '差旅制度库当前提供住宿标准。';
    }
    return '';
  }

  function roleQuestion(text, role) {
    if (!/(?:我|员工|财务|复核员|身份).{0,4}(?:能否|能不能|可以|能)(?:查|用|查询|核验)|(?:能查|能用|可以查)(?:哪些|谁的)|(?:我的|查看|查询|有无|有哪些|什么)(?:身份|权限)|有没有.{0,10}权限/.test(text)) return null;
    const askedRole = /(?:员工|财务(?:复核员)?)(?=.{0,2}(?:能否|能不能|可以|能))/.exec(text);
    const describedRole = askedRole ? (askedRole[0] === '员工' ? 'employee' : 'finance') : role;
    const ids = /供应商|企查查/.test(text) ? ['qcc'] : /报销单|单据/.test(text) ? ['bills'] : team.connectors;
    const result = emptyResult();
    result.message = (describedRole === 'finance' ? '财务复核员' : describedRole === 'employee' ? '普通员工' : '当前身份') + '的查询范围如下。' + ids.map(id => {
      const name = connectors.find(c => c.key === id).name;
      return allowed(id, describedRole) ? name + '可查询' + scope(id, describedRole) + '。' : '无' + name + '查询权限。';
    }).join('');
    return result;
  }

  function route(raw) {
    const text = String(raw || '').normalize('NFKC').trim();
    const requested = new Set(), skipped = new Set(), only = new Set(), notices = new Set();
    let hardLimit = false;
    // Keep “附件和供应商” in one clause so a preceding “不查” or “只查” applies to the whole list.
    const normalized = text.replace(/不(?:只是|仅仅是|仅是|仅|只是要)/g, '')
      .replace(/除了(.+?)以?外/g, '跳过$1，')
      .replace(/(供应商(?:主体)?|附件|票据|材料|住宿(?:标准)?)(?:先)?(不用|不必|无需)(查|核对|看|检查)/g, '，$2$3$1，')
      .replace(/(?:但是?|不过|然后|接着|之后|同时|另外|并且|并(?=核|查|检|付|审|提|看|预)|再(?=核|查|检|付|审|提|看)|还(?:要|需|请))/g, '，')
      .replace(new RegExp('(?=(?:' + excluded.source + '|' + exclusive.source + '))', 'g'), '，');
    for (const part of normalized.split(/[，,。；;！!？?\n]+/)) {
      const clause = part.trim();
      if (!clause) continue;
      const negative = excluded.test(clause);
      const narrow = exclusive.test(clause);
      const limitation = unsupported(clause);
      if (limitation) {
        if (!negative) notices.add(limitation);
        continue;
      }
      if (narrow) hardLimit = true;
      for (const key of classify(clause)) {
        (negative ? skipped : requested).add(key);
        if (narrow && !negative) only.add(key);
      }
    }
    const keys = team.skills.filter(key => requested.has(key) && !skipped.has(key) && (!hardLimit || only.has(key)));
    return { keys, notices: [...notices] };
  }

  function ownRecord(records, key) {
    return typeof key === 'string' && records && Object.hasOwn(records, key) ? records[key] : undefined;
  }

  function billEvidence(skill, bill, rule, money) {
    if (skill === 'policy') return [
      { title: '住宿费用', source: bill.id + ' · 住宿发票', quote: bill.city + '住宿 2 晚，合计 ' + money(bill.hotel * 2) + '，每晚 ' + money(bill.hotel) + '。' },
      { title: rule.title, source: rule.source, quote: rule.quote }
    ];
    return [
      { title: '单据费用明细', source: bill.id + ' · 市内交通', quote: '网约车费用 ' + money(bill.taxi) + '。' },
      { title: '随单材料', source: bill.id + ' · 附件目录', quote: '往返车票、住宿发票、网约车发票' + (bill.tripSheet ? '、电子行程单。' : '。本单未附电子行程单。') },
      { title: '网约车报销材料要求', source: '技能内置核对要求 · 示例制度第 8 条', quote: '报销网约车费须同时提供发票和电子行程单。' }
    ];
  }

  function checkBill(skill, bill, rule, env, result) {
    const material = skill === 'materials';
    if (material ? typeof bill.tripSheet !== 'boolean' || !Number.isFinite(bill.taxi) : !Number.isFinite(bill.hotel)) {
      result.missing.push(material ? '请补充费用明细及随单附件目录。' : '请补充住宿发票或每晚住宿金额。');
      return;
    }
    const [, issue, title, body] = env.getChecks(skill, bill)[0];
    result.findings.push({ skill, title, body, issue, evidence: billEvidence(skill, bill, rule, env.money) });
    result.usedSkills.push(skill);
    if (!issue) return;
    if (material) result.followup.push('补交与 ' + env.money(bill.taxi) + ' 网约车发票对应的电子行程单。');
    else result.followup.push('补充住宿超标 ' + env.money((bill.hotel - rule.limit) * 2) + ' 的书面说明，写明实际原因。');
  }

  function checkSupplier(record, text, result) {
    const asksStatus = /经营状态|登记状态|经营状况|是否存续|是否注销/.test(text);
    const asksName = /名称|登记名|公司名|企业名/.test(text);
    const checkName = asksName || !asksStatus;
    const checkStatus = asksStatus || !asksName;
    if (!record.name || (checkName && !record.registered) || (checkStatus && !record.status)) {
      result.missing.push('请补充供应商的登记资料后重新核验。');
      return;
    }
    const mismatch = checkName && record.name !== record.registered;
    const inactive = checkStatus && !['存续', '在业', '开业'].includes(record.status);
    const body = [], evidence = [];
    if (checkName) {
      body.push('供应商名称为“' + record.name + '”，登记名称为“' + record.registered + '”。');
      evidence.push({ title: '待核供应商', source: '本次核验对象 · 示例供应商主数据', quote: record.name });
      evidence.push({ title: '企业登记名称', source: '企查查 · 合成登记快照', quote: record.registered });
    }
    if (checkStatus) {
      body.push('登记经营状态为“' + record.status + '”。');
      evidence.push({ title: '企业经营状态', source: '企查查 · 合成登记快照', quote: record.registered + ' · ' + record.status });
    }
    const title = mismatch ? '供应商名称待核实' : inactive ? '供应商经营状态待核实' :
      checkName && checkStatus ? '供应商名称一致，经营状态正常' : checkName ? '供应商名称一致' : '经营状态为' + record.status;
    result.findings.push({ skill: 'supplier', title, body: body.join(''), issue: Boolean(mismatch || inactive), evidence });
    result.usedSkills.push('supplier');
    if (mismatch) result.followup.push('请核实供应商登记名称，并补充对应的主体证明。');
    if (inactive) result.followup.push('请复核供应商当前经营状态。');
  }

  function execute(keys, input, env, notices = [], connectorPool = team.connectors) {
    const result = emptyResult();
    const snapshots = new Map();
    function read(id) {
      if (snapshots.has(id)) return snapshots.get(id);
      const value = id === 'rules' ? lodgingRule : id === 'bills' ?
        ownRecord(env.bills, input.billKey) : ownRecord(env.suppliers, input.supplierKey);
      snapshots.set(id, value);
      if (value) result.usedConnectors.push(id);
      return value;
    }
    for (const skill of skills.filter(s => keys.includes(s.key))) {
      const absent = skill.connectors.find(id => !connectorPool.includes(id));
      if (absent) {
        const source = connectors.find(c => c.key === absent);
        result.blocked.push({ skill: skill.key, connector: absent, reason: '专家团未配置' + (source?.name || absent) + '连接器。' });
        continue;
      }
      const denied = skill.connectors.find(id => !allowed(id, input.role));
      if (denied) {
        result.blocked.push({ skill: skill.key, connector: denied, reason: scope(denied, input.role) });
        continue;
      }
      const supplier = skill.key === 'supplier';
      const key = supplier ? input.supplierKey : input.billKey;
      const record = key ? read(supplier ? 'qcc' : 'bills') : undefined;
      if (!record) {
        const missing = supplier ? '请选择本次核验的示例供应商。' : '请选择本次核对的示例报销单。';
        if (!result.missing.includes(missing)) result.missing.push(missing);
        continue;
      }
      const text = input.text || '';
      const billId = text.match(/\bBX-\d+-\d+\b/i)?.[0].toUpperCase();
      const cities = text.match(/北京|杭州/g) || [];
      const supplierNames = text.match(/青屿|棠木/g) || [];
      const conflict = supplier ? supplierNames.some(name => !record.name?.includes(name)) :
        (billId && billId !== record.id) || cities.some(city => city !== record.city);
      if (conflict) {
        const hint = supplier ? '任务中的供应商与已选对象不一致，请重新选择供应商。' : '任务中的单号或城市与已选报销单不一致，请重新选择报销单。';
        if (!result.missing.includes(hint)) result.missing.push(hint);
        continue;
      }
      if (supplier) checkSupplier(record, input.text || '', result);
      else checkBill(skill.key, record, skill.key === 'policy' ? read('rules') : undefined, env, result);
    }
    const denied = result.blocked.length || notices.length;
    if (result.findings.length) {
      result.status = denied || result.missing.length ? 'partial' : 'done';
      const issues = result.findings.filter(f => f.issue).length;
      result.message = '已完成' + result.usedSkills.map(key => skills.find(s => s.key === key).name).join('、') + '。' +
        (issues ? '有 ' + issues + ' 项需要补充或核实。' : '所核项目均相符。');
      if (result.blocked.length) result.message += '另有核验受限，详见执行记录。';
      if (result.missing.length) result.message += '其余核验还需补充材料。';
    } else if (denied) {
      result.status = 'blocked';
      result.message = result.blocked.length ? result.blocked.map(b => b.reason).join('') : '';
    } else if (result.missing.length) {
      result.message = result.missing.join('');
    } else {
      result.message = '请说明想核对哪项业务，例如报销附件、住宿标准或供应商主体。';
    }
    result.message += notices.join('');
    return result;
  }

  function run(input, env) {
    const text = String(input.text || '');
    // The authenticated role is supplied by the workspace. Instructions in the task cannot expand it.
    if (/全公司|所有(?:员工|部门|同事)|其他部门|跨部门|任意(?:报销单|员工)|越权|绕过权限/.test(text) ||
        (input.role === 'employee' && /同事的|他人的|别人的|其他(?:人|员工)的|全部门/.test(text))) {
      return execute([], input, env, ['所请求的查询范围超出当前身份的授权。']);
    }
    if (/(?:开通|申请|授予|提升|修改|切换).{0,8}(?:权限|身份)/.test(text)) {
      return execute([], input, env, ['请联系权限管理员办理授权。']);
    }
    const rights = roleQuestion(text, input.role);
    if (rights) return rights;
    const plan = route(text);
    return execute(plan.keys, input, env, plan.notices);
  }

  function runSkill(key, input, env) {
    const skill = skills.find(s => s.key === key);
    return execute(skill ? [key] : [], { ...input, text: '' }, env, [], skill?.connectors || []);
  }

  window.teamModel = { skills, connectors, team, allowed, scope, run, runSkill };
})();
