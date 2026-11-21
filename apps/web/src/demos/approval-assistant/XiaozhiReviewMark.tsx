import type { RiskAssessment } from './risk-assessment';

const documentSymbols = {
  high: (
    <g stroke="#b43a2c">
      <path d="M21.1 17.9v3.8" strokeWidth="2.2" />
      <circle cx="21.1" cy="24.3" r="1.1" fill="#b43a2c" stroke="none" />
    </g>
  ),
  medium: (
    <g stroke="#98600f" strokeWidth="1.8">
      <circle cx="20.35" cy="20.65" r="2.25" />
      <path d="m22 22.3 2.15 2.15" />
    </g>
  ),
  low: (
    <path d="m17.85 21.7 2.2 2.15 4.25-4.55" stroke="#227255" strokeWidth="2" />
  ),
  neutral: <path d="M18.45 21.65h5.5" stroke="#667687" strokeWidth="1.85" />,
};

export function XiaozhiReviewMark({ tone }: { tone: RiskAssessment['tone'] }) {
  return (
    <svg
      className="xiaozhi-review-mark"
      data-risk-tone={tone}
      aria-hidden="true"
      focusable="false"
      width="28"
      height="28"
      viewBox="0 0 28 28"
      fill="none"
      stroke="#365c82"
      strokeWidth="1.65"
      strokeLinejoin="round"
      strokeLinecap="round"
    >
      <g transform="translate(-.65 .25) scale(.87)">
        <path
          d="M4.2 12.1 5 5.2c.1-.9.7-1.2 1.5-.7L11 7.9a19 19 0 0 1 6 0l4.5-3.4c.8-.5 1.4-.2 1.5.7l.8 6.9a8.8 8.8 0 0 1 1.7 5.1c0 4.9-4.4 7.5-11.5 7.5S2.5 22.1 2.5 17.2a8.8 8.8 0 0 1 1.7-5.1Z"
          fill="#eaf4ff"
        />
        <path
          d="M10.3 12h7.4c3.3 0 4.9 1.6 4.9 4.3 0 2.8-2.3 4.8-8.6 4.8s-8.6-2-8.6-4.8c0-2.7 1.6-4.3 4.9-4.3Z"
          fill="#fff"
          strokeWidth="1.5"
        />
        <path d="M10.1 15.6v1.5m6.2-1.5v1.5" strokeWidth="2.25" />
      </g>
      <path
        d="M17.55 13.1H23l3.65 3.65V25c0 1.05-.65 1.7-1.7 1.7h-7.4c-1.05 0-1.7-.65-1.7-1.7V14.8c0-1.05.65-1.7 1.7-1.7Z"
        fill="#fff"
        strokeWidth="1.4"
      />
      <path d="M23 13.3v3.45h3.45" fill="#e6eff8" strokeWidth="1.1" />
      {documentSymbols[tone]}
    </svg>
  );
}
