const root = new URL('./', import.meta.url);
const portrait = new URL('../capability-hub/brand.webp', root).href;

export const styles = [
  { id: 'd', title: '纸上工作室', series: 'current', art: 'paper' },
  { id: 'e', title: '立体工作台', series: 'current', art: 'studio' },
  { id: 'a', title: '小智名片', series: 'previous', note: '用一句话交代用途，留出更多空间浏览目录。' },
  { id: 'b', title: '场景问答', series: 'previous', note: '从一个具体的财务问题切入，让第一次来的用户知道能做什么。' },
  { id: 'c', title: '常用任务', series: 'previous', note: '把两项常用工作放在页头，可以直接进入。' },
];

const areas = {
  hub: {
    title: '能力中心',
    paper: '召唤专家团，让小智查制度、核单据、看财报。',
    studio: '召唤专家团，让小智按任务选用技能和数据来源。',
    intro: '召唤专家团，小智会按任务选用技能和数据来源，核单据、查制度、分析财报。',
    question: '这笔住宿费，符合差旅标准吗？',
    answer: '请小智查制度、核单据，给出适用条款。也可以召唤专家团分析费用和财报。',
    tasksIntro: '专家团按任务选用技能和数据来源，在对话中给出结果。',
    image: new URL('review.webp', root).href,
    tasks: [
      { title: '核对单据与制度', id: 'finance-review-team', icon: 'document' },
      { title: '分析费用与财报', id: 'finance-analysis-team', icon: 'chart' },
    ],
  },
  apps: {
    title: '轻应用',
    paper: '打开独立工具，核对表格、汇总费用。',
    studio: '在独立窗口使用业务工具。创作者可上传自制 HTML 应用，审核通过后发布。',
    intro: '在独立窗口核对表格、汇总费用。创作者也可以上传自己的 HTML 小工具。',
    question: '流水和台账，哪里对不上？',
    answer: '用“两表核对”在独立窗口查找差异。其他轻应用还能汇总费用、转换台账。',
    tasksIntro: '在独立窗口核对表格、汇总费用，再导出结果。',
    image: new URL('desk.webp', root).href,
    tasks: [
      { title: '两表核对', id: 'reconcile', icon: 'table' },
      { title: 'CSV 费用汇总', id: 'expense-summary', icon: 'sum' },
    ],
  },
};

const shapes = {
  chart: '<path d="M4 4v15h16M8 15v-4m4 4V7m4 8v-6"/>',
  document: '<path d="M8 3h8l3 3v14H6V3h2zM9 9h6m-6 4h3m2 2 2 2 4-5"/>',
  table: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 10h18m-11 0v9"/>',
  sum: '<path d="M17 5H7l6 7-6 7h10"/>',
  forward: '<path d="m9 5 7 7-7 7"/>',
  external: '<path d="M13 5h6v6m0-6-8 8M9 6H5v13h13v-4"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  copy: '<rect x="8" y="8" width="12" height="13" rx="2"/><path d="M15 8V4H4v12h4"/>',
  expand: '<path d="M4 10V4h6m4 0h6v6m0 4v6h-6m-4 0H4v-6"/>',
};

export function icon(name) {
  return '<svg aria-hidden="true" focusable="false" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">' + shapes[name] + '</svg>';
}

function taskLinks(area, tasks) {
  return tasks.map(task => {
    const hub = area === 'hub';
    const href = hub
      ? new URL('preview.html?style=c&area=hub&team=' + task.id, root).href
      : new URL('/agent.html#light-apps?tool=' + task.id + '&action=tool', root).href;
    const target = hub ? '_top' : '_blank';
    return '<a class="bh-action" target="' + target + '" rel="noopener" href="' + href + '">' +
      icon(task.icon) + '<span>' + task.title + '</span>' + icon(hub ? 'forward' : 'external') + '</a>';
  }).join('');
}

// The same header renders at catalog size in the workbench and at column size on the comparison sheet.
export function createBrandHeader(area, style, targetDocument = document, headingLevel = 1) {
  const item = areas[area];
  const design = styles.find(candidate => candidate.id === style);
  if (!item || !design) throw new TypeError('未知的页头样式');
  const title = headingLevel === 3 ? 'h3' : 'h1';
  const el = targetDocument.createElement('section');
  el.className = 'bh-module bh-' + area + ' bh-' + style;
  el.setAttribute('aria-label', item.title);
  const heading = (cls = 'bh-title') => '<' + title + ' class="' + cls + '">' + item.title + '</' + title + '>';
  if (design.art) {
    const art = new URL(design.art + '-' + area + '.webp', root);
    el.classList.add('bh-illustrated');
    el.style.setProperty('--bh-art', 'url("' + art.href + '")');
    el.innerHTML = '<div class="bh-inner"><div class="bh-plate" aria-hidden="true"><img class="bh-artwork" src="' + art.href + '" alt=""></div>' +
      '<div class="bh-caption">' + heading() + '<p class="bh-copy">' + item[design.art] + '</p></div></div>';
  } else if (style === 'a') {
    el.innerHTML = '<div class="bh-inner"><span class="bh-avatar"><img src="' + portrait + '" alt=""></span><div>' +
      heading() + '<p class="bh-copy">' + item.intro + '</p></div></div>';
  } else if (style === 'b') {
    el.innerHTML = '<div class="bh-inner"><div class="bh-words">' + heading('bh-section-name') +
      '<p class="bh-question">' + item.question + '</p><p class="bh-copy">' + item.answer + '</p></div>' +
      '<div class="bh-scene" aria-hidden="true"><i class="bh-lines"></i><i class="bh-ring"></i><img src="' + item.image + '" alt=""></div></div>';
  } else {
    el.innerHTML = '<div class="bh-inner"><div class="bh-action-heading"><div>' + heading() +
      '<p class="bh-copy">' + item.tasksIntro + '</p></div><img src="' + item.image + '" alt=""></div>' +
      '<div class="bh-actions">' + taskLinks(area, item.tasks) + '</div></div>';
  }
  return el;
}
