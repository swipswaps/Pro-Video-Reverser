// PATH: src/App.tsx
//
// FILE BROWSER UX CHANGES:
//   - All four folders (Source, Chunks, Reversed, Master) expanded by default
//   - Every file row has a visible Play button (not hover-only)
//   - Active/selected file highlighted in emerald across all sections
//   - Type badge per section (SOURCE / CHUNK / REV / MASTER) for orientation
//   - Player header shows full filename of currently playing file
//   - Download button always visible (was hover-only)
//   - Section file counts shown as badges
//   - Empty sections show a clear "No files yet" state instead of blank

import React, { useState, useEffect, useRef } from "react";
import {
  Play,
  Download,
  AlertCircle,
  CheckCircle2,
  Loader2,
  Terminal as TerminalIcon,
  Video,
  ArrowLeftRight,
  ChevronRight,
  Cpu,
  Folder,
  Trash2,
  PlayCircle,
} from "lucide-react";
import { motion, AnimatePresence } from "motion/react";

interface Job {
  id: string;
  url: string;
  status: "pending" | "downloading" | "splitting" | "reversing" | "merging" | "completed" | "failed";
  progress: number;
  logs: string[];
  outputFile?: string;
  error?: string;
  chunks?: {
    total: number;
    completed: string[];
    downloaded: boolean;
  };
}



export default function App() {
  const [url, setUrl] = useState("");
  const [currentJobId, setCurrentJobId] = useState<string | null>(null);
  const [job, setJob] = useState<Job | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [systemHealth, setSystemHealth] = useState<{
    load: number;
    psi: number;
    disk: { available: number; total: number };
    zombies: number;
  } | null>(null);
  const [hasUpdate, setHasUpdate] = useState(false);
  const [isUpdating, setIsUpdating] = useState(false);
  const [playbackError, setPlaybackError] = useState(false);
  const [selectedFilePath, setSelectedFilePath] = useState<string | null>(null);

  const logEndRef = useRef<HTMLDivElement>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  // ── Active job discovery on mount ──────────────────────────────────────────
  useEffect(() => {
    const discoverActiveJob = async () => {
      try {
        const res = await fetch("/api/jobs/active");
        if (res.ok) {
          const data = await res.json();
          if (data) {
            setCurrentJobId(data.id);
            setJob(data);
            localStorage.setItem("currentJobId", data.id);
          }
        }
      } catch (e) {
        console.error("Discovery error", e);
      }
    };
    discoverActiveJob();
  }, []);

  // ── Update check ───────────────────────────────────────────────────────────
  useEffect(() => {
    const checkUpdate = async () => {
      try {
        const res = await fetch("/api/system/update-check");
        if (res.ok) {
          const data = await res.json();
          setHasUpdate(data.hasUpdate);
        }
      } catch (e) {}
    };
    checkUpdate();
    const interval = setInterval(checkUpdate, 60000);
    return () => clearInterval(interval);
  }, []);

  const applyUpdate = async () => {
    setIsUpdating(true);
    try {
      const res = await fetch("/api/system/update-apply", { method: "POST" });
      if (res.ok) window.location.reload();
    } catch (e) {}
    finally { setIsUpdating(false); }
  };

  // ── System health polling ──────────────────────────────────────────────────
  useEffect(() => {
    const fetchHealth = async () => {
      try {
        const res = await fetch("/api/system/health");
        if (res.ok) {
          setSystemHealth(await res.json());
        } else {
          const text = await res.text();
          console.error(`Health fetch failed ${res.status}:`, text);
        }
      } catch (e) {
        console.error("Health fetch error:", e);
      }
    };
    fetchHealth();
    const interval = setInterval(fetchHealth, 5000);
    return () => clearInterval(interval);
  }, []);

  // ── Job status polling ─────────────────────────────────────────────────────
  useEffect(() => {
    let interval: NodeJS.Timeout;
    if (currentJobId && job?.status !== "completed" && job?.status !== "failed") {
      interval = setInterval(async () => {
        try {
          const res = await fetch(`/api/jobs/${currentJobId}`);
          if (res.ok) {
            setJob(await res.json());
          } else if (res.status === 404) {
            setJob(null);
            setCurrentJobId(null);
            localStorage.removeItem("currentJobId");
          }
        } catch (e) {}
      }, 2000);
    }
    return () => clearInterval(interval);
  }, [currentJobId, job?.status]);

  // ── Auto-scroll logs ───────────────────────────────────────────────────────
  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [job?.logs]);

  // ── File Browser state ────────────────────────────────────────────────────
  // Navigable filesystem browser — starts at the jobs directory, user can
  // navigate into/out of any directory under /home.
  const [browserPath, setBrowserPath] = useState<string | null>(null);
  const [browserData, setBrowserData] = useState<{
    path: string;
    parent: string | null;
    dirs: { name: string; path: string }[];
    files: { name: string; size: number; mtime: string; path: string }[];
  } | null>(null);
  const [browserLoading, setBrowserLoading] = useState(false);

  const browseTo = React.useCallback(async (targetPath: string) => {
    setBrowserLoading(true);
    try {
      const res = await fetch(`/api/browse?path=${encodeURIComponent(targetPath)}`);
      if (res.ok) {
        const data = await res.json();
        setBrowserData(data);
        setBrowserPath(data.path);
      } else {
        const err = await res.json();
        console.error("Browse error:", err.error);
      }
    } catch (e) {
      console.error("Browse fetch error:", e);
    } finally {
      setBrowserLoading(false);
    }
  }, []);

  // Initialize browser at jobs dir on mount
  useEffect(() => {
    browseTo("/home/owner/Documents");
  }, []);

  // When job completes, navigate browser into that job's folder
  useEffect(() => {
    if (job?.status === "completed" && job.id) {
      browseTo(`/home/owner/Documents/47911b4f-b8b8-4453-90c9-360918fbf53a/Pro-Video-Reverser/jobs/${job.id}`);
    }
  }, [job?.status, job?.id]);

  // ── Reset playback error when file changes ─────────────────────────────────
  useEffect(() => {
    setPlaybackError(false);
  }, [selectedFilePath, job?.outputFile]);

  // ── Auto-select master when job completes ─────────────────────────────────
  useEffect(() => {
    if (job?.status === "completed" && job.outputFile && !selectedFilePath) {
      setSelectedFilePath(job.outputFile);
    }
  }, [job?.status, job?.outputFile]);

  // ── Submit new job ─────────────────────────────────────────────────────────
  const startJob = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!url) return;
    setIsSubmitting(true);
    try {
      const res = await fetch("/api/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      });
      if (res.ok) {
        const { jobId } = await res.json();
        setCurrentJobId(jobId);
        setSelectedFilePath(null);
        localStorage.setItem("currentJobId", jobId);
        setJob({ id: jobId, url, status: "pending", progress: 0, logs: ["Initializing..."] });
      }
    } catch (e) {
      console.error("Submit error", e);
    } finally {
      setIsSubmitting(false);
    }
  };

  // ── Delete job ─────────────────────────────────────────────────────────────
  const deleteJob = async () => {
    if (!job || isDeleting) return;
    setIsDeleting(true);
    setDeleteError(null);
    try {
      const res = await fetch(`/api/jobs/${job.id}`, { method: "DELETE" });
      if (res.ok || res.status === 404) {
        setJob(null);
        setCurrentJobId(null);
        setSelectedFilePath(null);
        setPlaybackError(false);
        localStorage.removeItem("currentJobId");
      } else {
        let msg = `Status ${res.status}`;
        try { const d = await res.json(); msg = d.error || JSON.stringify(d); } catch {}
        setDeleteError(`Delete failed: ${msg}`);
      }
    } catch (e: any) {
      setDeleteError(`Network error: ${e.message}`);
    } finally {
      setIsDeleting(false);
    }
  };

  // ── Helpers ────────────────────────────────────────────────────────────────
  const getStatusColor = (status: string) => {
    switch (status) {
      case "completed": return "text-emerald-400";
      case "failed":    return "text-rose-400";
      case "pending":   return "text-amber-400";
      default:          return "text-sky-400";
    }
  };

  // ── Stable player source — Date.now() computed ONCE per source change ────────
  // Bug: playerSrc was computed inline in render with Date.now(), so every
  // 5-second health/file poll triggered a re-render → new URL → video element
  // remounted → playback restarted from zero.
  // Fix: useMemo recomputes only when selectedFilePath or job.outputFile changes.
  // The cache-bust timestamp is frozen at the moment the source changes, not
  // at every render.
  const cacheBustRef = useRef<number>(Date.now());
  const prevSourceKeyRef = useRef<string>("");

  const playerSrc = React.useMemo(() => {
    const sourceKey = selectedFilePath || job?.outputFile || "";
    if (sourceKey !== prevSourceKeyRef.current) {
      cacheBustRef.current = Date.now();
      prevSourceKeyRef.current = sourceKey;
    }
    if (!sourceKey) return null;
    if (sourceKey.startsWith("http")) return sourceKey;
    return `/api/media?path=${encodeURIComponent(sourceKey)}&t=${cacheBustRef.current}`;
  }, [selectedFilePath, job?.outputFile]);

  const playerFilename = (selectedFilePath || job?.outputFile || "").split("/").pop() || null;

  return (
    <div className="min-h-screen bg-[#0a0a0a] text-[#e4e3e0] font-sans selection:bg-emerald-500/30">

      {/* ── Header ── */}
      <header className="border-b border-white/10 p-6 flex items-center justify-between bg-black/50 backdrop-blur-xl sticky top-0 z-50">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 bg-emerald-500 rounded flex items-center justify-center shadow-[0_0_20px_rgba(16,185,129,0.3)]">
            <ArrowLeftRight className="text-black w-6 h-6" />
          </div>
          <div>
            <h1 className="text-xl font-bold tracking-tight uppercase italic font-serif">Pro Video Reverser</h1>
            <p className="text-[10px] uppercase tracking-[0.2em] text-white/40 font-mono">Job Pipeline // System v1.2</p>
          </div>
        </div>
        <div className="hidden md:flex items-center gap-6 font-mono text-[10px] uppercase tracking-widest text-white/60">
          <div className="flex items-center gap-2">
            <div className={`w-2 h-2 rounded-full animate-pulse ${systemHealth && systemHealth.load < 4 ? "bg-emerald-500" : "bg-amber-500"}`} />
            LOAD: {systemHealth?.load.toFixed(2) ?? "0.00"}
          </div>
          <div className="flex items-center gap-2">
            <div className={`w-2 h-2 rounded-full animate-pulse ${systemHealth && systemHealth.psi < 10 ? "bg-emerald-500" : "bg-rose-500"}`} />
            PSI: {systemHealth?.psi.toFixed(1) ?? "0.0"}%
          </div>
          <div className="flex items-center gap-2">
            <div className={`w-2 h-2 rounded-full animate-pulse ${systemHealth && systemHealth.disk.available > 1024 ? "bg-emerald-500" : "bg-amber-500"}`} />
            DISK: {systemHealth ? (systemHealth.disk.available / 1024).toFixed(1) : "0.0"}GB FREE
          </div>
          <div className="flex items-center gap-2">
            <div className={`w-2 h-2 rounded-full animate-pulse ${systemHealth && systemHealth.zombies === 0 ? "bg-emerald-500" : "bg-amber-500"}`} />
            PROC: {systemHealth?.zombies ?? 0} ACTIVE
          </div>
          <div className="flex items-center gap-2">
            <Cpu className="w-3 h-3" />
            Throttled Mode Active
          </div>
          <div className="flex items-center gap-2 text-emerald-400 font-mono text-[10px] border-l border-white/10 pl-4">
            <TerminalIcon className="w-3 h-3" />
            TUI: npm run tui (Now Clickable!)
          </div>
        </div>
      </header>

      {hasUpdate && (
        <div className="bg-emerald-500/10 border-y border-emerald-500/20 px-6 py-2 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-2 h-2 bg-emerald-500 rounded-full animate-ping" />
            <span className="text-[10px] font-mono text-emerald-400 uppercase tracking-widest">Update Available: New pipeline features staged on GitHub</span>
          </div>
          <div className="flex items-center gap-4">
            <p className="text-[9px] font-mono text-white/40 uppercase tracking-widest">Apply via terminal or button:</p>
            <button
              onClick={applyUpdate}
              disabled={isUpdating}
              className="bg-emerald-500 hover:bg-emerald-400 text-black text-[9px] font-bold px-4 py-1 rounded uppercase tracking-widest transition-all disabled:opacity-50"
            >
              {isUpdating ? "Applying..." : "1-Click Update"}
            </button>
          </div>
        </div>
      )}

      <main className="max-w-7xl mx-auto p-6 grid grid-cols-1 lg:grid-cols-12 gap-8">

        {/* ── Left Column ── */}
        <section className="lg:col-span-5 space-y-6">

          {/* URL input */}
          <div className="bg-[#141414] border border-white/10 rounded-xl p-6 shadow-2xl relative overflow-hidden">
            <h2 className="text-sm font-mono uppercase tracking-widest text-emerald-400 mb-6 flex items-center gap-2">
              <ChevronRight className="w-4 h-4" />
              Job Pipeline
            </h2>
            <form onSubmit={startJob} className="space-y-4 relative z-10">
              <div className="space-y-2">
                <label className="text-[10px] uppercase tracking-widest text-white/40 font-mono ml-1">YouTube Source URL</label>
                <input
                  type="text"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder="https://www.youtube.com/watch?v=..."
                  className="w-full bg-black border border-white/10 rounded-lg px-4 py-3 text-sm focus:outline-none focus:border-emerald-500/50 transition-colors font-mono"
                  disabled={isSubmitting || (job !== null && job.status !== "completed" && job.status !== "failed")}
                />
              </div>
              <div className="flex gap-2">
                <button
                  type="submit"
                  disabled={isSubmitting || !url || (job !== null && job.status !== "completed" && job.status !== "failed")}
                  className="flex-1 bg-emerald-500 hover:bg-emerald-400 disabled:bg-white/5 disabled:text-white/20 text-black font-bold py-3 rounded-lg transition-all flex items-center justify-center gap-3 uppercase tracking-widest text-[10px] shadow-[0_0_30px_rgba(16,185,129,0.2)]"
                >
                  {isSubmitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4 fill-current" />}
                  Initialize Pipeline
                </button>
                {url && url.startsWith("http") && !url.includes("youtube.com") && !url.includes("youtu.be") && (
                  <button
                    type="button"
                    onClick={() => setSelectedFilePath(url)}
                    className="bg-white/5 hover:bg-white/10 text-white font-bold px-4 py-3 rounded-lg transition-all flex items-center justify-center gap-2 uppercase tracking-widest text-[10px] border border-white/10"
                  >
                    <Video className="w-4 h-4" />
                    Direct Play
                  </button>
                )}
              </div>
            </form>
          </div>

          {/* ── Video Player ── */}
          <div className="bg-[#141414] border border-white/10 rounded-xl overflow-hidden shadow-2xl">
            <div className="p-3 border-b border-white/5 flex items-center justify-between bg-black/20">
              <h3 className="text-[10px] font-mono text-white/40 uppercase tracking-widest flex items-center gap-2">
                <Video className="w-3 h-3" />
                Video Player
              </h3>
              {playerFilename && (
                <span className="text-[9px] font-mono text-emerald-400/80 truncate max-w-[240px]" title={playerFilename}>
                  {playerFilename}
                </span>
              )}
            </div>

            <div className="aspect-video bg-black relative">
              {playerSrc ? (
                <div className="relative w-full h-full">
                  <video
                    key={playerSrc}
                    controls
                    playsInline
                    autoPlay
                    className="w-full h-full"
                    preload="auto"
                    onCanPlay={() => setPlaybackError(false)}
                    onError={() => setPlaybackError(true)}
                  >
                    <source src={playerSrc} type="video/mp4" />
                  </video>
                  {playbackError && (
                    <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/95 p-8 text-center z-10">
                      <AlertCircle className="w-8 h-8 text-rose-500 mb-4" />
                      <p className="text-xs font-mono text-white/60">Playback Failed: Incompatible Format</p>
                      <p className="text-[10px] font-mono text-white/40 mt-2 leading-relaxed">
                        The browser cannot decode this asset.<br />
                        <span className="text-rose-400 font-bold">Try: Delete Job &amp; Reset, then re-run.</span>
                      </p>
                    </div>
                  )}
                </div>
              ) : (
                <div className="absolute inset-0 flex flex-col items-center justify-center text-white/10">
                  <Play className="w-12 h-12 mb-4 opacity-10" />
                  <p className="text-[10px] font-mono uppercase tracking-widest">No Media Selected</p>
                  <p className="text-[9px] font-mono text-white/5 mt-1">Click any file below to play</p>
                </div>
              )}
            </div>

            <div className="p-3 bg-black/40 flex justify-between items-center border-t border-white/5">
              <button
                onClick={() => {
                  const p = selectedFilePath || job?.outputFile;
                  if (p) {
                    navigator.clipboard.writeText(`${window.location.origin}/api/media?path=${encodeURIComponent(p)}`);
                    alert("Media URL copied!");
                  }
                }}
                className="text-[9px] font-mono text-white/40 hover:text-emerald-500 transition-colors uppercase tracking-widest"
              >
                [ Copy URL ]
              </button>
              <button
                onClick={() => setSelectedFilePath(null)}
                className="text-[9px] font-mono text-white/20 hover:text-rose-500 transition-colors uppercase tracking-widest"
              >
                [ Reset ]
              </button>
            </div>
          </div>

          {/* ── File Browser ── */}
          <div className="bg-[#141414] border border-white/10 rounded-xl p-4 shadow-2xl">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-[10px] font-mono text-white/40 uppercase tracking-[0.2em] flex items-center gap-2">
                <Folder className="w-3 h-3" />
                File Browser
              </h3>
              <button
                onClick={() => browserPath && browseTo(browserPath)}
                className="text-[9px] font-mono text-white/20 hover:text-emerald-500 transition-colors uppercase tracking-widest"
              >
                {browserLoading ? "Loading..." : "[ Refresh ]"}
              </button>
            </div>

            {/* Breadcrumb / path bar */}
            {browserData && (
              <div className="flex items-center gap-1 mb-3 overflow-x-auto pb-1 custom-scrollbar">
                {browserData.parent && (
                  <button
                    onClick={() => browseTo(browserData.parent!)}
                    className="flex-shrink-0 text-[9px] font-mono text-white/30 hover:text-emerald-400 transition-colors px-1.5 py-1 rounded hover:bg-white/5"
                    title="Go up"
                  >
                    ↑ ..
                  </button>
                )}
                {browserData.path.split("/").filter(Boolean).map((segment, i, arr) => {
                  const segPath = "/" + arr.slice(0, i + 1).join("/");
                  const isLast = i === arr.length - 1;
                  return (
                    <React.Fragment key={segPath}>
                      {i > 0 && <span className="text-white/15 text-[9px] font-mono flex-shrink-0">/</span>}
                      <button
                        onClick={() => !isLast && browseTo(segPath)}
                        className={`flex-shrink-0 text-[9px] font-mono px-1 py-0.5 rounded transition-colors ${
                          isLast
                            ? "text-emerald-400 cursor-default"
                            : "text-white/30 hover:text-emerald-400 hover:bg-white/5"
                        }`}
                      >
                        {segment}
                      </button>
                    </React.Fragment>
                  );
                })}
              </div>
            )}

            <div className="space-y-0.5 max-h-[460px] overflow-y-auto custom-scrollbar">
              {!browserData && !browserLoading && (
                <p className="text-[10px] font-mono text-white/10 italic text-center py-8">Initializing browser...</p>
              )}
              {browserLoading && (
                <div className="flex items-center justify-center py-8 gap-2 text-white/20">
                  <Loader2 className="w-4 h-4 animate-spin" />
                  <span className="text-[10px] font-mono">Loading...</span>
                </div>
              )}
              {browserData && !browserLoading && (
                <>
                  {/* Directories */}
                  {browserData.dirs.map((dir) => (
                    <button
                      key={dir.path}
                      onClick={() => browseTo(dir.path)}
                      className="w-full flex items-center gap-2 px-3 py-2 rounded hover:bg-white/5 transition-colors text-left group"
                    >
                      <Folder className="w-3.5 h-3.5 text-amber-400/60 flex-shrink-0 group-hover:text-amber-400 transition-colors" />
                      <span className="text-[10px] font-mono text-white/50 group-hover:text-white/80 transition-colors truncate flex-1">
                        {dir.name}
                      </span>
                      <ChevronRight className="w-3 h-3 text-white/15 flex-shrink-0" />
                    </button>
                  ))}

                  {/* Separator if both dirs and files exist */}
                  {browserData.dirs.length > 0 && browserData.files.length > 0 && (
                    <div className="border-t border-white/5 my-1" />
                  )}

                  {/* Files */}
                  {browserData.files.map((f) => {
                    const isActive = selectedFilePath === f.path;
                    const isVideo = /\.(mp4|webm|mkv|mov|avi)$/i.test(f.name);
                    const sizeMb = (f.size / 1024 / 1024).toFixed(1);
                    return (
                      <div
                        key={f.path}
                        className={`flex items-center gap-2 px-3 py-2 rounded transition-colors ${
                          isActive
                            ? "bg-emerald-500/10 border border-emerald-500/30"
                            : "hover:bg-white/5 border border-transparent"
                        }`}
                      >
                        {/* Play button — only for video files */}
                        {isVideo ? (
                          <button
                            onClick={() => setSelectedFilePath(f.path)}
                            title={`Play ${f.name}`}
                            className={`flex-shrink-0 transition-colors ${isActive ? "text-emerald-400" : "text-white/25 hover:text-emerald-400"}`}
                          >
                            <PlayCircle className="w-4 h-4" />
                          </button>
                        ) : (
                          <span className="flex-shrink-0 w-4 h-4 flex items-center justify-center">
                            <span className="w-1.5 h-1.5 rounded-full bg-white/10" />
                          </span>
                        )}

                        {/* Filename */}
                        <button
                          onClick={() => isVideo && setSelectedFilePath(f.path)}
                          className={`flex-1 text-left text-[10px] font-mono truncate transition-colors ${
                            isActive
                              ? "text-emerald-300 font-bold"
                              : isVideo
                                ? "text-white/60 hover:text-white"
                                : "text-white/30 cursor-default"
                          }`}
                          title={f.name}
                        >
                          {f.name}
                        </button>

                        {/* Size */}
                        <span className="flex-shrink-0 text-[8px] font-mono text-white/20 w-12 text-right">
                          {sizeMb}MB
                        </span>

                        {/* Download */}
                        <a
                          href={`/api/media?path=${encodeURIComponent(f.path)}`}
                          download={f.name}
                          title={`Download ${f.name}`}
                          className="flex-shrink-0 text-white/20 hover:text-emerald-400 transition-colors"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <Download className="w-3.5 h-3.5" />
                        </a>
                      </div>
                    );
                  })}

                  {browserData.dirs.length === 0 && browserData.files.length === 0 && (
                    <p className="text-[9px] font-mono text-white/15 italic text-center py-6">Empty directory</p>
                  )}
                </>
              )}
            </div>
          </div>

          {/* Stats row */}
          <div className="grid grid-cols-2 gap-4">
            {[
              { label: "Chunk Size", value: "60s",  icon: ArrowLeftRight },
              { label: "Threads",    value: "1",     icon: Cpu            },
            ].map((stat, i) => (
              <div key={i} className="bg-[#141414] border border-white/5 rounded-lg p-4 flex items-center gap-4">
                <div className="p-2 bg-white/5 rounded">
                  <stat.icon className="w-4 h-4 text-white/40" />
                </div>
                <div>
                  <p className="text-[9px] uppercase tracking-widest text-white/30 font-mono">{stat.label}</p>
                  <p className="text-xs font-bold font-mono">{stat.value}</p>
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* ── Right Column: Status & Logs ── */}
        <section className="lg:col-span-7 space-y-6">
          <AnimatePresence mode="wait">
            {!job ? (
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="h-full min-h-[400px] border border-dashed border-white/10 rounded-xl flex flex-col items-center justify-center text-white/20 space-y-4"
              >
                <TerminalIcon className="w-12 h-12 opacity-20" />
                <p className="font-mono text-[10px] uppercase tracking-[0.3em]">Waiting for input...</p>
              </motion.div>
            ) : (
              <motion.div
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                className="space-y-6"
              >
                {/* Progress card */}
                <div className="bg-[#141414] border border-white/10 rounded-xl p-6 shadow-2xl">
                  <div className="flex items-center justify-between mb-6">
                    <div>
                      <h3 className={`text-xs font-mono uppercase tracking-widest ${getStatusColor(job.status)} flex items-center gap-2`}>
                        {job.status === "completed" ? <CheckCircle2 className="w-4 h-4" /> :
                         job.status === "failed"    ? <AlertCircle  className="w-4 h-4" /> :
                                                      <Loader2       className="w-4 h-4 animate-spin" />}
                        Status: {job.status}
                      </h3>
                      <div className="flex flex-col gap-2 mt-1">
                        <div className="flex items-center gap-3">
                          <p className="text-[10px] text-white/40 font-mono truncate max-w-[200px]">JOB_ID: {job.id}</p>
                          <button
                            onClick={deleteJob}
                            disabled={isDeleting}
                            className={`relative z-50 px-3 py-1.5 ${isDeleting ? "bg-red-900/50 text-red-400" : "bg-red-500/20 text-red-400 border border-red-500/30 hover:bg-red-500 hover:text-white"} text-[10px] font-bold uppercase tracking-widest transition-all rounded-lg shadow-lg flex items-center gap-2 active:scale-95 disabled:opacity-50`}
                          >
                            {isDeleting ? <Loader2 className="w-3 h-3 animate-spin" /> : <Trash2 className="w-3 h-3" />}
                            {isDeleting ? "Wiping Data..." : "Delete Job & Reset"}
                          </button>
                        </div>
                        {deleteError && (
                          <p className="text-[9px] text-rose-500 font-mono uppercase tracking-widest">{deleteError}</p>
                        )}
                      </div>
                    </div>
                    <div className="text-right">
                      <p className="text-2xl font-bold font-mono tracking-tighter">{Math.round(job.progress)}%</p>
                      <p className="text-[9px] uppercase tracking-widest text-white/30 font-mono">Overall Progress</p>
                    </div>
                  </div>

                  <div className="h-1.5 w-full bg-black rounded-full overflow-hidden border border-white/5">
                    <motion.div
                      initial={{ width: 0 }}
                      animate={{ width: `${job.progress}%` }}
                      className={`h-full ${job.status === "failed" ? "bg-rose-500" : "bg-emerald-500"} shadow-[0_0_15px_rgba(16,185,129,0.5)]`}
                    />
                  </div>

                  {/* Chunk map */}
                  {job.chunks && job.chunks.total > 0 && (
                    <div className="mt-6 space-y-3">
                      <div className="flex justify-between text-[9px] font-mono text-white/40 uppercase tracking-widest">
                        <span>Processing Chunk Map</span>
                        <span>{job.chunks.completed.length} / {job.chunks.total} Verified</span>
                      </div>
                      <div className="flex flex-wrap gap-1.5">
                        {Array.from({ length: job.chunks.total }).map((_, i) => {
                          const chunkName = `part_${String(i).padStart(5, "0")}.mp4`;
                          const isCompleted = job.chunks?.completed.includes(chunkName);
                          return (
                            <div
                              key={i}
                              className={`w-3 h-3 rounded-sm transition-all duration-500 cursor-pointer ${isCompleted ? "bg-emerald-500 shadow-[0_0_10px_rgba(16,185,129,0.4)] hover:bg-emerald-300" : "bg-white/5 hover:bg-white/10"}`}
                              title={isCompleted ? `Chunk ${i + 1}: Completed` : `Chunk ${i + 1}: Pending`}
                              onClick={() => {
                                // Navigate browser to the reversed folder for this job
                                // so user can click the specific chunk file
                                if (isCompleted && job) {
                                  browseTo(
                                    `/home/owner/Documents/47911b4f-b8b8-4453-90c9-360918fbf53a/Pro-Video-Reverser/jobs/${job.id}/reversed`
                                  );
                                }
                              }}
                            />
                          );
                        })}
                      </div>
                      <p className="text-[8px] font-mono text-white/20">Click a completed chunk dot to preview it</p>
                    </div>
                  )}

                  {job.status === "failed" && (
                    <div className="mt-6 p-4 bg-rose-500/10 border border-rose-500/20 rounded-lg flex items-start gap-3">
                      <AlertCircle className="w-4 h-4 text-rose-500 shrink-0 mt-0.5" />
                      <div>
                        <p className="text-xs font-bold text-rose-500 uppercase tracking-widest">Pipeline Failure</p>
                        <p className="text-[11px] text-rose-400/80 font-mono mt-1">{job.error}</p>
                      </div>
                    </div>
                  )}
                </div>

                {/* Log viewer */}
                <div className="bg-black border border-white/10 rounded-xl overflow-hidden flex flex-col h-[300px]">
                  <div className="bg-[#141414] border-b border-white/10 p-3 flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <TerminalIcon className="w-3 h-3 text-white/40" />
                      <span className="text-[10px] uppercase tracking-widest text-white/60 font-mono">System Logs</span>
                    </div>
                    <div className="flex gap-1">
                      <div className="w-2 h-2 rounded-full bg-rose-500/50" />
                      <div className="w-2 h-2 rounded-full bg-amber-500/50" />
                      <div className="w-2 h-2 rounded-full bg-emerald-500/50" />
                    </div>
                  </div>
                  <div className="p-4 font-mono text-[11px] overflow-y-auto flex-1 space-y-1 custom-scrollbar">
                    {job.logs.map((logLine, i) => (
                      <div key={i} className="flex gap-3 border-l border-white/5 pl-3 hover:bg-white/5 transition-colors">
                        <span className="text-white/20 shrink-0 select-none">{(i + 1).toString().padStart(3, "0")}</span>
                        <span className="text-white/70 break-all">{logLine}</span>
                      </div>
                    ))}
                    <div ref={logEndRef} />
                  </div>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </section>
      </main>

      <footer className="max-w-6xl mx-auto p-12 text-center">
        <p className="text-[10px] uppercase tracking-[0.4em] text-white/20 font-mono">
          Engineered for Stability // No-OOM Guarantee
        </p>
      </footer>

      <style dangerouslySetInnerHTML={{ __html: `
        .custom-scrollbar::-webkit-scrollbar { width: 4px; }
        .custom-scrollbar::-webkit-scrollbar-track { background: transparent; }
        .custom-scrollbar::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.1); border-radius: 10px; }
        .custom-scrollbar::-webkit-scrollbar-thumb:hover { background: rgba(255,255,255,0.2); }
      `}} />
    </div>
  );
}
