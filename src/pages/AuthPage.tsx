import React, { useState } from "react";
import { ArrowLeft, Eye, EyeOff, AlertCircle, ArrowRight } from "lucide-react";
import { useStudio } from "../context/StudioContext";
import { submitAuthLogin, submitAuthRegister } from "../services/api";

export function AuthPage() {
  const { navigate, updateSessionUser } = useStudio();
  const [mode, setMode] = useState<"login" | "register">("login");
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [feedback, setFeedback] = useState<{
    type: "error" | "integration";
    message: string;
    endpoint?: string;
  } | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setFeedback(null);
    setSubmitting(true);

    const res =
      mode === "login"
        ? await submitAuthLogin({ email, password })
        : await submitAuthRegister({ fullName, email, password });

    setSubmitting(false);

    if (res.ok && res.data?.user) {
      updateSessionUser({
        displayName: res.data.user.fullName,
        email: res.data.user.email,
        workspaceName: res.data.user.workspaceName,
        defaultFps: res.data.user.defaultFps,
        defaultResolution: res.data.user.defaultResolution,
      });
      navigate("dashboard");
      return;
    }

    if (!res.ok) {
      setFeedback({
        type: res.status === 501 || res.status === 503 ? "integration" : "error",
        message: res.error || "Authentication request could not be completed.",
        endpoint: res.integrationPoint,
      });
    }
  };

  return (
    <div className="min-h-screen bg-[#09090B] text-zinc-100 flex flex-col">
      <header className="h-16 border-b border-zinc-800/80 px-6 flex items-center justify-between">
        <button
          type="button"
          onClick={() => navigate("landing")}
          className="inline-flex items-center gap-2 text-xs font-medium text-zinc-400 hover:text-white transition-colors"
        >
          <ArrowLeft className="h-4 w-4" />
          <span>Back to AI Studio</span>
        </button>
        <button
          type="button"
          onClick={() => navigate("dashboard")}
          className="text-xs font-medium text-violet-400 hover:text-violet-300 transition-colors"
        >
          Continue in Local Studio Session
        </button>
      </header>

      <main className="flex-1 flex items-center justify-center p-6">
        <div className="w-full max-w-md rounded-2xl border border-zinc-800/90 bg-[#111114] p-7">
          <div className="mb-6">
            <h1 className="font-display text-xl font-semibold text-white">
              {mode === "login" ? "Sign in to AI Studio" : "Create your studio account"}
            </h1>
            <p className="mt-1.5 text-xs text-zinc-400">
              {mode === "login"
                ? "Connect to your configured authentication provider or continue locally."
                : "Register a workspace profile once an identity store is attached."}
            </p>
          </div>

          {/* Mode Tabs */}
          <div className="grid grid-cols-2 gap-1 p-1 rounded-lg bg-[#09090B] border border-zinc-800/80 mb-6">
            <button
              type="button"
              onClick={() => {
                setMode("login");
                setFeedback(null);
              }}
              className={`rounded-md py-2 text-xs font-medium transition-colors ${
                mode === "login" ? "bg-zinc-800 text-white" : "text-zinc-400 hover:text-zinc-200"
              }`}
            >
              Sign In
            </button>
            <button
              type="button"
              onClick={() => {
                setMode("register");
                setFeedback(null);
              }}
              className={`rounded-md py-2 text-xs font-medium transition-colors ${
                mode === "register" ? "bg-zinc-800 text-white" : "text-zinc-400 hover:text-zinc-200"
              }`}
            >
              Register
            </button>
          </div>

          <form onSubmit={handleSubmit} className="space-y-4">
            {mode === "register" && (
              <div>
                <label htmlFor="auth-name" className="block text-xs font-medium text-zinc-300 mb-1.5">
                  Full Name
                </label>
                <input
                  id="auth-name"
                  type="text"
                  value={fullName}
                  onChange={(e) => setFullName(e.target.value)}
                  placeholder="Elena Vance"
                  required
                  className="w-full rounded-lg border border-zinc-800 bg-[#09090B] px-3.5 py-2.5 text-sm text-zinc-100 placeholder:text-zinc-500 focus:border-violet-500 focus:outline-none"
                />
              </div>
            )}

            <div>
              <label htmlFor="auth-email" className="block text-xs font-medium text-zinc-300 mb-1.5">
                Email Address
              </label>
              <input
                id="auth-email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="editor@studio.example"
                required
                className="w-full rounded-lg border border-zinc-800 bg-[#09090B] px-3.5 py-2.5 text-sm text-zinc-100 placeholder:text-zinc-500 focus:border-violet-500 focus:outline-none"
              />
            </div>

            <div>
              <label htmlFor="auth-password" className="block text-xs font-medium text-zinc-300 mb-1.5">
                Password
              </label>
              <div className="relative">
                <input
                  id="auth-password"
                  type={showPassword ? "text" : "password"}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder={mode === "register" ? "Minimum 8 characters" : "Enter password"}
                  required
                  className="w-full rounded-lg border border-zinc-800 bg-[#09090B] pl-3.5 pr-10 py-2.5 text-sm text-zinc-100 placeholder:text-zinc-500 focus:border-violet-500 focus:outline-none"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 p-1 text-zinc-500 hover:text-zinc-300"
                  aria-label={showPassword ? "Hide password" : "Show password"}
                >
                  {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
            </div>

            {feedback && (
              <div
                className={`rounded-lg border p-3 text-xs leading-relaxed flex items-start gap-2.5 ${
                  feedback.type === "integration"
                    ? "border-amber-500/30 bg-amber-500/10 text-amber-200"
                    : "border-rose-500/30 bg-rose-500/10 text-rose-300"
                }`}
              >
                <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
                <div>
                  <p>{feedback.message}</p>
                  {feedback.endpoint && (
                    <p className="mt-1 font-mono text-[11px] opacity-80">
                      Integration point: {feedback.endpoint}
                    </p>
                  )}
                </div>
              </div>
            )}

            <button
              type="submit"
              disabled={submitting}
              className="w-full rounded-lg bg-gradient-to-r from-violet-600 to-blue-600 py-2.5 px-4 text-xs font-medium text-white hover:from-violet-500 hover:to-blue-500 transition-colors disabled:opacity-50"
            >
              {submitting
                ? "Verifying with server..."
                : mode === "login"
                ? "Sign In"
                : "Create Account"}
            </button>
          </form>

          <div className="mt-6 pt-5 border-t border-zinc-800/80">
            <button
              type="button"
              onClick={() => navigate("dashboard")}
              className="w-full inline-flex items-center justify-center gap-2 rounded-lg border border-zinc-800 bg-[#09090B] py-2.5 px-4 text-xs font-medium text-zinc-200 hover:bg-zinc-900 transition-colors"
            >
              <span>Continue in Local Studio Session</span>
              <ArrowRight className="h-3.5 w-3.5 text-violet-400" />
            </button>
          </div>
        </div>
      </main>
    </div>
  );
}
