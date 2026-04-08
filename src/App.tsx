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
  Folder
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
}

export default function App() {
  const [url, setUrl] = useState("");
  const [currentJobId, setCurrentJobId] = useState<string | null>(null);
  const [job, setJob] = useState<Job | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [systemHealth, setSystemHealth] = useState<{ load: number; psi: number; disk: { available: number; total: number }; zombies: number } | null>(null);
  const [showPreview, setShowPreview] = useState(false);
  const [showExplorer, setShowExplorer] = useState(false);
  const [hasUpdate, setHasUpdate] = useState(false);
  const [isUpdating, setIsUpdating] = useState(false);
  const [jobFiles, setJobFiles] = useState<{ download: any[], chunks: any[], reversed: any[], final: any[] } | null>(null);
  const [selectedFilePath, setSelectedFilePath] = useState<string | null>(null);
  const [expandedFolders, setExpandedFolders] = useState<Record<string, boolean>>({
    download: true,
    chunks: false,
    reversed: false,
    final: true
  });
  const logEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const discoverActiveJob = async () => {
      try {
        const res = await fetch("/api/jobs/active");
        if (res.ok) {
          const data = await res.json();
          if (data) {
            setCurrentJobId(data.id);
            setJob(data);
          }
        }
      } catch (e) {
        console.error("Discovery error", e);
      }
    };
    discoverActiveJob();
  }, []);

  useEffect(() => {
    const checkUpdate = async () => {
      try {
        const res = await fetch("/api/system/update-check");
        if (res.ok) {
          const data = await res.json();
          setHasUpdate(data.hasUpdate);
        }
      } catch (e) {
        console.error("Update check error", e);
      }
    };
    checkUpdate();
    const interval = setInterval(checkUpdate, 60000);
    return () => clearInterval(interval);
  }, []);

  const applyUpdate = async () => {
    setIsUpdating(true);
    try {
      const res = await fetch("/api/system/update-apply", { method: "POST" });
      if (res.ok) {
        window.location.reload();
      }
    } catch (e) {
      console.error("Update apply error", e);
    } finally {
      setIsUpdating(false);
    }
  };

  useEffect(() => {
    const fetchHealth = async () => {
      try {
        const res = await fetch("/api/system/health");
        if (res.ok) {
          const data = await res.json();
          setSystemHealth(data);
        }
      } catch (e) {
        console.error("Health fetch error", e);
      }
    };
    fetchHealth();
    const interval = setInterval(fetchHealth, 5000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    let interval: NodeJS.Timeout;
    if (currentJobId && job?.status !== "completed" && job?.status !== "failed") {
      interval = setInterval(async () => {
        try {
          const res = await fetch(`/api/jobs/${currentJobId}`);
          if (res.ok) {
            const data = await res.json();
            setJob(data);
          }
        } catch (e) {
          console.error("Polling error", e);
        }
      }, 2000);
    }
    return () => clearInterval(interval);
  }, [currentJobId, job?.status]);

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [job?.logs]);

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
        setJob({
          id: jobId,
          url,
          status: "pending",
          progress: 0,
          logs: ["Initializing..."],
        });
      }
    } catch (e) {
      console.error("Submit error", e);
    } finally {
      setIsSubmitting(false);
    }
  };

  useEffect(() => {
    if (job) {
      const fetchFiles = async () => {
        try {
          const res = await fetch(`/api/jobs/${job.id}/files`);
          if (res.ok) setJobFiles(await res.json());
        } catch (e) {
          console.error("Explorer error", e);
        }
      };
      fetchFiles();
      const interval = setInterval(fetchFiles, 5000);
      return () => clearInterval(interval);
    }
  }, [job?.id]);

  const deleteJob = async () => {
    if (!job) return;
    if (!confirm("Are you sure you want to delete this job and all its files?")) return;
    try {
      const res = await fetch(`/api/jobs/${job.id}`, { method: "DELETE" });
      if (res.ok) {
        setJob(null);
        setCurrentJobId(null);
        setSelectedFilePath(null);
        setJobFiles(null);
      }
    } catch (e) {
      console.error("Delete error", e);
    }
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case "completed": return "text-emerald-400";
      case "failed": return "text-rose-400";
      case "pending": return "text-amber-400";
      default: return "text-sky-400";
    }
  };

  return (
    <div className="min-h-screen bg-[#0a0a0a] text-[#e4e3e0] font-sans selection:bg-emerald-500/30">
      {/* Header */}
      <header className="border-b border-white/10 p-6 flex items-center justify-between bg-black/50 backdrop-blur-xl sticky top-0 z-50">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 bg-emerald-500 rounded flex items-center justify-center shadow-[0_0_20px_rgba(16,185,129,0.3)]">
            <ArrowLeftRight className="text-black w-6 h-6" />
          </div>
          <div>
            <h1 className="text-xl font-bold tracking-tight uppercase italic font-serif">Pro Video Reverser</h1>
            <p className="text-[10px] uppercase tracking-[0.2em] text-white/40 font-mono">Mission Control // Stable Pipeline v1.0</p>
          </div>
        </div>
        <div className="hidden md:flex items-center gap-6 font-mono text-[10px] uppercase tracking-widest text-white/60">
          <div className="flex items-center gap-2">
            <div className={`w-2 h-2 rounded-full ${systemHealth && systemHealth.load < 4 ? 'bg-emerald-500' : 'bg-amber-500'} animate-pulse`} />
            LOAD: {systemHealth?.load.toFixed(2) || "0.00"}
          </div>
          <div className="flex items-center gap-2">
            <div className={`w-2 h-2 rounded-full ${systemHealth && systemHealth.psi < 10 ? 'bg-emerald-500' : 'bg-rose-500'} animate-pulse`} />
            PSI: {systemHealth?.psi.toFixed(1) || "0.0"}%
          </div>
          <div className="flex items-center gap-2">
            <div className={`w-2 h-2 rounded-full ${systemHealth && systemHealth.disk.available > 1024 ? 'bg-emerald-500' : 'bg-amber-500'} animate-pulse`} />
            DISK: {systemHealth ? (systemHealth.disk.available / 1024).toFixed(1) : "0.0"}GB FREE
          </div>
          <div className="flex items-center gap-2">
            <div className={`w-2 h-2 rounded-full ${systemHealth && systemHealth.zombies === 0 ? 'bg-emerald-500' : 'bg-amber-500'} animate-pulse`} />
            PROC: {systemHealth?.zombies || 0} ACTIVE
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
            <span className="text-[10px] font-mono text-emerald-400 uppercase tracking-widest">Update Available: New forensic features staged on GitHub</span>
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
        {/* Left Column: Input, Player, Explorer */}
        <section className="lg:col-span-5 space-y-6">
          <div className="bg-[#141414] border border-white/10 rounded-xl p-6 shadow-2xl relative overflow-hidden group">
            <h2 className="text-sm font-mono uppercase tracking-widest text-emerald-400 mb-6 flex items-center gap-2">
              <ChevronRight className="w-4 h-4" />
              Mission Control
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
                {url && (url.startsWith('http') || url.startsWith('https')) && !url.includes('youtube.com') && !url.includes('youtu.be') && (
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

          {/* Integrated Player */}
          <div className="bg-[#141414] border border-white/10 rounded-xl overflow-hidden shadow-2xl">
            <div className="p-3 border-b border-white/5 flex items-center justify-between bg-black/20">
              <h3 className="text-[10px] font-mono text-white/40 uppercase tracking-widest flex items-center gap-2">
                <Video className="w-3 h-3" />
                Forensic Player
              </h3>
              {selectedFilePath && (
                <span className="text-[9px] font-mono text-emerald-500/60 truncate max-w-[200px]">
                  {selectedFilePath.split('/').pop()}
                </span>
              )}
            </div>
            
            <div className="aspect-video bg-black relative group">
              {selectedFilePath || (job?.outputFile && job.status === "completed") ? (
                <video 
                  key={selectedFilePath || job?.outputFile}
                  src={selectedFilePath?.startsWith('http') ? selectedFilePath : (selectedFilePath ? `/api/media?path=${encodeURIComponent(selectedFilePath)}&t=${Date.now()}` : `/api/media?path=${encodeURIComponent(job?.outputFile || '')}&t=${Date.now()}`)}
                  controls 
                  playsInline
                  autoPlay
                  className="w-full h-full"
                  preload="auto"
                  onError={(e) => {
                    console.error("Video playback error", e);
                  }}
                >
                  <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/90 p-8 text-center">
                    <AlertCircle className="w-8 h-8 text-rose-500 mb-4" />
                    <p className="text-xs font-mono text-white/60">
                      Playback Failed: Codec Mismatch
                    </p>
                    <p className="text-[10px] font-mono text-white/40 mt-2">
                      The browser cannot decode this forensic asset. 
                      Try the "Open in VLC" link below.
                    </p>
                  </div>
                </video>
              ) : (
                <div className="absolute inset-0 flex flex-col items-center justify-center text-white/10">
                  <Play className="w-12 h-12 mb-4 opacity-10" />
                  <p className="text-[10px] font-mono uppercase tracking-widest">No Media Selected</p>
                </div>
              )}
            </div>
            
            <div className="p-3 bg-black/40 flex justify-between items-center border-t border-white/5">
              <button 
                onClick={() => {
                  const path = selectedFilePath || job?.outputFile;
                  if (path) {
                    const url = `${window.location.origin}/api/media?path=${encodeURIComponent(path)}`;
                    navigator.clipboard.writeText(url);
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

          {/* File Explorer */}
          <div className="bg-[#141414] border border-white/10 rounded-xl p-4 shadow-2xl">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-[10px] font-mono text-white/40 uppercase tracking-[0.2em] flex items-center gap-2">
                <Folder className="w-3 h-3" />
                File Explorer
              </h3>
              <button 
                onClick={async () => {
                  if (!job) return;
                  try {
                    const res = await fetch(`/api/jobs/${job.id}/files`);
                    if (res.ok) setJobFiles(await res.json());
                  } catch (e) {}
                }}
                className="text-[9px] font-mono text-white/20 hover:text-emerald-500 transition-colors uppercase tracking-widest"
              >
                [ Refresh ]
              </button>
            </div>

            <div className="space-y-2 max-h-[400px] overflow-y-auto custom-scrollbar pr-2">
              {jobFiles ? (
                [
                  { id: "download", title: "Source", files: jobFiles.download },
                  { id: "chunks", title: "Chunks", files: jobFiles.chunks },
                  { id: "reversed", title: "Reversed", files: jobFiles.reversed },
                  { id: "final", title: "Master", files: jobFiles.final }
                ].map((section) => (
                  <div key={section.id} className="bg-black/40 border border-white/5 rounded-lg overflow-hidden">
                    <button 
                      onClick={() => setExpandedFolders(prev => ({ ...prev, [section.id]: !prev[section.id] }))}
                      className="w-full flex items-center justify-between p-2.5 hover:bg-white/5 transition-colors"
                    >
                      <div className="flex items-center gap-2">
                        <ChevronRight className={`w-3 h-3 text-emerald-500 transition-transform ${expandedFolders[section.id] ? 'rotate-90' : ''}`} />
                        <span className="text-[10px] font-mono text-white/60 uppercase tracking-widest">{section.title}</span>
                      </div>
                      <span className="text-[9px] font-mono text-white/20">{section.files.length}</span>
                    </button>
                    
                    <AnimatePresence>
                      {expandedFolders[section.id] && (
                        <motion.div 
                          initial={{ height: 0, opacity: 0 }}
                          animate={{ height: "auto", opacity: 1 }}
                          exit={{ height: 0, opacity: 0 }}
                          className="overflow-hidden"
                        >
                          <div className="p-2 pt-0 space-y-1 border-t border-white/5">
                            {section.files.map((f, fidx) => (
                              <div key={fidx} className="flex justify-between items-center group/file py-1.5 hover:bg-white/5 pl-5 rounded transition-colors">
                                <button 
                                  onClick={() => setSelectedFilePath(f.path)}
                                  className={`text-[9px] font-mono truncate max-w-[180px] text-left ${selectedFilePath === f.path ? 'text-emerald-400' : 'text-white/60 hover:text-white'}`}
                                >
                                  {f.name}
                                </button>
                                <div className="flex items-center gap-3">
                                  <span className="text-[8px] font-mono text-white/20">{(f.size / 1024 / 1024).toFixed(1)}MB</span>
                                  <a 
                                    href={`/api/media?path=${encodeURIComponent(f.path)}`}
                                    download={f.name}
                                    className="opacity-0 group-hover/file:opacity-100 transition-opacity"
                                  >
                                    <Download className="w-3 h-3 text-white/40 hover:text-emerald-500" />
                                  </a>
                                </div>
                              </div>
                            ))}
                          </div>
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </div>
                ))
              ) : (
                <p className="text-[10px] font-mono text-white/10 italic text-center py-8">No job data available</p>
              )}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            {[
              { label: "Chunk Size", value: "60s", icon: ArrowLeftRight },
              { label: "Threads", value: "1", icon: Cpu },
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

        {/* Right Column: Status & Logs */}
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
                  {/* Progress Card */}
                <div className="bg-[#141414] border border-white/10 rounded-xl p-6 shadow-2xl">
                  <div className="flex items-center justify-between mb-6">
                    <div>
                      <h3 className={`text-xs font-mono uppercase tracking-widest ${getStatusColor(job.status)} flex items-center gap-2`}>
                        {job.status === "completed" ? <CheckCircle2 className="w-4 h-4" /> : 
                         job.status === "failed" ? <AlertCircle className="w-4 h-4" /> : 
                         <Loader2 className="w-4 h-4 animate-spin" />}
                        Status: {job.status}
                      </h3>
                      <div className="flex items-center gap-3 mt-1">
                        <p className="text-[10px] text-white/40 font-mono truncate max-w-[200px]">JOB_ID: {job.id}</p>
                        <button 
                          onClick={deleteJob}
                          className="text-[9px] font-mono text-rose-500/60 hover:text-rose-500 uppercase tracking-widest transition-colors"
                        >
                          [ Delete Job ]
                        </button>
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

                  {/* Chunk Map */}
                  {job.chunks && job.chunks.total > 0 && (
                    <div className="mt-6 space-y-3">
                      <div className="flex justify-between text-[9px] font-mono text-white/40 uppercase tracking-widest">
                        <span>Forensic Chunk Map</span>
                        <span>{job.chunks.completed.length} / {job.chunks.total} Verified</span>
                      </div>
                      <div className="flex flex-wrap gap-1.5">
                        {Array.from({ length: job.chunks.total }).map((_, i) => {
                          const chunkName = `part_${String(i).padStart(5, '0')}.mp4`;
                          const isCompleted = job.chunks?.completed.includes(chunkName);
                          return (
                            <div 
                              key={i}
                              className={`w-3 h-3 rounded-sm transition-all duration-500 ${
                                isCompleted ? 'bg-emerald-500 shadow-[0_0_10px_rgba(16,185,129,0.4)]' : 'bg-white/5'
                              }`}
                              title={isCompleted ? `Chunk ${i + 1}: Completed` : `Chunk ${i + 1}: Pending`}
                            />
                          );
                        })}
                      </div>
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

                {/* Log Viewer */}
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
                    {job.logs.map((log, i) => (
                      <div key={i} className="flex gap-3 border-l border-white/5 pl-3 hover:bg-white/5 transition-colors">
                        <span className="text-white/20 shrink-0 select-none">{(i + 1).toString().padStart(3, "0")}</span>
                        <span className="text-white/70 break-all">{log}</span>
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
        .custom-scrollbar::-webkit-scrollbar {
          width: 4px;
        }
        .custom-scrollbar::-webkit-scrollbar-track {
          background: transparent;
        }
        .custom-scrollbar::-webkit-scrollbar-thumb {
          background: rgba(255,255,255,0.1);
          border-radius: 10px;
        }
        .custom-scrollbar::-webkit-scrollbar-thumb:hover {
          background: rgba(255,255,255,0.2);
        }
      `}} />
    </div>
  );
}
