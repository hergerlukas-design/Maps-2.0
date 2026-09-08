import { useCallback, useEffect, useRef } from 'react';

/**
 * Spoken turn instructions via the Web Speech API.
 *
 * Mapbox also returns SSML, but `SpeechSynthesisUtterance` does not accept it,
 * so the plain-text announcement is used.
 */
export function useVoice(enabled: boolean) {
  const voiceRef = useRef<SpeechSynthesisVoice | null>(null);
  const supported = typeof window !== 'undefined' && 'speechSynthesis' in window;

  useEffect(() => {
    if (!supported) return;

    const pickVoice = () => {
      const voices = window.speechSynthesis.getVoices();
      voiceRef.current =
        voices.find((v) => v.lang === 'de-DE' && v.localService) ??
        voices.find((v) => v.lang.startsWith('de')) ??
        null;
    };
    pickVoice();
    // Chrome populates the voice list asynchronously.
    window.speechSynthesis.addEventListener('voiceschanged', pickVoice);
    return () => window.speechSynthesis.removeEventListener('voiceschanged', pickVoice);
  }, [supported]);

  const speak = useCallback(
    (text: string, options: { interrupt?: boolean } = {}) => {
      if (!enabled || !supported || !text) return;
      // A turn instruction that arrives late is worse than one cut short.
      if (options.interrupt) window.speechSynthesis.cancel();

      const utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = 'de-DE';
      utterance.rate = 1.05;
      utterance.volume = 1;
      if (voiceRef.current) utterance.voice = voiceRef.current;
      window.speechSynthesis.speak(utterance);
    },
    [enabled, supported],
  );

  const cancel = useCallback(() => {
    if (supported) window.speechSynthesis.cancel();
  }, [supported]);

  useEffect(() => () => {
    if (supported) window.speechSynthesis.cancel();
  }, [supported]);

  return { speak, cancel, supported };
}
