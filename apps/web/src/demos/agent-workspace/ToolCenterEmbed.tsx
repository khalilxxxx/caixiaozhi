import { useEffect, useRef, useState } from 'react';
import { ExpenseSummaryTool } from './ExpenseSummaryTool';
import { Button, Icon } from './ui';
import './tool-center-embed.css';

const allowedRoutes = /^(?:(?:tool|manage|review|edit|share|request)\/[^/]+|upload|requests)$/;
const guideActions = new Set(['load-sample', 'upload-sample', 'download-upload-sample']);
export function ToolCenterEmbed({ route, onBack }: { route: string; onBack: () => void }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const onBackRef = useRef(onBack);
  onBackRef.current = onBack;
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [height, setHeight] = useState(640);
  const validRoute = allowedRoutes.test(route);
  const native = route === 'tool/expense-summary';
  useEffect(() => { setLoading(true); setFailed(false); }, [route]);
  useEffect(() => () => { window.dispatchEvent(new CustomEvent('caixiaozhi-tool-panel-change',{detail:{kind:null}})); }, []);
  useEffect(() => {
    if (native || !validRoute) return;
    const sendViewport = () => {
      const rect = frame.current?.getBoundingClientRect();
      if (!rect) return;
      const top = Math.max(0, -rect.top);
      const visibleHeight = Math.max(240, Math.min(rect.bottom, innerHeight) - Math.max(rect.top, 0));
      frame.current?.contentWindow?.postMessage({source:'caixiaozhi-tool-host',type:'viewport',top,height:visibleHeight},location.origin);
    };
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== location.origin || event.source !== frame.current?.contentWindow || event.data?.source !== 'caixiaozhi-tool-center') return;
      if (event.data.type === 'back') onBackRef.current();
      if (event.data.type === 'open-skills') location.hash = 'skills';
      if (event.data.type === 'ready') { setLoading(false); sendViewport(); }
      if (event.data.type === 'height' && Number.isFinite(event.data.height)) {
        const top = frame.current?.getBoundingClientRect().top || 0;
        setHeight(Math.max(400, Math.min(20000, event.data.height), innerHeight - Math.max(top, 0) - 24));
        requestAnimationFrame(sendViewport);
      }
      if (event.data.type === 'navigate' && typeof event.data.route === 'string' && allowedRoutes.test(event.data.route)) {
        const [action, encodedId] = event.data.route.split('/');
        const query = new URLSearchParams(location.hash.split('?')[1] || '');
        query.set('action',action);
        if (encodedId) { try { query.set('tool',decodeURIComponent(encodedId)); } catch { return; } }
        else query.delete('tool');
        location.hash = `light-apps?${query}`;
      }
      if (event.data.type === 'state-change') window.dispatchEvent(new CustomEvent('caixiaozhi-tool-catalog-change'));
      if (event.data.type === 'panel-state') window.dispatchEvent(new CustomEvent('caixiaozhi-tool-panel-change',{detail:event.data}));
    };
    const onGuide = (event: Event) => {
      const detail = (event as CustomEvent<{action?:string;toolId?:string}>).detail;
      if (!detail || !guideActions.has(detail.action || '')) return;
      let currentId: string | undefined;
      try { currentId = route.includes('/') ? decodeURIComponent(route.slice(route.indexOf('/') + 1)) : undefined; } catch { return; }
      if (detail.toolId && detail.toolId !== currentId) return;
      frame.current?.contentWindow?.postMessage({source:'caixiaozhi-tool-host',type:'guide-action',action:detail.action,toolId:detail.toolId},location.origin);
    };
    window.addEventListener('message',onMessage);
    window.addEventListener('caixiaozhi-tool-guide-action',onGuide);
    window.addEventListener('resize',sendViewport);
    window.addEventListener('scroll',sendViewport,true);
    return () => {
      window.removeEventListener('message',onMessage);
      window.removeEventListener('caixiaozhi-tool-guide-action',onGuide);
      window.removeEventListener('resize',sendViewport);
      window.removeEventListener('scroll',sendViewport,true);
    };
  }, [route, native, validRoute]);
  if (native) return <section className="tool-center-native"><Button onClick={onBack}><Icon name="back" size={14}/>返回目录</Button><ExpenseSummaryTool/></section>;
  if (!validRoute) return <div className="tool-detail-state" role="alert">工具地址无效。<Button onClick={onBack}>返回目录</Button></div>;
  return <section className="tool-center-embedded" aria-label="工具工作区">
    {loading && !failed && <div className="tool-center-loading" role="status">正在加载工具…</div>}
    {failed && <div className="tool-center-loading" role="alert">工具加载失败。<Button onClick={() => { setFailed(false); setLoading(true); if (frame.current) frame.current.src = `/demos/tool-center/index.html?embed=agent#${route}`; }}>重新加载</Button></div>}
    <iframe ref={frame} title="工具工作区" src={`/demos/tool-center/index.html?embed=agent#${route}`} style={{height}} onLoad={() => setLoading(false)} onError={() => { setFailed(true); setLoading(false); }}/>
  </section>;
}
