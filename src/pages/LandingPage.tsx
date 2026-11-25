import { ArrowRight, Film, Layers, Cpu, Terminal, Play } from "lucide-react";
import { useStudio } from "../context/StudioContext";

export function LandingPage() {
  const { navigate } = useStudio();

  return (
    <div className="min-h-screen bg-[#09090B] text-zinc-100 flex flex-col">
      {/* 3-Zone Top Bar Contract */}
      <header className="sticky top-0 z-30 border-b border-zinc-800/80 bg-[#09090B]/90 backdrop-blur-md">
        <div className="mx-auto max-w-7xl px-6 h-16 flex items-center justify-between gap-8">
          <a
            href="#top"
            onClick={(e) => {
              e.preventDefault();
              window.scrollTo({ top: 0, behavior: "smooth" });
            }}
            className="font-display text-lg font-bold tracking-tight text-white whitespace-nowrap shrink-0"
          >
            AI Studio
          </a>

          <nav className="hidden md:flex items-center gap-7 text-sm font-medium text-zinc-400">
            <a
              href="#capabilities"
              className="hover:text-white transition-colors whitespace-nowrap shrink-0"
            >
              Capabilities
            </a>
            <a
              href="#architecture"
              className="hover:text-white transition-colors whitespace-nowrap shrink-0"
            >
              Architecture
            </a>
            <button
              type="button"
              onClick={() => navigate("editor")}
              className="hover:text-white transition-colors whitespace-nowrap shrink-0"
            >
              Editor
            </button>
            <button
              type="button"
              onClick={() => navigate("auth")}
              className="hover:text-white transition-colors whitespace-nowrap shrink-0"
            >
              Sign In
            </button>
          </nav>

          <div className="shrink-0">
            <button
              type="button"
              onClick={() => navigate("dashboard")}
              className="inline-flex items-center gap-2 rounded-lg bg-gradient-to-r from-violet-600 to-blue-600 px-4 py-2 text-xs font-medium text-white hover:from-violet-500 hover:to-blue-500 transition-colors whitespace-nowrap shrink-0"
            >
              <span>Get Started</span>
              <ArrowRight className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      </header>

      <main id="top" className="flex-1">
        {/* Hero Split Section */}
        <section className="mx-auto max-w-7xl px-6 pt-14 pb-20 lg:pt-20 lg:pb-24">
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-10 lg:gap-12 items-stretch">
            <div className="lg:col-span-6 flex flex-col justify-center">
              <p className="text-xs font-medium tracking-wide text-violet-400 mb-4">
                Browser-Native Post-Production Workspace
              </p>
              <h1
                className="font-display font-bold tracking-tight text-white leading-[1.08]"
                style={{ fontSize: "clamp(2.25rem, 4vw, 3.75rem)", textWrap: "balance" }}
              >
                Precision video editing built for AI-native workflows.
              </h1>
              <p className="mt-5 text-base leading-relaxed text-zinc-400 max-w-xl">
                Assemble multitrack sequences with local video, audio, and image assets directly in the browser, backed by an open Node.js server ready for AI video synthesis, editorial assistance, and cloud transcoding.
              </p>

              <div className="mt-8 flex flex-wrap items-center gap-4">
                <button
                  type="button"
                  onClick={() => navigate("dashboard")}
                  className="inline-flex items-center gap-2 rounded-lg bg-gradient-to-r from-violet-600 to-blue-600 px-5 py-3 text-sm font-medium text-white hover:from-violet-500 hover:to-blue-500 transition-colors whitespace-nowrap shrink-0"
                >
                  <span>Get Started</span>
                  <ArrowRight className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  onClick={() => navigate("editor")}
                  className="inline-flex items-center gap-2 rounded-lg border border-zinc-800 bg-[#111114] px-5 py-3 text-sm font-medium text-zinc-200 hover:bg-zinc-900 hover:text-white transition-colors whitespace-nowrap shrink-0"
                >
                  <Play className="h-3.5 w-3.5 text-blue-400" />
                  <span>Open Video Editor</span>
                </button>
              </div>

              <div className="mt-10 pt-6 border-t border-zinc-800/80 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-zinc-400">
                <span>Local HTML5 Playback</span>
                <span aria-hidden="true">·</span>
                <span>Multitrack Split &amp; Trim</span>
                <span aria-hidden="true">·</span>
                <span>Node.js Integration API</span>
              </div>
            </div>

            <div className="lg:col-span-6">
              <div className="relative h-full min-h-[300px] lg:min-h-[420px] rounded-2xl overflow-hidden border border-zinc-800/90 bg-[#111114]">
                <img
                  src="/src/assets/images/hero_editing_suite_1794647536161.jpg"
                  alt="AI Studio dark color grading and multitrack video editing workstation"
                  referrerPolicy="no-referrer"
                  className="h-full w-full object-cover"
                />
                <div className="absolute inset-0 bg-gradient-to-t from-[#09090B]/90 via-[#09090B]/20 to-transparent" />
                <div className="absolute bottom-0 inset-x-0 p-6">
                  <p className="text-xs font-mono text-zinc-300 tabular-nums">
                    16:9 Master Sequence · 24 fps · Local Timeline Engine
                  </p>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* Bento Feature Highlights */}
        <section id="capabilities" className="mx-auto max-w-7xl px-6 py-16 border-t border-zinc-800/80">
          <div className="max-w-2xl mb-12">
            <h2 className="font-display text-2xl sm:text-3xl font-semibold tracking-tight text-white">
              Core studio capabilities
            </h2>
            <p className="mt-3 text-sm sm:text-base text-zinc-400 leading-relaxed">
              Every control in the editor works directly on your local files today, while external AI generation, storage, and render queues expose clean server endpoints.
            </p>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            {/* Wide Marquee Feature */}
            <div className="lg:col-span-2 rounded-2xl border border-zinc-800/80 bg-[#111114] overflow-hidden flex flex-col">
              <div className="relative h-64 sm:h-72 overflow-hidden bg-zinc-950">
                <img
                  src="/src/assets/images/feature_cinema_frame_1794647536308.jpg"
                  alt="Cinematic anamorphic frame in sequence preview"
                  referrerPolicy="no-referrer"
                  className="h-full w-full object-cover"
                />
                <div className="absolute inset-0 bg-gradient-to-t from-[#111114] via-[#111114]/30 to-transparent" />
              </div>
              <div className="p-6 sm:p-8 flex-1 flex flex-col justify-between">
                <div>
                  <div className="flex items-center gap-2.5 text-violet-400 mb-3">
                    <Film className="h-4 w-4" />
                    <span className="text-xs font-medium">01. Multitrack Video Editor</span>
                  </div>
                  <h3 className="font-display text-xl font-semibold text-white">
                    Frame-accurate playback, razor splits, and multi-track layering
                  </h3>
                  <p className="mt-2.5 text-sm text-zinc-400 leading-relaxed max-w-2xl">
                    Import local MP4, WebM, image stills, and audio stems. Arrange clips across Video, Overlay, and Audio tracks with real-time scrubbing, playback speed controls, volume mixing, and timeline zoom.
                  </p>
                </div>
                <div className="mt-6">
                  <button
                    type="button"
                    onClick={() => navigate("editor")}
                    className="inline-flex items-center gap-1.5 text-xs font-medium text-blue-400 hover:text-blue-300 transition-colors"
                  >
                    <span>Launch Editor Workspace</span>
                    <ArrowRight className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
            </div>

            {/* Secondary Optical Feature */}
            <div className="rounded-2xl border border-zinc-800/80 bg-[#111114] overflow-hidden flex flex-col">
              <div className="relative h-56 overflow-hidden bg-zinc-950">
                <img
                  src="/src/assets/images/feature_cinema_lens_1794647537129.jpg"
                  alt="Precision cinema prime lens for media inspection"
                  referrerPolicy="no-referrer"
                  className="h-full w-full object-cover"
                />
                <div className="absolute inset-0 bg-gradient-to-t from-[#111114] via-[#111114]/25 to-transparent" />
              </div>
              <div className="p-6 flex-1 flex flex-col justify-between">
                <div>
                  <div className="flex items-center gap-2.5 text-blue-400 mb-3">
                    <Layers className="h-4 w-4" />
                    <span className="text-xs font-medium">02. Local Media Library</span>
                  </div>
                  <h3 className="font-display text-lg font-semibold text-white">
                    Instant metadata &amp; canvas frame thumbnails
                  </h3>
                  <p className="mt-2 text-sm text-zinc-400 leading-relaxed">
                    Inspect resolution, duration, and byte footprint directly in your browser without waiting on cloud uploads.
                  </p>
                </div>
                <div className="mt-6">
                  <button
                    type="button"
                    onClick={() => navigate("media")}
                    className="inline-flex items-center gap-1.5 text-xs font-medium text-blue-400 hover:text-blue-300 transition-colors"
                  >
                    <span>Open Media Library</span>
                    <ArrowRight className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
            </div>

            {/* Capability 03 */}
            <div className="rounded-2xl border border-zinc-800/80 bg-[#111114] p-6 sm:p-7 flex flex-col justify-between">
              <div>
                <div className="flex items-center gap-2.5 text-violet-400 mb-3">
                  <Cpu className="h-4 w-4" />
                  <span className="text-xs font-medium">03. AI Video &amp; Editorial Hooks</span>
                </div>
                <h3 className="font-display text-lg font-semibold text-white">
                  AI Script &amp; Storyboard planning
                </h3>
                <p className="mt-2 text-sm text-zinc-400 leading-relaxed">
                  Plan structured multi-scene scripts, narration, captions, and editor-compatible visual styles with Gemini before composing timelines via local FFmpeg.
                </p>
              </div>
              <div className="mt-6 pt-4 border-t border-zinc-800/80">
                <button
                  type="button"
                  onClick={() => navigate("generator")}
                  className="inline-flex items-center gap-1.5 text-xs font-medium text-zinc-200 hover:text-white transition-colors"
                >
                  <span>Open Storyboard Studio</span>
                  <ArrowRight className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>

            {/* Capability 04 */}
            <div className="lg:col-span-2 rounded-2xl border border-zinc-800/80 bg-[#111114] p-6 sm:p-7 flex flex-col justify-between">
              <div>
                <div className="flex items-center gap-2.5 text-blue-400 mb-3">
                  <Terminal className="h-4 w-4" />
                  <span className="text-xs font-medium">04. Transparent Integration Architecture</span>
                </div>
                <h3 className="font-display text-lg font-semibold text-white">
                  Zero fake processing — clear external service contracts
                </h3>
                <p className="mt-2 text-sm text-zinc-400 leading-relaxed max-w-2xl">
                  Every service requiring external infrastructure—database persistence, S3 object storage, GPU video synthesis, FFmpeg transcoding, and user auth—is wired to explicit Node.js API routes with live status reporting.
                </p>
              </div>
              <div className="mt-6 pt-4 border-t border-zinc-800/80 flex flex-wrap items-center gap-x-6 gap-y-2 text-xs font-mono text-zinc-400">
                <span>POST /api/ai/storyboard</span>
                <span>POST /api/ai/assistant</span>
                <span>POST /api/exports</span>
                <span>GET /api/integrations/status</span>
              </div>
            </div>
          </div>
        </section>

        {/* Architecture Breakdown Section */}
        <section id="architecture" className="mx-auto max-w-7xl px-6 py-16 border-t border-zinc-800/80">
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-10 items-start">
            <div className="lg:col-span-5">
              <h2 className="font-display text-2xl font-semibold tracking-tight text-white">
                Built to run locally first, scale to cloud workers when ready
              </h2>
              <p className="mt-3 text-sm text-zinc-400 leading-relaxed">
                Start cutting local footage immediately inside the React studio workspace, then attach your preferred database, storage bucket, and rendering queue on the Express backend.
              </p>
              <div className="mt-6">
                <button
                  type="button"
                  onClick={() => navigate("settings")}
                  className="inline-flex items-center gap-2 rounded-lg border border-zinc-800 bg-[#111114] px-4 py-2.5 text-xs font-medium text-zinc-200 hover:bg-zinc-900 transition-colors"
                >
                  <span>Inspect Integration Status</span>
                  <ArrowRight className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>

            <div className="lg:col-span-7 grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="rounded-xl border border-zinc-800/80 bg-[#111114] p-5">
                <p className="text-xs font-medium text-emerald-400 mb-1.5">Active Locally Now</p>
                <h3 className="text-sm font-semibold text-white">Client Editing Engine</h3>
                <ul className="mt-3 space-y-2 text-xs text-zinc-400">
                  <li>Local file upload &amp; canvas frame thumbnails</li>
                  <li>Synchronized HTML5 video &amp; audio playback</li>
                  <li>Clip split, trim, reposition, and speed control</li>
                  <li>Timeline EDL specification JSON download</li>
                </ul>
              </div>
              <div className="rounded-xl border border-zinc-800/80 bg-[#111114] p-5">
                <p className="text-xs font-medium text-violet-400 mb-1.5">Server Integration Points</p>
                <h3 className="text-sm font-semibold text-white">Node.js Backend Endpoints</h3>
                <ul className="mt-3 space-y-2 text-xs text-zinc-400">
                  <li>PostgreSQL / Firestore project persistence</li>
                  <li>Gemini editorial assistant via @google/genai</li>
                  <li>External text/image-to-video worker queue</li>
                  <li>FFmpeg cloud render &amp; auth provider hooks</li>
                </ul>
              </div>
            </div>
          </div>
        </section>
      </main>

      <footer className="border-t border-zinc-800/80 bg-[#09090B]">
        <div className="mx-auto max-w-7xl px-6 py-8 flex flex-col sm:flex-row items-center justify-between gap-4 text-xs text-zinc-500">
          <div className="flex items-center gap-3">
            <span className="font-display font-semibold text-zinc-200">AI Studio</span>
            <span aria-hidden="true">·</span>
            <span>Video Creation &amp; Editing Platform</span>
          </div>
          <div className="flex items-center gap-6">
            <button
              type="button"
              onClick={() => navigate("dashboard")}
              className="hover:text-zinc-300 transition-colors"
            >
              Dashboard
            </button>
            <button
              type="button"
              onClick={() => navigate("editor")}
              className="hover:text-zinc-300 transition-colors"
            >
              Editor
            </button>
            <button
              type="button"
              onClick={() => navigate("auth")}
              className="hover:text-zinc-300 transition-colors"
            >
              Sign In
            </button>
          </div>
        </div>
      </footer>
    </div>
  );
}
