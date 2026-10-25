/**
 * Seeds demo resources (and one sample disaster per lifecycle status) so the API is explorable immediately.
 * Idempotent: resources are only inserted when the table is empty.
 *   npm run seed
 */
import { randomUUID } from 'node:crypto';
import { loadConfig } from '../src/config.js';
import { openDatabase } from '../src/db/connection.js';
import { DisasterRepository } from '../src/modules/disasters/disaster.repository.js';
import type { Disaster } from '../src/modules/disasters/disaster.types.js';
import { ResourceRepository } from '../src/modules/resources/resource.repository.js';
import type { CreateResourceInput } from '../src/modules/resources/resource.schemas.js';

const RESOURCES: CreateResourceInput[] = [
  // New York City
  { name: 'Red Cross Shelter - Lower East Side', type: 'shelter', location_name: 'Lower East Side, Manhattan', lat: 40.7150, lng: -73.9843 },
  { name: 'NYU Langone Hospital', type: 'hospital', location_name: 'Kips Bay, Manhattan', lat: 40.7421, lng: -73.9739 },
  { name: 'Mount Sinai Hospital', type: 'hospital', location_name: 'East Harlem, Manhattan', lat: 40.7900, lng: -73.9526 },
  { name: 'Central Park Food Distribution', type: 'food', location_name: 'Central Park, Manhattan', lat: 40.7812, lng: -73.9665 },
  { name: 'Hudson Yards Water Point', type: 'water', location_name: 'Hudson Yards, Manhattan', lat: 40.7539, lng: -74.0010 },
  { name: 'FDNY Rescue 1', type: 'rescue', location_name: 'Midtown West, Manhattan', lat: 40.7640, lng: -73.9930 },
  { name: 'Brooklyn Community Shelter', type: 'shelter', location_name: 'Downtown Brooklyn', lat: 40.6928, lng: -73.9903 },
  { name: 'Queens General Hospital', type: 'hospital', location_name: 'Jamaica, Queens', lat: 40.7177, lng: -73.8045 },
  { name: 'Newark Relief Camp', type: 'shelter', location_name: 'Newark, NJ', lat: 40.7357, lng: -74.1724 },
  // Mumbai
  { name: 'KEM Hospital', type: 'hospital', location_name: 'Parel, Mumbai', lat: 19.0028, lng: 72.8423 },
  { name: 'BMC School Shelter - Dadar', type: 'shelter', location_name: 'Dadar, Mumbai', lat: 19.0178, lng: 72.8478 },
  { name: 'Dharavi Community Kitchen', type: 'food', location_name: 'Dharavi, Mumbai', lat: 19.0380, lng: 72.8538 },
  { name: 'NDRF Team - Andheri', type: 'rescue', location_name: 'Andheri, Mumbai', lat: 19.1136, lng: 72.8697 },
  { name: 'Water Tanker Point - Kurla', type: 'water', location_name: 'Kurla, Mumbai', lat: 19.0726, lng: 72.8845 },
  // Chennai
  { name: 'Rajiv Gandhi Govt. General Hospital', type: 'hospital', location_name: 'Park Town, Chennai', lat: 13.0810, lng: 80.2770 },
  { name: 'Velachery Relief Shelter', type: 'shelter', location_name: 'Velachery, Chennai', lat: 12.9815, lng: 80.2180 },
  { name: 'Adyar Food Bank', type: 'food', location_name: 'Adyar, Chennai', lat: 13.0012, lng: 80.2565 },
  // Kerala
  { name: 'Ernakulam General Hospital', type: 'hospital', location_name: 'Kochi, Kerala', lat: 9.9700, lng: 76.2830 },
  { name: 'Aluva Flood Relief Camp', type: 'shelter', location_name: 'Aluva, Kerala', lat: 10.1004, lng: 76.3570 },
  // Fiji (near the antimeridian)
  { name: 'Suva Evacuation Centre', type: 'shelter', location_name: 'Suva, Fiji', lat: -18.1416, lng: 178.4419 },
  { name: 'Taveuni Rescue Post', type: 'rescue', location_name: 'Taveuni, Fiji', lat: -16.8500, lng: -179.9800 },
];

const config = loadConfig();
const db = openDatabase(config.DATABASE_PATH);
const resources = new ResourceRepository(db);
const disasters = new DisasterRepository(db);
const now = new Date().toISOString();

const { total } = resources.list({ limit: 1, offset: 0 });
if (total === 0) {
  db.transaction(() => RESOURCES.forEach((r) => resources.insert(r, now)))();
  console.log(`Inserted ${RESOURCES.length} resources`);
} else {
  console.log(`Resources table already has ${total} rows, skipping`);
}

// One sample per lifecycle stage, so the dashboard and GET /stats have something to show.
const SAMPLE_DISASTERS: Array<Omit<Disaster, 'id' | 'created_at' | 'updated_at'>> = [
  {
    title: 'Manhattan flash flooding',
    description: 'Heavy flooding has affected Manhattan, NYC. Subway stations closed.',
    location: { name: 'Manhattan, NYC', lat: 40.7831, lng: -73.9712, source: 'geocoded' },
    tags: ['flood', 'urban'],
    status: 'active',
    created_by: 'admin',
  },
  {
    title: 'Mumbai monsoon waterlogging',
    description: 'Severe waterlogging reported across Mumbai after 300mm of rain.',
    location: { name: 'Mumbai', lat: 19.076, lng: 72.8777, source: 'geocoded' },
    tags: ['flood', 'monsoon'],
    status: 'reported',
    created_by: 'contributor1',
  },
  {
    title: 'Cyclone approaching Chennai coast',
    description: 'IMD has confirmed a severe cyclonic storm expected to make landfall near Chennai within 36 hours.',
    location: { name: 'Chennai', lat: 13.0827, lng: 80.2707, source: 'geocoded' },
    tags: ['cyclone', 'coastal'],
    status: 'verified',
    created_by: 'contributor1',
  },
  {
    title: 'Landslide near Aluva',
    description: 'Landslide blocked roads near Aluva, Kerala. Rescue teams have stabilised the slope.',
    location: { name: 'Aluva, Kerala', lat: 10.1004, lng: 76.357, source: 'geocoded' },
    tags: ['landslide', 'monsoon'],
    status: 'contained',
    created_by: 'admin',
  },
  {
    title: 'Tropical storm warning for Suva',
    description: 'Tropical storm passed south of Suva, Fiji with minor damage; shelters have closed.',
    location: { name: 'Suva, Fiji', lat: -18.1416, lng: 178.4419, source: 'geocoded' },
    tags: ['storm'],
    status: 'resolved',
    created_by: 'admin',
  },
];

if (disasters.list({ limit: 1, offset: 0 }).total === 0) {
  db.transaction(() => {
    for (const sample of SAMPLE_DISASTERS) {
      // Goes through the repository, so each sample also gets its 'created' audit entry
      disasters.insert(
        { ...sample, id: randomUUID(), created_at: now, updated_at: now },
        { action: 'created', actor: sample.created_by, changes: {}, at: now },
      );
    }
  })();
  console.log(`Inserted ${SAMPLE_DISASTERS.length} sample disasters`);
}

db.close();
