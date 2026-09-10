import type { FuelKind, StopKind, VehicleKind } from '@shared/types';

/**
 * Hand-written row types mirroring `supabase/migrations/0001_init.sql`.
 *
 * Once a project exists these can be replaced by
 * `supabase gen types typescript`, but keeping them here means the client
 * compiles without a live project.
 *
 * These must be `type` aliases, not `interface` declarations. supabase-js
 * constrains every table to `Record<string, unknown>`, and TypeScript only
 * gives object *type aliases* an implicit index signature — an interface fails
 * that constraint, the schema silently resolves to `never`, and every insert
 * and update stops type-checking.
 */

export type VehicleRow = {
  id: string;
  user_id: string;
  name: string;
  kind: VehicleKind;
  fuel: FuelKind | null;
  connectors: string[];
  typical_range_km: number | null;
  consumption_per_100km: number | null;
  is_default: boolean;
  created_at: string;
  updated_at: string;
}

export type SettingsRow = {
  id: string;
  user_id: string;
  vehicle_id: string | null;
  range_threshold_km: number;
  search_radius_km: number;
  re_ask_interval_km: number;
  max_suggestions: number;
  detour_penalty_ct_per_km: number;
  min_charging_power_kw: number;
  voice_guidance: boolean;
  keep_screen_awake: boolean;
  push_notifications: boolean;
  avoid_tolls: boolean;
  avoid_motorways: boolean;
  avoid_ferries: boolean;
  created_at: string;
  updated_at: string;
}

export type FavoriteRow = {
  id: string;
  user_id: string;
  stop_id: string;
  kind: StopKind;
  name: string;
  lng: number;
  lat: number;
  note: string | null;
  created_at: string;
}

export type TripRow = {
  id: string;
  user_id: string;
  vehicle_id: string | null;
  origin_name: string;
  origin_lng: number;
  origin_lat: number;
  destination_name: string;
  destination_lng: number;
  destination_lat: number;
  distance_m: number;
  duration_s: number;
  start_range_km: number | null;
  stops: Array<{ id: string; kind: StopKind; name: string }>;
  started_at: string;
  finished_at: string | null;
}

export type ProfileRow = {
  id: string;
  display_name: string | null;
  created_at: string;
  updated_at: string;
}

type Insert<T, Optional extends keyof T> = Omit<T, Optional> & Partial<Pick<T, Optional>>;

export type Database = {
  public: {
    Tables: {
      profiles: {
        Row: ProfileRow;
        Insert: Insert<ProfileRow, 'created_at' | 'updated_at' | 'display_name'>;
        Update: Partial<ProfileRow>;
        Relationships: [];
      };
      vehicles: {
        Row: VehicleRow;
        Insert: Insert<
          VehicleRow,
          'id' | 'created_at' | 'updated_at' | 'connectors' | 'is_default'
        >;
        Update: Partial<VehicleRow>;
        Relationships: [];
      };
      settings: {
        Row: SettingsRow;
        Insert: Insert<SettingsRow, Exclude<keyof SettingsRow, 'user_id'>>;
        Update: Partial<SettingsRow>;
        Relationships: [];
      };
      favorites: {
        Row: FavoriteRow;
        Insert: Insert<FavoriteRow, 'id' | 'created_at' | 'note'>;
        Update: Partial<FavoriteRow>;
        Relationships: [];
      };
      trips: {
        Row: TripRow;
        Insert: Insert<
          TripRow,
          'id' | 'started_at' | 'finished_at' | 'stops' | 'vehicle_id' | 'start_range_km'
        >;
        Update: Partial<TripRow>;
        Relationships: [];
      };
    };
    Views: Record<string, never>;
    Functions: Record<string, never>;
    Enums: {
      vehicle_kind: VehicleKind;
      fuel_kind: FuelKind;
      stop_kind: StopKind;
    };
    CompositeTypes: Record<string, never>;
  };
};
