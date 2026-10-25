import type { DisasterRepository } from '../disasters/disaster.repository.js';
import type { ResourceRepository } from '../resources/resource.repository.js';

/** Dashboard counters. Each figure is one GROUP BY / COUNT query; no rows are loaded into memory. */
export class StatsService {
  constructor(
    private readonly disasters: DisasterRepository,
    private readonly resources: ResourceRepository,
  ) {}

  summary() {
    const byStatus = this.disasters.countByStatus();
    const byType = this.resources.countByType();
    return {
      disasters: {
        total: sum(byStatus),
        by_status: byStatus,
        unresolved_locations: this.disasters.countUnresolvedLocations(),
      },
      resources: { total: sum(byType), by_type: byType },
    };
  }
}

const sum = (counts: Record<string, number>) => Object.values(counts).reduce((a, b) => a + b, 0);
