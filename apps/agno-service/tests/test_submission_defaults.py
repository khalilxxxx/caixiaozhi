from copy import deepcopy

import pytest

from business import Business, BusinessError


@pytest.fixture
def workspace(tmp_path):
    from store import Store
    store = Store(tmp_path / 'defaults.db')
    return store, Business(store)


def leg(**values):
    return {'id': 'go', 'arrivalCity': '上海', 'departureDate': '2026-11-20', **values}


def update_leg(business, draft, **values):
    legs = deepcopy(draft['legs'])
    legs[0].update(values)
    return business.update_draft('travel', {'legs': legs})['draft']


def test_business_applies_defaults_without_external_dependencies():
    from test_business import MemoryStore
    business = Business(MemoryStore())
    draft = business.update_draft('travel', {'legs': [leg()]})['draft']
    assert draft['legs'][0]['departureCity'] == '杭州'
    assert draft['legs'][0]['transport'] == '火车-二等座'


def test_missing_fields_are_filled_with_sources_without_inventing_return(workspace):
    _, business = workspace
    draft = business.update_draft('travel', {'legs': [leg()]})['draft']
    assert len(draft['legs']) == 1
    assert draft['legs'][0]['departureCity'] == '杭州'
    assert draft['legs'][0]['transport'] == '火车-二等座'
    assert draft['legs'][0]['arrivalDate'] == '2026-11-20'
    fields = draft['autoFill']['fields']
    assert fields['legs.go.departureCity']['value'] == '杭州'
    assert fields['legs.go.transport']['ruleId']
    assert '本地' in fields['legs.go.transport']['source']
    assert '本地' in fields['legs.go.departureCity']['source']


@pytest.mark.parametrize('destination,expected', [('上海', '火车-二等座'), ('北京', '飞机-经济舱'), ('未知城', '')])
def test_local_route_reference_recommends_only_known_routes(workspace, destination, expected):
    _, business = workspace
    draft = business.update_draft('travel', {'legs': [leg(arrivalCity=destination)]})['draft']
    assert draft['legs'][0]['transport'] == expected
    assert draft['legs'][0]['arrivalDate'] == '2026-11-20'


@pytest.mark.parametrize('transport,expected', [('高铁','火车-二等座'), ('动车','火车-二等座'), ('火车','火车-二等座'), ('飞机','飞机-经济舱'), ('火车-一等座','火车-一等座'), ('飞机-商务舱','飞机-商务舱')])
def test_explicit_mode_keeps_choice_and_only_completes_missing_seat(workspace, transport, expected):
    _, business = workspace
    draft = business.update_draft('travel', {'legs': [leg(arrivalCity='北京', transport=transport)]})['draft']
    assert draft['legs'][0]['transport'] == expected


def test_unknown_applicant_does_not_receive_current_employees_base(workspace):
    _, business = workspace
    draft = business.update_draft('travel', {'applicant': '其他员工', 'legs': [leg()]})['draft']
    assert draft['legs'][0]['departureCity'] == ''
    assert draft['legs'][0]['transport'] == ''
    assert business.get_draft('travel')['submissionContext']['employee'] is None


def test_explicit_values_and_clears_survive_dependency_changes(workspace):
    _, business = workspace
    draft = business.update_draft('travel', {'legs': [leg()]})['draft']
    draft = update_leg(business, draft, transport='火车-一等座', arrivalDate='2026-11-21')
    draft = update_leg(business, draft, arrivalCity='北京', departureDate='2026-11-22')
    assert draft['legs'][0]['transport'] == '火车-一等座'
    assert draft['legs'][0]['arrivalDate'] == '2026-11-21'
    draft = update_leg(business, draft, transport='', departureCity='', arrivalDate='')
    assert {'legs.go.transport','legs.go.departureCity','legs.go.arrivalDate'} <= set(draft['autoFill']['suppressed'])
    draft = update_leg(business, draft, arrivalCity='上海')
    assert draft['legs'][0]['transport'] == draft['legs'][0]['departureCity'] == draft['legs'][0]['arrivalDate'] == ''


def test_generated_values_recompute_when_dependencies_change(workspace):
    _, business = workspace
    draft = business.update_draft('travel', {'legs': [leg()]})['draft']
    draft = update_leg(business, draft, departureDate='2026-11-21')
    assert draft['legs'][0]['arrivalDate'] == '2026-11-21'
    draft = update_leg(business, draft, arrivalCity='北京')
    assert draft['legs'][0]['transport'] == '飞机-经济舱'
    assert draft['legs'][0]['arrivalDate'] == '2026-11-21'
    draft = update_leg(business, draft, arrivalCity='未知城')
    assert draft['legs'][0]['transport'] == ''


def test_return_chains_to_actual_first_origin_and_never_invents_date(workspace):
    _, business = workspace
    draft = business.update_draft('travel', {'legs': [leg(departureCity='南京'), {'id':'back','isReturn':True}]})['draft']
    assert draft['legs'][1]['departureCity'] == '上海'
    assert draft['legs'][1]['arrivalCity'] == '南京'
    assert draft['legs'][1]['departureDate'] == draft['legs'][1]['arrivalDate'] == ''
    assert 'isReturn' in business.get_draft('travel')['legFields']


def test_nonreturn_missing_destination_is_not_invented(workspace):
    _, business = workspace
    draft = business.update_draft('travel', {'legs': [leg(), {'id':'next'}]})['draft']
    assert draft['legs'][1]['departureCity'] == '上海'
    assert draft['legs'][1]['arrivalCity'] == ''


def test_overnight_or_explicit_arrival_is_never_replaced(workspace):
    _, business = workspace
    draft = business.update_draft('travel', {'legs': [leg(isOvernight=True)]})['draft']
    assert draft['legs'][0]['arrivalDate'] == ''
    draft = update_leg(business, draft, arrivalDate='2026-11-21')
    assert draft['legs'][0]['arrivalDate'] == '2026-11-21'


@pytest.mark.parametrize('draft_id', ['expense', 'personal'])
def test_reimbursements_do_not_infer_route_transport_or_dates(workspace, draft_id):
    _, business = workspace
    draft = business.update_draft(draft_id, {'legs':[leg(transport='高铁')], 'expenses':[{'id':'fee','categoryId':'travel-transport','transport':'飞机'}]})['draft']
    assert draft['legs'][0]['departureCity'] == draft['legs'][0]['arrivalDate'] == ''
    assert draft['legs'][0]['transport'] == '高铁'
    assert draft['expenses'][0]['transport'] == '飞机'
    assert draft['expenses'][0]['currency'] == 'CNY'
    assert draft['expenses'][0]['rental'] == ''
    assert draft['expenses'][0]['amount'] == draft['expenses'][0]['people'] == draft['expenses'][0]['oaId'] == ''


def test_model_update_uses_current_form_edits_and_preserves_omitted_fields(workspace):
    store, business = workspace
    draft = business.update_draft('travel', {'legs':[leg()]})['draft']
    submissions = store.get_state()['data']['submissions']
    edit = deepcopy(draft)
    edit['purpose'] = '表单里尚未保存的事由'
    edit['legs'][0]['departureDate'] = '2026-11-22'
    submissions['edits']['travel'] = edit
    store.patch({'baseRevision':store.snapshot()['revision'], 'data':{'submissions':submissions}})
    before_read = store.snapshot()
    effective = business.get_draft('travel')['draft']
    assert effective['purpose'] == '表单里尚未保存的事由'
    assert store.snapshot() == before_read
    draft = business.update_draft('travel', {'legs':[{'id':'go','arrivalCity':'北京'}]})['draft']
    assert draft['purpose'] == '表单里尚未保存的事由'
    assert draft['legs'][0]['departureDate'] == '2026-11-22'
    assert draft['legs'][0]['transport'] == '飞机-经济舱'
    assert 'travel' not in store.get_state()['data']['submissions']['edits']


def test_store_form_save_applies_same_defaults_and_ignores_forged_metadata(workspace):
    store, business = workspace
    submissions = store.get_state()['data']['submissions']
    submissions['drafts']['travel']['legs'] = [leg()]
    submissions['drafts']['travel']['autoFill'] = {'fields':{}, 'suppressed':['legs.go.departureCity']}
    submissions['checks']['travel'] = {'version':1,'canSubmit':True}
    store.patch({'baseRevision':store.snapshot()['revision'], 'data':{'submissions':submissions}})
    draft = business.get_draft('travel')['draft']
    assert draft['legs'][0]['departureCity'] == '杭州'
    assert draft['legs'][0]['transport'] == '火车-二等座'
    assert draft['version'] == 2
    assert 'travel' not in store.get_state()['data']['submissions']['checks']


def test_stable_ids_keep_manual_fields_when_rows_are_reordered(workspace):
    _, business = workspace
    draft = business.update_draft('travel', {'legs':[leg(),leg(id='back',departureCity='上海',arrivalCity='杭州',transport='火车-一等座')]})['draft']
    draft = business.update_draft('travel', {'legs':list(reversed(draft['legs']))})['draft']
    assert draft['legs'][0]['id'] == 'back'
    assert draft['legs'][0]['transport'] == '火车-一等座'
    assert 'legs.back.transport' not in draft['autoFill']['fields']


def test_locked_snapshots_are_not_changed_by_default_engine(workspace):
    store, business = workspace
    draft = business.update_draft('travel', {'purpose':'客户会议','legs':[leg(),leg(id='back',isReturn=True,arrivalCity='',departureDate='2026-11-21')]})['draft']
    receipt = business.submit_draft('travel', draft['version'], 'defaults-submit')['request']
    original = deepcopy(receipt['snapshot'])
    incoming = store.get_state()['data']['submissions']
    incoming['drafts']['travel']['legs'] = [leg(arrivalCity='北京')]
    incoming['drafts']['travel']['autoFill'] = {'fields':{},'suppressed':[]}
    store.patch({'baseRevision':store.snapshot()['revision'],'data':{'submissions':incoming}})
    assert store.get_state()['data']['submissions']['requests'][0]['snapshot'] == original
    with pytest.raises(BusinessError):
        business.update_draft('travel', {'purpose':'篡改'})


def test_new_instances_receive_defaults_without_overwriting_previous_content(workspace):
    store, business = workspace
    first = business.new_draft('travel')['draft']
    first = business.update_draft(first['id'], {'purpose':'客户会议', 'legs':[leg()]})['draft']
    second = business.new_draft('travel')['draft']
    assert second['id'] != first['id']
    assert second['autoFill']['fields']['travelType']['value'] == '普通差旅'
    assert second['legs'] == []
    assert store.get_state()['data']['submissions']['drafts'][first['id']] == first
    assert first['legs'][0]['departureCity'] == '杭州'


def test_initial_explicit_blank_and_same_value_confirmation_override_defaults(workspace):
    _, business = workspace
    draft = business.update_draft('travel', {'legs':[leg(transport='')]}, manual_fields=['legs.go.transport'])['draft']
    assert draft['legs'][0]['transport'] == ''
    assert 'legs.go.transport' in draft['autoFill']['suppressed']
    draft = business.update_draft('travel', {'legs':[{'id':'go','transport':'火车-二等座'}]})['draft']
    assert 'legs.go.transport' not in draft['autoFill']['suppressed']
    other = business.new_draft('travel')['draft']
    other = business.update_draft(other['id'], {'legs':[leg()]})['draft']
    other = business.update_draft(other['id'], {}, manual_fields=['legs.go.transport'])['draft']
    assert 'legs.go.transport' not in other['autoFill']['fields']
    other = business.update_draft(other['id'], {'legs':[{'id':'go','arrivalCity':'北京'}]})['draft']
    assert other['legs'][0]['transport'] == '火车-二等座'


def test_expense_rental_default_only_applies_to_lodging_and_clear_survives_category_change(workspace):
    _, business = workspace
    draft = business.update_draft('expense', {'expenses':[{'id':'room','categoryId':'hotel'}]})['draft']
    assert draft['expenses'][0]['rental'] == '否'
    assert draft['autoFill']['fields']['expenses.room.rental']['value'] == '否'
    draft = business.update_draft('expense', {'expenses':[{'id':'room','rental':''}]})['draft']
    business.update_draft('expense', {'expenses':[{'id':'room','categoryId':'taxi'}]})
    draft = business.update_draft('expense', {'expenses':[{'id':'room','categoryId':'hotel'}]})['draft']
    assert draft['expenses'][0]['rental'] == ''
    assert 'expenses.room.rental' in draft['autoFill']['suppressed']


def test_changing_applicant_clears_seed_profile_defaults_but_preserves_manual_organization(workspace):
    _, business = workspace
    draft = business.update_draft('travel', {'applicant':'其他员工','legs':[leg()]})['draft']
    assert draft['department'] == draft['paymentCompany'] == draft['legs'][0]['departureCity'] == ''
    draft = business.update_draft('travel', {'department':'项目部','paymentCompany':'项目公司'})['draft']
    draft = business.update_draft('travel', {'applicant':'另一员工'})['draft']
    assert draft['department'] == '项目部'
    assert draft['paymentCompany'] == '项目公司'


def test_reference_policy_boundary_and_missing_employee_base_are_configurable():
    from submission_defaults import apply_submission_defaults, load_config, merge_draft_patch
    from test_business import MemoryStore
    original = MemoryStore().get_state()['data']['submissions']['drafts']['travel']
    candidate = merge_draft_patch(original, {'legs':[leg()]})
    config = load_config()
    config['employees'][0]['baseCity'] = ''
    result = apply_submission_defaults(candidate, original, config=config)
    assert result['legs'][0]['departureCity'] == result['legs'][0]['transport'] == ''
    candidate['legs'][0]['departureCity'] = '杭州'
    config['routes'][0].update(distanceKm=800, railHours=4, flightAvailable=True)
    result = apply_submission_defaults(candidate, original, config=config)
    assert result['legs'][0]['transport'] == '火车-二等座'
    config['routes'][0]['railHours'] = 4.1
    result = apply_submission_defaults(candidate, original, config=config)
    assert result['legs'][0]['transport'] == '飞机-经济舱'


def test_invalid_manual_path_and_duplicate_ids_fail_without_mutating(workspace):
    store, business = workspace
    before = store.snapshot()
    with pytest.raises(BusinessError):
        business.update_draft('travel', {'legs':[leg()]}, manual_fields=['legs.missing.transport'])
    with pytest.raises(BusinessError):
        business.update_draft('travel', {'legs':[leg(),leg()]})
    assert store.snapshot() == before


def test_unknown_route_arrival_tracks_departure_until_explicitly_confirmed(workspace):
    _, business = workspace
    draft = business.update_draft('travel', {'legs':[leg(arrivalCity='未知城')]})['draft']
    assert draft['legs'][0]['arrivalDate'] == '2026-11-20'
    draft = update_leg(business, draft, departureDate='2026-11-21')
    assert draft['legs'][0]['arrivalDate'] == '2026-11-21'
    business.update_draft('travel', {}, manual_fields=['legs.go.arrivalDate'])
    draft = update_leg(business, draft, departureDate='2026-11-22')
    assert draft['legs'][0]['arrivalDate'] == '2026-11-21'
    assert 'legs.go.arrivalDate' not in draft['autoFill']['fields']


def test_pending_return_creates_one_undated_leg_and_keeps_its_id(workspace):
    _, business = workspace
    draft = business.update_draft('travel', {'returnDatePending':True, 'legs':[leg()]})['draft']
    assert len(draft['legs']) == 2
    back = draft['legs'][1]
    assert back['isReturn'] is True
    assert (back['departureCity'], back['arrivalCity']) == ('上海', '杭州')
    assert back['departureDate'] == back['arrivalDate'] == ''
    assert back['transport'] == '火车-二等座'
    assert draft['returnDatePending'] is True
    for purpose in ('客户会议', '拜访客户'):
        draft = business.update_draft('travel', {'purpose':purpose})['draft']
        assert len(draft['legs']) == 2
        assert draft['legs'][1] == back


def test_explicit_return_date_updates_original_leg_and_clears_pending(workspace):
    _, business = workspace
    draft = business.update_draft('travel', {'returnDatePending':True, 'legs':[leg()]})['draft']
    back_id = draft['legs'][1]['id']
    draft = business.update_draft('travel', {'legs':[{'id':'go'}, {'id':back_id, 'departureDate':'2026-11-23'}]})['draft']
    assert len(draft['legs']) == 2
    assert draft['legs'][1]['id'] == back_id
    assert draft['legs'][1]['departureDate'] == draft['legs'][1]['arrivalDate'] == '2026-11-23'
    assert draft['returnDatePending'] is False
    assert draft['legs'][0]['departureDate'] == '2026-11-20'


def test_unrelated_reply_preserves_manual_pending_return_fields(workspace):
    _, business = workspace
    draft = business.update_draft('travel', {'returnDatePending':True, 'legs':[leg()]})['draft']
    back_id = draft['legs'][1]['id']
    draft = business.update_draft('travel', {'legs':[{'id':'go'}, {'id':back_id, 'arrivalCity':'南京', 'transport':'火车-一等座', 'arrivalDate':''}]}, manual_fields=[f'legs.{back_id}.arrivalDate'])['draft']
    back = deepcopy(draft['legs'][1])
    draft = business.update_draft('travel', {'purpose':'合作沟通'})['draft']
    assert draft['legs'][1] == back


def test_deleted_pending_return_is_not_regenerated(workspace):
    _, business = workspace
    draft = business.update_draft('travel', {'returnDatePending':True, 'legs':[leg()]})['draft']
    draft = business.update_draft('travel', {'legs':[draft['legs'][0]]})['draft']
    assert len(draft['legs']) == 1
    assert draft['returnDatePending'] is False
    draft = business.update_draft('travel', {'purpose':'不再安排返程'})['draft']
    assert len(draft['legs']) == 1


def test_false_pending_flag_does_not_create_return(workspace):
    _, business = workspace
    draft = business.update_draft('travel', {'returnDatePending':False, 'legs':[leg()]})['draft']
    draft = business.update_draft('travel', {'purpose':'单程拜访'})['draft']
    assert len(draft['legs']) == 1


def test_pending_return_connects_last_city_to_actual_first_origin(workspace):
    _, business = workspace
    draft = business.update_draft('travel', {'returnDatePending':True, 'legs':[leg(departureCity='南京'), {'id':'next', 'arrivalCity':'北京', 'departureDate':'2026-11-21'}]})['draft']
    assert len(draft['legs']) == 3
    back = draft['legs'][2]
    assert (back['departureCity'], back['arrivalCity']) == ('北京', '南京')
    assert back['departureDate'] == back['arrivalDate'] == ''


def test_new_city_is_inserted_before_existing_pending_return(workspace):
    _, business = workspace
    draft = business.update_draft('travel', {'returnDatePending':True, 'legs':[leg()]})['draft']
    back_id = draft['legs'][1]['id']
    draft = business.update_draft('travel', {'legs':[*draft['legs'], {'id':'next', 'arrivalCity':'北京', 'departureDate':'2026-11-21'}]})['draft']
    assert [trip['id'] for trip in draft['legs']] == ['go', 'next', back_id]
    assert draft['legs'][1]['departureCity'] == '上海'
    assert (draft['legs'][2]['departureCity'], draft['legs'][2]['arrivalCity']) == ('北京', '杭州')
    assert draft['legs'][2]['transport'] == '飞机-经济舱'
    assert draft['legs'][2]['departureDate'] == draft['legs'][2]['arrivalDate'] == ''


def test_explicit_overnight_change_removes_automatic_same_day_date(workspace):
    _, business = workspace
    draft = business.update_draft('travel', {'legs':[leg(arrivalCity='北京')]})['draft']
    assert draft['legs'][0]['arrivalDate'] == '2026-11-20'
    draft = update_leg(business, draft, isOvernight=True)
    assert draft['legs'][0]['arrivalDate'] == ''


def test_pending_return_does_not_replace_explicit_existing_return(workspace):
    _, business = workspace
    draft = business.update_draft('travel', {'returnDatePending':True, 'legs':[leg(), {'id':'my-return', 'isReturn':True, 'departureCity':'苏州', 'arrivalCity':'南京', 'departureDate':'2026-11-23', 'arrivalDate':'2026-11-24', 'transport':'火车-一等座'}]})['draft']
    assert len(draft['legs']) == 2
    back = draft['legs'][1]
    assert back['id'] == 'my-return'
    assert (back['departureCity'], back['arrivalCity'], back['departureDate'], back['arrivalDate'], back['transport']) == ('苏州', '南京', '2026-11-23', '2026-11-24', '火车-一等座')
    assert draft['returnDatePending'] is False


@pytest.mark.parametrize('draft_id', ['expense', 'personal'])
def test_pending_return_never_generates_reimbursement_facts(workspace, draft_id):
    _, business = workspace
    draft = business.update_draft(draft_id, {'returnDatePending':True, 'legs':[leg()]})['draft']
    assert len(draft['legs']) == 1
    assert draft['legs'][0]['departureCity'] == draft['legs'][0]['arrivalDate'] == ''


@pytest.mark.parametrize('value', ['true', 1, 0, None, [], {}])
def test_return_pending_rejects_non_boolean_without_mutation(workspace, value):
    store, business = workspace
    business.update_draft('travel', {'returnDatePending':True, 'legs':[leg()]})
    before = store.snapshot()
    with pytest.raises(BusinessError):
        business.update_draft('travel', {'returnDatePending':value})
    assert store.snapshot() == before


@pytest.mark.parametrize('container', ['drafts', 'edits'])
def test_browser_pending_return_uses_same_defaults_and_rejects_integer_flag(workspace, container):
    from store import Conflict
    store, business = workspace
    store.patch({'baseRevision':store.snapshot()['revision'], 'data':{'submissions':{container:{'travel':{'returnDatePending':True, 'legs':[leg()]}}}}})
    draft = business.get_draft('travel')['draft']
    assert len(draft['legs']) == 2
    assert draft['returnDatePending'] is True
    before = store.snapshot()
    with pytest.raises(Conflict):
        store.patch({'baseRevision':before['revision'], 'data':{'submissions':{container:{'travel':{'returnDatePending':1}}}}})
    assert store.snapshot() == before


def test_store_rejects_invalid_leg_values_without_losing_saved_draft(workspace):
    from store import Conflict
    store, _ = workspace
    before = store.snapshot()
    with pytest.raises(Conflict):
        store.patch({'baseRevision':before['revision'], 'data':{'submissions':{'drafts':{'travel':{'legs':[leg(transport=42)]}}}}})
    assert store.snapshot() == before


def test_store_partial_save_consumes_current_edit_and_clears_stale_overlay(workspace):
    store, business = workspace
    draft = business.update_draft('travel', {'legs':[leg()]})['draft']
    edit = deepcopy(draft)
    edit['purpose'] = '编辑中事由'
    store.patch({'baseRevision':store.snapshot()['revision'], 'data':{'submissions':{'edits':{'travel':edit}}}})
    store.patch({'baseRevision':store.snapshot()['revision'], 'data':{'submissions':{'drafts':{'travel':{'purpose':'已保存的新事由'}}}}})
    assert business.get_draft('travel')['draft']['purpose'] == '已保存的新事由'
    assert 'travel' not in store.get_state()['data']['submissions']['edits']


def test_historical_manual_identity_is_not_relabelled_as_profile_defaults(workspace):
    store, business = workspace
    store.mutate(lambda state: state['data']['submissions']['drafts']['travel'].update(version=3, purpose='已有人工内容'))
    draft = business.update_draft('travel', {'applicant':'其他员工'})['draft']
    assert draft['department'] == '财务部'
    assert draft['paymentCompany'] == '华川科技'
    assert 'department' not in draft['autoFill']['fields']


def test_new_draft_uses_configured_employee_instead_of_fixed_seed(workspace, monkeypatch):
    import submission_defaults
    _, business = workspace
    config = submission_defaults.load_config()
    config['currentEmployeeId'] = 'local-new'
    config['employees'] = [{'id':'local-new','name':'本地新员工','department':'项目部','paymentCompany':'本地公司','baseCity':'南京','synthetic':True}]
    monkeypatch.setattr(submission_defaults, 'load_config', lambda: deepcopy(config))
    draft = business.new_draft('travel')['draft']
    assert draft['applicant'] == '本地新员工'
    assert draft['department'] == '项目部'
    draft = business.update_draft(draft['id'], {'legs':[leg()]})['draft']
    assert draft['legs'][0]['departureCity'] == '南京'


@pytest.mark.parametrize('container', ['drafts', 'edits'])
def test_new_browser_expense_explicit_empty_fields_survive_save_and_category_switch(workspace, container):
    store, business = workspace
    expense = {'id':'new-room','categoryId':'hotel','currency':'','rental':'','manualFields':['currency','rental']}
    draft = deepcopy(store.get_state()['data']['submissions']['drafts']['expense'])
    draft['expenses'] = [expense]
    draft['autoFill'] = {'fields':{'expenses.new-room.currency':{'value':'USD','source':'伪造来源'}},'suppressed':[]}
    store.patch({'baseRevision':store.snapshot()['revision'], 'data':{'submissions':{container:{'expense':draft}}}})
    effective = business.get_draft('expense')['draft']
    assert effective['expenses'][0]['currency'] == effective['expenses'][0]['rental'] == ''
    assert {'expenses.new-room.currency','expenses.new-room.rental'} <= set(effective['autoFill']['suppressed'])
    assert 'expenses.new-room.currency' not in effective['autoFill']['fields']
    assert effective['expenses'][0]['manualFields'] == ['currency','rental']
    business.update_draft('expense', {'expenses':[{'id':'new-room','categoryId':'taxi'}]})
    effective = business.update_draft('expense', {'expenses':[{'id':'new-room','categoryId':'hotel'}]})['draft']
    assert effective['expenses'][0]['currency'] == effective['expenses'][0]['rental'] == ''
    assert effective['expenses'][0]['manualFields'] == ['currency','rental']


@pytest.mark.parametrize('manual_fields', ['currency', ['currency', 'autoFill'], [{'field':'currency','source':'假来源'}]])
def test_browser_expense_manual_fields_reject_invalid_control_data(workspace, manual_fields):
    from store import Conflict
    store, _ = workspace
    before = store.snapshot()
    expense = {'id':'row','categoryId':'hotel','manualFields':manual_fields}
    with pytest.raises(Conflict):
        store.patch({'baseRevision':before['revision'], 'data':{'submissions':{'drafts':{'expense':{'expenses':[expense]}}}}})
    assert store.snapshot() == before
