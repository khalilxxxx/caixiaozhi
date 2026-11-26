import { useSyncExternalStore } from 'react';
import { readCatalogRoute, type CatalogArea } from './skills-catalog-model';
import './catalog-heading.css';

const catalogHeadings = {
  skills: '能力中心',
  'light-apps': '轻应用',
  schedules: '自动化',
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
  const title = catalogHeadings[area];
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
        </div>
      </div>
    </header>
  );
}
