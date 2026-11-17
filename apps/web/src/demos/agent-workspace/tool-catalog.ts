import { useCallback, useEffect, useState } from 'react';

export type ToolStatus = 'published' | 'draft' | 'review' | 'rejected' | 'disabled';
export type ToolRole = 'author' | 'employee' | 'business' | 'technical' | 'admin';
export interface ToolIdentity { id: string; name: string; role: ToolRole; label: string }
export interface ToolCatalogItem {
  id: string;
  name: string;
  description: string;
  category: string;
  icon: string;
  version: string;
  owner: string;
  status: ToolStatus;
  latestVersion: string;
  latestStatus: ToolStatus;
  favorite: boolean;
  canUse: boolean;
  canManage: boolean;
  canReview: boolean;
  canView: boolean;
  updatedAt: string;
  sourceLabel: string;
}
export interface ToolDetail extends ToolCatalogItem {
  execution: string;
  input: string;
  output: string;
  visibilityLabel: string;
  useScopeLabel: string;
  resultLabel: string;
  history: { version: string; status: ToolStatus; archivedAt: string }[];
}
interface CatalogSnapshot {
  items: ToolCatalogItem[];
  identity: ToolIdentity | null;
  canUpload: boolean;
  canReview: boolean;
}
interface ToolModel {
  USERS: Record<string, ToolIdentity>;
  TOOL_STORE: string;
  TOOL_CHANGE_EVENT: string;
  readToolState: () => unknown;
  getToolCatalog: (state: unknown) => CatalogSnapshot;
  getToolDetail: (state: unknown, id: string) => ToolDetail | null;
  toggleToolFavorite: (id: string) => void;
  setToolPersona: (id: string) => void;
}
const personas: ToolIdentity[] = [];
export const TOOL_PERSONAS: readonly ToolIdentity[] = personas;
let modelPromise: Promise<ToolModel> | null = null;
function loadModel(): Promise<ToolModel> {
  if (!modelPromise) {
    modelPromise = new Promise<ToolModel>((resolve, reject) => {
      const key = Symbol.for('caixiaozhi.tool-catalog.model');
      const registry = window as unknown as Record<symbol, ToolModel | undefined>;
      const ready = () => {
        const model = registry[key];
        if (!model) { reject(new Error('工具模型加载失败，请重试。')); return; }
        personas.splice(0, personas.length, ...Object.values(model.USERS));
        resolve(model);
      };
      if (registry[key]) { ready(); return; }
      const script = document.createElement('script');
      script.type = 'module';
      script.src = '/demos/tool-center/catalog-bridge.js';
      script.onload = ready;
      script.onerror = () => { script.remove(); reject(new Error('工具模型加载失败，请重试。')); };
      document.head.append(script);
    }).catch(error => { modelPromise = null; throw error; });
  }
  return modelPromise;
}
export async function setToolPersona(id: string): Promise<void> {
  (await loadModel()).setToolPersona(id);
}
export async function getToolDetail(id: string): Promise<ToolDetail | null> {
  const model = await loadModel();
  return model.getToolDetail(model.readToolState(), id);
}
export function useToolCatalog() {
  const [snapshot, setSnapshot] = useState<CatalogSnapshot>({items: [], identity: null, canUpload: false, canReview: false});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const refresh = useCallback(async () => {
    try {
      const model = await loadModel();
      setSnapshot(model.getToolCatalog(model.readToolState()));
      setError('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '工具目录加载失败，请重试。');
    } finally { setLoading(false); }
  }, []);
  useEffect(() => {
    void refresh();
    const onStorage = (event: StorageEvent) => { if (!event.key || event.key === 'caixiaozhi-tool-center-v1') void refresh(); };
    const onChange = () => { void refresh(); };
    window.addEventListener('storage', onStorage);
    window.addEventListener('caixiaozhi-tool-catalog-change', onChange);
    return () => {
      window.removeEventListener('storage', onStorage);
      window.removeEventListener('caixiaozhi-tool-catalog-change', onChange);
    };
  }, [refresh]);
  const toggleFavorite = useCallback(async (id: string) => {
    try {
      (await loadModel()).toggleToolFavorite(id);
      await refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : '收藏保存失败，请重试。'); }
  }, [refresh]);
  return {...snapshot, loading, error, refresh, toggleFavorite};
}
