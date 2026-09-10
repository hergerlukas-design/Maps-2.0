import { useEffect, useState } from 'react';
import type { CapabilitiesResponse } from '@shared/types';
import { SETTINGS_BOUNDS, type Settings } from '@/types/domain';
import { env } from '@/config/env';
import { fetchJson } from '@/lib/http';
import {
  checkPushSupport,
  isIos,
  isStandalone,
  sendTestPush,
  subscribeToPush,
} from '@/services/push';
import { SliderField, ToggleField } from '@/components/ui/Field';
import { Sheet } from '@/components/ui/Sheet';

interface SettingsPanelProps {
  open: boolean;
  settings: Settings;
  syncing: boolean;
  syncError: string | null;
  signedIn: boolean;
  onChange: (patch: Partial<Settings>) => void;
  onReset: () => void;
  onClose: () => void;
}

/**
 * Every threshold from the briefing is editable here.
 *
 * The defaults are the briefing's examples (215 km, 12 km, 50 km); the ranges
 * come from `SETTINGS_BOUNDS`, where the 25 km cap on the radius is Tankerkönig's
 * own API limit rather than a design choice.
 */
export function SettingsPanel({
  open,
  settings,
  syncing,
  syncError,
  signedIn,
  onChange,
  onReset,
  onClose,
}: SettingsPanelProps) {
  const [capabilities, setCapabilities] = useState<CapabilitiesResponse | null>(null);
  const [pushMessage, setPushMessage] = useState<string | null>(null);
  const [pushBusy, setPushBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    void fetchJson<CapabilitiesResponse>(`${env.apiBase}/capabilities`, { timeoutMs: 5000 })
      .then(setCapabilities)
      .catch(() => setCapabilities(null));
  }, [open]);

  const support = checkPushSupport();

  return (
    <Sheet open={open} title="Einstellungen" onClose={onClose}>
      <div className="space-y-6 px-4 pb-4">
        {/* Range monitoring ------------------------------------------- */}
        <section className="space-y-4">
          <SectionHeading
            title="Reichweiten-Überwachung"
            description="Wann und wie weit im Umkreis die App nach einem Stopp sucht."
          />

          <SliderField
            label="Schwellenwert"
            value={settings.rangeThresholdKm}
            min={SETTINGS_BOUNDS.rangeThresholdKm.min}
            max={SETTINGS_BOUNDS.rangeThresholdKm.max}
            step={SETTINGS_BOUNDS.rangeThresholdKm.step}
            unit="km"
            hint="Ab dieser Restreichweite fragt die App, ob getankt oder geladen werden soll."
            onChange={(rangeThresholdKm) => onChange({ rangeThresholdKm })}
          />

          <SliderField
            label="Suchradius um die Route"
            value={settings.searchRadiusKm}
            min={SETTINGS_BOUNDS.searchRadiusKm.min}
            max={SETTINGS_BOUNDS.searchRadiusKm.max}
            step={SETTINGS_BOUNDS.searchRadiusKm.step}
            unit="km"
            hint="Maximal 25 km — das ist die Obergrenze der Tankerkönig-API."
            onChange={(searchRadiusKm) => onChange({ searchRadiusKm })}
          />

          <SliderField
            label="Nachfrage-Intervall"
            value={settings.reAskIntervalKm}
            min={SETTINGS_BOUNDS.reAskIntervalKm.min}
            max={SETTINGS_BOUNDS.reAskIntervalKm.max}
            step={SETTINGS_BOUNDS.reAskIntervalKm.step}
            unit="km"
            hint='Nach einem „Nein danke" wird erst nach dieser Distanz erneut gefragt. Bei kritischer Reichweite fragt die App trotzdem sofort.'
            onChange={(reAskIntervalKm) => onChange({ reAskIntervalKm })}
          />
        </section>

        {/* Ranking ---------------------------------------------------- */}
        <section className="space-y-4 border-t border-ink-700/70 pt-5">
          <SectionHeading
            title="Auswahl der Vorschläge"
            description="Wie viele Stationen gezeigt werden und wie stark ein Umweg gegen den Preis zählt."
          />

          <SliderField
            label="Anzahl Vorschläge"
            value={settings.maxSuggestions}
            min={SETTINGS_BOUNDS.maxSuggestions.min}
            max={SETTINGS_BOUNDS.maxSuggestions.max}
            step={SETTINGS_BOUNDS.maxSuggestions.step}
            unit=""
            onChange={(maxSuggestions) => onChange({ maxSuggestions })}
          />

          <SliderField
            label="Umweg lohnt sich ab"
            value={settings.detourPenaltyCtPerKm}
            min={SETTINGS_BOUNDS.detourPenaltyCtPerKm.min}
            max={SETTINGS_BOUNDS.detourPenaltyCtPerKm.max}
            step={SETTINGS_BOUNDS.detourPenaltyCtPerKm.step}
            unit="ct/l je km"
            format={(value) => value.toFixed(1).replace('.', ',')}
            hint={
              settings.detourPenaltyCtPerKm === 0
                ? 'Bei 0 zählt nur der Preis — auch eine Tankstelle weit abseits der Route kann gewinnen.'
                : `Aktuell: Eine Tankstelle 10 km abseits muss mindestens ` +
                  `${(settings.detourPenaltyCtPerKm * 10).toFixed(1).replace('.', ',')} ct/l ` +
                  `günstiger sein als eine direkt an der Route. Höher = die App bleibt lieber an der Route.`
            }
            onChange={(detourPenaltyCtPerKm) => onChange({ detourPenaltyCtPerKm })}
          />

          <SliderField
            label="Mindestladeleistung"
            value={settings.minChargingPowerKw}
            min={SETTINGS_BOUNDS.minChargingPowerKw.min}
            max={SETTINGS_BOUNDS.minChargingPowerKw.max}
            step={SETTINGS_BOUNDS.minChargingPowerKw.step}
            unit="kW"
            hint="0 zeigt auch langsame Ladepunkte. Gilt nur für E-Auto und Hybrid."
            onChange={(minChargingPowerKw) => onChange({ minChargingPowerKw })}
          />
        </section>

        {/* Driving --------------------------------------------------- */}
        <section className="space-y-4 border-t border-ink-700/70 pt-5">
          <SectionHeading title="Während der Fahrt" />

          <ToggleField
            label="Sprachansagen"
            hint="Abbiegehinweise werden vorgelesen."
            checked={settings.voiceGuidance}
            onChange={(voiceGuidance) => onChange({ voiceGuidance })}
          />

          <ToggleField
            label="Display anlassen"
            hint="Verhindert, dass der Bildschirm während der Navigation abschaltet — kostet Akku."
            checked={settings.keepScreenAwake}
            onChange={(keepScreenAwake) => onChange({ keepScreenAwake })}
          />

          <ToggleField
            label="Benachrichtigungen"
            hint="Zusätzlich zum Hinweis in der App wird eine System-Benachrichtigung ausgelöst."
            checked={settings.pushNotifications}
            onChange={(pushNotifications) => onChange({ pushNotifications })}
          />

          <div className="space-y-3 rounded-2xl bg-ink-850/70 p-3">
            <ToggleField
              label="Mautstraßen vermeiden"
              checked={settings.avoid.tolls}
              onChange={(tolls) => onChange({ avoid: { ...settings.avoid, tolls } })}
            />
            <ToggleField
              label="Autobahnen vermeiden"
              checked={settings.avoid.motorways}
              onChange={(motorways) => onChange({ avoid: { ...settings.avoid, motorways } })}
            />
            <ToggleField
              label="Fähren vermeiden"
              checked={settings.avoid.ferries}
              onChange={(ferries) => onChange({ avoid: { ...settings.avoid, ferries } })}
            />
          </div>
        </section>

        {/* Push diagnostics ------------------------------------------ */}
        <section className="space-y-3 border-t border-ink-700/70 pt-5">
          <SectionHeading
            title="Benachrichtigungen prüfen"
            description="Web Push verhält sich je nach Plattform unterschiedlich."
          />

          {!support.supported && (
            <p className="rounded-xl border border-warn-600/50 bg-warn-600/10 px-3 py-2.5 text-xs text-warn-500">
              {support.reason}
            </p>
          )}

          {isIos() && !isStandalone() && (
            <p className="rounded-xl border border-warn-600/50 bg-warn-600/10 px-3 py-2.5 text-xs text-warn-500">
              Unter iOS funktionieren Push-Benachrichtigungen nur, wenn die App über
              „Teilen → Zum Home-Bildschirm" installiert und von dort gestartet wurde.
            </p>
          )}

          {capabilities && !capabilities.push && (
            <p className="text-xs text-ink-400">
              Auf dem Server ist kein VAPID-Schlüsselpaar hinterlegt. Hinweise innerhalb der
              App funktionieren trotzdem — nur Push bei geschlossener App nicht.
            </p>
          )}

          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={pushBusy || !support.supported}
              onClick={async () => {
                setPushBusy(true);
                const result = await subscribeToPush();
                setPushMessage(result.message);
                setPushBusy(false);
              }}
              className="touch-target rounded-xl bg-ink-800 px-3 text-sm font-medium text-ink-100 active:bg-ink-700 disabled:opacity-50"
            >
              Push aktivieren
            </button>
            <button
              type="button"
              disabled={pushBusy || !capabilities?.push}
              onClick={async () => {
                setPushBusy(true);
                const result = await sendTestPush();
                setPushMessage(result.message);
                setPushBusy(false);
              }}
              className="touch-target rounded-xl bg-ink-800 px-3 text-sm font-medium text-ink-100 active:bg-ink-700 disabled:opacity-50"
            >
              Test senden
            </button>
          </div>

          {pushMessage && <p className="text-xs text-ink-300">{pushMessage}</p>}
        </section>

        {/* Data sources --------------------------------------------- */}
        {capabilities && (
          <section className="space-y-2 border-t border-ink-700/70 pt-5">
            <SectionHeading title="Datenquellen" />
            <ul className="space-y-1.5 text-xs">
              <SourceRow ok={capabilities.fuelPrices} label="Tankerkönig (Kraftstoffpreise)" />
              <SourceRow
                ok={capabilities.charging.goingelectric}
                label="GoingElectric (Ladesäulen)"
                fallback={
                  capabilities.charging.openchargemap
                    ? 'Open Charge Map wird als Ersatz genutzt'
                    : undefined
                }
              />
              <SourceRow ok={capabilities.amenities} label="OpenStreetMap Overpass (Rastplatz, Toilette)" />
            </ul>
          </section>
        )}

        {/* Sync ------------------------------------------------------- */}
        <section className="space-y-2 border-t border-ink-700/70 pt-5">
          <p className="text-xs text-ink-400">
            {signedIn
              ? syncing
                ? 'Einstellungen werden synchronisiert …'
                : 'Einstellungen werden mit dem Konto synchronisiert.'
              : 'Ohne Konto werden die Einstellungen nur auf diesem Gerät gespeichert.'}
          </p>
          {syncError && <p className="text-xs text-warn-500">{syncError}</p>}
          <button
            type="button"
            onClick={onReset}
            className="touch-target rounded-xl bg-ink-800 px-3 text-sm font-medium text-ink-300 active:bg-ink-700"
          >
            Auf Standardwerte zurücksetzen
          </button>
        </section>
      </div>
    </Sheet>
  );
}

function SectionHeading({
  title,
  description,
}: {
  title: string;
  description?: string;
}) {
  return (
    <div>
      <h3 className="text-sm font-bold text-ink-100">{title}</h3>
      {description && <p className="mt-0.5 text-xs leading-snug text-ink-400">{description}</p>}
    </div>
  );
}

function SourceRow({
  ok,
  label,
  fallback,
}: {
  ok: boolean;
  label: string;
  fallback?: string;
}) {
  return (
    <li className="flex items-start gap-2">
      <span
        className={`mt-1 size-2 shrink-0 rounded-full ${ok ? 'bg-go-500' : 'bg-warn-500'}`}
        aria-hidden="true"
      />
      <span className="text-ink-300">
        {label}
        {!ok && (
          <span className="text-warn-500">
            {' '}
            — kein API-Key konfiguriert
            {fallback ? `, ${fallback}` : ''}
          </span>
        )}
      </span>
    </li>
  );
}
