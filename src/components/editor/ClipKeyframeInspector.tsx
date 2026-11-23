import React, { useMemo, useState } from "react";
import {
  ChevronLeft,
  ChevronRight,
  Diamond,
  Plus,
  RotateCcw,
  Trash2,
} from "lucide-react";
import type {
  ClipKeyframe,
  KeyframeEasing,
  KeyframeProperty,
  TimelineClip,
} from "../../types/studio";
import {
  KEYFRAME_EASING_OPTIONS,
  KEYFRAME_PROPERTY_SPECS,
  clampKeyframeTime,
  clampPropertyValue,
  clearPropertyKeyframes,
  evaluateClipProperty,
  formatKeyframeValueDisplay,
  getPropertyKeyframes,
  getSupportedKeyframeProperties,
  removeClipKeyframe,
  updateClipKeyframeById,
  upsertClipKeyframe,
} from "../../utils/keyframes";
import { usePlaybackTime, type TimelinePlaybackClock } from "../../utils/timelineClock";

interface ClipKeyframeInspectorProps {
  clip: TimelineClip;
  playheadTime?: number;
  playbackClock?: TimelinePlaybackClock;
  onSeek: (time: number) => void;
  onUpdateClip: (clipId: string, patch: Partial<TimelineClip>, recordHistory?: boolean) => void;
}

export const ClipKeyframeInspector = React.memo(function ClipKeyframeInspector({
  clip,
  playheadTime = 0,
  playbackClock,
  onSeek,
  onUpdateClip,
}: ClipKeyframeInspectorProps) {
  const currentTime = usePlaybackTime(playbackClock, {
    fallbackTime: playheadTime,
    throttleMs: 66,
  });

  const supportedProps = useMemo(
    () => getSupportedKeyframeProperties(clip),
    [clip.kind, clip.trackId]
  );

  const [selectedProperty, setSelectedProperty] = useState<KeyframeProperty>(
    supportedProps[0] ?? "opacity"
  );
  const [selectedEasing, setSelectedEasing] = useState<KeyframeEasing>("linear");

  const activeProperty: KeyframeProperty = supportedProps.includes(selectedProperty)
    ? selectedProperty
    : supportedProps[0] ?? "opacity";

  const propSpec = KEYFRAME_PROPERTY_SPECS[activeProperty];
  const propKeyframes = useMemo(
    () => getPropertyKeyframes(clip.keyframes, activeProperty),
    [clip.keyframes, activeProperty]
  );

  const rawLocalTime = currentTime - clip.startTime;
  const isPlayheadInsideClip = rawLocalTime >= -0.02 && rawLocalTime <= clip.duration + 0.02;
  const clampedLocalTime = clampKeyframeTime(rawLocalTime, clip.duration);

  const evaluatedValue = evaluateClipProperty(clip, activeProperty, clampedLocalTime);

  const keyframeAtPlayhead: ClipKeyframe | null = useMemo(
    () =>
      propKeyframes.find((kf) => Math.abs(kf.timeSec - clampedLocalTime) <= 0.05) ?? null,
    [propKeyframes, clampedLocalTime]
  );

  const prevKeyframe = useMemo(() => {
    const candidates = propKeyframes.filter((kf) => kf.timeSec < clampedLocalTime - 0.05);
    return candidates.length > 0 ? candidates[candidates.length - 1] : null;
  }, [propKeyframes, clampedLocalTime]);

  const nextKeyframe = useMemo(() => {
    return propKeyframes.find((kf) => kf.timeSec > clampedLocalTime + 0.05) ?? null;
  }, [propKeyframes, clampedLocalTime]);

  const handleToggleOrUpdateKeyframe = () => {
    const targetTime = isPlayheadInsideClip
      ? clampedLocalTime
      : propKeyframes.length === 0
        ? 0
        : clampedLocalTime;
    const { keyframes } = upsertClipKeyframe(
      clip.keyframes,
      {
        property: activeProperty,
        timeSec: targetTime,
        value: evaluatedValue,
        easing: keyframeAtPlayhead?.easing ?? selectedEasing,
        id: keyframeAtPlayhead?.id,
      },
      clip.duration
    );
    onUpdateClip(clip.id, { keyframes });
    if (!isPlayheadInsideClip) {
      onSeek(Number((clip.startTime + targetTime).toFixed(2)));
    }
  };

  const handleValueInput = (nextRawValue: number) => {
    const clampedVal = clampPropertyValue(activeProperty, nextRawValue);
    const { keyframes } = upsertClipKeyframe(
      clip.keyframes,
      {
        property: activeProperty,
        timeSec: clampedLocalTime,
        value: clampedVal,
        easing: keyframeAtPlayhead?.easing ?? selectedEasing,
        id: keyframeAtPlayhead?.id,
      },
      clip.duration
    );
    onUpdateClip(clip.id, { keyframes });
  };

  const handleDeleteAtPlayhead = () => {
    if (!keyframeAtPlayhead) return;
    onUpdateClip(clip.id, {
      keyframes: removeClipKeyframe(clip.keyframes, keyframeAtPlayhead.id),
    });
  };

  const handleClearProperty = () => {
    onUpdateClip(clip.id, {
      keyframes: clearPropertyKeyframes(clip.keyframes, activeProperty),
    });
  };

  const displayNumberForInput = (val: number): number => {
    const scaled = val * propSpec.displayMultiplier;
    return propSpec.displayMultiplier >= 10 ? Math.round(scaled) : Number(scaled.toFixed(1));
  };

  const parseDisplayInput = (displayVal: number): number => {
    if (!Number.isFinite(displayVal)) return propSpec.defaultValue;
    return clampPropertyValue(activeProperty, displayVal / propSpec.displayMultiplier);
  };

  const totalClipKeyframeCount = clip.keyframes?.length ?? 0;

  return (
    <div className="space-y-3 pt-2 border-t border-zinc-800/80" data-testid="clip-keyframe-inspector">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <Diamond className="h-3.5 w-3.5 text-amber-400" />
          <span className="text-[11px] font-medium text-zinc-200">
            Animation &amp; Keyframes
          </span>
          {totalClipKeyframeCount > 0 && (
            <span className="font-mono text-[10px] text-amber-300 tabular-nums">
              ({totalClipKeyframeCount})
            </span>
          )}
        </div>
        {propKeyframes.length > 0 && (
          <button
            type="button"
            onClick={handleClearProperty}
            className="inline-flex items-center gap-1 rounded border border-zinc-800 bg-zinc-900 px-1.5 py-0.5 text-[10px] text-zinc-400 hover:text-white"
            title={`Clear all ${propSpec.label} keyframes`}
          >
            <RotateCcw className="h-2.5 w-2.5" />
            <span>Clear</span>
          </button>
        )}
      </div>

      {/* Property Selector + Easing Selector */}
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="block text-[10px] text-zinc-500 mb-1">Property</label>
          <select
            value={activeProperty}
            onChange={(e) => setSelectedProperty(e.target.value as KeyframeProperty)}
            className="w-full rounded-md border border-zinc-800 bg-[#09090B] px-2 py-1.5 text-[11px] text-zinc-100 focus:border-violet-500 focus:outline-none"
            aria-label="Keyframe property"
          >
            {supportedProps.map((prop) => {
              const count = getPropertyKeyframes(clip.keyframes, prop).length;
              return (
                <option key={prop} value={prop}>
                  {KEYFRAME_PROPERTY_SPECS[prop].label}
                  {count > 0 ? ` (${count})` : ""}
                </option>
              );
            })}
          </select>
        </div>

        <div>
          <label className="block text-[10px] text-zinc-500 mb-1">Easing</label>
          <select
            value={keyframeAtPlayhead ? keyframeAtPlayhead.easing : selectedEasing}
            onChange={(e) => {
              const nextEase = e.target.value as KeyframeEasing;
              setSelectedEasing(nextEase);
              if (keyframeAtPlayhead) {
                onUpdateClip(clip.id, {
                  keyframes: updateClipKeyframeById(
                    clip.keyframes,
                    keyframeAtPlayhead.id,
                    { easing: nextEase },
                    clip.duration
                  ),
                });
              }
            }}
            className="w-full rounded-md border border-zinc-800 bg-[#09090B] px-2 py-1.5 text-[11px] text-zinc-100 focus:border-violet-500 focus:outline-none"
            aria-label="Keyframe easing"
          >
            {KEYFRAME_EASING_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Playhead Keyframe Bar: Prev | Live Value & Add/Update | Delete | Next */}
      <div className="rounded-lg border border-zinc-800/80 bg-[#09090B] p-2.5 space-y-2">
        <div className="flex items-center justify-between text-[11px]">
          <span className="text-zinc-400">
            At <span className="font-mono text-zinc-200 tabular-nums">{clampedLocalTime.toFixed(2)}s</span>
          </span>
          <span className="font-mono text-amber-300 tabular-nums" data-testid="keyframe-live-value">
            {formatKeyframeValueDisplay(activeProperty, evaluatedValue)}
          </span>
        </div>

        <input
          type="range"
          min={propSpec.min}
          max={propSpec.max}
          step={propSpec.step}
          value={evaluatedValue}
          onChange={(e) => handleValueInput(Number(e.target.value))}
          className="w-full accent-amber-400"
          aria-label={`${propSpec.label} keyframe value`}
        />

        <div className="flex items-center gap-1.5">
          <button
            type="button"
            disabled={!prevKeyframe}
            onClick={() => prevKeyframe && onSeek(clip.startTime + prevKeyframe.timeSec)}
            className="rounded border border-zinc-800 bg-zinc-900 p-1.5 text-zinc-300 hover:bg-zinc-800 hover:text-white disabled:opacity-35"
            title="Jump to previous keyframe"
            aria-label="Previous keyframe"
          >
            <ChevronLeft className="h-3.5 w-3.5" />
          </button>

          <button
            type="button"
            onClick={handleToggleOrUpdateKeyframe}
            className={`flex-1 inline-flex items-center justify-center gap-1.5 rounded-md border py-1.5 px-2 text-[11px] font-medium transition-colors ${
              keyframeAtPlayhead
                ? "border-amber-400/60 bg-amber-500/15 text-amber-200 hover:bg-amber-500/25"
                : "border-zinc-700 bg-zinc-900 text-zinc-200 hover:border-amber-400/50 hover:text-white"
            }`}
          >
            <Plus className="h-3 w-3" />
            <span>{keyframeAtPlayhead ? "Update Keyframe" : "Add Keyframe"}</span>
          </button>

          {keyframeAtPlayhead && (
            <button
              type="button"
              onClick={handleDeleteAtPlayhead}
              className="rounded border border-rose-500/30 bg-rose-500/10 p-1.5 text-rose-300 hover:bg-rose-500/20"
              title="Delete keyframe at playhead"
              aria-label="Delete keyframe at playhead"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          )}

          <button
            type="button"
            disabled={!nextKeyframe}
            onClick={() => nextKeyframe && onSeek(clip.startTime + nextKeyframe.timeSec)}
            className="rounded border border-zinc-800 bg-zinc-900 p-1.5 text-zinc-300 hover:bg-zinc-800 hover:text-white disabled:opacity-35"
            title="Jump to next keyframe"
            aria-label="Next keyframe"
          >
            <ChevronRight className="h-3.5 w-3.5" />
          </button>
        </div>

        {/* Mini Keyframe Lane */}
        <div
          className="relative h-5 rounded bg-zinc-900/90 border border-zinc-800/80 cursor-pointer"
          onClick={(e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            const frac = Math.max(0, Math.min(1, (e.clientX - rect.left) / Math.max(1, rect.width)));
            onSeek(Number((clip.startTime + frac * clip.duration).toFixed(2)));
          }}
          title="Click along clip bar to scrub or click a diamond to jump"
        >
          {/* Playhead hairline inside clip */}
          {isPlayheadInsideClip && clip.duration > 0 && (
            <div
              style={{
                left: `${Math.max(0, Math.min(100, (clampedLocalTime / clip.duration) * 100))}%`,
              }}
              className="absolute top-0 bottom-0 w-px bg-violet-400 pointer-events-none"
            />
          )}
          {propKeyframes.map((kf) => {
            const pct = clip.duration > 0 ? Math.max(2, Math.min(98, (kf.timeSec / clip.duration) * 100)) : 0;
            const isActive = Math.abs(kf.timeSec - clampedLocalTime) <= 0.05;
            return (
              <button
                key={kf.id}
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onSeek(Number((clip.startTime + kf.timeSec).toFixed(2)));
                }}
                style={{ left: `${pct}%` }}
                className={`absolute top-1/2 -translate-x-1/2 -translate-y-1/2 h-2.5 w-2.5 rotate-45 border transition-transform ${
                  isActive
                    ? "bg-amber-400 border-white scale-125"
                    : "bg-amber-500/80 border-amber-200 hover:scale-110"
                }`}
                title={`${kf.timeSec.toFixed(2)}s · ${formatKeyframeValueDisplay(activeProperty, kf.value)} (${kf.easing})`}
                aria-label={`Jump to keyframe at ${kf.timeSec.toFixed(2)}s`}
              />
            );
          })}
        </div>
      </div>

      {/* Exact Editable Keyframes Table */}
      {propKeyframes.length > 0 && (
        <div className="space-y-1.5 max-h-40 overflow-y-auto pr-0.5">
          {propKeyframes.map((kf) => {
            const isAtKf = Math.abs(kf.timeSec - clampedLocalTime) <= 0.05;
            return (
              <div
                key={kf.id}
                className={`rounded-md border px-2 py-1.5 flex items-center gap-1.5 text-[11px] ${
                  isAtKf
                    ? "border-amber-500/50 bg-amber-500/10"
                    : "border-zinc-800/80 bg-[#09090B]"
                }`}
              >
                <button
                  type="button"
                  onClick={() => onSeek(Number((clip.startTime + kf.timeSec).toFixed(2)))}
                  className="h-2.5 w-2.5 rotate-45 bg-amber-400 shrink-0 hover:scale-110"
                  title="Jump to keyframe"
                  aria-label={`Seek to ${kf.timeSec.toFixed(2)}s`}
                />
                <input
                  type="number"
                  min={0}
                  max={clip.duration}
                  step={0.05}
                  value={Number(kf.timeSec.toFixed(2))}
                  onChange={(e) =>
                    onUpdateClip(clip.id, {
                      keyframes: updateClipKeyframeById(
                        clip.keyframes,
                        kf.id,
                        { timeSec: Number(e.target.value) },
                        clip.duration
                      ),
                    })
                  }
                  className="w-14 rounded border border-zinc-800 bg-zinc-950 px-1 py-0.5 text-[10px] font-mono text-zinc-200 tabular-nums focus:border-violet-500 focus:outline-none"
                  aria-label="Keyframe time seconds"
                />
                <input
                  type="number"
                  step={propSpec.displayMultiplier >= 10 ? 5 : 1}
                  value={displayNumberForInput(kf.value)}
                  onChange={(e) =>
                    onUpdateClip(clip.id, {
                      keyframes: updateClipKeyframeById(
                        clip.keyframes,
                        kf.id,
                        { value: parseDisplayInput(Number(e.target.value)) },
                        clip.duration
                      ),
                    })
                  }
                  className="w-14 rounded border border-zinc-800 bg-zinc-950 px-1 py-0.5 text-[10px] font-mono text-amber-200 tabular-nums focus:border-violet-500 focus:outline-none"
                  aria-label="Keyframe value"
                />
                <select
                  value={kf.easing}
                  onChange={(e) =>
                    onUpdateClip(clip.id, {
                      keyframes: updateClipKeyframeById(
                        clip.keyframes,
                        kf.id,
                        { easing: e.target.value as KeyframeEasing },
                        clip.duration
                      ),
                    })
                  }
                  className="flex-1 min-w-0 rounded border border-zinc-800 bg-zinc-950 px-1 py-0.5 text-[10px] text-zinc-300 focus:border-violet-500 focus:outline-none"
                  aria-label="Keyframe row easing"
                >
                  {KEYFRAME_EASING_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={() =>
                    onUpdateClip(clip.id, {
                      keyframes: removeClipKeyframe(clip.keyframes, kf.id),
                    })
                  }
                  className="p-0.5 text-zinc-500 hover:text-rose-400 shrink-0"
                  title="Remove keyframe"
                  aria-label="Remove keyframe"
                >
                  <Trash2 className="h-3 w-3" />
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
});
