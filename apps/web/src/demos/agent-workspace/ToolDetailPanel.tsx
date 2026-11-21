import { useEffect, useState } from 'react';
import { getToolDetail, useToolCatalog, type ToolDetail, type ToolStatus } from './tool-catalog';
import { useWorkspace } from './workspace';
import { Button, Icon } from './ui';
import './tool-center-embed.css';

const statusNames: Record<ToolStatus, string> = {published:'已发布',draft:'草稿',review:'审核中',rejected:'已退回',disabled:'已停用'};
export function ToolDetailPanel({ id }: { id: string }) {
  const workspace = useWorkspace();
  const catalog = useToolCatalog();
  const [detail, setDetail] = useState<ToolDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    setLoading(true);
    getToolDetail(id).then(value => { if (active) { setDetail(value); setError(''); } }).catch(cause => {
      if (active) { setDetail(null); setError(cause instanceof Error ? cause.message : '工具详情加载失败'); }
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [id, catalog.items, catalog.identity]);
  const actionLink = (action: string) => {
    const query = new URLSearchParams(location.hash.split('?')[1] || '');
    query.set('tool', id);
    query.set('action', action);
    query.delete('result');
    if (['manage','review','edit'].includes(action)) query.set('view','manage');
    return `#light-apps?${query}`;
  };
  const open = (action: string) => {
    workspace.closePanel();
    location.hash = actionLink(action);
  };
  if (loading) return <div className="tool-detail-state" role="status">正在加载工具详情…</div>;
  if (error) return <div className="tool-detail-state" role="alert">{error}</div>;
  if (!detail) return <div className="tool-detail-state">工具不存在，或当前账号没有查看权限。</div>;
  return <div className="tool-detail">
    <div className="tool-detail-heading"><span className="tool-detail-icon"><Icon name={detail.icon} size={22}/></span><div><h2>{detail.name}</h2><span>轻应用 · v{detail.version} · {statusNames[detail.status]}</span></div></div>
    <p className="tool-detail-description">{detail.description}</p>
    <dl className="tool-detail-fields">
      <div><dt>维护者</dt><dd>{detail.owner}</dd></div>
      <div><dt>运行方式</dt><dd>{detail.execution}</dd></div>
      <div><dt>输入</dt><dd>{detail.input}</dd></div>
      <div><dt>输出</dt><dd>{detail.output}</dd></div>
      <div><dt>结果保存</dt><dd>{detail.resultLabel}</dd></div>
    </dl>
    <div className="tool-detail-actions">
      {detail.canUse ? <a className="btn primary" href={actionLink('tool')} target="_blank" rel="noopener">打开轻应用<Icon name="arrow" size={14}/></a> : detail.status === 'published' ? <Button variant="primary" onClick={() => open('request')}>申请使用</Button> : <span className="tool-detail-unavailable">{statusNames[detail.status]}，暂不可使用</span>}
      <Button onClick={() => void catalog.toggleFavorite(id)}><Icon name="star" size={14}/>{detail.favorite ? '取消收藏' : '收藏'}</Button>
      {detail.status === 'published' && detail.id !== 'expense-summary' && <Button onClick={() => open('share')}>分享</Button>}
    </div>
    {!detail.canUse && detail.status === 'published' && <p className="tool-detail-notice">当前身份没有使用权限。收藏或分享不会授予权限。</p>}
    <details className="tool-detail-section"><summary>权限与来源</summary><dl className="tool-detail-fields"><div><dt>可查看</dt><dd>{detail.visibilityLabel}</dd></div><div><dt>可使用</dt><dd>{detail.useScopeLabel}</dd></div><div><dt>权限来源</dt><dd>{detail.sourceLabel}</dd></div>{detail.id !== 'expense-summary' && <div><dt>演示身份</dt><dd>{catalog.identity?.name} · {catalog.identity?.label}</dd></div>}</dl></details>
    {(detail.latestVersion !== detail.version || detail.history.length > 0) && <details className="tool-detail-section"><summary>版本记录</summary>{detail.latestVersion !== detail.version && <p>最新提交 v{detail.latestVersion} · {statusNames[detail.latestStatus]}</p>}{detail.history.map((version,index) => <p key={`${version.version}-${index}`}>v{version.version} · 已归档</p>)}</details>}
    {(detail.canManage || detail.canReview) && <div className="tool-detail-management">{detail.canManage && <Button onClick={() => open('manage')}>管理工具</Button>}{detail.canReview && <Button onClick={() => open('review')}>查看审核</Button>}</div>}
  </div>;
}
