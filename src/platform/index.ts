import { Capacitor } from '@capacitor/core';

/**
 * Die Trennlinie zwischen Browser und nativer App.
 *
 * Derselbe React-Code läuft an zwei Orten: als Website auf Fly und in einer
 * WebView innerhalb der Android-App. Was sich unterscheidet, sind genau drei
 * Dinge — Ortung, Sprachausgabe und Wachhalten des Bildschirms —, und für die
 * gibt es hier je eine Auswahl nach Laufzeitumgebung.
 *
 * Alles andere bleibt bewusst gemeinsam: Die App soll nicht in zwei
 * Varianten auseinanderlaufen, von denen nur eine getestet wird.
 */
export const isNative = Capacitor.isNativePlatform();

/** `web`, `android` oder `ios`. */
export const platformName = Capacitor.getPlatform();
