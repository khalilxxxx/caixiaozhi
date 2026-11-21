import { createBrandHeader, styles } from './headers.js';

const areas = {
  hub: { path: '#skills?section=teams', title: '能力中心' },
  apps: { path: '#light-apps?view=catalog', title: '轻应用' },
};
const teamTitles = {
  'finance-review-team': '财务核验专家团',
  'finance-analysis-team': '财务分析专家团',
};
const params = new URLSearchParams(location.search);
const style = styles.find(candidate => candidate.id === params.get('style'))?.id ?? styles[0].id;
let area = params.get('area') === 'apps' ? 'apps' : 'hub';
let pendingTeam = area === 'hub' && Object.hasOwn(teamTitles, params.get('team'))
  ? params.get('team') : null;
const frame = document.getElementById('workspace');
const retryPanel = document.getElementById('load-error');
const select = document.getElementById('style-select');
for (const [series, label] of [['current', '本轮横幅'], ['previous', '上一轮款式']]) {
  const group = document.createElement('optgroup');
  group.label = label;
  for (const design of styles.filter(candidate => candidate.series === series)) {
    group.append(new Option(design.id.toUpperCase() + ' · ' + design.title, design.id));
  }
  select.append(group);
}
const areaLinks = [...document.querySelectorAll('.preview-areas a')];
const headerStyles = new URL('./headers.css', import.meta.url);
const workspacePath = '/agent.html';
let observer;
let timer;
let repaint;
let oldHeading;
let sample;

function previewUrl(nextStyle, nextArea) {
  const url = new URL('./preview.html', location.href);
  url.searchParams.set('style', nextStyle);
  url.searchParams.set('area', nextArea);
  return url;
}
function paintControls(activeArea) {
  for (const link of areaLinks) {
    const dest = link.dataset.area;
    link.href = previewUrl(style, dest).href;
    if (activeArea === dest) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
  document.getElementById('back-link').href = `./index.html#style-${style}`;
  select.value = style;
  document.title = `${select.selectedOptions[0].textContent} · 工作台预览 · 财小智`;
}
function catalogArea(hash) {
  const [path, query] = hash.split('?');
  const options = new URLSearchParams(query);
  if (options.get('view') === 'manage' || options.has('tool') ||
      ['upload', 'requests'].includes(options.get('action'))) return null;
  if (path === '#skills') return 'hub';
  if (path === '#light-apps') return 'apps';
  return null;
}
function removeSample() {
  if (oldHeading) {
    oldHeading.style.removeProperty('display');
    oldHeading = null;
  }
  sample?.remove();
  sample = null;
}
function rememberLocation(hash, activeArea) {
  if (activeArea) area = activeArea;
  const url = new URL(location.href);
  if (url.searchParams.get('area') !== area) url.searchParams.set('area', area);
  if (hash !== areas.hub.path) {
    pendingTeam = null;
    url.searchParams.delete('team');
  }
  if (history.state?.frameHash !== hash || location.href !== url.href) {
    history.replaceState({ ...history.state, frameHash: hash }, '', url);
  }
}
function showTeamDetail(doc) {
  if (!pendingTeam) return;
  const wanted = teamTitles[pendingTeam];
  const nameButton = [...doc.querySelectorAll('.et-card .et-name')]
    .find((button) => button.textContent.trim() === wanted);
  if (nameButton) {
    pendingTeam = null;
    nameButton.click();
  }
}
function paintSample() {
  const doc = frame.contentDocument;
  if (!doc || doc.location.pathname !== workspacePath) return;
  const hash = doc.location.hash;
  const activeArea = catalogArea(hash);
  rememberLocation(hash, activeArea);
  paintControls(activeArea);
  const root = doc.getElementById('root');
  if (root?.firstElementChild) {
    clearTimeout(timer);
    retryPanel.hidden = true;
  }
  const heading = doc.querySelector('main.main-shell .page-container > .page-heading');
  if (!activeArea || heading?.querySelector('h1')?.textContent !== areas[activeArea].title) {
    if (sample) removeSample();
    return;
  }
  if (style === 'e' && heading.classList.contains('catalog-heading')) {
    if (sample) removeSample();
    if (activeArea === 'hub') showTeamDetail(doc);
    return;
  }
  if (!sample?.isConnected || sample.dataset.previewArea !== activeArea || oldHeading !== heading) {
    removeSample();
    sample = createBrandHeader(activeArea, style, doc);
    sample.dataset.previewArea = activeArea;
    sample.style.marginBlockEnd = 'clamp(16px, 1.8vw, 26px)';
    oldHeading = heading;
    oldHeading.style.setProperty('display', 'none', 'important');
    heading.before(sample);
  }
  if (activeArea === 'hub') showTeamDetail(doc);
}
function queuePaint() {
  if (repaint) return;
  repaint = requestAnimationFrame(() => {
    repaint = null;
    paintSample();
  });
}
function onFrameLoad() {
  observer?.disconnect();
  const doc = frame.contentDocument;
  if (doc?.URL === 'about:blank') return;
  if (!doc?.getElementById('root') && (!doc || doc.location.pathname === workspacePath)) {
    retryPanel.hidden = false;
    return;
  }
  if (doc.location.pathname !== workspacePath) {
    retryPanel.hidden = true;
    clearTimeout(timer);
    paintControls(null);
    return;
  }
  const css = doc.createElement('link');
  css.rel = 'stylesheet';
  css.href = headerStyles.href;
  doc.head.append(css);
  observer = new MutationObserver(queuePaint);
  observer.observe(doc.getElementById('root'), { childList: true, characterData: true, subtree: true });
  doc.defaultView.addEventListener('hashchange', queuePaint);
  paintSample();
}
function loadWorkspace(hash) {
  retryPanel.hidden = true;
  clearTimeout(timer);
  timer = setTimeout(() => { retryPanel.hidden = false; }, 12000);
  const target = new URL(workspacePath + hash, location.origin);
  if (frame.contentDocument?.URL === target.href) frame.contentWindow.location.reload();
  else frame.src = target.href;
}
select.addEventListener('change', () => location.assign(previewUrl(select.value, area)));
frame.addEventListener('load', onFrameLoad);
frame.addEventListener('error', () => { retryPanel.hidden = false; });
document.getElementById('retry').addEventListener('click', () => loadWorkspace(areas[area].path));
window.addEventListener('pageshow', (event) => { if (event.persisted) queuePaint(); });
paintControls(area);
const savedHash = history.state?.frameHash;
loadWorkspace(!pendingTeam && typeof savedHash === 'string' && savedHash.startsWith('#')
  ? savedHash : areas[area].path);
