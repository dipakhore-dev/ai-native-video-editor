import { Download, FileJson, Film, AlertTriangle } from "lucide-react";
import { StudioShell } from "../components/layout/StudioShell";
import { IntegrationNotice } from "../components/common/IntegrationNotice";
import { useStudio } from "../context/StudioContext";
import { formatTimecode } from "../utils/media";

export function ExportsPage() {
  const { exportAttempts, navigate } = useStudio();

  const downloadSnapshot = (filename: string, json: string) => {
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <StudioShell
      headerAction={
        <button
          type="button"
          onClick={() => navigate("editor")}
          className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-1.5 text-xs font-medium text-zinc-200 hover:bg-zinc-800 transition-colors whitespace-nowrap shrink-0"
        >
          <Film className="h-3.5 w-3.5 text-violet-400" />
          <span>Back to Editor</span>
        </button>
      }
    >
      <div className="max-w-6xl mx-auto space-y-6">
        <div>
          <h1 className="font-display text-2xl font-semibold text-white">Export History</h1>
          <p className="mt-1 text-sm text-zinc-400">
            Track render job submissions and download local timeline edit specifications (.json).
          </p>
        </div>

        {exportAttempts.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-zinc-800 bg-[#111114]/70 p-12 text-center">
            <div className="mx-auto flex h-11 w-11 items-center justify-center rounded-xl bg-zinc-900 border border-zinc-800 text-blue-400 mb-4">
              <Download className="h-5 w-5" />
            </div>
            <h2 className="text-base font-medium text-white">No export jobs submitted yet</h2>
            <p className="mt-1.5 text-xs text-zinc-400 max-w-md mx-auto leading-relaxed">
              Open a sequence in the Video Editor and click Export Sequence to test the render job payload or download a timeline specification.
            </p>
            <div className="mt-5">
              <button
                type="button"
                onClick={() => navigate("editor")}
                className="inline-flex items-center gap-2 rounded-lg bg-gradient-to-r from-violet-600 to-blue-600 px-4 py-2 text-xs font-medium text-white hover:from-violet-500 hover:to-blue-500"
              >
                <Film className="h-3.5 w-3.5" />
                <span>Open Video Editor</span>
              </button>
            </div>
          </div>
        ) : (
          <div className="rounded-xl border border-zinc-800/80 bg-[#111114] overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="border-b border-zinc-800/80 text-zinc-400">
                <tr>
                  <th className="py-3.5 px-5 font-medium">Sequence</th>
                  <th className="py-3.5 px-4 font-medium">Output Spec</th>
                  <th className="py-3.5 px-4 font-medium text-right">Duration</th>
                  <th className="py-3.5 px-4 font-medium">Render Worker Status</th>
                  <th className="py-3.5 px-5 font-medium text-right">Timeline Spec</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800/70">
                {exportAttempts.map((item) => (
                  <tr key={item.id} className="hover:bg-zinc-900/50">
                    <td className="py-3.5 px-5">
                      <p className="font-medium text-white">{item.projectName}</p>
                      <p className="text-[11px] text-zinc-500 mt-0.5 tabular-nums">
                        Submitted {new Date(item.requestedAt).toLocaleTimeString()}
                      </p>
                    </td>
                    <td className="py-3.5 px-4 font-mono text-zinc-300 tabular-nums">
                      {item.format.toUpperCase()} · {item.resolution} · {item.fps}fps
                    </td>
                    <td className="py-3.5 px-4 font-mono text-zinc-300 text-right tabular-nums">
                      {formatTimecode(item.totalDuration)}
                    </td>
                    <td className="py-3.5 px-4">
                      <div className="inline-flex items-center gap-1.5 text-amber-400 font-medium">
                        <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                        <span>Integration Required</span>
                      </div>
                      <p className="text-[11px] text-zinc-500 mt-0.5 max-w-xs">{item.message}</p>
                    </td>
                    <td className="py-3.5 px-5 text-right">
                      <button
                        type="button"
                        onClick={() =>
                          downloadSnapshot(
                            `${item.projectName.toLowerCase().replace(/\s+/g, "-")}-timeline.json`,
                            item.timelineSnapshotJson
                          )
                        }
                        className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-1.5 text-xs font-medium text-zinc-200 hover:bg-zinc-800 transition-colors whitespace-nowrap"
                      >
                        <FileJson className="h-3.5 w-3.5 text-blue-400" />
                        <span>Download JSON</span>
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <IntegrationNotice
          title="FFmpeg / Cloud Render Queue Integration Point"
          endpoint="POST /api/exports"
          description="Completed MP4/WebM/MOV files are never faked. Wire a server-side FFmpeg worker or cloud transcoding service to /api/exports to render downloadable video files."
        />
      </div>
    </StudioShell>
  );
}
