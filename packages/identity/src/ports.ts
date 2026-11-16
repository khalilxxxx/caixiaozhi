import type { ActorContext } from '@caixiaozhi/contracts/common';
import type {
  Grant,
  PersonCandidate,
  PlaceResolution,
  AuthorizationGroup,
} from '@caixiaozhi/contracts/identity';

export type AuthCallbackInput = {
  code: string;
  state: string;
  nonce: string;
  redirectUri: string;
};
export type ExternalIdentity = {
  subject: string;
  issuer: string;
  tenantId: string;
  userId: string;
  active: boolean;
};
export interface IdentityProvider {
  readonly issuer: string;
  readonly ready: boolean;
  authenticate(input: AuthCallbackInput): Promise<ExternalIdentity>;
  resolveSubject(subject: string, issuer: string): Promise<ExternalIdentity>;
}
export type PageInput = { q?: string; cursor?: string; limit?: number };
export type PeopleQuery = PageInput & { department_id?: string };
export type Page<T> = { items: T[]; next_cursor: string | null };
export interface DirectoryProvider {
  searchPeople(
    ctx: ActorContext,
    input: PeopleQuery,
  ): Promise<Page<PersonCandidate>>;
  resolveManager(
    ctx: ActorContext,
    departmentId: string,
  ): Promise<PersonCandidate>;
  listGroups(
    ctx: ActorContext,
    input: PageInput,
  ): Promise<Page<AuthorizationGroup>>;
  isGroupMember(
    ctx: ActorContext,
    groupId: string,
    userId: string,
  ): Promise<boolean>;
  resolvePlace(ctx: ActorContext, text: string): Promise<PlaceResolution>;
}
export type AuthorizationRef = { type: string; id: string; version: number };
export type ResourceMetadata = {
  tenant_id: string;
  version: number;
  owner_id?: string;
  department_id?: string;
  assigned_to?: string;
  status?: string;
  stage?: string;
  resource_type?: string;
};
export type ResourceResolver = (
  ctx: ActorContext,
  ref: AuthorizationRef,
) => Promise<ResourceMetadata | null>;
export type ResourceScope = {
  tenant_id: string;
  owner_ids: string[];
  department_ids: string[];
  named_resource_ids: string[];
  operations_ids: string[];
  assigned_task_department_ids: string[];
};
export type ActorOrigin =
  | { sessionId: string; invocationOrigin: 'interactive'; delegationId?: null }
  | { sessionId: null; invocationOrigin: 'subscription'; delegationId: string };
export type DemoEnvironmentInput = {
  tenantId?: string;
  environmentId?: string;
  generation?: number;
};
export type DemoGrantChange = {
  tenantId: string;
  targetUserId: string;
  expectedVersion: number;
  grants: Grant[];
  reason: string;
  traceId: string;
};
