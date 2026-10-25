export type Role = 'admin' | 'contributor';

export interface User {
  id: string;
  name: string;
  role: Role;
}

/**
 * Mock identity store. These are deliberately public demo tokens, not secrets:
 * the assignment allows mock users, and a real deployment would replace this
 * with an identity provider issuing signed JWTs (see README "Limitations").
 */
const TOKENS: Record<string, User> = {
  'admin-token': { id: 'admin', name: 'Admin User', role: 'admin' },
  'contributor-token': { id: 'contributor1', name: 'Field Volunteer', role: 'contributor' },
  'contributor2-token': { id: 'contributor2', name: 'Second Volunteer', role: 'contributor' },
};

export function findUserByToken(token: string): User | undefined {
  return Object.hasOwn(TOKENS, token) ? TOKENS[token] : undefined;
}
