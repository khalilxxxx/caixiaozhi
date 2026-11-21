import { useSyncExternalStore } from 'react';
import { readCatalogRoute, type CatalogArea } from './skills-catalog-model';
import './catalog-heading.css';

const catalogHeadings = {
  skills: {
    title: '能力中心',
    description: '召唤专家团，让小智按任务选用技能和数据来源。',
  },
  'light-apps': {
    title: '轻应用',
    description:
      '在独立窗口使用业务工具。创作者可上传自制 HTML 应用，审核通过后发布。',
  },
  schedules: {
    title: '自动化',
    description: '安排小智定时整理待办或执行指令，查看每次运行的结果。',
  },
};

function subscribeToNavigation(update: () => void) {
  window.addEventListener('hashchange', update);
  return () => window.removeEventListener('hashchange', update);
}

function isDirectory() {
  const route = readCatalogRoute(window.location.hash);
  return (
    route.view === 'catalog' &&
    !route.toolId &&
    !['upload', 'requests'].includes(route.action)
  );
}

export function CatalogHeading({ area }: { area: CatalogArea | 'schedules' }) {
  const showBanner = useSyncExternalStore(subscribeToNavigation, isDirectory);
  const { title, description } = catalogHeadings[area];
  if (area !== 'schedules' && !showBanner)
    return (
      <div className="page-heading">
        <h1>{title}</h1>
      </div>
    );
  return (
    <header className="page-heading catalog-heading" data-catalog={area}>
      <div className="catalog-heading-surface">
        <div className="catalog-heading-art" aria-hidden="true" />
        <div className="catalog-heading-text">
          <h1>{title}</h1>
          <p>{description}</p>
        </div>
      </div>
    </header>
  );
}
