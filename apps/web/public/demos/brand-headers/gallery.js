import { createBrandHeader, icon, styles } from './headers.js';
const areas = {hub: '能力中心', apps: '轻应用'};
const samples = document.querySelector('#samples');
const copyButton = document.querySelector('#copy');
const summary = document.querySelector('#selection-summary');
const feedback = document.querySelector('#feedback');
const selected = {};
const storageKey = area => 'cx.brand-headers.choice.' + area;

for (const area of Object.keys(areas)) {
  try {
    const saved = localStorage.getItem(storageKey(area));
    if (styles.some(style => style.id === saved)) selected[area] = saved;
  } catch { /* The selection also works within this visit. */ }
}

for (const style of styles) {
  const row = document.createElement('section');
  row.className = 'sample-row';
  row.id = 'style-' + style.id;
  row.setAttribute('aria-labelledby', 'title-' + style.id);
  row.innerHTML = '<div class="row-title"><span class="letter">' + style.id.toUpperCase() +
    '</span><h2 id="title-' + style.id + '">' + style.title + '</h2>' +
    (style.note ? '<p>' + style.note + '</p>' : '') + '</div><div class="pair"></div>';
  for (const [area, name] of Object.entries(areas)) {
    const sample = document.createElement('div');
    sample.className = 'sample';
    sample.dataset.area = area;
    sample.setAttribute('role', 'group');
    sample.setAttribute('aria-label', name + ' · ' + style.title);
    sample.append(createBrandHeader(area, style.id, document, 3));
    const controls = document.createElement('div');
    controls.className = 'sample-actions';
    const preview = document.createElement('a');
    preview.href = './preview.html?' + new URLSearchParams({style:style.id, area});
    preview.innerHTML = icon('expand') + '放入工作台';
    preview.setAttribute('aria-label', '在工作台预览' + name + '的' + style.title);
    const pick = document.createElement('button');
    pick.type = 'button';
    pick.dataset.area = area;
    pick.dataset.choice = style.id;
    pick.addEventListener('click', () => toggleChoice(area, style.id));
    controls.append(preview, pick);
    sample.append(controls);
    row.querySelector('.pair').append(sample);
  }
  document.getElementById(style.series + '-styles').append(row);
}

function toggleChoice(area, style) {
  if (selected[area] === style) delete selected[area];
  else selected[area] = style;
  try {
    if (selected[area]) localStorage.setItem(storageKey(area), selected[area]);
    else localStorage.removeItem(storageKey(area));
  } catch { /* Private browsing can disable persistent storage. */ }
  updateSelection();
}

function updateSelection() {
  for (const pick of samples.querySelectorAll('button[data-choice]')) {
    const {area, choice} = pick.dataset;
    const active = selected[area] === choice;
    pick.setAttribute('aria-pressed', String(active));
    pick.setAttribute('aria-label', areas[area] + '选择 ' + choice.toUpperCase() + ' 款');
    pick.innerHTML = (active ? icon('check') + '已选 ' : '选 ') + choice.toUpperCase() + ' 款';
  }
  const selections = Object.entries(areas).filter(([key]) => selected[key]);
  summary.textContent = selections.map(([key, name]) => name + ' ' + selected[key].toUpperCase()).join(' · ') || '尚未选择';
  copyButton.disabled = !selections.length;
}
copyButton.innerHTML = icon('copy') + '<span>复制选择</span>';
copyButton.addEventListener('click', async () => {
  const text = Object.entries(areas).filter(([area]) => selected[area]).map(([area, name]) => {
    const style = styles.find(s => s.id === selected[area]);
    return name + '选 ' + style.id.toUpperCase() + ' 款「' + style.title + '」';
  }).join('，');
  try {
    await navigator.clipboard.writeText(text);
    inform('已复制，可以粘贴到对话中。');
  } catch {
    const range = document.createRange();
    range.selectNodeContents(summary);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    inform('已选中款式文字，可手动复制。');
  }
});

let timer;
function inform(message) {
  feedback.textContent = message;
  feedback.classList.add('visible');
  clearTimeout(timer);
  timer = setTimeout(() => feedback.classList.remove('visible'), 3500);
}
for (const filter of document.querySelectorAll('[data-scope]')) {
  filter.addEventListener('click', () => {
    const scope = filter.dataset.scope;
    for (const button of document.querySelectorAll('[data-scope]')) {
      button.setAttribute('aria-pressed', String(button === filter));
    }
    for (const tile of samples.querySelectorAll('.sample')) {
      tile.hidden = scope !== 'all' && tile.dataset.area !== scope;
    }
    samples.classList.toggle('single', scope !== 'all');
  });
}

function revealLinkedStyle() {
  const linked = styles.find(style => location.hash === '#style-' + style.id);
  if (!linked) return;
  if (linked.series === 'previous') document.getElementById('archive').open = true;
  requestAnimationFrame(() => document.getElementById('style-' + linked.id).scrollIntoView());
}
updateSelection();
revealLinkedStyle();
window.addEventListener('hashchange', revealLinkedStyle);
