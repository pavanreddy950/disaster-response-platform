import { EventEmitter } from 'node:events';
import type { Disaster } from '../modules/disasters/disaster.types.js';

export type DisasterEventType = 'disaster_created' | 'disaster_updated' | 'disaster_deleted';

export interface DisasterEvent {
  type: DisasterEventType;
  disaster: Disaster;
  actor: string;
  at: string;
}

/**
 * In-process domain event bus. Services publish here; transports (SSE today,
 * a message broker tomorrow) subscribe. Keeps services unaware of delivery.
 */
export class EventBus {
  private readonly emitter = new EventEmitter();

  constructor() {
    this.emitter.setMaxListeners(0); // one listener per SSE client
  }

  publish(event: DisasterEvent): void {
    this.emitter.emit('disaster', event);
  }

  subscribe(listener: (event: DisasterEvent) => void): () => void {
    this.emitter.on('disaster', listener);
    return () => this.emitter.off('disaster', listener);
  }
}
