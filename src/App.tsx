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
  const [jobFiles, setJobFiles] = useState<{ download: any[], chunks: any[], reversed: any[], final: any[] } | null>(null);
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
    if (job && showExplorer) {
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
  }, [job, showExplorer]);

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
        </div>
      </header>

      <main className="max-w-6xl mx-auto p-6 grid grid-cols-1 lg:grid-cols-12 gap-8">
        {/* Input Section */}
        <section className="lg:col-span-5 space-y-8">
          <div className="bg-[#141414] border border-white/10 rounded-xl p-8 shadow-2xl relative overflow-hidden group">
            <div className="absolute top-0 right-0 p-4 opacity-10 group-hover:opacity-20 transition-opacity">
              <Video className="w-24 h-24" />
            </div>
            
            <h2 className="text-sm font-mono uppercase tracking-widest text-emerald-400 mb-6 flex items-center gap-2">
              <ChevronRight className="w-4 h-4" />
              New Processing Job
            </h2>

            <form onSubmit={startJob} className="space-y-6 relative z-10">
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

              <button
                type="submit"
                disabled={isSubmitting || !url || (job !== null && job.status !== "completed" && job.status !== "failed")}
                className="w-full bg-emerald-500 hover:bg-emerald-400 disabled:bg-white/5 disabled:text-white/20 text-black font-bold py-4 rounded-lg transition-all flex items-center justify-center gap-3 uppercase tracking-widest text-xs shadow-[0_0_30px_rgba(16,185,129,0.2)]"
              >
                {isSubmitting ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Play className="w-4 h-4 fill-current" />
                )}
                Initialize Pipeline
              </button>
            </form>
          </div>

          {/* System Stats / Recipe 3 feel */}
          <div className="grid grid-cols-2 gap-4">
            {[
              { label: "Chunk Size", value: "60s", icon: ArrowLeftRight },
              { label: "Threads", value: "1", icon: Cpu },
              { label: "Format", value: "MP4/H.264", icon: Video },
              { label: "Engine", value: "FFmpeg v4.4", icon: TerminalIcon },
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

        {/* Status Section */}
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
                      <p className="text-[10px] text-white/40 font-mono mt-1 truncate max-w-[300px]">JOB_ID: {job.id}</p>
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
                            <a 
                              key={i}
                              href={isCompleted ? `/api/download/${job.id}/chunks/${chunkName}` : undefined}
                              target="_blank"
                              rel="noreferrer"
                              className={`w-3 h-3 rounded-sm transition-all duration-500 cursor-pointer ${
                                isCompleted ? 'bg-emerald-500 shadow-[0_0_10px_rgba(16,185,129,0.4)] hover:scale-125' : 'bg-white/5 cursor-not-allowed'
                              }`}
                              title={isCompleted ? `Download Chunk ${i + 1}: ${chunkName}` : `Chunk ${i + 1}: Pending`}
                            />
                          );
                        })}
                      </div>
                    </div>
                  )}

                  {job.status === "completed" && (
                    <div className="mt-8 space-y-4">
                      <div className="grid grid-cols-2 gap-4">
                        <button
                          onClick={() => setShowPreview(!showPreview)}
                          className="bg-white/5 hover:bg-white/10 text-white font-bold py-4 rounded-lg transition-all flex items-center justify-center gap-3 uppercase tracking-widest text-xs border border-white/10"
                        >
                          <Video className="w-4 h-4" />
                          {showPreview ? "Hide Preview" : "Preview Result"}
                        </button>
                        <a
                          href={`/api/download/${job.id}`}
                          className="bg-white text-black font-bold py-4 rounded-lg transition-all flex items-center justify-center gap-3 uppercase tracking-widest text-xs hover:bg-emerald-400 shadow-[0_0_20px_rgba(255,255,255,0.1)]"
                        >
                          <Download className="w-4 h-4" />
                          Download Final
                        </a>
                      </div>

                      {showPreview && (
                        <motion.div 
                          initial={{ opacity: 0, height: 0 }}
                          animate={{ opacity: 1, height: "auto" }}
                          className="rounded-lg overflow-hidden border border-white/10 bg-black"
                        >
                          <video 
                            controls 
                            className="w-full aspect-video"
                            src={`/api/download/${job.id}?preview=true`}
                          />
                        </motion.div>
                      )}
                    </div>
                  )}

                  {/* Forensic File Explorer */}
                  <div className="mt-6">
                    <button 
                      onClick={() => setShowExplorer(!showExplorer)}
                      className="text-[10px] font-mono text-white/40 uppercase tracking-[0.2em] hover:text-emerald-400 transition-colors flex items-center gap-2"
                    >
                      <Folder className="w-3 h-3" />
                      {showExplorer ? "Hide Forensic File Explorer" : "Show Forensic File Explorer"}
                    </button>

                    {showExplorer && jobFiles && (
                      <motion.div 
                        initial={{ opacity: 0, y: 10 }}
                        animate={{ opacity: 1, y: 0 }}
                        className="mt-4 grid grid-cols-1 md:grid-cols-2 gap-4"
                      >
                        {[
                          { title: "Download Source", files: jobFiles.download },
                          { title: "Input Chunks", files: jobFiles.chunks },
                          { title: "Reversed Chunks", files: jobFiles.reversed },
                          { title: "Final Master", files: jobFiles.final }
                        ].map((section, idx) => (
                          <div key={idx} className="bg-black/40 border border-white/5 rounded-lg p-3">
                            <h4 className="text-[9px] font-mono text-white/30 uppercase tracking-widest mb-2 border-b border-white/5 pb-1">
                              {section.title}
                            </h4>
                            <div className="space-y-1 max-h-[120px] overflow-y-auto custom-scrollbar">
                              {section.files.length === 0 ? (
                                <p className="text-[9px] font-mono text-white/10 italic">No files detected</p>
                              ) : (
                                section.files.map((f, fidx) => (
                                  <div key={fidx} className="flex justify-between items-center text-[9px] font-mono">
                                    <span className="text-white/60 truncate max-w-[150px]">{f.name}</span>
                                    <span className="text-white/20">{(f.size / 1024 / 1024).toFixed(2)}MB</span>
                                  </div>
                                ))
                              )}
                            </div>
                          </div>
                        ))}
                      </motion.div>
                    )}
                  </div>

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
