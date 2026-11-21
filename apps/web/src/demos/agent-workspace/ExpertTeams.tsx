import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react';
import { CatalogMark } from './CatalogMark';
import { api } from './runtime-client';
import { Button, Empty, Icon } from './ui';
import { useWorkspace } from './workspace';
import {
  availableTeamSkill,
  selectionForTeam,
  type ExpertTeam,
  type TeamConnector,
} from './expert-team-catalog';
import './expert-teams.css';

type Overlay =
  | { kind: 'team'; team: ExpertTeam }
  | { kind: 'connector'; connector: TeamConnector }
  | { kind: 'create' };
type Summon = (team: ExpertTeam, prompt?: string) => void;

function TeamDialog({
  title,
  onClose,
  creating = false,
  locked = false,
  children,
}: {
  title: string;
  onClose: () => void;
  creating?: boolean;
  locked?: boolean;
  children: ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useLayoutEffect(() => {
    const node = dialog.current!;
    const trigger = document.activeElement;
    node.showModal();
    node.querySelector<HTMLElement>('[data-initial-focus]')?.focus();
    return () => {
      if (node.open) node.close();
      if (trigger instanceof HTMLElement && trigger.isConnected) {
        trigger.focus({ preventScroll: true });
      }
    };
  }, []);
  return (
    <dialog
      ref={dialog}
      className={`et-dialog ${creating ? 'et-create' : 'et-drawer'}`}
      aria-labelledby="et-dialog-title"
      onCancel={(event) => {
        event.preventDefault();
        if (!locked) onClose();
      }}
    >
      <header className="et-dialog-head">
        <h2 id="et-dialog-title">{title}</h2>
        <button
          type="button"
          className="icon-btn"
          aria-label="关闭"
          disabled={locked}
          onClick={onClose}
        >
          <Icon name="close" />
        </button>
      </header>
      {children}
    </dialog>
  );
}

function TeamDetail({
  team,
  onClose,
  summon,
}: {
  team: ExpertTeam;
  onClose: () => void;
  summon: Summon;
}) {
  return (
    <TeamDialog title={team.name} onClose={onClose}>
      <div className="et-dialog-body">
        <p className="et-detail-summary">{team.description}</p>
        {team.examples.length > 0 && (
          <section>
            <h3>常用任务</h3>
            <div className="et-examples">
              {team.examples.map((example) => (
                <button
                  key={example}
                  type="button"
                  onClick={() => summon(team, example)}
                >
                  {example}
                  <Icon name="chevron" size={14} />
                </button>
              ))}
            </div>
          </section>
        )}
        <section>
          <h3>成员与技能</h3>
          <dl className="et-detail-list">
            {team.skills.map((skill) => (
              <div key={skill.id}>
                <dt>
                  {skill.name}
                  {skill.member && <small>{skill.member}</small>}
                </dt>
                <dd>{skill.description}</dd>
              </div>
            ))}
          </dl>
        </section>
        <section>
          <h3>连接器</h3>
          <dl className="et-detail-list">
            {team.connectors.map((c) => (
              <div key={c.id}>
                <dt>
                  {c.name}
                  <ConnectorStatus connector={c} />
                </dt>
                <dd>{c.scope}</dd>
              </div>
            ))}
          </dl>
        </section>
      </div>
      <footer className="et-footer">
        <Button variant="primary" icon="chat" onClick={() => summon(team)}>
          召唤专家团
        </Button>
      </footer>
    </TeamDialog>
  );
}

function ConnectorStatus({
  connector,
  id,
}: {
  connector: TeamConnector;
  id?: string;
}) {
  return (
    <span
      id={id}
      className={`et-state ${connector.status === 'available' ? 'is-available' : ''}`}
    >
      {connector.status === 'available' ? '可用' : '未接入'}
    </span>
  );
}

const connectorFilters = [
  { id: 'all', label: '全部' },
  { id: 'available', label: '可用' },
  { id: 'unavailable', label: '未接入' },
] as const;

function TeamCard({
  team,
  onDetail,
  onSummon,
}: {
  team: ExpertTeam;
  onDetail: () => void;
  onSummon: () => void;
}) {
  const available = team.skills.filter((skill) =>
    availableTeamSkill(skill, team.connectors),
  );
  const pending = team.skills.filter((skill) => !available.includes(skill));
  return (
    <article className="et-card">
      <header className="et-title">
        <CatalogMark kind="team" id={team.baseTeamId ?? team.id} />
        <div>
          <h3>
            <button type="button" className="et-name" onClick={onDetail}>
              {team.name}
            </button>
          </h3>
          <small>{team.baseTeamId ? '我创建的' : '财小智内置'}</small>
        </div>
      </header>
      <p className="et-summary">{team.description}</p>
      <dl className="et-capabilities">
        <div>
          <dt>可用技能</dt>
          <dd>{available.map((s) => s.name).join('、') || '暂无'}</dd>
        </div>
        {pending.length > 0 && (
          <div>
            <dt>待接入</dt>
            <dd>{pending.map((s) => s.name).join('、')}</dd>
          </div>
        )}
      </dl>
      <footer>
        <button type="button" className="et-detail-btn" onClick={onDetail}>
          查看详情
        </button>
        <Button icon="chat" variant="primary" onClick={onSummon}>
          召唤专家团
        </Button>
      </footer>
    </article>
  );
}

interface TeamDraft {
  baseTeamId: string;
  name: string;
  description: string;
  skillIds: string[];
}
const draftKey = 'cx.expert-teams.create.v1';
function initialDraft(bases: ExpertTeam[]): TeamDraft {
  const blank = {
    baseTeamId: bases[0]?.id ?? '',
    name: '',
    description: '',
    skillIds: [],
  };
  try {
    const d = JSON.parse(sessionStorage.getItem(draftKey) || 'null');
    if (
      d &&
      typeof d.name === 'string' &&
      typeof d.description === 'string' &&
      Array.isArray(d.skillIds) &&
      bases.some((t) => t.id === d.baseTeamId)
    )
      return { ...blank, ...d };
  } catch {
    /* A new draft can still be created if storage is disabled. */
  }
  return blank;
}

function CreateTeam({
  bases,
  onClose,
  onCreated,
}: {
  bases: ExpertTeam[];
  onClose: () => void;
  onCreated: (team: ExpertTeam) => void;
}) {
  const [draft, setDraft] = useState(() => initialDraft(bases));
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const sending = useRef(false);
  const base = bases.find((t) => t.id === draft.baseTeamId) ?? bases[0]!;
  const selection = selectionForTeam(base, draft.skillIds);
  const connectors = base.connectors.filter((c) =>
    selection.connectorIds.includes(c.id),
  );
  const change = (patch: Partial<TeamDraft>) => {
    const next = { ...draft, ...patch };
    setDraft(next);
    setError('');
    try {
      sessionStorage.setItem(draftKey, JSON.stringify(next));
    } catch {
      /* Keep the open form usable. */
    }
  };
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (sending.current) return;
    if (!draft.name.trim() || !draft.description.trim()) {
      setError('请填写专家团名称和职责。');
      return;
    }
    if (!selection.skillIds.length) {
      setError('请至少选择一项可用技能。');
      return;
    }
    sending.current = true;
    setSaving(true);
    setError('');
    try {
      const result = await api<{ team: ExpertTeam }>('/expert-teams', {
        name: draft.name.trim(),
        description: draft.description.trim(),
        baseTeamId: base.id,
        ...selection,
      });
      try {
        sessionStorage.removeItem(draftKey);
      } catch {
        /* Creation already succeeded. */
      }
      onCreated(result.team);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '创建失败，请重试。');
    } finally {
      sending.current = false;
      setSaving(false);
    }
  }
  return (
    <TeamDialog title="创建专家团" onClose={onClose} creating locked={saving}>
      <form className="et-form" onSubmit={save}>
        <div className="et-dialog-body">
          <fieldset disabled={saving} className="et-fields">
            <label>
              专家团名称
              <input
                data-initial-focus
                required
                maxLength={60}
                value={draft.name}
                onChange={(e) => change({ name: e.target.value })}
                placeholder="例如 差旅政策复核组"
              />
            </label>
            <label>
              职责
              <textarea
                required
                maxLength={300}
                rows={2}
                value={draft.description}
                onChange={(e) => change({ description: e.target.value })}
                placeholder="说明这个专家团负责的工作"
              />
            </label>
            <label>
              基础专家团
              <select
                value={base.id}
                onChange={(e) =>
                  change({ baseTeamId: e.target.value, skillIds: [] })
                }
              >
                {bases.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
            </label>
            <fieldset className="et-skill-choices">
              <legend>可用技能</legend>
              {base.skills.map((skill) => {
                const available = availableTeamSkill(skill, base.connectors);
                const unavailable = base.connectors
                  .filter(
                    (c) =>
                      skill.connectorIds.includes(c.id) &&
                      c.status !== 'available',
                  )
                  .map((c) => c.name);
                return (
                  <label key={skill.id} className="et-choice">
                    <input
                      type="checkbox"
                      disabled={!available}
                      checked={selection.skillIds.includes(skill.id)}
                      onChange={(e) =>
                        change({
                          skillIds: e.target.checked
                            ? [...selection.skillIds, skill.id]
                            : selection.skillIds.filter(
                                (id) => id !== skill.id,
                              ),
                        })
                      }
                    />
                    <span>
                      <strong>{skill.name}</strong>
                      <small>
                        {available
                          ? skill.description
                          : (unavailable.join('、') || '所需连接器') + '未接入'}
                      </small>
                    </span>
                  </label>
                );
              })}
            </fieldset>
            <div className="et-derived">
              <strong>所需连接器</strong>
              <p>
                {connectors.length
                  ? connectors.map((c) => c.name).join('、')
                  : '选择技能后显示。'}
              </p>
            </div>
          </fieldset>
          {error && (
            <p className="et-error" role="alert">
              {error}
            </p>
          )}
        </div>
        <footer className="et-footer">
          <Button disabled={saving} onClick={onClose}>
            关闭
          </Button>
          <button type="submit" className="btn primary" disabled={saving}>
            {saving ? '正在创建…' : '创建'}
          </button>
        </footer>
      </form>
    </TeamDialog>
  );
}

export function ExpertDirectory({
  section,
}: {
  section: 'teams' | 'connectors';
}) {
  const { summonExpertTeam, notify } = useWorkspace();
  const [teams, setTeams] = useState<ExpertTeam[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [mine, setMine] = useState(false);
  const [status, setStatus] = useState<'all' | TeamConnector['status']>('all');
  const [search, setSearch] = useState('');
  const [overlay, setOverlay] = useState<Overlay | null>(null);
  useEffect(() => {
    let current = true;
    setLoading(true);
    setError('');
    api<{ teams: ExpertTeam[] }>('/expert-teams')
      .then((data) => {
        if (current) setTeams(data.teams);
      })
      .catch((cause) => {
        if (current)
          setError(cause instanceof Error ? cause.message : '目录加载失败。');
      })
      .finally(() => {
        if (current) setLoading(false);
      });
    return () => {
      current = false;
    };
  }, [attempt]);
  const baseTeams = teams.filter((t) => !t.baseTeamId);
  const byConnector = new Map<string, TeamConnector>();
  for (const team of teams)
    for (const c of team.connectors) byConnector.set(c.id, c);
  const needle = search.trim().toLocaleLowerCase();
  const visibleTeams = teams.filter(
    (t) =>
      (!mine || t.baseTeamId) &&
      [
        t.name,
        t.description,
        ...t.members.map((m) => m.name),
        ...t.skills.map((s) => s.name),
      ]
        .join(' ')
        .toLocaleLowerCase()
        .includes(needle),
  );
  const visibleConnectors = [...byConnector.values()].filter(
    (c) =>
      (status === 'all' || c.status === status) &&
      (c.name + ' ' + c.scope).toLocaleLowerCase().includes(needle),
  );
  function summon(team: ExpertTeam, prompt?: string) {
    setOverlay(null);
    summonExpertTeam(team.id, prompt, team.name);
  }
  if (loading)
    return (
      <div className="et-feedback" role="status">
        正在读取{section === 'teams' ? '专家团' : '连接器'}…
      </div>
    );
  if (error)
    return (
      <div className="et-feedback" role="alert">
        <span>目录加载失败。{error}</span>
        <Button onClick={() => setAttempt((n) => n + 1)}>重试</Button>
      </div>
    );
  return (
    <div className="et-library">
      <div className="et-controls">
        {section === 'teams' ? (
          <div className="et-filters" role="group" aria-label="专家团范围">
            <button
              type="button"
              aria-pressed={!mine}
              onClick={() => setMine(false)}
            >
              全部
            </button>
            <button
              type="button"
              aria-pressed={mine}
              onClick={() => setMine(true)}
            >
              我创建的
            </button>
          </div>
        ) : (
          <div className="et-filters" role="group" aria-label="连接状态">
            {connectorFilters.map((filter) => (
              <button
                type="button"
                key={filter.id}
                aria-pressed={status === filter.id}
                onClick={() => setStatus(filter.id)}
              >
                {filter.label}
              </button>
            ))}
          </div>
        )}
        <label className="et-search">
          <Icon name="search" size={16} />
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label={section === 'teams' ? '搜索专家团' : '搜索连接器'}
            placeholder={
              section === 'teams' ? '搜索专家团或技能' : '搜索连接器'
            }
          />
        </label>
        {section === 'teams' && baseTeams.length > 0 && (
          <Button icon="plus" onClick={() => setOverlay({ kind: 'create' })}>
            创建专家团
          </Button>
        )}
      </div>
      {section === 'teams' ? (
        visibleTeams.length ? (
          <div className="et-grid">
            {visibleTeams.map((team) => (
              <TeamCard
                key={team.id}
                team={team}
                onDetail={() => setOverlay({ kind: 'team', team })}
                onSummon={() => summon(team)}
              />
            ))}
          </div>
        ) : (
          <Empty
            title={mine && !search ? '尚未创建专家团' : '没有匹配的专家团'}
          />
        )
      ) : visibleConnectors.length ? (
        <div className="et-connections">
          {visibleConnectors.map((c) => (
            <article key={c.id}>
              <button
                type="button"
                className="et-connection"
                onClick={() => setOverlay({ kind: 'connector', connector: c })}
                aria-label={'查看' + c.name + '详情'}
                aria-describedby={`et-connection-status-${c.id} et-source-scope-${c.id}`}
              >
                <span className="et-source-heading">
                  <CatalogMark kind="connector" id={c.id} />
                  <span className="et-source-identity">
                    <strong>{c.name}</strong>
                    <ConnectorStatus
                      id={`et-connection-status-${c.id}`}
                      connector={c}
                    />
                  </span>
                  <Icon name="chevron" size={15} />
                </span>
                <span
                  className="et-source-scope"
                  id={`et-source-scope-${c.id}`}
                >
                  {c.scope}
                </span>
              </button>
            </article>
          ))}
        </div>
      ) : (
        <Empty title="没有匹配的连接器" />
      )}
      {overlay?.kind === 'team' && (
        <TeamDetail
          team={overlay.team}
          onClose={() => setOverlay(null)}
          summon={summon}
        />
      )}
      {overlay?.kind === 'connector' && (
        <TeamDialog
          title={overlay.connector.name}
          onClose={() => setOverlay(null)}
        >
          <div className="et-dialog-body">
            <section>
              <h3>连接状态</h3>
              <ConnectorStatus connector={overlay.connector} />
            </section>
            <section>
              <h3>数据范围</h3>
              <p>{overlay.connector.scope}</p>
            </section>
            <section>
              <h3>关联专家团</h3>
              <ul>
                {teams
                  .filter((t) =>
                    t.connectors.some((c) => c.id === overlay.connector.id),
                  )
                  .map((t) => (
                    <li key={t.id}>{t.name}</li>
                  ))}
              </ul>
            </section>
          </div>
        </TeamDialog>
      )}
      {overlay?.kind === 'create' && (
        <CreateTeam
          bases={baseTeams}
          onClose={() => setOverlay(null)}
          onCreated={(team) => {
            setTeams((current) => [
              ...current.filter((t) => t.id !== team.id),
              team,
            ]);
            setSearch('');
            setMine(true);
            setOverlay(null);
            notify('专家团已创建');
          }}
        />
      )}
    </div>
  );
}
