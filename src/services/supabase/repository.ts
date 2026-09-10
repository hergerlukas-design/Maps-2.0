import type { ConnectorType, StopKind } from '@shared/types';
import type { FavouriteStop, Settings, Vehicle } from '@/types/domain';
import { clampSettings, DEFAULT_SETTINGS } from '@/types/domain';
import { supabase } from './client';
import type { FavoriteRow, SettingsRow, VehicleRow } from './schema';

/* ------------------------------------------------------------------ *
 * Row ↔ domain mapping
 *
 * The DB uses snake_case and stores connectors as a text[]; the app uses
 * camelCase and a narrowed union. Keeping the translation in one place means a
 * schema change touches exactly this file.
 * ------------------------------------------------------------------ */

const KNOWN_CONNECTORS: readonly ConnectorType[] = [
  'ccs',
  'chademo',
  'type2',
  'type2_socket',
  'tesla_supercharger',
  'schuko',
  'other',
];

function toConnectors(values: string[] | null): ConnectorType[] {
  if (!values) return [];
  return values.filter((v): v is ConnectorType =>
    KNOWN_CONNECTORS.includes(v as ConnectorType),
  );
}

export function vehicleFromRow(row: VehicleRow): Vehicle {
  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    kind: row.kind,
    fuel: row.fuel,
    connectors: toConnectors(row.connectors),
    typicalRangeKm: row.typical_range_km,
    consumption: { per100km: row.consumption_per_100km },
    isDefault: row.is_default,
    createdAt: row.created_at,
  };
}

export function settingsFromRow(row: SettingsRow): Settings {
  return clampSettings({
    rangeThresholdKm: row.range_threshold_km,
    searchRadiusKm: row.search_radius_km,
    reAskIntervalKm: row.re_ask_interval_km,
    maxSuggestions: row.max_suggestions,
    detourPenaltyCtPerKm: Number(row.detour_penalty_ct_per_km),
    minChargingPowerKw: row.min_charging_power_kw,
    voiceGuidance: row.voice_guidance,
    keepScreenAwake: row.keep_screen_awake,
    pushNotifications: row.push_notifications,
    avoid: {
      tolls: row.avoid_tolls,
      motorways: row.avoid_motorways,
      ferries: row.avoid_ferries,
    },
    units: 'metric',
  });
}

function settingsToRow(settings: Settings, userId: string) {
  return {
    user_id: userId,
    vehicle_id: null,
    range_threshold_km: Math.round(settings.rangeThresholdKm),
    search_radius_km: Math.round(settings.searchRadiusKm),
    re_ask_interval_km: Math.round(settings.reAskIntervalKm),
    max_suggestions: Math.round(settings.maxSuggestions),
    detour_penalty_ct_per_km: settings.detourPenaltyCtPerKm,
    min_charging_power_kw: Math.round(settings.minChargingPowerKw),
    voice_guidance: settings.voiceGuidance,
    keep_screen_awake: settings.keepScreenAwake,
    push_notifications: settings.pushNotifications,
    avoid_tolls: settings.avoid.tolls,
    avoid_motorways: settings.avoid.motorways,
    avoid_ferries: settings.avoid.ferries,
  };
}

function favouriteFromRow(row: FavoriteRow): FavouriteStop {
  return {
    id: row.id,
    userId: row.user_id,
    stopId: row.stop_id,
    kind: row.kind,
    name: row.name,
    location: { lng: row.lng, lat: row.lat },
    note: row.note,
    createdAt: row.created_at,
  };
}

/* ------------------------------------------------------------------ *
 * Vehicles
 * ------------------------------------------------------------------ */

export async function listVehicles(userId: string): Promise<Vehicle[]> {
  if (!supabase) return [];
  const { data, error } = await supabase
    .from('vehicles')
    .select('*')
    .eq('user_id', userId)
    .order('is_default', { ascending: false })
    .order('created_at', { ascending: true });
  if (error) throw new Error(`Fahrzeuge konnten nicht geladen werden: ${error.message}`);
  return (data ?? []).map(vehicleFromRow);
}

export interface VehicleInput {
  name: string;
  kind: Vehicle['kind'];
  fuel: Vehicle['fuel'];
  connectors: ConnectorType[];
  typicalRangeKm: number | null;
  consumptionPer100km: number | null;
  isDefault: boolean;
}

export async function saveVehicle(
  userId: string,
  input: VehicleInput,
  vehicleId?: string,
): Promise<Vehicle> {
  if (!supabase) throw new Error('Supabase ist nicht konfiguriert.');

  const payload = {
    user_id: userId,
    name: input.name,
    kind: input.kind,
    // An electric car has no fuel grade; keep the column null rather than
    // storing a value the constraint would let through but the UI ignores.
    fuel: input.kind === 'electric' ? null : input.fuel,
    connectors: input.kind === 'combustion' ? [] : input.connectors,
    typical_range_km: input.typicalRangeKm,
    consumption_per_100km: input.consumptionPer100km,
    is_default: input.isDefault,
  };

  // The partial unique index allows only one default per user, so an existing
  // default has to be cleared first.
  if (input.isDefault) {
    const { error } = await supabase
      .from('vehicles')
      .update({ is_default: false })
      .eq('user_id', userId)
      .eq('is_default', true);
    if (error) {
      throw new Error(`Standardfahrzeug konnte nicht gewechselt werden: ${error.message}`);
    }
  }

  const query = vehicleId
    ? supabase.from('vehicles').update(payload).eq('id', vehicleId).eq('user_id', userId)
    : supabase.from('vehicles').insert(payload);

  const { data, error } = await query.select().single();
  if (error) throw new Error(`Fahrzeug konnte nicht gespeichert werden: ${error.message}`);
  return vehicleFromRow(data);
}

export async function deleteVehicle(userId: string, vehicleId: string): Promise<void> {
  if (!supabase) return;
  const { error } = await supabase
    .from('vehicles')
    .delete()
    .eq('id', vehicleId)
    .eq('user_id', userId);
  if (error) throw new Error(`Fahrzeug konnte nicht gelöscht werden: ${error.message}`);
}

/* ------------------------------------------------------------------ *
 * Settings
 * ------------------------------------------------------------------ */

export async function loadSettings(userId: string): Promise<Settings> {
  if (!supabase) return DEFAULT_SETTINGS;
  const { data, error } = await supabase
    .from('settings')
    .select('*')
    .eq('user_id', userId)
    .is('vehicle_id', null)
    .maybeSingle();
  if (error) {
    throw new Error(`Einstellungen konnten nicht geladen werden: ${error.message}`);
  }
  return data ? settingsFromRow(data) : DEFAULT_SETTINGS;
}

export async function saveSettings(userId: string, settings: Settings): Promise<void> {
  if (!supabase) return;
  // The signup trigger creates the default row, but upsert also covers accounts
  // that predate it. `vehicle_id is null` is the per-user default row.
  const { error } = await supabase
    .from('settings')
    .upsert(settingsToRow(settings, userId), { onConflict: 'user_id,vehicle_id' });
  if (error) {
    throw new Error(`Einstellungen konnten nicht gespeichert werden: ${error.message}`);
  }
}

/* ------------------------------------------------------------------ *
 * Favourites
 * ------------------------------------------------------------------ */

export async function listFavourites(userId: string): Promise<FavouriteStop[]> {
  if (!supabase) return [];
  const { data, error } = await supabase
    .from('favorites')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false });
  if (error) throw new Error(`Favoriten konnten nicht geladen werden: ${error.message}`);
  return (data ?? []).map(favouriteFromRow);
}

export async function addFavourite(
  userId: string,
  stop: { id: string; kind: StopKind; name: string; location: { lng: number; lat: number } },
  note: string | null = null,
): Promise<void> {
  if (!supabase) return;
  const { error } = await supabase.from('favorites').upsert(
    {
      user_id: userId,
      stop_id: stop.id,
      kind: stop.kind,
      name: stop.name,
      lng: stop.location.lng,
      lat: stop.location.lat,
      note,
    },
    { onConflict: 'user_id,stop_id' },
  );
  if (error) throw new Error(`Favorit konnte nicht gespeichert werden: ${error.message}`);
}

export async function removeFavourite(userId: string, stopId: string): Promise<void> {
  if (!supabase) return;
  const { error } = await supabase
    .from('favorites')
    .delete()
    .eq('user_id', userId)
    .eq('stop_id', stopId);
  if (error) throw new Error(`Favorit konnte nicht entfernt werden: ${error.message}`);
}

/* ------------------------------------------------------------------ *
 * Trip history
 * ------------------------------------------------------------------ */

export interface TripInput {
  vehicleId: string | null;
  originName: string;
  originLocation: { lng: number; lat: number };
  destinationName: string;
  destinationLocation: { lng: number; lat: number };
  distanceM: number;
  durationS: number;
  startRangeKm: number | null;
}

/** Records the start of a trip and returns its id, or `null` when offline. */
export async function startTrip(
  userId: string,
  input: TripInput,
): Promise<string | null> {
  if (!supabase) return null;
  const { data, error } = await supabase
    .from('trips')
    .insert({
      user_id: userId,
      vehicle_id: input.vehicleId,
      origin_name: input.originName,
      origin_lng: input.originLocation.lng,
      origin_lat: input.originLocation.lat,
      destination_name: input.destinationName,
      destination_lng: input.destinationLocation.lng,
      destination_lat: input.destinationLocation.lat,
      distance_m: Math.round(input.distanceM),
      duration_s: Math.round(input.durationS),
      start_range_km: input.startRangeKm,
    })
    .select('id')
    .single();
  // History is a nicety: a failure here must never stop navigation.
  if (error) {
    console.warn('[trips] Fahrt konnte nicht gespeichert werden:', error.message);
    return null;
  }
  return data.id;
}

export async function finishTrip(
  tripId: string,
  stops: Array<{ id: string; kind: StopKind; name: string }>,
): Promise<void> {
  if (!supabase) return;
  const { error } = await supabase
    .from('trips')
    .update({ finished_at: new Date().toISOString(), stops })
    .eq('id', tripId);
  if (error) console.warn('[trips] Fahrtende konnte nicht gespeichert werden:', error.message);
}
