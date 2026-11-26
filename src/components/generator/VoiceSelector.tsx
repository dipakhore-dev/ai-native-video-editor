import React, { useMemo } from "react";
import type {
  StoryboardVoiceoverSettings,
  TtsAudioFormat,
  TtsLanguageCode,
  TtsProviderId,
  TtsStatusInfo,
  TtsVoiceOption,
} from "../../types/studio";
import { formatTtsLanguageLabel } from "../../utils/storyboardVoiceover";

interface VoiceSelectorProps {
  language: TtsLanguageCode;
  ttsStatus: TtsStatusInfo | null;
  voices: TtsVoiceOption[];
  provider: TtsProviderId;
  voiceId?: string;
  speakingRate: number;
  pitch: number;
  format: TtsAudioFormat;
  volume: number;
  compact?: boolean;
  disabled?: boolean;
  onChange: (patch: Partial<StoryboardVoiceoverSettings>) => void;
}

export function VoiceSelector({
  language,
  ttsStatus,
  voices,
  provider,
  voiceId,
  speakingRate,
  pitch,
  format,
  volume,
  compact = false,
  disabled = false,
  onChange,
}: VoiceSelectorProps) {
  const languageVoices = useMemo(() => {
    const byLang = voices.filter((v) => v.language === language);
    if (provider !== "auto" && provider !== "none") {
      return byLang.filter((v) => v.provider === provider);
    }
    return byLang;
  }, [voices, language, provider]);

  const effectiveVoiceValue = useMemo(() => {
    if (voiceId && languageVoices.some((v) => v.voiceId === voiceId)) {
      return voiceId;
    }
    return languageVoices[0]?.voiceId || "";
  }, [voiceId, languageVoices]);

  const mp3Supported = ttsStatus?.mp3Supported ?? false;
  const availableProviders = ttsStatus?.providers ?? [];

  return (
    <div className={compact ? "space-y-2.5" : "space-y-3"}>
      <div
        className={`grid gap-2.5 ${
          compact ? "grid-cols-1 sm:grid-cols-2 lg:grid-cols-3" : "grid-cols-1 sm:grid-cols-2 lg:grid-cols-3"
        }`}
      >
        {/* Engine / Provider Selector */}
        <div>
          <label className="block text-[11px] font-medium text-zinc-400 mb-1">
            Local TTS Engine
          </label>
          <select
            aria-label={compact ? "Scene TTS engine" : "Global TTS engine"}
            disabled={disabled}
            value={provider}
            onChange={(e) => {
              const nextProvider = e.target.value as TtsProviderId;
              const nextVoices = voices.filter(
                (v) =>
                  v.language === language &&
                  (nextProvider === "auto" || nextProvider === "none" || v.provider === nextProvider)
              );
              onChange({
                provider: nextProvider,
                voiceId: nextVoices[0]?.voiceId || "",
              });
            }}
            className="w-full rounded-lg border border-zinc-800 bg-[#111114] px-2.5 py-1.5 text-xs text-zinc-100 focus:border-violet-500 focus:outline-none disabled:opacity-50"
          >
            <option value="auto">Auto (Prefer Piper Neural → eSpeak NG)</option>
            {availableProviders.map((p) => (
              <option key={p.provider} value={p.provider} disabled={!p.available}>
                {p.label}
                {!p.available ? " (Not Installed)" : ` (${p.voiceCount} voices)`}
              </option>
            ))}
          </select>
        </div>

        {/* Voice Selector strictly filtered by language */}
        <div>
          <label className="block text-[11px] font-medium text-zinc-400 mb-1">
            Voice ({formatTtsLanguageLabel(language)})
          </label>
          <select
            aria-label={compact ? "Scene TTS voice" : "Global TTS voice"}
            disabled={disabled || languageVoices.length === 0}
            value={effectiveVoiceValue}
            onChange={(e) => onChange({ voiceId: e.target.value })}
            className="w-full rounded-lg border border-zinc-800 bg-[#111114] px-2.5 py-1.5 text-xs text-zinc-100 focus:border-violet-500 focus:outline-none disabled:opacity-50"
          >
            {languageVoices.length === 0 ? (
              <option value="">No installed {formatTtsLanguageLabel(language)} voices</option>
            ) : (
              languageVoices.map((v) => (
                <option key={`${v.provider}:${v.voiceId}`} value={v.voiceId}>
                  {v.label} · {v.provider === "piper" ? "Piper" : v.provider === "espeak_ng" ? "eSpeak NG" : "SAPI5"}
                </option>
              ))
            )}
          </select>
        </div>

        {/* Output Format */}
        <div>
          <label className="block text-[11px] font-medium text-zinc-400 mb-1">
            Audio Format
          </label>
          <select
            aria-label={compact ? "Scene voiceover format" : "Global voiceover format"}
            disabled={disabled}
            value={format === "mp3" && mp3Supported ? "mp3" : "wav"}
            onChange={(e) => onChange({ format: e.target.value as TtsAudioFormat })}
            className="w-full rounded-lg border border-zinc-800 bg-[#111114] px-2.5 py-1.5 text-xs text-zinc-100 focus:border-violet-500 focus:outline-none disabled:opacity-50"
          >
            <option value="wav">WAV (PCM 22.05kHz Mono · Lossless)</option>
            <option value="mp3" disabled={!mp3Supported}>
              {mp3Supported ? "MP3 (Compressed 128kbps)" : "MP3 (Unavailable — no libmp3lame)"}
            </option>
          </select>
        </div>
      </div>

      {/* Sliders: Speaking Rate, Pitch, Volume */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div>
          <div className="flex items-center justify-between text-[11px] mb-1">
            <span className="text-zinc-400">Speaking Rate</span>
            <span className="font-mono text-zinc-200 tabular-nums">{speakingRate.toFixed(2)}x</span>
          </div>
          <input
            type="range"
            min={0.6}
            max={1.5}
            step={0.05}
            disabled={disabled}
            aria-label={compact ? "Scene speaking rate" : "Global speaking rate"}
            value={speakingRate}
            onChange={(e) => onChange({ speakingRate: Number(e.target.value) })}
            className="w-full accent-violet-500 cursor-pointer disabled:opacity-50"
          />
        </div>

        <div>
          <div className="flex items-center justify-between text-[11px] mb-1">
            <span className="text-zinc-400">Pitch Adjustment</span>
            <span className="font-mono text-zinc-200 tabular-nums">
              {pitch > 0 ? `+${pitch}` : pitch}
            </span>
          </div>
          <input
            type="range"
            min={-20}
            max={20}
            step={2}
            disabled={disabled}
            aria-label={compact ? "Scene voice pitch" : "Global voice pitch"}
            value={pitch}
            onChange={(e) => onChange({ pitch: Number(e.target.value) })}
            className="w-full accent-violet-500 cursor-pointer disabled:opacity-50"
          />
        </div>

        <div>
          <div className="flex items-center justify-between text-[11px] mb-1">
            <span className="text-zinc-400">Mix Volume</span>
            <span className="font-mono text-zinc-200 tabular-nums">
              {Math.round(volume * 100)}%
            </span>
          </div>
          <input
            type="range"
            min={0}
            max={2}
            step={0.05}
            disabled={disabled}
            aria-label={compact ? "Scene voiceover volume" : "Global voiceover volume"}
            value={volume}
            onChange={(e) => onChange({ volume: Number(e.target.value) })}
            className="w-full accent-violet-500 cursor-pointer disabled:opacity-50"
          />
        </div>
      </div>

      {ttsStatus?.available && languageVoices.length === 0 && (
        <p className="text-[11px] text-amber-300 leading-snug">
          No local {formatTtsLanguageLabel(language)} voice is installed for{" "}
          {provider === "auto" ? "the available engines" : provider}. Install an{" "}
          {language === "hi" || language === "bn" ? "eSpeak NG language pack or Piper ONNX voice" : "English voice pack"}{" "}
          on this machine — English voices are never substituted for {formatTtsLanguageLabel(language)}.
        </p>
      )}
    </div>
  );
}
