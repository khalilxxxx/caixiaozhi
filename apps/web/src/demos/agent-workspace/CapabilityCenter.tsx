import { useEffect, useState } from 'react';
import { SkillsPage } from './Skills';
import { ExpertDirectory } from './ExpertTeams';

const sections = [
  { id: 'teams', label: '专家团', href: '#skills?section=teams' },
  { id: 'skills', label: '技能', href: '#skills' },
  { id: 'connectors', label: '连接器', href: '#skills?section=connectors' },
] as const;

function selectedSection(): (typeof sections)[number]['id'] {
  const query = new URLSearchParams(location.hash.split('?')[1]);
  const section = query.get('section');
  return section === 'teams' || section === 'connectors' ? section : 'skills';
}

export function CapabilityCenter() {
  const [section, setSection] = useState(selectedSection);
  useEffect(() => {
    const onHash = () => setSection(selectedSection());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  return (
    <>
      <nav className="cap-center-tabs" aria-label="能力类型">
        {sections.map((item) => (
          <a
            key={item.id}
            href={item.href}
            aria-current={section === item.id ? 'page' : undefined}
          >
            {item.label}
          </a>
        ))}
      </nav>
      {section === 'skills' ? (
        <SkillsPage />
      ) : (
        <ExpertDirectory key={section} section={section} />
      )}
    </>
  );
}
