import { z } from 'zod';
import { DISASTER_STATUSES } from './disaster.types.js';
import { INITIAL_STATUSES } from './lifecycle.js';

const tag = z
  .string()
  .trim()
  .toLowerCase()
  .min(1)
  .max(32)
  .regex(/^[a-z0-9][a-z0-9_-]*$/, 'tags may contain only letters, digits, "-" and "_"');

const tags = z
  .array(tag)
  .max(10, 'at most 10 tags')
  .transform((list) => [...new Set(list)]);

// Fields shared by create and update; no defaults here so `.partial()` stays a pure "patch".
const fields = {
  title: z.string().trim().min(3).max(200),
  description: z.string().trim().min(10).max(5000),
  location_name: z.string().trim().min(2).max(200),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  tags,
  status: z.enum(DISASTER_STATUSES),
};

const bothOrNeitherCoordinate = (v: { lat?: number; lng?: number }) =>
  (v.lat === undefined) === (v.lng === undefined);
const coordinateMessage = { message: 'lat and lng must be provided together', path: ['lat'] };

export const createDisasterSchema = z
  .strictObject({
    title: fields.title,
    description: fields.description,
    location_name: fields.location_name.optional(),
    lat: fields.lat.optional(),
    lng: fields.lng.optional(),
    tags: fields.tags.optional(),
    // A new incident cannot start contained/resolved; see lifecycle.ts
    status: z.enum(INITIAL_STATUSES).optional(),
  })
  .refine(bothOrNeitherCoordinate, coordinateMessage);

export const updateDisasterSchema = z
  .strictObject({
    title: fields.title.optional(),
    description: fields.description.optional(),
    location_name: fields.location_name.optional(),
    lat: fields.lat.optional(),
    lng: fields.lng.optional(),
    tags: fields.tags.optional(),
    status: fields.status.optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'request body must contain at least one field' })
  .refine(bothOrNeitherCoordinate, coordinateMessage);

export const listDisastersQuerySchema = z.object({
  tag: tag.optional(),
  status: z.enum(DISASTER_STATUSES).optional(),
  created_by: z.string().trim().min(1).max(100).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

export type CreateDisasterInput = z.infer<typeof createDisasterSchema>;
export type UpdateDisasterInput = z.infer<typeof updateDisasterSchema>;
export type ListDisastersQuery = z.infer<typeof listDisastersQuerySchema>;
