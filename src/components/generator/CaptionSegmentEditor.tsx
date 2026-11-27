import React from "react";
import { GitMerge, Play, Plus, Scissors, Trash2 } from "lucide-react";
import type { StoryboardCaptionSegment } from "../../types/studio";
import {
  addCaptionSegment,
  CAPTION_OVERFLOW_TOLERANCE_SEC,
  deleteCaptionSegment,
  findCaptionSegmentOverlaps,
  MAX_CAPTIONS_PER_SCENE,
  mergeCaptionSegmentWithNext,
  splitCaptionSegment,
  updateCaptionSegment,
} from "../../utils/storyboardCaptions";

interface CaptionSegmentEditorProps {
  sceneId: string;
  sceneDuration: number;
  locale: string;
  segments: StoryboardCaptionSegment[];
  onChangeSegments: (next: StoryboardCaptionSegment[]) => void;
  onSeekToSec?: (timeSec: number) => void;
}

export function CaptionSegmentEditor({
  sceneId,
  sceneDuration,
  locale,
  segments,
  onChangeSegments,
  onSeekToSec,
}: CaptionSegmentEditorProps) {
  const overlaps = findCaptionSegmentOverlaps(segments);

  return (
    <div className="space-y-2.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] font-medium text-zinc-300">
          Caption Cues ({segments.length} / {MAX_CAPTIONS_PER_SCENE})
        </span>
        <button
          type="button"
          disabled={segments.length >= MAX_CAPTIONS_PER_SCENE}
          onClick={() => onChangeSegments(addCaptionSegment(segments, sceneDuration))}
          className="inline-flex items-center gap-1 rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-[11px] font-medium text-zinc-200 hover:bg-zinc-800 hover:text-white disabled:opacity-45"
        >
          <Plus className="h-3 w-3 text-violet-400" />
          <span>Add Cue</span>
        </button>
      </div>

      {segments.length === 0 ? (
        <p className="text-[11px] text-zinc-500 rounded border border-zinc-800/80 bg-[#09090B] px-3 py-2.5">
          No caption cues yet. Click Generate Script Captions, Transcribe Voiceover Audio, or Add Cue.
        </p>
      ) : (
        <div className="space-y-2">
          {segments.map((seg, idx) => {
            const isOverlap = overlaps.has(seg.id);
            const isOverflow = seg.end > sceneDuration + CAPTION_OVERFLOW_TOLERANCE_SEC;
            const canSplit =
              seg.end - seg.start >= 0.4 && segments.length < MAX_CAPTIONS_PER_SCENE;
            const canMergeNext = idx < segments.length - 1;

            return (
              <div
                key={seg.id}
                className={`rounded-md border bg-[#09090B] p-2.5 space-y-2 ${
                  isOverlap
                    ? "border-rose-500/50"
                    : isOverflow
                      ? "border-amber-500/40"
                      : "border-zinc-800"
                }`}
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-2 text-[11px]">
                    <span className="font-mono text-zinc-500 tabular-nums">#{idx + 1}</span>

                    <label className="inline-flex items-center gap-1 text-zinc-400">
                      <span>Start</span>
                      <input
                        type="number"
                        min={0}
                        max={3600}
                        step={0.1}
                        aria-label={`Cue ${idx + 1} start seconds for ${sceneId}`}
                        value={seg.start}
                        onChange={(e) => {
                          const v = Number(e.target.value);
                          if (!Number.isFinite(v)) return;
                          onChangeSegments(
                            updateCaptionSegment(segments, seg.id, { start: Math.max(0, v) })
                          );
                        }}
                        className="w-16 rounded border border-zinc-800 bg-[#111114] px-1.5 py-0.5 text-[11px] font-mono text-zinc-100 tabular-nums focus:border-violet-500 focus:outline-none"
                      />
                    </label>

                    <label className="inline-flex items-center gap-1 text-zinc-400">
                      <span>End</span>
                      <input
                        type="number"
                        min={0.1}
                        max={3600}
                        step={0.1}
                        aria-label={`Cue ${idx + 1} end seconds for ${sceneId}`}
                        value={seg.end}
                        onChange={(e) => {
                          const v = Number(e.target.value);
                          if (!Number.isFinite(v)) return;
                          onChangeSegments(
                            updateCaptionSegment(segments, seg.id, { end: Math.max(0.1, v) })
                          );
                        }}
                        className="w-16 rounded border border-zinc-800 bg-[#111114] px-1.5 py-0.5 text-[11px] font-mono text-zinc-100 tabular-nums focus:border-violet-500 focus:outline-none"
                      />
                    </label>

                    {seg.isManuallyEdited && (
                      <span className="rounded bg-violet-500/15 px-1.5 py-0.5 font-mono text-[10px] text-violet-300">
                        Manual
                      </span>
                    )}
                    {isOverlap && (
                      <span className="rounded bg-rose-500/15 px-1.5 py-0.5 font-mono text-[10px] text-rose-300">
                        Overlap
                      </span>
                    )}
                    {isOverflow && (
                      <span className="rounded bg-amber-500/15 px-1.5 py-0.5 font-mono text-[10px] text-amber-300">
                        &gt;{sceneDuration.toFixed(1)}s
                      </span>
                    )}
                  </div>

                  <div className="flex items-center gap-1 shrink-0">
                    {onSeekToSec && (
                      <button
                        type="button"
                        onClick={() => onSeekToSec(seg.start)}
                        className="rounded border border-zinc-800 bg-[#111114] p-1 text-zinc-400 hover:text-emerald-300"
                        title="Jump preview playhead to this cue"
                        aria-label={`Jump to cue ${idx + 1}`}
                      >
                        <Play className="h-3 w-3" />
                      </button>
                    )}
                    <button
                      type="button"
                      disabled={!canSplit}
                      onClick={() =>
                        onChangeSegments(splitCaptionSegment(segments, seg.id, locale))
                      }
                      className="rounded border border-zinc-800 bg-[#111114] p-1 text-zinc-400 hover:text-white disabled:opacity-35"
                      title="Split cue cleanly at midpoint"
                      aria-label={`Split cue ${idx + 1}`}
                    >
                      <Scissors className="h-3 w-3" />
                    </button>
                    <button
                      type="button"
                      disabled={!canMergeNext}
                      onClick={() =>
                        onChangeSegments(mergeCaptionSegmentWithNext(segments, seg.id))
                      }
                      className="rounded border border-zinc-800 bg-[#111114] p-1 text-zinc-400 hover:text-white disabled:opacity-35"
                      title="Merge with next cue"
                      aria-label={`Merge cue ${idx + 1} with next`}
                    >
                      <GitMerge className="h-3 w-3" />
                    </button>
                    <button
                      type="button"
                      onClick={() => onChangeSegments(deleteCaptionSegment(segments, seg.id))}
                      className="rounded border border-zinc-800 bg-[#111114] p-1 text-zinc-400 hover:text-rose-400"
                      title="Delete cue"
                      aria-label={`Delete cue ${idx + 1}`}
                    >
                      <Trash2 className="h-3 w-3" />
                    </button>
                  </div>
                </div>

                <textarea
                  rows={2}
                  maxLength={400}
                  aria-label={`Cue ${idx + 1} text`}
                  value={seg.text}
                  onChange={(e) =>
                    onChangeSegments(
                      updateCaptionSegment(segments, seg.id, { text: e.target.value })
                    )
                  }
                  className="w-full rounded border border-zinc-800 bg-[#111114] px-2.5 py-1.5 text-xs text-zinc-100 focus:border-violet-500 focus:outline-none resize-none"
                />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
