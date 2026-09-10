import { create } from 'zustand';
import type { User } from '@supabase/supabase-js';
import type { ConnectorType, FuelKind, VehicleKind } from '@shared/types';
import {
  clampSettings,
  DEFAULT_SETTINGS,
  type PlaceRef,
  type Settings,
  type Vehicle,
} from '@/types/domain';
import { hasSupabase } from '@/config/env';
import {
  listVehicles,
  loadSettings,
  saveSettings as persistSettings,
} from '@/services/supabase/repository';

const SETTINGS_STORAGE_KEY = 'reichweite:settings';
const VEHICLE_STORAGE_KEY = 'reichweite:vehicle';
const PLAN_STORAGE_KEY = 'reichweite:plan';

/* ------------------------------------------------------------------ *
 * Local persistence
 *
 * Settings live in localStorage first and Supabase second. Without an account
 * the app is still fully usable, and a signed-in user's settings survive a
 * flaky connection because the local copy is authoritative until a sync lands.
 * ------------------------------------------------------------------ */

function readLocal<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function writeLocal(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Private mode / quota exceeded: the app keeps working in memory.
  }
}

/**
 * The local vehicle profile used when nobody is signed in. It carries no
 * `userId`, which is how the rest of the app tells a guest profile apart.
 */
export const GUEST_VEHICLE_ID = 'local-vehicle';

function defaultVehicle(): Vehicle {
  return {
    id: GUEST_VEHICLE_ID,
    userId: null,
    name: 'Mein Fahrzeug',
    kind: 'combustion',
    fuel: 'e10',
    connectors: [],
    // Bewusst leer: Die volle Reichweite unterscheidet sich von Fahrzeug zu
    // Fahrzeug um mehr als den Faktor vier. Ein Vorgabewert wäre für fast
    // jeden falsch; wer die Abkürzung will, trägt seinen Wert selbst ein.
    typicalRangeKm: null,
    consumption: { per100km: null },
    isDefault: true,
    createdAt: new Date(0).toISOString(),
  };
}

export interface PlanDraft {
  origin: PlaceRef | null;
  destination: PlaceRef | null;
  /** Manually entered remaining range in km — never read from the vehicle. */
  remainingRangeKm: number;
}

interface AppState {
  /* auth */
  user: User | null;
  authReady: boolean;
  /** True when a Supabase project is configured at all. */
  accountsAvailable: boolean;

  /* settings */
  settings: Settings;
  settingsSyncing: boolean;
  settingsError: string | null;

  /* vehicles */
  vehicles: Vehicle[];
  activeVehicleId: string;

  /* plan */
  plan: PlanDraft;

  /* actions */
  setUser: (user: User | null) => void;
  setAuthReady: (ready: boolean) => void;
  updateSettings: (patch: Partial<Settings>) => void;
  resetSettings: () => void;
  setVehicles: (vehicles: Vehicle[]) => void;
  setActiveVehicle: (id: string) => void;
  updateGuestVehicle: (patch: Partial<Omit<Vehicle, 'id' | 'userId'>>) => void;
  setPlan: (patch: Partial<PlanDraft>) => void;
  swapPlanEnds: () => void;
  /** Pulls settings and vehicles for a signed-in user. */
  hydrateFromAccount: (userId: string) => Promise<void>;
}

export const useAppStore = create<AppState>()((set, get) => ({
  user: null,
  authReady: !hasSupabase,
  accountsAvailable: hasSupabase,

  settings: clampSettings(readLocal<Partial<Settings>>(SETTINGS_STORAGE_KEY)),
  settingsSyncing: false,
  settingsError: null,

  vehicles: [readLocal<Vehicle>(VEHICLE_STORAGE_KEY) ?? defaultVehicle()],
  activeVehicleId:
    readLocal<Vehicle>(VEHICLE_STORAGE_KEY)?.id ?? GUEST_VEHICLE_ID,

  plan: {
    origin: null,
    destination: null,
    remainingRangeKm: readLocal<PlanDraft>(PLAN_STORAGE_KEY)?.remainingRangeKm ?? 450,
  },

  setUser: (user) => set({ user }),
  setAuthReady: (authReady) => set({ authReady }),

  updateSettings: (patch) => {
    const next = clampSettings({ ...get().settings, ...patch });
    set({ settings: next, settingsError: null });
    writeLocal(SETTINGS_STORAGE_KEY, next);

    const userId = get().user?.id;
    if (!userId) return;
    set({ settingsSyncing: true });
    void persistSettings(userId, next)
      .then(() => set({ settingsSyncing: false }))
      .catch((error: unknown) =>
        set({
          settingsSyncing: false,
          // Local state stays applied; only the sync failed.
          settingsError:
            error instanceof Error
              ? `Nicht synchronisiert: ${error.message}`
              : 'Einstellungen konnten nicht synchronisiert werden.',
        }),
      );
  },

  resetSettings: () => get().updateSettings(DEFAULT_SETTINGS),

  setVehicles: (vehicles) => {
    if (vehicles.length === 0) {
      set({ vehicles: [defaultVehicle()], activeVehicleId: GUEST_VEHICLE_ID });
      return;
    }
    const current = get().activeVehicleId;
    const keep = vehicles.some((v) => v.id === current);
    set({
      vehicles,
      activeVehicleId: keep
        ? current
        : (vehicles.find((v) => v.isDefault)?.id ?? vehicles[0]!.id),
    });
  },

  setActiveVehicle: (id) => {
    set({ activeVehicleId: id });
    const vehicle = get().vehicles.find((v) => v.id === id);
    if (vehicle && vehicle.userId === null) writeLocal(VEHICLE_STORAGE_KEY, vehicle);
  },

  updateGuestVehicle: (patch) => {
    const { vehicles, activeVehicleId } = get();
    const next = vehicles.map((vehicle) =>
      vehicle.id === activeVehicleId ? { ...vehicle, ...patch } : vehicle,
    );
    set({ vehicles: next });
    const updated = next.find((v) => v.id === activeVehicleId);
    if (updated?.userId === null) writeLocal(VEHICLE_STORAGE_KEY, updated);
  },

  setPlan: (patch) => {
    const plan = { ...get().plan, ...patch };
    set({ plan });
    // Only the range is worth restoring; places go stale immediately.
    writeLocal(PLAN_STORAGE_KEY, { remainingRangeKm: plan.remainingRangeKm });
  },

  swapPlanEnds: () => {
    const { origin, destination } = get().plan;
    set({ plan: { ...get().plan, origin: destination, destination: origin } });
  },

  hydrateFromAccount: async (userId) => {
    set({ settingsSyncing: true, settingsError: null });
    try {
      const [settings, vehicles] = await Promise.all([
        loadSettings(userId),
        listVehicles(userId),
      ]);
      set({ settings, settingsSyncing: false });
      writeLocal(SETTINGS_STORAGE_KEY, settings);
      get().setVehicles(vehicles);
    } catch (error) {
      set({
        settingsSyncing: false,
        settingsError:
          error instanceof Error
            ? error.message
            : 'Kontodaten konnten nicht geladen werden.',
      });
    }
  },
}));

/* ------------------------------------------------------------------ *
 * Selectors
 * ------------------------------------------------------------------ */

export function useActiveVehicle(): Vehicle {
  return useAppStore(
    (state) =>
      state.vehicles.find((v) => v.id === state.activeVehicleId) ??
      state.vehicles[0] ??
      defaultVehicle(),
  );
}

/** Vehicle fields the searches need, narrowed to what each source supports. */
export function searchProfileFor(vehicle: Vehicle): {
  kinds: Array<'fuel' | 'charging'>;
  fuel: FuelKind;
  connectors: ConnectorType[];
} {
  const kinds: Array<'fuel' | 'charging'> = [];
  if (vehicle.kind === 'combustion' || vehicle.kind === 'hybrid') kinds.push('fuel');
  if (vehicle.kind === 'electric' || vehicle.kind === 'hybrid') kinds.push('charging');
  return {
    kinds,
    fuel: vehicle.fuel ?? 'e10',
    connectors: vehicle.connectors,
  };
}

export const VEHICLE_KIND_LABELS: Record<VehicleKind, string> = {
  combustion: 'Verbrenner',
  electric: 'Elektro',
  hybrid: 'Hybrid',
};

export { defaultVehicle };
