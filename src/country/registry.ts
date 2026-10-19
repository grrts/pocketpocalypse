import { NETHERLANDS } from './nl';
import type { CountryProfile } from './profile';

const COUNTRIES: Record<string, CountryProfile> = {
  [NETHERLANDS.id]: NETHERLANDS,
};

export function getCountry(id: string): CountryProfile {
  const c = COUNTRIES[id];
  if (!c) throw new Error(`Unknown country ${id}`);
  return c;
}

export function listCountries(): CountryProfile[] {
  return Object.values(COUNTRIES);
}
