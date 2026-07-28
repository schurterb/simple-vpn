export type ResourceType = 'iface' | 'route' | 'fwrule' | 'mapping';
export type LifecycleState = 'intended' | 'created' | 'removing' | 'removed';

export interface JournalEntry {
  id: string;
  resourceType: ResourceType;
  identity: string;
  action: 'create' | 'delete';
  attributes: Record<string, unknown>;
  state: LifecycleState;
  createdAt: number;
  updatedAt: number;
}

export interface JournalSnapshot {
  entries: JournalEntry[];
}
