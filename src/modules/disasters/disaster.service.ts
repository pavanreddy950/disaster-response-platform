import { randomUUID } from 'node:crypto';
import type { User } from '../../auth/users.js';
import type { LocationResolver } from '../../integrations/geocoding/locationResolver.js';
import { ForbiddenError, NotFoundError } from '../../lib/errors.js';
import type { EventBus } from '../../realtime/events.js';
import type { DisasterRepository } from './disaster.repository.js';
import type { CreateDisasterInput, ListDisastersQuery, UpdateDisasterInput } from './disaster.schemas.js';
import type { Disaster, DisasterLocation } from './disaster.types.js';

export class DisasterService {
  constructor(
    private readonly repo: DisasterRepository,
    private readonly locations: LocationResolver,
    private readonly events: EventBus,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async create(input: CreateDisasterInput, user: User): Promise<Disaster> {
    const location = await this.locations.resolve(input);
    const timestamp = this.now().toISOString();

    const disaster: Disaster = {
      id: randomUUID(),
      title: input.title,
      description: input.description,
      location,
      tags: input.tags ?? [],
      status: input.status ?? 'reported',
      created_by: user.id,
      created_at: timestamp,
      updated_at: timestamp,
    };
    this.repo.insert(disaster);
    this.events.publish({ type: 'disaster_created', disaster, actor: user.id, at: timestamp });
    return disaster;
  }

  list(query: ListDisastersQuery) {
    return this.repo.list(query);
  }

  get(id: string): Disaster {
    const disaster = this.repo.findById(id);
    if (!disaster) throw new NotFoundError('Disaster', id);
    return disaster;
  }

  async update(id: string, input: UpdateDisasterInput, user: User): Promise<Disaster> {
    const current = this.get(id);
    assertCanModify(current, user);
    assertStatusTransitionAllowed(current, input, user);

    const location = await this.nextLocation(current, input);

    const updated: Disaster = {
      ...current,
      title: input.title ?? current.title,
      description: input.description ?? current.description,
      tags: input.tags ?? current.tags,
      status: input.status ?? current.status,
      location,
      updated_at: this.now().toISOString(),
    };
    this.repo.update(updated);
    this.events.publish({ type: 'disaster_updated', disaster: updated, actor: user.id, at: updated.updated_at });
    return updated;
  }

  delete(id: string, user: User): void {
    const current = this.get(id);
    // Route already requires admin; re-checked here so the rule holds for any caller of the service.
    if (user.role !== 'admin') throw new ForbiddenError('Only admins can delete disasters');

    const at = this.now().toISOString();
    if (!this.repo.softDelete(id, at)) throw new NotFoundError('Disaster', id);
    this.events.publish({ type: 'disaster_deleted', disaster: current, actor: user.id, at });
  }

  /**
   * Location only changes when location-relevant input changed (avoids needless geocoding calls):
   *  - explicit coordinates win
   *  - a new location_name is geocoded
   *  - a new description is re-extracted, unless the client pinned coordinates explicitly;
   *    if the new text names no place, the previous location is kept
   */
  private async nextLocation(current: Disaster, input: UpdateDisasterInput): Promise<DisasterLocation> {
    if (input.lat !== undefined && input.lng !== undefined) {
      return { name: input.location_name ?? current.location.name, lat: input.lat, lng: input.lng, source: 'client' };
    }
    if (input.location_name !== undefined) {
      return this.locations.resolve({ description: input.description ?? current.description, location_name: input.location_name });
    }
    if (input.description !== undefined && current.location.source !== 'client') {
      const next = await this.locations.resolve({ description: input.description });
      return next.name ? next : current.location;
    }
    return current.location;
  }
}

/** Ownership rule: admins may modify any disaster; contributors only their own. */
function assertCanModify(disaster: Disaster, user: User): void {
  if (user.role === 'admin') return;
  if (disaster.created_by !== user.id) {
    throw new ForbiddenError('Contributors can only modify disasters they created');
  }
}

/** Business rule: a resolved disaster is closed; only an admin may reopen it. */
function assertStatusTransitionAllowed(disaster: Disaster, input: UpdateDisasterInput, user: User): void {
  const reopening = disaster.status === 'resolved' && input.status !== undefined && input.status !== 'resolved';
  if (reopening && user.role !== 'admin') {
    throw new ForbiddenError('Only admins can reopen a resolved disaster');
  }
}
