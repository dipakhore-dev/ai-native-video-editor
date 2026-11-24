import React from "react";
import { AlertTriangle, RotateCcw } from "lucide-react";

interface ErrorBoundaryProps {
  children: React.ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  errorMessage: string;
}

export class ErrorBoundary extends React.Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = {
      hasError: false,
      errorMessage: "",
    };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return {
      hasError: true,
      errorMessage:
        error?.message && error.message.length < 240
          ? error.message
          : "An unexpected interface error occurred.",
    };
  }

  componentDidCatch(error: Error) {
    console.error("[AI Studio UI ErrorBoundary]", error);
  }

  private handleReset = () => {
    this.setState({ hasError: false, errorMessage: "" });
  };

  private handleReload = () => {
    window.location.reload();
  };

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen bg-[#09090B] text-zinc-100 flex items-center justify-center p-6">
          <div className="max-w-md w-full rounded-2xl border border-zinc-800 bg-[#111114] p-7 text-center space-y-4 shadow-2xl">
            <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-xl border border-rose-500/30 bg-rose-500/10 text-rose-400">
              <AlertTriangle className="h-6 w-6" />
            </div>
            <div className="space-y-1.5">
              <h1 className="font-display text-lg font-semibold text-white">
                Studio Interface Interrupted
              </h1>
              <p className="text-xs text-zinc-400 leading-relaxed">
                Your timeline and local media stored in browser IndexedDB remain intact. Reload the workspace to continue editing.
              </p>
              {this.state.errorMessage && (
                <p className="mt-2 rounded-lg border border-zinc-800 bg-[#09090B] px-3 py-2 text-[11px] font-mono text-zinc-400 break-words">
                  {this.state.errorMessage}
                </p>
              )}
            </div>
            <div className="flex flex-col sm:flex-row items-center justify-center gap-2.5 pt-2">
              <button
                type="button"
                onClick={this.handleReload}
                className="w-full sm:w-auto inline-flex items-center justify-center gap-2 rounded-lg bg-gradient-to-r from-violet-600 to-blue-600 px-4 py-2 text-xs font-medium text-white hover:from-violet-500 hover:to-blue-500 transition-colors"
              >
                <RotateCcw className="h-3.5 w-3.5" />
                <span>Reload Studio</span>
              </button>
              <button
                type="button"
                onClick={this.handleReset}
                className="w-full sm:w-auto rounded-lg border border-zinc-800 bg-zinc-900 px-4 py-2 text-xs font-medium text-zinc-300 hover:bg-zinc-800 hover:text-white transition-colors"
              >
                Try Recovering View
              </button>
            </div>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
