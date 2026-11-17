import { skillExecutionBlock, type SkillFile } from './skill-package-model';

export type Conclusion = 'pending' | 'pass' | 'fail';
export type VersionStatus = 'draft' | 'review' | 'returned' | 'published';
export interface SkillVersion {
  version: string;
  status: VersionStatus;
  business: Conclusion;
  security: Conclusion;
  compatibility: Conclusion;
  technical: Conclusion;
  mode: 'runnable' | 'storage';
  note: string;
  updated: string;
  file?: SkillFile;
  instructions?: string;
  events: string[];
}
export interface Skill {
  id: string;
  title: string;
  category: string;
  icon: string;
  description: string;
  owner: string;
  tags: string[];
  favorite: boolean;
  view: boolean;
  download: boolean;
  call: boolean;
  instructions: string;
  versions: SkillVersion[];
}

export interface CatalogItem {
  id: string;
  type: 'skill' | 'tool';
  name: string;
  description: string;
  category: string;
  icon: string;
  owner: string;
  version: string;
  status: string;
  latestVersion: string;
  latestStatus: string;
  updatedAt: string;
  favorite: boolean;
  canView: boolean;
  canUse: boolean;
  canManage: boolean;
  canReview: boolean;
  sourceLabel: string;
  searchText?: string;
  unavailableReason?: string;
  availabilityState?: 'available' | 'reference' | 'denied' | 'unavailable';
}
export interface CatalogRoute {
  view: 'catalog' | 'manage';
  management: 'mine' | 'review';
  search: string;
  type: 'all' | 'skill' | 'tool';
  category: string;
  favorites: boolean;
  toolId: string;
  action: string;
}
export const currentVersion = (s: Skill) =>
  s.versions.find((v) => v.status === 'published') || s.versions[0]!;
export const available = (s: Skill, v = currentVersion(s)) =>
  s.view &&
  s.call &&
  !!v &&
  v.status === 'published' &&
  v.mode === 'runnable' &&
  v.business === 'pass' &&
  v.technical === 'pass' &&
  v.security === 'pass' &&
  v.compatibility === 'pass' &&
  !skillExecutionBlock(v.file);
export function skillUnavailableReason(
  s: Skill,
  v = currentVersion(s),
): string {
  if (!s.view) return '没有查看权限';
  if (!v || v.status !== 'published') return '尚未发布';
  if (v.mode === 'storage') return '仅供查阅';
  if (!s.call) return '没有使用权限';
  return (
    skillExecutionBlock(v.file) ||
    (!available(s, v) ? '审核或运行检查未通过' : '')
  );
}
export function skillCatalogItem(s: Skill): CatalogItem {
  const version = currentVersion(s);
  const latest = s.versions[0];
  return {
    id: s.id,
    type: 'skill',
    name: s.title,
    description: s.description,
    category: s.category,
    icon: s.icon,
    owner: s.owner,
    version: version?.version || '',
    status: version?.status || 'draft',
    latestVersion: latest?.version || '',
    latestStatus: latest?.status || 'draft',
    updatedAt: latest?.updated || '',
    favorite: s.favorite,
    canView: s.view,
    canUse: available(s),
    availabilityState: available(s)
      ? 'available'
      : !s.view
        ? 'denied'
        : version?.mode === 'storage'
          ? 'reference'
          : !s.call
            ? 'denied'
            : 'unavailable',
    canManage: s.view && s.owner === '我',
    canReview: s.view,
    sourceLabel: '技能审核：演示权限',
    searchText: s.tags.join(' '),
    unavailableReason: skillUnavailableReason(s),
  };
}
export function filterCatalog<T extends CatalogItem>(
  items: T[],
  filters: CatalogRoute,
): T[] {
  const search = filters.search.trim().toLocaleLowerCase();
  return items.filter(
    (item) =>
      (filters.view === 'catalog'
        ? item.canView && item.status === 'published'
        : filters.management === 'review'
          ? item.canReview
          : item.canManage) &&
      (filters.type === 'all' || item.type === filters.type) &&
      (filters.category === '全部分类' || item.category === filters.category) &&
      (!filters.favorites || item.favorite) &&
      `${item.name} ${item.description} ${item.category} ${item.searchText || ''}`
        .toLocaleLowerCase()
        .includes(search),
  );
}
export function readCatalogRoute(hash: string): CatalogRoute {
  const params = new URLSearchParams(hash.split('?')[1] || '');
  return {
    view: params.get('view') === 'manage' ? 'manage' : 'catalog',
    management: params.get('management') === 'review' ? 'review' : 'mine',
    search: params.get('q') || '',
    type:
      params.get('type') === 'skill'
        ? 'skill'
        : params.get('type') === 'tool' || params.get('tab') === 'tools'
          ? 'tool'
          : 'all',
    category: params.get('category') || '全部分类',
    favorites: params.get('favorites') === '1',
    toolId: params.get('tool') || '',
    action: params.get('action') || 'tool',
  };
}
export function writeCatalogRoute(state: CatalogRoute): string {
  const params = new URLSearchParams();
  if (state.view === 'manage') params.set('view', 'manage');
  if (state.management === 'review') params.set('management', 'review');
  if (state.search) params.set('q', state.search);
  if (state.type !== 'all') params.set('type', state.type);
  if (state.category !== '全部分类') params.set('category', state.category);
  if (state.favorites) params.set('favorites', '1');
  if (state.toolId) params.set('tool', state.toolId);
  if (state.action !== 'tool') params.set('action', state.action);
  return '#skills' + (params.size ? `?${params}` : '');
}
export function reviewStage(
  v: SkillVersion,
): 'pending' | 'active' | 'returned' | 'complete' {
  if (v.status === 'returned') return 'returned';
  if (v.status === 'draft') return 'pending';
  return v.business === 'pass' &&
    v.technical === 'pass' &&
    v.security === 'pass'
    ? 'complete'
    : 'active';
}

export function formatCatalogUpdatedAt(value: string): string {
  const input = value.trim();
  if (!input) return '—';
  if (/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:?\d{2})$/i.test(input)) {
    const date = new Date(input);
    if (!Number.isFinite(date.getTime())) return input;
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Asia/Shanghai',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
      })
        .formatToParts(date)
        .map((part) => [part.type, part.value]),
    );
    return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
  }
  const local = input.match(
    /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[ T,]+(\d{1,2}):(\d{2})(?::\d{2}(?:\.\d+)?)?)?$/,
  );
  if (!local) return input;
  const date = `${local[1]}-${local[2]!.padStart(2, '0')}-${local[3]!.padStart(2, '0')}`;
  return local[4] ? `${date} ${local[4].padStart(2, '0')}:${local[5]}` : date;
}
