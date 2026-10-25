import { z } from 'zod';

export const RESOURCE_TYPES = ['shelter', 'hospital', 'food', 'water', 'rescue', 'medical', 'other'] as const;
export type ResourceType = (typeof RESOURCE_TYPES)[number];

export const MAX_RADIUS_KM = 200;

export const nearbyQuerySchema = z
  .object({
    lat: z.coerce.number().min(-90).max(90).optional(),
    lng: z.coerce.number().min(-180).max(180).optional(),
    radius: z.coerce.number().positive().max(MAX_RADIUS_KM).default(10),
    type: z.enum(RESOURCE_TYPES).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  })
  .refine((v) => (v.lat === undefined) === (v.lng === undefined), {
    message: 'lat and lng must be provided together',
    path: ['lat'],
  });

export const createResourceSchema = z.strictObject({
  name: z.string().trim().min(2).max(200),
  type: z.enum(RESOURCE_TYPES),
  location_name: z.string().trim().min(2).max(200).optional(),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
});

export const listResourcesQuerySchema = z.object({
  type: z.enum(RESOURCE_TYPES).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export type CreateResourceInput = z.infer<typeof createResourceSchema>;
