"""可编辑语义场景目录与一次性、保留用户内容的历史规则迁移。"""
from __future__ import annotations

from copy import deepcopy
from datetime import datetime, timezone

CATALOG_AT = '2026-11-17T00:00:00+08:00'
MIGRATION_REASON = '通用OA附件示例不适合作为所有差旅申请的必填要求；停用原始示例，按实际业务材料要求检查。历史版本与草稿保留。'


def _v1_demo_rules() -> list[dict]:
    """返回独立副本；这些个人提醒示例不是企业制度。"""
    definitions = [
        ('SEM-TRAVEL-001', '差旅事由明确性', 'oa', 'itinerary', ['purpose', 'activities'],
         '检查差旅事由是否明确说明业务事项、业务对象及本次出差要完成的任务。已提供事由但仅写出差、办事、拜访等笼统内容，且活动安排也无法补充业务目标时命中；具体对象、事项与任务齐备时不命中；事由或必要上下文未提供时证据不足。'),
        ('SEM-TRAVEL-002', '差旅私人活动风险', 'oa', 'itinerary', ['purpose', 'legs', 'activities'],
         '检查差旅申请的事由、行程和活动安排中是否明确包含私人旅游、探亲、个人购物或其他与业务无关的活动，并被纳入本次申请行程或费用。只有明确肯定的安排才命中；未安排旅游、取消探亲、私人活动自费且不计入申请等否定或排除说明不命中；仅有景点地名、可能性或未说明活动性质时证据不足，不得按关键词判断。'),
        ('SEM-TRAVEL-003', '行程与业务安排一致性', 'oa', 'itinerary', ['purpose', 'legs', 'activities'],
         '对照差旅出发到达城市和日期、业务事由及活动日期地点。明确出现业务活动地点与行程不符、活动日期完全不在到访日期内且无合理说明时命中；地点日期一致或明确合理解释变更时不命中；缺少行程或业务活动地点日期依据时证据不足，不得自行推测交通时间。'),
        ('SEM-EXPENSE-001', '业务招待高档消费风险', 'expense', 'business_entertainment', ['purpose', 'expenses', 'files'],
         '招待费用中涉及高档消费时，提单和审单时提醒本人。根据费用用途、招待明细和已提供附件文字判断是否明确包含高档酒水、奢侈食材或娱乐会所等高档消费；明确实际购买或消费时命中；未点高档酒水、不含高档消费、取消未付款、引用禁止事项等否定语境不得命中；仅有餐厅名称、金额偏高或模糊套餐而无消费内容依据时证据不足，不编造金额阈值或企业禁令。'),
        ('SEM-EXPENSE-002', '费用用途与报销事由一致性', 'expense', 'general', ['purpose', 'expenses', 'files'],
         '逐项对照费用用途和报销事由。明确费用用于私人事项或与本次业务目标不相容且无合理说明时命中；明细业务用途与事由一致，或有明确的合理业务关联时不命中；缺少具体费用用途、报销事由或关联依据时证据不足。仅文字不同不得认定用途不符。'),
        ('SEM-EXPENSE-003', '业务招待信息完整性', 'expense', 'business_entertainment', ['purpose', 'expenses', 'files'],
         '对确认属于业务招待的费用，检查是否明确记录招待对象、实际人数和业务目的；明细或附件明确缺失、留空或写待补充其中任一项时命中；三项在已提供信息中齐备时不命中；无法确认是否业务招待或相关资料尚未取得时证据不足。不得根据金额推算人数或虚构招待对象。'),
    ]
    result = []
    for rule_id, name, system, category, fields, instruction in definitions:
        logic = instruction if rule_id == 'SEM-EXPENSE-001' else f'{name}存在需核实的问题时，提单和审单时提醒本人。'
        evidence = [{'name': {'purpose': '业务事由', 'activities': '业务活动安排', 'legs': '差旅行程', 'expenses': '费用明细', 'files': '附件元数据及已提取文字'}[field],
                     'source': field, 'purpose': '仅核对已提供的业务事实，并定位原文证据'} for field in fields]
        result.append({
            'id': rule_id, 'name': name, 'system': system, 'origin': 'personal',
            'scope': 'both', 'metric': 'semantic', 'effect': 'warn', 'enabled': True,
            'version': 1, 'description': instruction, 'instruction': instruction,
            'requiredFields': list(fields), 'documentTypes': ['travel'] if system == 'oa' else ['expense', 'personal'],
            'category': category, 'logic': logic, 'source': '场景示例',
            'applicability': ['差旅申请' if system == 'oa' else '差旅报销及个人费用报销', '提单和审单场景'],
            'evidence': evidence, 'output': '逐规则返回命中、未命中或待核实；提供中文原因及可定位的原文证据。命中仅提醒本人。',
            'missing': '必要事实或依据不足时标记为待核实，并列明待补内容，不推测结论。',
            'updatedAt': CATALOG_AT, 'stage': 'published',
            'revisions': [{'version': 1, 'at': CATALOG_AT, 'summary': '创建个人语义场景示例；示例不作为企业制度。', 'logic': logic}],
        })
    return result


def demo_rules() -> list[dict]:
    """默认必需字段只列出实际决策不可缺少的事实。"""
    rules = _v1_demo_rules()
    for rule in rules:
        if rule['id'] in ('SEM-TRAVEL-001', 'SEM-TRAVEL-002'):
            rule['requiredFields'] = ['purpose']
        elif rule['id'] == 'SEM-EXPENSE-001':
            rule['requiredFields'] = ['purpose']
            instruction = '招待费用事由中涉及高档消费时，提单和审单时提醒本人。仅根据已提供的事由判断：明确描述已发生或计划安排高档酒水、奢侈食材、娱乐会所等高档消费时命中；未安排、不包含、已取消且不发生费用、引用禁止事项等否定或排除语境不命中；仅有餐厅名称、金额偏高、可能性或模糊套餐而无高档消费事实时证据不足。不得按关键词或编造金额阈值、企业禁令判断。'
            rule.update(instruction=instruction, description=instruction, logic=instruction)
            rule['revisions'][0]['logic'] = instruction
        elif rule['id'] in ('SEM-EXPENSE-002', 'SEM-EXPENSE-003'):
            rule['requiredFields'] = ['purpose', 'expenses']
        rule['evidence'] = [item for item in rule['evidence'] if item['source'] != 'files']
        if rule['id'] == 'SEM-EXPENSE-001':
            rule['evidence'] = [item for item in rule['evidence'] if item['source'] == 'purpose']
        rule['instruction'] = rule['instruction'].replace('和已提供附件文字', '').replace('明细或附件', '事由或明细')
        rule['description'] = rule['instruction']
    return rules


def demo_cases() -> list[dict]:
    """合成测试材料，场景标签在单据外；不会写入业务单据列表。"""
    def legs(city='上海', day='2026-11-20'):
        return [{'id': 'synthetic-go', 'departureCity': '北京', 'arrivalCity': city, 'departureDate': day, 'arrivalDate': day, 'transport': '高铁'},
                {'id': 'synthetic-back', 'departureCity': city, 'arrivalCity': '北京', 'departureDate': '2026-11-22', 'arrivalDate': '2026-11-22', 'transport': '高铁'}]

    def activities(description, day='2026-11-21'):
        return [{'id': 'synthetic-activity', 'description': description, 'effectiveDate': day, 'expiryDate': day}]

    def expense(reason, **extra):
        return [{'id': 'synthetic-expense', 'categoryId': 'meal-business', 'categoryName': '业务招待费', 'categoryGroup': 'meal', 'name': '业务招待餐费', 'currency': 'CNY', 'amount': '860.00', 'date': '2026-11-21', 'reason': reason, 'files': [], **extra}]

    materials = [
        ('SEM-TRAVEL-001', [
            ('hit', '事由过于笼统', {'purpose': '出差办事', 'activities': activities('外出办事')}),
            ('clear', '业务事项具体', {'purpose': '赴上海与合成客户甲方开展供应链系统验收，完成接口联调及验收清单签署', 'activities': activities('上海甲方办公室：供应链系统接口联调和验收签署')}),
            ('unknown', '尚未提供事由', {'purpose': None, 'activities': []}),
        ]),
        ('SEM-TRAVEL-002', [
            ('hit', '私人旅游计入申请', {'purpose': '上海客户验收后安排私人旅游，游览门票及延长住宿纳入本次差旅申请', 'legs': legs(), 'activities': activities('11月21日办理客户验收，22日私人游览景点并申请报销')}),
            ('clear', '否定私人活动', {'purpose': '上海客户系统验收；未安排私人旅游或探亲，取消的个人游览未发生费用，不计入申请', 'legs': legs(), 'activities': activities('上海客户办公室完成系统验收，无私人活动')}),
            ('unknown', '活动性质未明确', {'purpose': '赴上海处理项目事项', 'legs': legs(), 'activities': activities('外滩附近活动，性质及费用归属待确认')}),
        ]),
        ('SEM-TRAVEL-003', [
            ('hit', '活动与到访地点不符', {'purpose': '11月21日在广州合成客户办公室现场验收', 'legs': legs('上海'), 'activities': activities('广州客户办公室现场验收，必须现场参加，无线上或行程变更安排')}),
            ('clear', '地点及日期一致', {'purpose': '11月21日在上海合成客户办公室验收', 'legs': legs(), 'activities': activities('上海客户办公室现场验收')}),
            ('unknown', '缺少活动日期地点', {'purpose': '赴客户处验收', 'legs': legs(), 'activities': []}),
        ]),
        ('SEM-EXPENSE-001', [
            ('hit', '明确实际高档消费', {'purpose': '合成客户甲方项目验收业务招待，计划安排高档白酒两瓶及鱼翅套餐并纳入招待费用', 'expenses': expense('实际招待餐中购买高档白酒两瓶及鱼翅套餐，均已消费付款', people='4')}),
            ('clear', '否定与取消消费', {'purpose': '合成客户甲方验收普通工作餐；未安排高档酒水，不含鱼翅，原拟高档套餐已取消且不发生费用', 'expenses': expense('普通工作餐，未点高档酒水，不含鱼翅；原拟高档套餐已取消未付款', people='4')}),
            ('unknown', '套餐内容缺证据', {'purpose': '合成客户甲方项目招待，拟选商务套餐，具体菜品及酒水尚未确认', 'expenses': expense('商务套餐，具体菜品及酒水清单尚未取得', people='4')}),
        ]),
        ('SEM-EXPENSE-002', [
            ('hit', '私人用途与事由不符', {'purpose': '采购项目联调所需办公耗材', 'expenses': expense('实际为本人家用生日聚餐，与项目无关', categoryId='other-office', categoryName='办公用品', categoryGroup='other', name='办公用品')}),
            ('clear', '用途有明确业务关联', {'purpose': '采购项目联调所需办公耗材', 'expenses': expense('采购联调测试记录用打印纸及标签，全部用于该项目', categoryId='other-office', categoryName='办公用品', categoryGroup='other', name='办公耗材')}),
            ('unknown', '具体用途尚未提供', {'purpose': '项目支出', 'expenses': expense('费用具体用途待补充', categoryId='other-office', categoryName='其他费用', categoryGroup='other', name='其他费用')}),
        ]),
        ('SEM-EXPENSE-003', [
            ('hit', '招待要素明确缺失', {'purpose': '项目验收业务招待', 'expenses': expense('业务招待记录：招待对象未填写，实际人数未填写，业务目的为验收沟通', people='')}),
            ('clear', '招待要素齐备', {'purpose': '项目验收业务招待', 'expenses': expense('招待对象：合成客户甲方验收团队；实际人数4人；业务目的：确认接口验收清单和交付时间', people='4')}),
            ('unknown', '资料未取得', {'purpose': '日常费用报销', 'expenses': [{'id': 'synthetic-expense', 'name': '餐费', 'categoryId': 'meal', 'categoryName': '餐饮费', 'categoryGroup': 'meal', 'currency': 'CNY', 'amount': '860.00', 'reason': '餐饮资料尚未取得，无法确认是员工工作餐还是业务招待', 'files': []}]}),
        ]),
    ]
    result = []
    for rule_id, cases in materials:
        system = 'oa' if 'TRAVEL' in rule_id else 'expense'
        document_type = 'travel' if system == 'oa' else 'personal'
        for scenario, name, document in cases:
            result.append({'id': f'{rule_id}-{scenario}', 'name': f'合成样例：{name}', 'ruleId': rule_id, 'system': system,
                           'documentType': document_type, 'scenario': scenario,
                           'document': {'documentType': document_type, 'system': system, 'files': [], **document}})
    return result


def _original_oa_attachment(rule):
    """保守匹配；修改了业务定义的同ID规则必须留给用户。"""
    expected = {'id': 'R005', 'name': '申请材料完整性', 'system': 'oa', 'origin': 'builtin', 'scope': 'both', 'metric': 'attachment', 'effect': 'block', 'description': 'OA申请须附对应的证明材料。'}
    if any(rule.get(key) != value for key, value in expected.items()):
        return False
    if rule.get('instruction') or rule.get('documentTypes') or rule.get('requiredFields'):
        return False
    return rule.get('logic', 'OA申请缺少对应证明材料时，阻断提单。') == 'OA申请缺少对应证明材料时，阻断提单。'


def migrate_rules(data: dict) -> bool:
    """原地进行一次性迁移，保存源定义，不覆盖个人编辑或历史签名。"""
    if not isinstance(data, dict):
        return False
    keys = ('rulesSubmission', 'srsRuleCenterV1')
    if not all(isinstance(data.get(key), dict) and isinstance(data[key].get('rules'), list) for key in keys):
        return False
    if not any(data[key]['rules'] for key in keys):
        return False
    if isinstance(data.get('ruleMigration'), dict) and data['ruleMigration'].get('version', 0) >= 2:
        return False
    if isinstance(data.get('ruleMigration'), dict) and data['ruleMigration'].get('version') == 1:
        return _upgrade_v1_catalog(data)
    at = datetime.now(timezone.utc).isoformat()
    originals = {key: deepcopy(data[key]['rules']) for key in keys}
    decisions, seen, changed_systems = [], set(), set()
    original_r005 = [rule for key in keys for rule in data[key]['rules'] if rule.get('id') == 'R005']
    disable_r005 = bool(original_r005) and all(_original_oa_attachment(rule) for rule in original_r005)
    for key in keys:
        center = data[key]
        for rule in center['rules']:
            rule_id = rule.get('id')
            if rule_id not in seen:
                action = 'disabled' if rule_id == 'R005' and disable_r005 else 'preserved'
                reason = MIGRATION_REASON if action == 'disabled' else '保留当前定义、版本、阈值和启停状态；个人规则与草稿不作覆盖。'
                if rule_id == 'R005' and not disable_r005:
                    reason = '同ID规则已有实质业务修改，不自动停用，保留用户当前定义。'
                decisions.append({'id': rule_id, 'name': rule.get('name', str(rule_id)), 'action': action, 'reason': reason})
                seen.add(rule_id)
            if rule_id == 'R005' and disable_r005:
                old_version = rule.get('version', 1)
                logic = rule.get('logic', 'OA申请缺少对应证明材料时，阻断提单。')
                revisions = rule.setdefault('revisions', [])
                if not any(revision.get('version') == old_version for revision in revisions):
                    revisions.append({'version': old_version, 'at': rule.get('updatedAt', at), 'summary': '保留迁移前OA附件示例版本', 'logic': logic})
                rule['enabled'] = False
                rule['version'] = old_version + 1
                rule['updatedAt'] = at
                revisions.append({'version': rule['version'], 'at': at, 'summary': MIGRATION_REASON, 'logic': logic})
                changed_systems.add('oa')
        existing_ids = {rule.get('id') for rule in center['rules']}
        for example in demo_rules():
            if example['id'] in existing_ids:
                continue
            center['rules'].append(example)
            changed_systems.add(example['system'])
            if example['id'] not in seen:
                decisions.append({'id': example['id'], 'name': example['name'], 'action': 'added', 'reason': '新增可编辑的个人语义提醒场景示例；不作为企业制度。'})
                seen.add(example['id'])
    data['ruleMigration'] = {'version': 2, 'at': at, 'decisions': decisions, 'originals': originals}
    if changed_systems:
        checks = data.get('submissions', {}).get('checks')
        if isinstance(checks, dict):
            checks.clear()
        reviewed_at = data['rulesSubmission'].get('reviewedAt')
        if isinstance(reviewed_at, dict):
            for system in changed_systems:
                if system in reviewed_at:
                    reviewed_at[system] = ''
    return True


def _upgrade_v1_catalog(data):
    """仅升级本次发布后尚未编辑的默认定义，原始快照保持原样。"""
    previous = {rule['id']: rule for rule in _v1_demo_rules()}
    current = {rule['id']: rule for rule in demo_rules()}
    at = datetime.now(timezone.utc).isoformat()
    changed_systems = set()
    decisions = data['ruleMigration'].setdefault('decisions', [])
    for key in ('rulesSubmission', 'srsRuleCenterV1'):
        for rule in data[key]['rules']:
            old = previous.get(rule.get('id'))
            if old is None or rule != old or current[rule['id']] == old:
                continue
            replacement = deepcopy(current[rule['id']])
            replacement['version'] = rule['version'] + 1
            replacement['updatedAt'] = at
            replacement['revisions'] = deepcopy(rule['revisions']) + [{'version': replacement['version'], 'at': at, 'summary': '收窄必要字段，招待高档消费按事由判断并覆盖明确计划；附件仅使用元数据。', 'logic': replacement['logic']}]
            rule.update(replacement)
            changed_systems.add(rule['system'])
            if not any(item.get('id') == rule['id'] and item.get('action') == 'updated' for item in decisions):
                decisions.append({'id': rule['id'], 'name': rule['name'], 'action': 'updated', 'reason': '修正未编辑场景示例的必要字段与业务判断范围，保留先前版本。'})
    if changed_systems:
        checks = data.get('submissions', {}).get('checks')
        if isinstance(checks, dict):
            checks.clear()
        reviewed_at = data['rulesSubmission'].get('reviewedAt', {})
        for system in changed_systems:
            if system in reviewed_at:
                reviewed_at[system] = ''
    data['ruleMigration']['version'] = 2
    data['ruleMigration']['updatedAt'] = at
    return True
