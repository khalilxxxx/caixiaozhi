// Small vector brand mark. The face reinforces the adjacent written status.
export function xiaozhiIcon(phase = 'idle', className = '', compact = false) {
  const known = ['idle', 'thinking', 'working', 'waiting', 'checking', 'responding', 'completed', 'failed', 'stopped'];
  const state = known.includes(phase) ? phase : 'idle';
  const safeClass = className.replace(/[^a-zA-Z0-9_ -]/g, '');
  const eyes = state === 'completed'
    ? '<path d="M12.5 22.5q2-3 4 0m7 0q2-3 4 0" fill="none" stroke="#91ebed" stroke-width="2.1" stroke-linecap="round"/>'
    : state === 'stopped'
      ? '<path d="M12.5 22.5h4m7 0h4" fill="none" stroke="#a4d5e1" stroke-width="2" stroke-linecap="round"/>'
      : `<g class="xz-eyes"><rect x="12.5" y="19" width="4" height="7" rx="2" fill="#91ebed"/><rect x="23.5" y="19" width="4" height="7" rx="2" fill="#91ebed"/></g>`;
  const mouth = ['failed', 'stopped'].includes(state)
    ? '<path d="M17.5 29h5" stroke="#a4d5e1" stroke-width="1.7" stroke-linecap="round"/>'
    : state === 'waiting'
      ? '<circle cx="20" cy="29" r="1.4" fill="#91ebed"/>'
      : '<path d="M17.2 28.5q2.8 3 5.6 0" fill="none" stroke="#91ebed" stroke-width="1.8" stroke-linecap="round"/>';
  return `<svg class="xz-icon ${safeClass}" data-face="${state}" width="32" height="32" viewBox="${compact ? '7 13 26 22' : '0 0 40 40'}" fill="none" aria-hidden="true" focusable="false">
    ${compact ? '' : `<path d="M7 18 8 5.5Q9 2 12 4l8 8M33 18 32 5.5Q31 2 28 4l-8 8" fill="#edf7fd" stroke="#8eb9d8" stroke-width="1.1" stroke-linejoin="round"/>
    <path d="m10 14 .4-6.2q.2-1.8 1.8-.5l4.3 4.1m13.5 2.6-.4-6.2q-.2-1.8-1.8-.5l-4.3 4.1" fill="#78b8e9"/>
    <rect x="1" y="17.5" width="5" height="13" rx="2.5" fill="#72b4e6"/>
    <rect x="34" y="17.5" width="5" height="13" rx="2.5" fill="#72b4e6"/>
    <path d="M4.5 24C4.5 15 10.5 10 20 10s15.5 5 15.5 14c0 8-5.5 12.5-15.5 12.5S4.5 32 4.5 24Z" fill="#edf7fd" stroke="#8eb9d8" stroke-width="1.1"/>`}
    <path d="M8 23.5c0-6.6 4.8-10.3 9-8.8q3 1.1 6 0c4.2-1.5 9 2.2 9 8.8 0 6.8-4.2 10-12 10s-12-3.2-12-10Z" fill="#203858"/>
    ${eyes}${mouth}
  </svg>`;
}

export const xiaozhiIconCss = `
.variant-a .xz-icon { display: inline-block; flex: none; overflow: visible; vertical-align: middle; }
.variant-a .xz-icon[data-face='stopped'] { opacity: .75; }
.variant-a .a-state-icon .xz-icon[data-face='thinking'] .xz-eyes,
.variant-a .a-state-icon .xz-icon[data-face='working'] .xz-eyes,
.variant-a .a-state-icon .xz-icon[data-face='checking'] .xz-eyes,
.variant-a .a-state-icon .xz-icon[data-face='responding'] .xz-eyes {
  transform-box: fill-box; transform-origin: center;
  animation: xz-focus 4.8s ease-in-out infinite;
}
@keyframes xz-focus {
  0%, 16%, 72%, 100% { transform: translateX(0) scaleY(1); }
  30%, 48% { transform: translateX(1px) scaleY(1); }
  80%, 84% { transform: translateX(0) scaleY(1); }
  82% { transform: translateX(0) scaleY(.12); }
}
body[data-motion='paused'] .variant-a .xz-eyes { animation-play-state: paused; }
@media (prefers-reduced-motion: reduce) {
  .variant-a .a-state-icon .xz-icon .xz-eyes { animation: none; transform: none; }
}
`;
