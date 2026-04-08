// PATH: src/App.tsx
// v1.3 — Unified layout. Player is the hero. Any loaded file can be reversed.

import React, { useState, useEffect, useRef, useCallback, useMemo } from "react";
import {
  Play, Download, AlertCircle, CheckCircle2, Loader2,
  Terminal as TerminalIcon, Video, ArrowLeftRight,
  ChevronRight, Folder, Trash2, PlayCircle, RefreshCw,
  Link2, HardDrive,
} from "lucide-react";
import { motion, AnimatePresence } from "motion/react";

interface Job {
  id: string;
  url: string;
  sourceFile?: string | null;
  status: "pending" | "downloading" | "splitting" | "reversing" | "merging" | "completed" | "failed";
  progress: number;
  logs: string[];
  outputFile?: string;
  error?: string;
  chunks?: { total: number; completed: string[]; downloaded: boolean };
}

interface BrowseData {
  path: string;
  parent: string | null;
  dirs: { name: string; path: string }[];
  files: { name: string; size: number; mtime: string; path: string }[];
}

const IS_VIDEO = (name: string) => /\.(mp4|webm|mkv|mov|avi|m4v)$/i.test(name);

export default function App() {
  const [currentJobId, setCurrentJobId] = useState<string | null>(null);
  const [job, setJob] = useState<Job | null>(null);
  const [selectedFilePath, setSelectedFilePath] = useState<string | null>(null);
  const [playbackError, setPlaybackError] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [youtubeUrl, setYoutubeUrl] = useState("");
  const [activeTab, setActiveTab] = useState<"url" | "browser">("browser");
  const [systemHealth, setSystemHealth] = useState<{
    load: number; psi: number;
    disk: { available: number; total: number }; zombies: number;
  } | null>(null);
  const [hasUpdate, setHasUpdate] = useState(false);
  const [isUpdating, setIsUpdating] = useState(false);
  const [browserData, setBrowserData] = useState<BrowseData | null>(null);
  const [browserPath, setBrowserPath] = useState<string | null>(null);
  const [browserLoading, setBrowserLoading] = useState(false);
  const logEndRef = useRef<HTMLDivElement>(null);

  // Stable player src — only recomputes when file actually changes, not on every poll
  const cacheBustRef = useRef<number>(Date.now());
  const prevSourceKeyRef = useRef<string>("");
  const playerSrc = useMemo(() => {
    const key = selectedFilePath || job?.outputFile || "";
    if (key !== prevSourceKeyRef.current) {
      cacheBustRef.current = Date.now();
      prevSourceKeyRef.current = key;
    }
    if (!key) return null;
    if (key.startsWith("http")) return key;
    return `/api/media?path=${encodeURIComponent(key)}&t=${cacheBustRef.current}`;
  }, [selectedFilePath, job?.outputFile]);

  const playerFilename = (selectedFilePath || job?.outputFile || "").split("/").pop() || null;

  const browseTo = useCallback(async (targetPath: string) => {
    setBrowserLoading(true);
    try {
      const res = await fetch(`/api/browse?path=${encodeURIComponent(targetPath)}`);
      if (res.ok) {
        const data: BrowseData = await res.json();
        setBrowserData(data);
        setBrowserPath(data.path);
      }
    } catch (e) { console.error("Browse error", e); }
    finally { setBrowserLoading(false); }
  }, []);

  useEffect(() => {
    fetch("/api/jobs/active").then(r => r.ok ? r.json() : null).then(data => {
      if (data) { setCurrentJobId(data.id); setJob(data); }
    }).catch(() => {});
    browseTo("/home/owner/Documents");
  }, []);

  useEffect(() => {
    const check = () => fetch("/api/system/update-check")
      .then(r => r.ok ? r.json() : null).then(d => d && setHasUpdate(d.hasUpdate)).catch(() => {});
    check();
    const t = setInterval(check, 60000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    const poll = () => fetch("/api/system/health")
      .then(r => r.ok ? r.json() : null).then(d => d && setSystemHealth(d)).catch(() => {});
    poll();
    const t = setInterval(poll, 5000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    if (!currentJobId || job?.status === "completed" || job?.status === "failed") return;
    const t = setInterval(async () => {
      try {
        const res = await fetch(`/api/jobs/${currentJobId}`);
        if (res.ok) setJob(await res.json());
        else if (res.status === 404) { setJob(null); setCurrentJobId(null); }
      } catch {}
    }, 2000);
    return () => clearInterval(t);
  }, [currentJobId, job?.status]);

  useEffect(() => { logEndRef.current?.scrollIntoView({ behavior: "smooth" }); }, [job?.logs]);

  useEffect(() => {
    if (job?.status === "completed" && job.outputFile && !selectedFilePath) {
      setSelectedFilePath(job.outputFile);
    }
    if (job?.status === "completed" && job.id) {
      browseTo(`/home/owner/Documents/47911b4f-b8b8-4453-90c9-360918fbf53a/Pro-Video-Reverser/jobs/${job.id}`);
    }
  }, [job?.status]);

  useEffect(() => { setPlaybackError(false); }, [selectedFilePath, job?.outputFile]);

  const startJob = async (opts: { url?: string; sourceFile?: string }) => {
    setIsSubmitting(true);
    try {
      const res = await fetch("/api/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(opts),
      });
      if (res.ok) {
        const { jobId } = await res.json();
        setCurrentJobId(jobId);
        setSelectedFilePath(null);
        setJob({
          id: jobId,
          url: opts.url || opts.sourceFile || "",
          sourceFile: opts.sourceFile || null,
          status: "pending",
          progress: 0,
          logs: [opts.sourceFile ? `Reversing local file: ${opts.sourceFile}` : "Initializing..."],
        });
      }
    } catch (e) { console.error("Submit error", e); }
    finally { setIsSubmitting(false); }
  };

  const deleteJob = async () => {
    if (!job || isDeleting) return;
    setIsDeleting(true); setDeleteError(null);
    try {
      const res = await fetch(`/api/jobs/${job.id}`, { method: "DELETE" });
      if (res.ok || res.status === 404) {
        setJob(null); setCurrentJobId(null);
        setSelectedFilePath(null); setPlaybackError(false);
        localStorage.removeItem("currentJobId");
      } else {
        const d = await res.json().catch(() => ({ error: `Status ${res.status}` }));
        setDeleteError(`Delete failed: ${d.error}`);
      }
    } catch (e: any) { setDeleteError(`Network error: ${e.message}`); }
    finally { setIsDeleting(false); }
  };

  const jobActive = job && job.status !== "completed" && job.status !== "failed";
  const canReverse = selectedFilePath && !selectedFilePath.startsWith("http") && !jobActive && !isSubmitting;
  const statusColor = (s: string) =>
    s === "completed" ? "text-emerald-400" : s === "failed" ? "text-rose-400" : "text-sky-400";

  return (
    <div className="min-h-screen bg-[#0a0a0a] text-[#e4e3e0] font-sans selection:bg-emerald-500/30">

      {/* Slim header */}
      <header className="border-b border-white/[0.06] px-6 py-3 flex items-center justify-between bg-black/60 backdrop-blur-xl sticky top-0 z-50">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 bg-emerald-500 rounded flex items-center justify-center shadow-[0_0_16px_rgba(16,185,129,0.3)]">
            <ArrowLeftRight className="text-black w-4 h-4" />
          </div>
          <span className="text-sm font-bold tracking-tight uppercase italic font-serif">Pro Video Reverser</span>
          <span className="text-[9px] uppercase tracking-[0.2em] text-white/20 font-mono hidden md:block">v1.3</span>
        </div>
        <div className="flex items-center gap-5 font-mono text-[9px] uppercase tracking-widest">
          {systemHealth && (
            <>
              <span className={systemHealth.load < 4 ? "text-emerald-500/70" : "text-amber-400"}>LOAD {systemHealth.load.toFixed(1)}</span>
              <span className={systemHealth.psi < 10 ? "text-emerald-500/70" : "text-rose-400"}>PSI {systemHealth.psi.toFixed(0)}%</span>
              <span className={systemHealth.disk.available > 1024 ? "text-emerald-500/70" : "text-amber-400"}>{(systemHealth.disk.available / 1024).toFixed(0)}GB FREE</span>
            </>
          )}
          {hasUpdate && (
            <button onClick={() => { setIsUpdating(true); fetch("/api/system/update-apply", { method: "POST" }).then(() => window.location.reload()); }}
              className="text-emerald-400 border border-emerald-500/30 px-2 py-1 rounded hover:bg-emerald-500/10 transition-colors">
              {isUpdating ? "Updating..." : "Update ↑"}
            </button>
          )}
        </div>
      </header>

      <main className="max-w-7xl mx-auto p-4 md:p-6 space-y-4">

        {/* Hero: Player */}
        <div className="bg-[#0f0f0f] border border-white/[0.06] rounded-xl overflow-hidden shadow-2xl">
          <div className="px-4 py-2.5 border-b border-white/[0.04] flex items-center justify-between bg-black/20">
            <div className="flex items-center gap-2 text-[9px] font-mono text-white/25 uppercase tracking-widest">
              <Video className="w-3 h-3" />
              <span>Player</span>
              {playerFilename && <span className="text-emerald-400/60 ml-1 normal-case tracking-normal truncate max-w-xs">{playerFilename}</span>}
            </div>
            <div className="flex items-center gap-4">
              {playerSrc && <button onClick={() => { const p = selectedFilePath || job?.outputFile; if (p) navigator.clipboard.writeText(`${window.location.origin}/api/media?path=${encodeURIComponent(p)}`); }} className="text-[9px] font-mono text-white/15 hover:text-white/40 transition-colors uppercase tracking-widest">Copy URL</button>}
              {playerSrc && <button onClick={() => setSelectedFilePath(null)} className="text-[9px] font-mono text-white/15 hover:text-rose-400 transition-colors uppercase tracking-widest">Clear</button>}
            </div>
          </div>

          <div className="aspect-video bg-black relative">
            {playerSrc ? (
              <>
                <video key={playerSrc} controls playsInline autoPlay className="w-full h-full" preload="auto"
                  onCanPlay={() => setPlaybackError(false)} onError={() => setPlaybackError(true)}>
                  <source src={playerSrc} type="video/mp4" />
                </video>
                {playbackError && (
                  <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/95 p-8 text-center z-10">
                    <AlertCircle className="w-8 h-8 text-rose-500 mb-3" />
                    <p className="text-xs font-mono text-white/40">Playback failed — incompatible format</p>
                    <p className="text-[10px] font-mono text-rose-400/70 mt-1">Delete job &amp; reset, then re-run</p>
                  </div>
                )}
              </>
            ) : (
              <div className="absolute inset-0 flex flex-col items-center justify-center text-white/[0.06]">
                <Play className="w-16 h-16 mb-2" />
                <p className="text-[10px] font-mono uppercase tracking-widest text-white/15">Browse a file below to play it</p>
              </div>
            )}
          </div>

          {/* Reverse action bar */}
          <div className="px-4 py-3 border-t border-white/[0.04] bg-black/30 flex items-center gap-3">
            <button
              onClick={() => selectedFilePath && startJob({ sourceFile: selectedFilePath })}
              disabled={!canReverse}
              className="flex items-center gap-2 px-4 py-2 bg-emerald-500 hover:bg-emerald-400 disabled:bg-white/[0.04] disabled:text-white/15 text-black font-bold text-[10px] uppercase tracking-widest rounded-lg transition-all shadow-[0_0_20px_rgba(16,185,129,0.15)] disabled:shadow-none"
            >
              {isSubmitting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ArrowLeftRight className="w-3.5 h-3.5" />}
              {isSubmitting ? "Starting..." : "Reverse This Clip"}
            </button>
            <span className="text-[9px] font-mono text-white/20">
              {!playerSrc ? "Load a local file to reverse it" :
               selectedFilePath?.startsWith("http") ? "Remote URLs: use YouTube input below" :
               jobActive ? "Job in progress..." :
               playerFilename}
            </span>
          </div>
        </div>

        {/* Two-column: controls + browser */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">

          {/* Left: input + job status */}
          <div className="lg:col-span-5 space-y-4">

            {/* Tab: URL / Local */}
            <div className="bg-[#0f0f0f] border border-white/[0.06] rounded-xl overflow-hidden">
              <div className="flex border-b border-white/[0.04]">
                {(["browser", "url"] as const).map(tab => (
                  <button key={tab} onClick={() => setActiveTab(tab)}
                    className={`flex-1 py-2.5 text-[9px] font-mono uppercase tracking-widest transition-colors flex items-center justify-center gap-1.5 ${activeTab === tab ? "text-emerald-400 bg-emerald-500/[0.06] border-b border-emerald-500" : "text-white/25 hover:text-white/45"}`}>
                    {tab === "url" ? <Link2 className="w-3 h-3" /> : <HardDrive className="w-3 h-3" />}
                    {tab === "url" ? "YouTube URL" : "Local File"}
                  </button>
                ))}
              </div>
              <div className="p-4">
                {activeTab === "url" ? (
                  <form onSubmit={e => { e.preventDefault(); if (youtubeUrl) startJob({ url: youtubeUrl }); }} className="space-y-3">
                    <input type="text" value={youtubeUrl} onChange={e => setYoutubeUrl(e.target.value)}
                      placeholder="https://www.youtube.com/watch?v=..."
                      className="w-full bg-black border border-white/[0.07] rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:border-emerald-500/30 transition-colors font-mono text-white/70 placeholder:text-white/15"
                      disabled={isSubmitting || !!jobActive} />
                    <button type="submit" disabled={isSubmitting || !youtubeUrl || !!jobActive}
                      className="w-full bg-emerald-500 hover:bg-emerald-400 disabled:bg-white/[0.04] disabled:text-white/15 text-black font-bold py-2.5 rounded-lg transition-all flex items-center justify-center gap-2 uppercase tracking-widest text-[10px]">
                      {isSubmitting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5 fill-current" />}
                      Download &amp; Reverse
                    </button>
                  </form>
                ) : (
                  <p className="text-[10px] font-mono text-white/25 text-center py-3 leading-relaxed">
                    Browse to a video on the right →<br />
                    Click <PlayCircle className="inline w-3 h-3 text-emerald-400 mx-0.5" /> to load it, then<br />
                    <span className="text-emerald-400">"Reverse This Clip"</span> above the player.
                  </p>
                )}
              </div>
            </div>

            {/* Job status */}
            <AnimatePresence mode="wait">
              {job ? (
                <motion.div key="job" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
                  className="bg-[#0f0f0f] border border-white/[0.06] rounded-xl overflow-hidden">
                  <div className="px-4 py-3 border-b border-white/[0.04] flex items-center justify-between">
                    <div className={`flex items-center gap-2 text-[10px] font-mono uppercase tracking-widest ${statusColor(job.status)}`}>
                      {job.status === "completed" ? <CheckCircle2 className="w-3.5 h-3.5" /> :
                       job.status === "failed" ? <AlertCircle className="w-3.5 h-3.5" /> :
                       <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                      {job.status}
                    </div>
                    <div className="flex items-center gap-3">
                      <span className="text-xl font-bold font-mono tabular-nums">{Math.round(job.progress)}%</span>
                      <button onClick={deleteJob} disabled={isDeleting}
                        className="flex items-center gap-1.5 px-2.5 py-1.5 bg-red-500/10 text-red-400 border border-red-500/20 hover:bg-red-500 hover:text-white text-[9px] font-bold uppercase tracking-widest rounded-lg transition-all disabled:opacity-50">
                        {isDeleting ? <Loader2 className="w-3 h-3 animate-spin" /> : <Trash2 className="w-3 h-3" />}
                        {isDeleting ? "..." : "Delete"}
                      </button>
                    </div>
                  </div>
                  {deleteError && <p className="px-4 py-1 text-[9px] text-rose-400 font-mono bg-rose-500/[0.04] border-b border-rose-500/10">{deleteError}</p>}
                  <div className="px-4 pt-3 pb-2">
                    <div className="h-1 w-full bg-black rounded-full overflow-hidden">
                      <motion.div initial={{ width: 0 }} animate={{ width: `${job.progress}%` }}
                        className={`h-full ${job.status === "failed" ? "bg-rose-500" : "bg-emerald-500"} shadow-[0_0_10px_rgba(16,185,129,0.35)]`} />
                    </div>
                  </div>
                  {job.chunks && job.chunks.total > 0 && (
                    <div className="px-4 pb-3 space-y-1">
                      <div className="flex justify-between text-[8px] font-mono text-white/20 uppercase tracking-widest">
                        <span>Chunks</span><span>{job.chunks.completed.length}/{job.chunks.total}</span>
                      </div>
                      <div className="flex flex-wrap gap-1">
                        {Array.from({ length: job.chunks.total }).map((_, i) => {
                          const name = `part_${String(i).padStart(5, "0")}.mp4`;
                          const done = job.chunks?.completed.includes(name);
                          return <div key={i} title={`Chunk ${i + 1}: ${done ? "done" : "pending"}`}
                            onClick={() => done && job.id && browseTo(`/home/owner/Documents/47911b4f-b8b8-4453-90c9-360918fbf53a/Pro-Video-Reverser/jobs/${job.id}/reversed`)}
                            className={`w-3 h-3 rounded-sm cursor-pointer transition-all ${done ? "bg-emerald-500 hover:bg-emerald-300" : "bg-white/[0.05]"}`} />;
                        })}
                      </div>
                    </div>
                  )}
                  {job.status === "failed" && (
                    <div className="mx-4 mb-3 p-3 bg-rose-500/[0.07] border border-rose-500/15 rounded-lg flex gap-2">
                      <AlertCircle className="w-3.5 h-3.5 text-rose-500 shrink-0 mt-0.5" />
                      <p className="text-[10px] text-rose-400/70 font-mono">{job.error}</p>
                    </div>
                  )}
                  <div className="border-t border-white/[0.04] h-44 overflow-y-auto custom-scrollbar p-3 font-mono text-[10px] space-y-0.5 bg-black/30">
                    {job.logs.map((line, i) => (
                      <div key={i} className="flex gap-2 text-white/35 hover:text-white/55 transition-colors">
                        <span className="text-white/12 shrink-0 select-none w-6 text-right tabular-nums">{i + 1}</span>
                        <span className="break-all leading-relaxed">{line}</span>
                      </div>
                    ))}
                    <div ref={logEndRef} />
                  </div>
                </motion.div>
              ) : (
                <motion.div key="idle" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                  className="border border-dashed border-white/[0.06] rounded-xl p-8 flex flex-col items-center justify-center text-white/10 gap-3">
                  <TerminalIcon className="w-8 h-8" />
                  <p className="font-mono text-[9px] uppercase tracking-[0.3em]">No active job</p>
                </motion.div>
              )}
            </AnimatePresence>
          </div>

          {/* Right: File browser */}
          <div className="lg:col-span-7">
            <div className="bg-[#0f0f0f] border border-white/[0.06] rounded-xl overflow-hidden">
              <div className="px-4 py-2.5 border-b border-white/[0.04] flex items-center justify-between bg-black/20">
                <div className="flex items-center gap-2 text-[9px] font-mono text-white/25 uppercase tracking-widest">
                  <HardDrive className="w-3 h-3" /><span>File Browser</span>
                </div>
                <button onClick={() => browserPath && browseTo(browserPath)} className="text-white/15 hover:text-emerald-400 transition-colors" title="Refresh">
                  <RefreshCw className={`w-3.5 h-3.5 ${browserLoading ? "animate-spin" : ""}`} />
                </button>
              </div>

              {browserData && (
                <div className="px-3 py-2 border-b border-white/[0.04] flex items-center gap-0.5 overflow-x-auto bg-black/10 custom-scrollbar">
                  {browserData.parent && (
                    <button onClick={() => browseTo(browserData.parent!)}
                      className="flex-shrink-0 text-[9px] font-mono text-white/20 hover:text-emerald-400 transition-colors px-1.5 py-0.5 rounded hover:bg-white/[0.04]">↑</button>
                  )}
                  {browserData.path.split("/").filter(Boolean).map((seg, i, arr) => {
                    const segPath = "/" + arr.slice(0, i + 1).join("/");
                    const isLast = i === arr.length - 1;
                    return (
                      <React.Fragment key={segPath}>
                        {i > 0 && <span className="text-white/[0.08] text-[9px] font-mono px-0.5">/</span>}
                        <button onClick={() => !isLast && browseTo(segPath)}
                          className={`flex-shrink-0 text-[9px] font-mono px-1 py-0.5 rounded transition-colors ${isLast ? "text-emerald-400 cursor-default" : "text-white/20 hover:text-emerald-400 hover:bg-white/[0.04]"}`}>
                          {seg}
                        </button>
                      </React.Fragment>
                    );
                  })}
                </div>
              )}

              <div className="overflow-y-auto custom-scrollbar" style={{ maxHeight: "calc(100vh - 320px)", minHeight: "400px" }}>
                {browserLoading ? (
                  <div className="flex items-center justify-center py-12 text-white/20 gap-2">
                    <Loader2 className="w-4 h-4 animate-spin" />
                    <span className="text-[10px] font-mono">Loading...</span>
                  </div>
                ) : browserData ? (
                  <div>
                    {browserData.dirs.map(dir => (
                      <button key={dir.path} onClick={() => browseTo(dir.path)}
                        className="w-full flex items-center gap-3 px-4 py-2.5 hover:bg-white/[0.03] transition-colors text-left group border-b border-white/[0.03]">
                        <Folder className="w-3.5 h-3.5 text-amber-400/40 group-hover:text-amber-400/70 flex-shrink-0 transition-colors" />
                        <span className="text-[10px] font-mono text-white/40 group-hover:text-white/65 transition-colors flex-1 truncate">{dir.name}</span>
                        <ChevronRight className="w-3 h-3 text-white/10 flex-shrink-0" />
                      </button>
                    ))}
                    {browserData.dirs.length > 0 && browserData.files.length > 0 && <div className="border-b border-white/[0.06]" />}
                    {browserData.files.map(f => {
                      const isActive = selectedFilePath === f.path;
                      const isVid = IS_VIDEO(f.name);
                      const mb = (f.size / 1024 / 1024).toFixed(1);
                      return (
                        <div key={f.path} className={`flex items-center gap-3 px-4 py-2.5 transition-colors border-b border-white/[0.03] border-l-2 ${isActive ? "bg-emerald-500/[0.07] border-l-emerald-500 pl-3.5" : "border-l-transparent hover:bg-white/[0.02]"}`}>
                          {isVid ? (
                            <button onClick={() => setSelectedFilePath(f.path)} className={`flex-shrink-0 transition-colors ${isActive ? "text-emerald-400" : "text-white/20 hover:text-emerald-400"}`}>
                              <PlayCircle className="w-4 h-4" />
                            </button>
                          ) : (
                            <span className="flex-shrink-0 w-4 flex items-center justify-center"><span className="w-1.5 h-1.5 rounded-full bg-white/[0.08]" /></span>
                          )}
                          <button onClick={() => isVid && setSelectedFilePath(f.path)} disabled={!isVid}
                            className={`flex-1 text-left text-[10px] font-mono truncate transition-colors ${isActive ? "text-emerald-300 font-semibold" : isVid ? "text-white/50 hover:text-white/75" : "text-white/20 cursor-default"}`}
                            title={f.name}>{f.name}</button>
                          <span className="flex-shrink-0 text-[8px] font-mono text-white/18 w-14 text-right tabular-nums">{mb}MB</span>
                          <a href={`/api/media?path=${encodeURIComponent(f.path)}`} download={f.name}
                            onClick={e => e.stopPropagation()}
                            className="flex-shrink-0 text-white/12 hover:text-emerald-400 transition-colors" title={`Download ${f.name}`}>
                            <Download className="w-3.5 h-3.5" />
                          </a>
                        </div>
                      );
                    })}
                    {browserData.dirs.length === 0 && browserData.files.length === 0 && (
                      <p className="text-[9px] font-mono text-white/12 italic text-center py-10">Empty directory</p>
                    )}
                  </div>
                ) : (
                  <p className="text-[9px] font-mono text-white/12 italic text-center py-10">Initializing...</p>
                )}
              </div>
            </div>
          </div>
        </div>
      </main>

      <footer className="text-center py-8">
        <p className="text-[9px] uppercase tracking-[0.4em] text-white/8 font-mono">Engineered for Stability // No-OOM Guarantee</p>
      </footer>

      <style dangerouslySetInnerHTML={{ __html: `
        .custom-scrollbar::-webkit-scrollbar { width: 3px; height: 3px; }
        .custom-scrollbar::-webkit-scrollbar-track { background: transparent; }
        .custom-scrollbar::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.06); border-radius: 10px; }
        .text-white\\/12 { color: rgba(255,255,255,0.12); }
        .text-white\\/18 { color: rgba(255,255,255,0.18); }
        .border-white\\/\\[0\\.04\\] { border-color: rgba(255,255,255,0.04); }
      `}} />
    </div>
  );
}
