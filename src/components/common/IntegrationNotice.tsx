import { PlugZap, ArrowUpRight } from "lucide-react";
import { useStudio } from "../../context/StudioContext";

interface IntegrationNoticeProps {
  title: string;
  endpoint: string;
  description: string;
  actionLabel?: string;
  onAction?: () => void;
}

export function IntegrationNotice({
  title,
  endpoint,
  description,
  actionLabel,
  onAction,
}: IntegrationNoticeProps) {
  const { navigate } = useStudio();

  return (
    <div className="rounded-xl border border-zinc-800 bg-[#111114] p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
      <div className="flex items-start gap-3">
        <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-violet-500/10 text-violet-400 border border-violet-500/20">
          <PlugZap className="h-4 w-4" />
        </div>
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <h4 className="text-sm font-medium text-zinc-100">{title}</h4>
            <span className="text-xs font-mono text-zinc-400">{endpoint}</span>
          </div>
          <p className="text-xs leading-relaxed text-zinc-400">{description}</p>
        </div>
      </div>
      <div className="shrink-0">
        <button
          type="button"
          onClick={onAction ?? (() => navigate("settings"))}
          className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-700/80 bg-zinc-900 px-3 py-1.5 text-xs font-medium text-zinc-200 hover:bg-zinc-800 hover:text-white transition-colors whitespace-nowrap shrink-0"
        >
          <span>{actionLabel ?? "View Integrations"}</span>
          <ArrowUpRight className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}
