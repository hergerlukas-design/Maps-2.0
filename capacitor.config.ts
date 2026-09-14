import type { CapacitorConfig } from '@capacitor/cli';

/*
 * Die Android-Hülle um dieselbe Weboberfläche.
 *
 * Wichtig: `appId` ist nach der ersten Veröffentlichung im Play Store
 * unveränderlich. Wer den Namen später anders haben will, muss das vor dem
 * ersten Hochladen tun.
 */
const config: CapacitorConfig = {
  appId: 'de.hergerlukas.reichweite',
  appName: 'Reichweite',
  webDir: 'dist',

  android: {
    // Die Oberfläche läuft unter `https://localhost`. Damit gelten für sie
    // dieselben Regeln wie für die Website — insbesondere keine unverschlüsselten
    // Verbindungen, was hier ohnehin niemand braucht.
    allowMixedContent: false,
  },

  plugins: {
    // Der Startbildschirm verschwindet, sobald React das erste Bild gezeichnet
    // hat; ohne das blitzt kurz eine weiße Fläche auf.
    SplashScreen: {
      launchAutoHide: true,
      launchShowDuration: 500,
      backgroundColor: '#0b1120',
    },
  },
};

export default config;
