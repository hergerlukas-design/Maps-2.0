import type { Position } from '@shared/types';

/* Raw shapes returned by the Mapbox Directions API (only what we consume). */

export interface MapboxManeuver {
  location: Position;
  bearing_before: number;
  bearing_after: number;
  instruction: string;
  type: string;
  modifier?: string;
  exit?: number;
}

export interface MapboxBannerComponent {
  text: string;
  type: string;
  abbr?: string;
  abbr_priority?: number;
}

export interface MapboxBannerText {
  text: string;
  type?: string;
  modifier?: string;
  degrees?: number;
  components?: MapboxBannerComponent[];
}

export interface MapboxBannerInstruction {
  distanceAlongGeometry: number;
  primary: MapboxBannerText;
  secondary?: MapboxBannerText | null;
  sub?: MapboxBannerText | null;
}

export interface MapboxVoiceInstruction {
  distanceAlongGeometry: number;
  announcement: string;
  ssmlAnnouncement?: string;
}

export interface MapboxIntersection {
  location: Position;
  bearings?: number[];
  entry?: boolean[];
  in?: number;
  out?: number;
  lanes?: Array<{ valid: boolean; active?: boolean; indications: string[] }>;
}

export interface MapboxStep {
  distance: number;
  duration: number;
  geometry: string;
  name: string;
  ref?: string;
  destinations?: string;
  exits?: string;
  mode: string;
  maneuver: MapboxManeuver;
  bannerInstructions?: MapboxBannerInstruction[];
  voiceInstructions?: MapboxVoiceInstruction[];
  intersections?: MapboxIntersection[];
}

export interface MapboxLeg {
  distance: number;
  duration: number;
  duration_typical?: number;
  summary: string;
  steps: MapboxStep[];
}

export interface MapboxRoute {
  distance: number;
  duration: number;
  duration_typical?: number;
  weight_name: string;
  geometry: string;
  legs: MapboxLeg[];
}

export interface MapboxDirectionsResponse {
  code: string;
  message?: string;
  routes: MapboxRoute[];
  waypoints: Array<{ name: string; location: Position }>;
  uuid?: string;
}

export interface MapboxGeocodingFeature {
  id: string;
  type: string;
  place_type?: string[];
  place_name: string;
  text: string;
  center?: Position;
  geometry?: { type: 'Point'; coordinates: Position };
  properties?: Record<string, unknown>;
  context?: Array<{ id: string; text: string }>;
}

export interface MapboxGeocodingResponse {
  type: string;
  features: MapboxGeocodingFeature[];
  attribution?: string;
}
