import type { ExpertTeamId } from './capability-model';

export interface TeamConnector {
  id: string;
  name: string;
  status: 'available' | 'unavailable';
  scope: string;
}
export interface TeamSkill {
  id: string;
  name: string;
  description: string;
  member?: string;
  connectorIds: string[];
}
export interface ExpertTeam {
  id: ExpertTeamId;
  name: string;
  description: string;
  baseTeamId?: ExpertTeamId;
  members: { name: string; role: string }[];
  skills: TeamSkill[];
  connectors: TeamConnector[];
  examples: string[];
}

export function availableTeamSkill(
  skill: TeamSkill,
  connectors: TeamConnector[],
) {
  return skill.connectorIds.every((id) =>
    connectors.some((c) => c.id === id && c.status === 'available'),
  );
}

export function selectionForTeam(team: ExpertTeam, chosen: readonly string[]) {
  const skills = team.skills.filter(
    (s) => chosen.includes(s.id) && availableTeamSkill(s, team.connectors),
  );
  return {
    skillIds: skills.map((s) => s.id),
    connectorIds: [...new Set(skills.flatMap((s) => s.connectorIds))],
  };
}
