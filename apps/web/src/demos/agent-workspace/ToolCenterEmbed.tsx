import { useEffect, useRef, useState } from 'react';
import './tool-center-embed.css';

function currentToolRoute() {
  const query = new URLSearchParams(location.hash.split('?')[1] || '');
  const tool = query.get('tool');
  return tool ? `tool/${encodeURIComponent(tool)}` : 'catalog';
}

export function ToolCenterEmbed({ onOpenSkills }: { onOpenSkills: () => void }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [route, setRoute] = useState(currentToolRoute);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const onHashChange = () => setRoute(currentToolRoute());
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== location.origin || event.source !== frame.current?.contentWindow) return;
      if (event.data?.source !== 'caixiaozhi-tool-center') return;
      if (event.data.type === 'open-skills') onOpenSkills();
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [onOpenSkills]);

  return <section className="tool-center-embedded" aria-label="小工具工作区">
    {loading && <div className="tool-center-loading" role="status">正在加载小工具…</div>}
    <iframe
      ref={frame}
      title="财务小工具"
      src={`/demos/tool-center/index.html?embed=agent#${route}`}
      onLoad={() => setLoading(false)}
    />
  </section>;
}
