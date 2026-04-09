// PATH: src/App.tsx  v1.5
// Queue: multiple jobs, FIFO, auto-start next on completion
// UX: browser fills left panel, action pinned at bottom, re-reverse from history
// Health: severity-coded indicators

import React, { useState, useEffect, useRef, useCallback, useMemo } from "react";
import {
  Play, Download, AlertCircle, CheckCircle2, Loader2,
  ArrowLeftRight, ChevronRight, Folder, Trash2, PlayCircle,
  RefreshCw, Link2, HardDrive, FlipHorizontal, FlipVertical,
  RotateCcw, Maximize2, Terminal,
} from "lucide-react";
import { motion, AnimatePresence } from "motion/react";

// Log line classifiers for the KEY filter
const isErrorLog   = (l: string) => /error|fail|SPAWN/i.test(l);
const isPhaseLog   = (l: string) => /\[SPLIT\]|\[REVERSE|\[MERGE\]|complete|Splitting|Reversing|Merging|Encoder Check|download|staged|Job paused|Job resumed/i.test(l);
const isKeyLog     = (l: string) => isErrorLog(l) || isPhaseLog(l);

// ── Types ────────────────────────────────────────────────────────────────────
interface Job {
  id: string;
  url: string;
  sourceFile?: string | null;
  status: "pending" | "downloading" | "splitting" | "reversing" | "merging" | "completed" | "failed" | "paused";
  pausedStatus?: string | null;
  progress: number;
  eta?: string | null;
  currentPhase?: string | null;
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

interface HistoryEntry {
  id: string;
  url: string;
  status: string;
  outputFile: string | null;
  created_at: string;
  finished_at: string;
}

interface Transform {
  flipH: boolean;
  flipV: boolean;
  rot180: boolean;
}

const IS_VIDEO = (n: string) => /\.(mp4|webm|mkv|mov|avi|m4v)$/i.test(n);

const STATUS_COLOR: Record<string, string> = {
  completed: "#f59e0b",
  failed:    "#ef4444",
  pending:   "#6b7280",
  default:   "#60a5fa",
};

function statusColor(s: string) {
  return STATUS_COLOR[s] ?? STATUS_COLOR.default;
}

// ── Component ────────────────────────────────────────────────────────────────
export default function App() {
  // core
  const [currentJobId, setCurrentJobId]     = useState<string | null>(null);
  const [job, setJob]                        = useState<Job | null>(null);
  const [selectedFile, setSelectedFile]     = useState<string | null>(null);
  const [playbackError, setPlaybackError]   = useState(false);
  const [isSubmitting, setIsSubmitting]     = useState(false);
  const [isDeleting, setIsDeleting]         = useState(false);
  const [deleteError, setDeleteError]       = useState<string | null>(null);
  const [isPausing, setIsPausing]           = useState(false);
  const [isResuming, setIsResuming]         = useState(false);

  // log filter: "all" shows everything, "key" shows only phase/error/complete lines
  const [logFilter, setLogFilter]           = useState<"all" | "key">("key");

  // history
  const [history, setHistory]               = useState<HistoryEntry[]>([]);
  const [historyOpen, setHistoryOpen]       = useState(false);

  // queue
  const [queue, setQueue]                   = useState<Job[]>([]);
  const [queuedUrl, setQueuedUrl]           = useState(""); // URL staged for queuing

  // dismiss completion banner after user acknowledges
  const [completionDismissed, setCompletionDismissed] = useState(false);

  // input
  // system
  const [health, setHealth]                 = useState<{ load: number; psi: number; disk: { available: number } } | null>(null);
  const [hasUpdate, setHasUpdate]           = useState(false);

  // browser
  const [browserData, setBrowserData]       = useState<BrowseData | null>(null);
  const [browserPath, setBrowserPath]       = useState<string | null>(null);
  const [browserLoading, setBrowserLoading] = useState(false);

  // player transform (CSS only — zero cost)
  const [xform, setXform]                   = useState<Transform>({ flipH: false, flipV: false, rot180: false });

  // logs panel toggle
  const [logsOpen, setLogsOpen]             = useState(true);

  const logEndRef   = useRef<HTMLDivElement>(null);
  const cacheBust   = useRef(Date.now());
  const prevSrcKey  = useRef("");

  // ── Stable player src ────────────────────────────────────────────────────
  const playerSrc = useMemo(() => {
    const key = selectedFile || job?.outputFile || "";
    if (key !== prevSrcKey.current) {
      cacheBust.current = Date.now();
      prevSrcKey.current = key;
    }
    if (!key) return null;
    if (key.startsWith("http")) return key;
    return `/api/media?path=${encodeURIComponent(key)}&t=${cacheBust.current}`;
  }, [selectedFile, job?.outputFile]);

  const playerFilename = (selectedFile || job?.outputFile || "").split("/").pop() || null;

  // CSS transform string from state
  const cssTransform = useMemo(() => {
    const parts: string[] = [];
    if (xform.rot180) parts.push("rotate(180deg)");
    if (xform.flipH)  parts.push("scaleX(-1)");
    if (xform.flipV)  parts.push("scaleY(-1)");
    return parts.join(" ") || "none";
  }, [xform]);

  // ── Browse ───────────────────────────────────────────────────────────────
  const browseTo = useCallback(async (p: string) => {
    setBrowserLoading(true);
    try {
      const r = await fetch(`/api/browse?path=${encodeURIComponent(p)}`);
      if (r.ok) { const d = await r.json(); setBrowserData(d); setBrowserPath(d.path); }
    } catch {}
    finally { setBrowserLoading(false); }
  }, []);

  // ── Init ─────────────────────────────────────────────────────────────────
  useEffect(() => {
    fetch("/api/jobs/active").then(r => r.ok ? r.json() : null)
      .then(d => { if (d) { setCurrentJobId(d.id); setJob(d); } }).catch(() => {});
    browseTo("/home/owner/Documents");
  }, []);

  // ── Polls ────────────────────────────────────────────────────────────────
  useEffect(() => {
    const t = setInterval(() =>
      fetch("/api/system/health").then(r => r.ok ? r.json() : null)
        .then(d => d && setHealth(d)).catch(() => {}), 5000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    const check = () => fetch("/api/system/update-check")
      .then(r => r.ok ? r.json() : null).then(d => d && setHasUpdate(d.hasUpdate)).catch(() => {});
    check();
    const t = setInterval(check, 60000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    if (!currentJobId || job?.status === "completed" || job?.status === "failed") return;
    const t = setInterval(async () => {
      try {
        const r = await fetch(`/api/jobs/${currentJobId}`);
        if (r.ok) setJob(await r.json());
        else if (r.status === 404) { setJob(null); setCurrentJobId(null); }
      } catch {}
    }, 2000);
    return () => clearInterval(t);
  }, [currentJobId, job?.status]);

  useEffect(() => { logEndRef.current?.scrollIntoView({ behavior: "smooth" }); }, [job?.logs]);

  useEffect(() => {
    if (job?.status === "completed" && job.outputFile && !selectedFile) setSelectedFile(job.outputFile);
    if (job?.status === "completed" && job.id)
      browseTo(`/home/owner/Documents/47911b4f-b8b8-4453-90c9-360918fbf53a/Pro-Video-Reverser/jobs/${job.id}`);
  }, [job?.status]);

  useEffect(() => { setPlaybackError(false); }, [selectedFile, job?.outputFile]);

  // ── Actions ──────────────────────────────────────────────────────────────
  const startJob = async (opts: { url?: string; sourceFile?: string }) => {
    setIsSubmitting(true);
    try {
      const r = await fetch("/api/jobs", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(opts),
      });
      if (r.ok) {
        const { jobId } = await r.json();
        setCurrentJobId(jobId); setSelectedFile(null);
        setCompletionDismissed(false);
        setJob({ id: jobId, url: opts.url || opts.sourceFile || "",
          sourceFile: opts.sourceFile || null, status: "pending", progress: 0,
          logs: [opts.sourceFile ? `Queued: ${opts.sourceFile}` : "Initializing..."] });
      }
    } catch {} finally { setIsSubmitting(false); }
  };

  const deleteJob = async () => {
    if (!job || isDeleting) return;
    setIsDeleting(true); setDeleteError(null);
    try {
      const r = await fetch(`/api/jobs/${job.id}`, { method: "DELETE" });
      if (r.ok || r.status === 404) {
        setJob(null); setCurrentJobId(null); setSelectedFile(null); setPlaybackError(false);
      } else {
        const d = await r.json().catch(() => ({ error: `Status ${r.status}` }));
        setDeleteError(d.error);
      }
    } catch (e: any) { setDeleteError(e.message); } finally { setIsDeleting(false); }
  };

  const pauseJob = async () => {
    if (!job || isPausing) return;
    setIsPausing(true);
    try {
      await fetch(`/api/jobs/${job.id}/pause`, { method: "POST" });
      setJob(j => j ? { ...j, status: "paused", currentPhase: "Paused", eta: null } : j);
    } catch (e: any) { console.error("Pause error", e); }
    finally { setIsPausing(false); }
  };

  const resumeJob = async () => {
    if (!job || isResuming) return;
    setIsResuming(true);
    try {
      await fetch(`/api/jobs/${job.id}/resume`, { method: "POST" });
      // Status will update via the 2-second poll
    } catch (e: any) { console.error("Resume error", e); }
    finally { setIsResuming(false); }
  };

  // Poll queue every 3s
  useEffect(() => {
    const poll = () => fetch("/api/queue")
      .then(r => r.ok ? r.json() : null)
      .then(d => d && setQueue(d.queued || []))
      .catch(() => {});
    poll();
    const t = setInterval(poll, 3000);
    return () => clearInterval(t);
  }, []);

  const reverseHistoryEntry = (h: HistoryEntry) => {
    if (h.outputFile && h.outputFile.includes("/download/")) {
      const sourceDir = h.outputFile.replace("/reversed_final.mp4", "/download/input.mp4");
      startJob({ sourceFile: sourceDir });
    } else {
      startJob({ url: h.url });
    }
  };

  const fetchHistory = async () => {
    try {
      const r = await fetch("/api/jobs/history");
      if (r.ok) setHistory(await r.json());
    } catch {}
  };

  const toggleXform = (key: keyof Transform) =>
    setXform(p => ({ ...p, [key]: !p[key] }));

  const resetXform = () => setXform({ flipH: false, flipV: false, rot180: false });

  // Fetch history when panel opens
  useEffect(() => { if (historyOpen) fetchHistory(); }, [historyOpen]);

  const jobActive = job && job.status !== "completed" && job.status !== "failed" && job.status !== "paused";
  const jobPaused = job?.status === "paused";
  const canReverse = selectedFile && !selectedFile.startsWith("http") && !jobActive && !isSubmitting;

  // ── Render ───────────────────────────────────────────────────────────────
  return (
    <>
      {/* Google Fonts — IBM Plex Mono + Syne */}
      <style dangerouslySetInnerHTML={{ __html: `
        @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:ital,wght@0,300;0,400;0,500;0,600;1,400&family=Syne:wght@400;500;600;700;800&display=swap');

        *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

        :root {
          --bg:        #0c0c0d;
          --surface:   #111114;
          --surface2:  #16161a;
          --border:    rgba(255,255,255,0.06);
          --border2:   rgba(255,255,255,0.10);
          --amber:     #f59e0b;
          --amber-dim: rgba(245,158,11,0.15);
          --red:       #ef4444;
          --blue:      #60a5fa;
          --text:      rgba(255,255,255,0.85);
          --text-mid:  rgba(255,255,255,0.45);
          --text-dim:  rgba(255,255,255,0.18);
          --mono:      'IBM Plex Mono', monospace;
          --sans:      'Syne', sans-serif;
          --radius:    6px;
          --panel:     1px solid var(--border);
        }

        html, body, #root { height: 100%; overflow: hidden; background: var(--bg); color: var(--text); }

        /* scrollbars */
        ::-webkit-scrollbar { width: 3px; height: 3px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.08); border-radius: 10px; }

        /* workstation grid */
        .workstation {
          display: grid;
          grid-template-rows: 36px 1fr;
          grid-template-columns: 280px 1fr 320px;
          height: 100vh;
          overflow: hidden;
        }

        /* topbar spans full width */
        .topbar {
          grid-column: 1 / -1;
          display: flex;
          align-items: center;
          gap: 16px;
          padding: 0 16px;
          border-bottom: var(--panel);
          background: rgba(12,12,13,0.9);
          backdrop-filter: blur(12px);
          position: relative;
          z-index: 10;
        }

        .panel {
          overflow: hidden;
          display: flex;
          flex-direction: column;
          border-right: var(--panel);
        }
        .panel-center { border-right: none; background: #0a0a0b; }
        .panel-right  { border-left: var(--panel); border-right: none; }

        .panel-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 0 12px;
          height: 32px;
          border-bottom: var(--panel);
          flex-shrink: 0;
          background: var(--surface);
        }

        .panel-label {
          font-family: var(--mono);
          font-size: 9px;
          letter-spacing: 0.12em;
          text-transform: uppercase;
          color: var(--text-dim);
          display: flex;
          align-items: center;
          gap: 6px;
        }

        .panel-scroll {
          overflow-y: auto;
          flex: 1;
          min-height: 0;
        }

        /* breadcrumb */
        .breadcrumb {
          display: flex;
          align-items: center;
          gap: 2px;
          padding: 6px 12px;
          border-bottom: var(--panel);
          overflow-x: auto;
          flex-shrink: 0;
          background: var(--surface);
        }

        .bc-seg {
          font-family: var(--mono);
          font-size: 9px;
          color: var(--text-dim);
          padding: 2px 4px;
          border-radius: 3px;
          white-space: nowrap;
          background: none;
          border: none;
          cursor: pointer;
          transition: color 0.15s;
        }
        .bc-seg:hover { color: var(--amber); }
        .bc-seg.active { color: var(--amber); cursor: default; }
        .bc-sep { font-family: var(--mono); font-size: 9px; color: var(--text-dim); opacity: 0.3; }

        /* file browser rows */
        .fb-row {
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 7px 12px;
          border-bottom: 1px solid rgba(255,255,255,0.02);
          cursor: pointer;
          transition: background 0.1s;
        }
        .fb-row:hover { background: rgba(255,255,255,0.03); }
        .fb-row.active {
          background: var(--amber-dim);
          border-left: 2px solid var(--amber);
          padding-left: 10px;
        }
        .fb-name {
          font-family: var(--mono);
          font-size: 10px;
          color: var(--text-mid);
          flex: 1;
          min-width: 0;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          transition: color 0.15s;
        }
        .fb-name.video:hover { color: var(--text); }
        .fb-name.active { color: var(--amber); }
        .fb-name.dim { color: var(--text-dim); cursor: default; }
        .fb-size {
          font-family: var(--mono);
          font-size: 8px;
          color: var(--text-dim);
          width: 46px;
          text-align: right;
          flex-shrink: 0;
        }

        /* stage / player */
        .stage {
          display: flex;
          flex-direction: column;
          height: 100%;
          background: #070708;
        }
        .stage-screen {
          flex: 1;
          min-height: 0;
          display: flex;
          align-items: center;
          justify-content: center;
          background: #000;
          position: relative;
          overflow: hidden;
        }
        .stage-screen video {
          width: 100%;
          height: 100%;
          object-fit: contain;
          transition: transform 0.2s cubic-bezier(0.4,0,0.2,1);
        }
        .stage-controls {
          flex-shrink: 0;
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 8px 12px;
          border-top: var(--panel);
          background: var(--surface);
          flex-wrap: wrap;
        }

        /* transform toggle buttons */
        .xbtn {
          display: flex;
          align-items: center;
          gap: 4px;
          padding: 4px 8px;
          background: rgba(255,255,255,0.04);
          border: 1px solid var(--border2);
          border-radius: var(--radius);
          font-family: var(--mono);
          font-size: 9px;
          color: var(--text-mid);
          cursor: pointer;
          transition: all 0.15s;
          white-space: nowrap;
        }
        .xbtn:hover { border-color: rgba(255,255,255,0.2); color: var(--text); }
        .xbtn.on {
          background: var(--amber-dim);
          border-color: var(--amber);
          color: var(--amber);
        }
        .xbtn-sep { width: 1px; height: 18px; background: var(--border); margin: 0 2px; flex-shrink: 0; }

        /* reverse action button */
        .reverse-btn {
          display: flex;
          align-items: center;
          gap: 6px;
          padding: 5px 14px;
          background: var(--amber);
          border: none;
          border-radius: var(--radius);
          font-family: var(--mono);
          font-size: 9px;
          font-weight: 600;
          letter-spacing: 0.08em;
          text-transform: uppercase;
          color: #000;
          cursor: pointer;
          transition: all 0.15s;
          white-space: nowrap;
        }
        .reverse-btn:hover:not(:disabled) { background: #fbbf24; }
        .reverse-btn:disabled {
          background: rgba(255,255,255,0.06);
          color: var(--text-dim);
          cursor: not-allowed;
        }

        /* right panel sections */
        .rp-section {
          border-bottom: var(--panel);
          flex-shrink: 0;
        }
        .rp-section-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 8px 12px;
          cursor: pointer;
          user-select: none;
        }
        .rp-section-header:hover { background: rgba(255,255,255,0.02); }

        /* progress bar */
        .progress-track {
          height: 2px;
          background: rgba(255,255,255,0.06);
          border-radius: 2px;
          overflow: hidden;
          margin: 0 12px 10px;
        }
        .progress-fill {
          height: 100%;
          border-radius: 2px;
          transition: width 0.6s ease;
        }

        /* chunk dots */
        .chunk-dot {
          width: 10px;
          height: 10px;
          border-radius: 2px;
          cursor: pointer;
          transition: all 0.3s;
          flex-shrink: 0;
        }

        /* log lines */
        .log-line {
          display: flex;
          gap: 8px;
          padding: 2px 12px;
          font-family: var(--mono);
          font-size: 9px;
          line-height: 1.6;
          color: var(--text-dim);
          transition: color 0.1s;
          border-left: 2px solid transparent;
        }
        .log-line:hover { color: var(--text-mid); }
        .log-line .ln { color: rgba(255,255,255,0.1); width: 24px; text-align: right; flex-shrink: 0; user-select: none; }

        /* input */
        .url-input {
          width: 100%;
          background: rgba(255,255,255,0.03);
          border: 1px solid var(--border2);
          border-radius: var(--radius);
          padding: 8px 10px;
          font-family: var(--mono);
          font-size: 10px;
          color: var(--text);
          outline: none;
          transition: border-color 0.15s;
        }
        .url-input:focus { border-color: rgba(245,158,11,0.4); }
        .url-input::placeholder { color: var(--text-dim); }

        /* tab strip */
        .tab-strip { display: flex; border-bottom: var(--panel); flex-shrink: 0; }
        .tab {
          flex: 1; padding: 8px 0;
          font-family: var(--mono); font-size: 9px;
          letter-spacing: 0.1em; text-transform: uppercase;
          color: var(--text-dim);
          background: none; border: none; border-bottom: 2px solid transparent;
          cursor: pointer; transition: all 0.15s;
          display: flex; align-items: center; justify-content: center; gap: 5px;
        }
        .tab:hover { color: var(--text-mid); }
        .tab.active { color: var(--amber); border-bottom-color: var(--amber); }

        /* icon buttons */
        .icon-btn {
          display: flex; align-items: center; justify-content: center;
          width: 22px; height: 22px;
          background: none; border: none;
          color: var(--text-dim); cursor: pointer;
          border-radius: 4px; transition: all 0.15s;
        }
        .icon-btn:hover { color: var(--text); background: rgba(255,255,255,0.06); }

        /* empty state */
        .empty {
          display: flex; flex-direction: column; align-items: center; justify-content: center;
          height: 100%; gap: 10px; color: var(--text-dim);
          font-family: var(--mono); font-size: 10px; letter-spacing: 0.1em;
          text-transform: uppercase; text-align: center;
          pointer-events: none; user-select: none;
        }

        /* status dot */
        .status-dot {
          width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0;
        }
        .pulse { animation: pulse 2s infinite; }
        @keyframes pulse { 0%,100% { opacity:1; } 50% { opacity:0.4; } }

        /* delete btn */
        .del-btn {
          display: flex; align-items: center; gap: 4px;
          padding: 3px 8px;
          background: rgba(239,68,68,0.08);
          border: 1px solid rgba(239,68,68,0.2);
          border-radius: var(--radius);
          font-family: var(--mono); font-size: 9px;
          color: #ef4444; cursor: pointer;
          transition: all 0.15s; white-space: nowrap;
        }
        .del-btn:hover:not(:disabled) { background: rgba(239,68,68,0.2); border-color: rgba(239,68,68,0.4); }
        .del-btn:disabled { opacity: 0.4; cursor: not-allowed; }

        /* pinned action bar at bottom of left panel */
        .action-bar {
          flex-shrink: 0;
          border-top: var(--panel);
          padding: 10px 12px;
          background: var(--surface);
          display: flex;
          flex-direction: column;
          gap: 6px;
        }

        /* queue badge */
        .queue-badge {
          display: inline-flex;
          align-items: center;
          gap: 4px;
          padding: 2px 6px;
          background: rgba(96,165,250,0.12);
          border: 1px solid rgba(96,165,250,0.25);
          border-radius: 10px;
          font-family: var(--mono);
          font-size: 8px;
          color: var(--blue);
          white-space: nowrap;
        }

        /* queued job pill in right panel */
        .queue-item {
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 6px 12px;
          border-bottom: 1px solid rgba(255,255,255,0.02);
          font-family: var(--mono);
          font-size: 9px;
          color: var(--text-dim);
        }
        .queue-pos {
          width: 16px;
          height: 16px;
          border-radius: 50%;
          background: rgba(96,165,250,0.15);
          border: 1px solid rgba(96,165,250,0.3);
          display: flex;
          align-items: center;
          justify-content: center;
          font-size: 8px;
          color: var(--blue);
          flex-shrink: 0;
        }
        .pause-btn {
          display: flex; align-items: center; gap: 4px;
          padding: 3px 8px;
          background: rgba(245,158,11,0.08);
          border: 1px solid rgba(245,158,11,0.2);
          border-radius: var(--radius);
          font-family: var(--mono); font-size: 9px;
          color: var(--amber); cursor: pointer;
          transition: all 0.15s; white-space: nowrap;
        }
        .pause-btn:hover:not(:disabled) { background: rgba(245,158,11,0.18); }
        .pause-btn:disabled { opacity: 0.4; cursor: not-allowed; }

        /* log filter toggle */
        .log-filter {
          display: flex; gap: 0;
          border: 1px solid var(--border2);
          border-radius: var(--radius);
          overflow: hidden;
        }
        .log-filter-opt {
          padding: 2px 7px;
          font-family: var(--mono); font-size: 8px;
          background: none; border: none; cursor: pointer;
          color: var(--text-dim); transition: all 0.12s;
          letter-spacing: 0.08em; text-transform: uppercase;
        }
        .log-filter-opt.active { background: var(--amber-dim); color: var(--amber); }
        .log-filter-opt:hover:not(.active) { color: var(--text-mid); }

        /* completion banner */
        .completion-banner {
          margin: 10px 12px;
          padding: 12px;
          background: rgba(245,158,11,0.08);
          border: 1px solid rgba(245,158,11,0.25);
          border-radius: var(--radius);
        }

        /* download button */
        .download-btn {
          display: flex; align-items: center; gap: 6px;
          width: 100%; padding: 8px 12px;
          background: var(--amber); border: none;
          border-radius: var(--radius);
          font-family: var(--mono); font-size: 10px; font-weight: 600;
          letter-spacing: 0.06em; text-transform: uppercase;
          color: #000; cursor: pointer;
          transition: all 0.15s; justify-content: center;
          text-decoration: none;
        }
        .download-btn:hover { background: #fbbf24; }

        /* history row */
        .hist-row {
          display: flex; align-items: center; gap: 8px;
          padding: 6px 12px;
          border-bottom: 1px solid rgba(255,255,255,0.02);
          cursor: pointer; transition: background 0.1s;
        }
        .hist-row:hover { background: rgba(255,255,255,0.02); }
        .hist-dot {
          width: 5px; height: 5px; border-radius: 50%; flex-shrink: 0;
        }

        /* paused state shimmer on progress bar */
        @keyframes paused-shimmer {
          0%,100% { opacity: 1; } 50% { opacity: 0.5; }
        }
        .progress-fill.paused { animation: paused-shimmer 2s ease infinite; }
          padding: 2px 8px;
          background: var(--amber-dim);
          border: 1px solid rgba(245,158,11,0.3);
          border-radius: 12px;
          font-family: var(--mono); font-size: 8px;
          color: var(--amber); cursor: pointer;
          transition: all 0.15s;
        }
        .update-pill:hover { background: rgba(245,158,11,0.25); }
      `}} />

      <div className="workstation">

        {/* ── Topbar ── */}
        <div className="topbar">
          {/* Logo */}
          <div style={{ display:"flex", alignItems:"center", gap:8, marginRight:8 }}>
            <div style={{
              width:22, height:22, background:"var(--amber)", borderRadius:4,
              display:"flex", alignItems:"center", justifyContent:"center", flexShrink:0,
            }}>
              <ArrowLeftRight size={12} color="#000" />
            </div>
            <span style={{ fontFamily:"var(--sans)", fontSize:12, fontWeight:700, letterSpacing:"0.05em", textTransform:"uppercase" }}>
              Pro Reverser
            </span>
            <span style={{ fontFamily:"var(--mono)", fontSize:8, color:"var(--text-dim)", letterSpacing:"0.15em" }}>v1.4</span>
          </div>

          {/* divider */}
          <div style={{ width:1, height:16, background:"var(--border)", flexShrink:0 }} />

          {/* Health */}
          {health && (
            <>
              <span style={{ fontFamily:"var(--mono)", fontSize:9, letterSpacing:"0.1em",
                color: health.load < 2 ? "var(--text-dim)" : health.load < 4 ? "var(--amber)" : "#ef4444" }}>
                LOAD {health.load.toFixed(1)}
              </span>
              <span style={{ fontFamily:"var(--mono)", fontSize:9, letterSpacing:"0.1em",
                color: health.psi < 5 ? "var(--text-dim)" : health.psi < 20 ? "var(--amber)" : "#ef4444" }}>
                PSI {health.psi.toFixed(0)}%
              </span>
              <span style={{ fontFamily:"var(--mono)", fontSize:9, letterSpacing:"0.1em",
                color: health.disk.available > 2048 ? "var(--text-dim)" : health.disk.available > 512 ? "var(--amber)" : "#ef4444" }}>
                {(health.disk.available / 1024).toFixed(0)}GB FREE
              </span>
            </>
          )}

          <div style={{ flex:1 }} />

          {hasUpdate && (
            <button className="update-pill"
              onClick={() => fetch("/api/system/update-apply", { method:"POST" }).then(() => window.location.reload())}>
              Update available ↑
            </button>
          )}
        </div>

        {/* ── LEFT PANEL: File Browser + Action ── */}
        <div className="panel" style={{ display:"flex", flexDirection:"column" }}>
          {/* Panel header */}
          <div className="panel-header">
            <span className="panel-label"><HardDrive size={10} /> Files</span>
            {queue.length > 0 && (
              <span className="queue-badge">{queue.length} queued</span>
            )}
          </div>

          {/* Breadcrumb */}
          {browserData && (
            <div className="breadcrumb">
              {browserData.parent && (
                <button className="bc-seg" onClick={() => browseTo(browserData.parent!)}>↑</button>
              )}
              {browserData.path.split("/").filter(Boolean).map((seg, i, arr) => {
                const p = "/" + arr.slice(0, i + 1).join("/");
                const last = i === arr.length - 1;
                return (
                  <React.Fragment key={p}>
                    {i > 0 && <span className="bc-sep">/</span>}
                    <button className={`bc-seg ${last ? "active" : ""}`} onClick={() => !last && browseTo(p)}>
                      {seg.length > 14 ? seg.slice(0, 12) + "…" : seg}
                    </button>
                  </React.Fragment>
                );
              })}
              <div style={{ flex:1 }} />
              <button className="icon-btn" onClick={() => browserPath && browseTo(browserPath)} title="Refresh">
                <RefreshCw size={10} className={browserLoading ? "animate-spin" : ""} />
              </button>
            </div>
          )}

          {/* File list — fills remaining space */}
          <div className="panel-scroll">
            {browserLoading ? (
              <div className="empty" style={{ height:120 }}><Loader2 size={16} className="animate-spin" />Loading…</div>
            ) : browserData ? (
              <>
                {browserData.dirs.map(dir => (
                  <div key={dir.path} className="fb-row" onClick={() => browseTo(dir.path)}>
                    <Folder size={11} color="rgba(245,158,11,0.5)" style={{ flexShrink:0 }} />
                    <span className="fb-name" style={{ color:"var(--text-mid)" }}>{dir.name}</span>
                    <ChevronRight size={9} color="var(--text-dim)" style={{ flexShrink:0 }} />
                  </div>
                ))}
                {browserData.dirs.length > 0 && browserData.files.length > 0 && (
                  <div style={{ height:1, background:"var(--border)", margin:"2px 0" }} />
                )}
                {browserData.files.map(f => {
                  const isVid = IS_VIDEO(f.name);
                  const isAct = selectedFile === f.path;
                  const mb = (f.size / 1024 / 1024).toFixed(1);
                  return (
                    <div key={f.path} className={`fb-row ${isAct ? "active" : ""}`}
                      onClick={() => isVid && setSelectedFile(f.path)}>
                      {isVid
                        ? <PlayCircle size={11} color={isAct ? "var(--amber)" : "rgba(255,255,255,0.2)"} style={{ flexShrink:0 }} />
                        : <span style={{ width:11, flexShrink:0 }} />
                      }
                      <span className={`fb-name ${isVid ? "video" : "dim"} ${isAct ? "active" : ""}`} title={f.name}>
                        {f.name}
                      </span>
                      <span className="fb-size">{mb}MB</span>
                      <a href={`/api/media?path=${encodeURIComponent(f.path)}`} download={f.name}
                        onClick={e => e.stopPropagation()}
                        style={{ flexShrink:0, color:"var(--text-dim)", display:"flex" }}
                        title="Download">
                        <Download size={10} />
                      </a>
                    </div>
                  );
                })}
                {browserData.dirs.length === 0 && browserData.files.length === 0 && (
                  <div className="empty" style={{ height:80, fontSize:9 }}>Empty directory</div>
                )}
              </>
            ) : (
              <div className="empty" style={{ height:80, fontSize:9 }}>Initializing…</div>
            )}
          </div>

          {/* ── Pinned action bar — always visible ── */}
          <div className="action-bar">
            {/* Primary: Reverse loaded file */}
            <button className="reverse-btn" style={{ width:"100%", justifyContent:"center" }}
              disabled={!canReverse}
              onClick={() => selectedFile && startJob({ sourceFile: selectedFile })}>
              {isSubmitting
                ? <><Loader2 size={11} className="animate-spin" /> Starting…</>
                : <><ArrowLeftRight size={11} /> Reverse This Clip</>
              }
            </button>

            {/* Secondary: YouTube URL input inline */}
            <div style={{ display:"flex", gap:5 }}>
              <input
                className="url-input"
                style={{ flex:1, fontSize:9, padding:"5px 8px" }}
                type="text"
                value={queuedUrl}
                onChange={e => setQueuedUrl(e.target.value)}
                placeholder="youtube.com/watch?v=…"
                onKeyDown={e => e.key === "Enter" && queuedUrl && startJob({ url: queuedUrl }).then(() => setQueuedUrl(""))}
              />
              <button
                className="reverse-btn"
                style={{ padding:"5px 10px", flexShrink:0 }}
                disabled={!queuedUrl || isSubmitting}
                onClick={() => startJob({ url: queuedUrl }).then(() => setQueuedUrl(""))}>
                <Play size={9} />
              </button>
            </div>

            {/* Queue status hint */}
            {queue.length > 0 && (
              <div style={{ fontFamily:"var(--mono)", fontSize:8, color:"var(--blue)", textAlign:"center" }}>
                {queue.length} job{queue.length > 1 ? "s" : ""} queued — will run automatically
              </div>
            )}
            {!canReverse && !playerSrc && (
              <div style={{ fontFamily:"var(--mono)", fontSize:8, color:"var(--text-dim)", textAlign:"center" }}>
                Click ▶ on a file above to load it
              </div>
            )}
          </div>
        </div>

        {/* ── CENTER PANEL: Stage ── */}
        <div className="panel panel-center">
          <div className="stage">
            {/* Player screen */}
            <div className="stage-screen">
              {playerSrc ? (
                <>
                  <video
                    key={playerSrc}
                    controls playsInline autoPlay preload="auto"
                    style={{ transform: cssTransform }}
                    onCanPlay={() => setPlaybackError(false)}
                    onError={() => setPlaybackError(true)}
                  >
                    <source src={playerSrc} type="video/mp4" />
                  </video>
                  {playbackError && (
                    <div style={{
                      position:"absolute", inset:0, background:"rgba(0,0,0,0.95)",
                      display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", gap:8
                    }}>
                      <AlertCircle size={24} color="#ef4444" />
                      <span style={{ fontFamily:"var(--mono)", fontSize:10, color:"var(--text-mid)" }}>
                        Playback failed — incompatible format
                      </span>
                      <span style={{ fontFamily:"var(--mono)", fontSize:9, color:"#ef4444" }}>
                        Delete &amp; re-run
                      </span>
                    </div>
                  )}
                </>
              ) : (
                <div className="empty">
                  <ArrowLeftRight size={24} color="rgba(245,158,11,0.15)" />
                  <span style={{ fontSize:9 }}>Browse a file — click ▶ to load</span>
                  <span style={{ fontSize:8, color:"var(--text-dim)" }}>or paste a YouTube URL in the Files panel</span>
                </div>
              )}
            </div>

            {/* Controls toolbar */}
            <div className="stage-controls">
              {/* Filename */}
              {playerFilename && (
                <span style={{
                  fontFamily:"var(--mono)", fontSize:9, color:"var(--amber)", opacity:0.7,
                  maxWidth:200, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap",
                  marginRight:4,
                }} title={playerFilename}>{playerFilename}</span>
              )}

              {/* Transform controls */}
              <button className={`xbtn ${xform.flipH ? "on" : ""}`} onClick={() => toggleXform("flipH")} title="Flip horizontal">
                <FlipHorizontal size={10} /> H
              </button>
              <button className={`xbtn ${xform.flipV ? "on" : ""}`} onClick={() => toggleXform("flipV")} title="Flip vertical">
                <FlipVertical size={10} /> V
              </button>
              <button className={`xbtn ${xform.rot180 ? "on" : ""}`} onClick={() => toggleXform("rot180")} title="Rotate 180°">
                <RotateCcw size={10} /> 180°
              </button>
              {(xform.flipH || xform.flipV || xform.rot180) && (
                <button className="xbtn" onClick={resetXform} title="Reset transform">✕ Reset</button>
              )}

              <div className="xbtn-sep" />

              {/* Reverse action */}
              <button className="reverse-btn"
                disabled={!canReverse}
                onClick={() => selectedFile && startJob({ sourceFile: selectedFile })}>
                {isSubmitting
                  ? <><Loader2 size={11} className="animate-spin" /> Starting…</>
                  : <><ArrowLeftRight size={11} /> Reverse This Clip</>
                }
              </button>

              {!playerSrc && (
                <span style={{ fontFamily:"var(--mono)", fontSize:9, color:"var(--text-dim)" }}>
                  Load a file to reverse it
                </span>
              )}
              {playerSrc && selectedFile?.startsWith("http") && (
                <span style={{ fontFamily:"var(--mono)", fontSize:9, color:"var(--text-dim)" }}>
                  Remote URL — use YouTube tab
                </span>
              )}
              {jobActive && (
                <span style={{ fontFamily:"var(--mono)", fontSize:9, color:"var(--amber)", opacity:0.7 }}>
                  Job in progress…
                </span>
              )}

              <div style={{ flex:1 }} />

              {/* Copy URL */}
              {playerSrc && (
                <button className="icon-btn"
                  onClick={() => { const p = selectedFile || job?.outputFile; if (p) navigator.clipboard.writeText(`${location.origin}/api/media?path=${encodeURIComponent(p)}`); }}
                  title="Copy media URL">
                  <Maximize2 size={11} />
                </button>
              )}
            </div>
          </div>
        </div>

        {/* ── RIGHT PANEL: Pipeline ── */}
        <div className="panel panel-right">
          <div className="panel-header">
            <span className="panel-label"><Terminal size={10} /> Pipeline</span>
            {job && (
              <span style={{ fontFamily:"var(--mono)", fontSize:8, color:"var(--text-dim)" }}>
                {job.id.slice(0,8)}…
              </span>
            )}
          </div>

          <div className="panel-scroll">
            <AnimatePresence mode="wait">
              {job ? (
                <motion.div key="job" initial={{ opacity:0, y:6 }} animate={{ opacity:1, y:0 }} exit={{ opacity:0 }}>

                  {/* ── Completion banner ── */}
                  {job.status === "completed" && job.outputFile && !completionDismissed && (
                    <div className="completion-banner">
                      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:8 }}>
                        <div style={{ display:"flex", alignItems:"center", gap:6 }}>
                          <CheckCircle2 size={12} color="var(--amber)" />
                          <span style={{ fontFamily:"var(--mono)", fontSize:9, color:"var(--amber)", fontWeight:600, letterSpacing:"0.1em", textTransform:"uppercase" }}>
                            Ready
                          </span>
                        </div>
                        <button onClick={() => setCompletionDismissed(true)}
                          style={{ background:"none", border:"none", color:"var(--text-dim)", cursor:"pointer", fontSize:12, lineHeight:1 }}>✕</button>
                      </div>
                      <p style={{ fontFamily:"var(--mono)", fontSize:8, color:"var(--text-mid)", marginBottom:10, lineHeight:1.7 }}>
                        {job.outputFile.split("/").pop()}<br/>
                        <span style={{ color:"var(--text-dim)" }}>
                          {job.outputFile.split("/").slice(-3, -1).join("/")}
                        </span>
                      </p>
                      <a className="download-btn"
                        href={`/api/media?path=${encodeURIComponent(job.outputFile)}`}
                        download={job.outputFile.split("/").pop()}>
                        <Download size={11} /> Download Reversed File
                      </a>
                      <button
                        onClick={() => setSelectedFile(job.outputFile!)}
                        style={{
                          display:"flex", alignItems:"center", gap:6, width:"100%",
                          marginTop:6, padding:"6px 12px",
                          background:"rgba(255,255,255,0.04)", border:"1px solid var(--border2)",
                          borderRadius:"var(--radius)", fontFamily:"var(--mono)", fontSize:9,
                          color:"var(--text-mid)", cursor:"pointer", justifyContent:"center",
                          transition:"all 0.15s",
                        }}>
                        <Play size={9} /> Preview in Player
                      </button>
                    </div>
                  )}

                  {/* ── Status + progress ── */}
                  <div style={{ padding:"10px 12px 0", borderBottom: job.status === "completed" && !completionDismissed ? "none" : "var(--panel)" }}>
                    {/* Status row */}
                    <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:8 }}>
                      <div className={`status-dot ${(jobActive || jobPaused) ? "pulse" : ""}`}
                        style={{ background: statusColor(job.status) }} />
                      <span style={{
                        fontFamily:"var(--mono)", fontSize:10, fontWeight:500, letterSpacing:"0.08em",
                        textTransform:"uppercase", color: statusColor(job.status), flex:1,
                      }}>
                        {job.status}
                      </span>
                      <span style={{ fontFamily:"var(--mono)", fontSize:18, fontWeight:600, color:"var(--text)", letterSpacing:"-0.02em" }}>
                        {Math.round(job.progress)}%
                      </span>
                    </div>

                    {/* Phase + ETA */}
                    {(job.currentPhase || job.eta) && (
                      <div style={{ display:"flex", justifyContent:"space-between", marginBottom:8 }}>
                        {job.currentPhase && (
                          <span style={{ fontFamily:"var(--mono)", fontSize:8, color:"var(--blue)", flex:1, minWidth:0, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>
                            {job.currentPhase}
                          </span>
                        )}
                        {job.eta && (
                          <span style={{ fontFamily:"var(--mono)", fontSize:8, color:"var(--text-dim)", flexShrink:0, marginLeft:8 }}>
                            {job.eta}
                          </span>
                        )}
                      </div>
                    )}

                    {/* Progress bar */}
                    <div className="progress-track" style={{ marginBottom:10 }}>
                      <motion.div
                        className={`progress-fill ${job.status === "paused" ? "paused" : ""}`}
                        initial={{ width:0 }}
                        animate={{ width:`${job.progress}%` }}
                        transition={{ duration:0.5 }}
                        style={{ background: job.status === "failed" ? "var(--red)" : "var(--amber)" }}
                      />
                    </div>
                  </div>

                  {/* ── Chunk map ── */}
                  {job.chunks && job.chunks.total > 0 && (
                    <div style={{ padding:"8px 12px", borderBottom:"var(--panel)" }}>
                      <div style={{ display:"flex", justifyContent:"space-between", marginBottom:6, alignItems:"center" }}>
                        <span style={{ fontFamily:"var(--mono)", fontSize:8, color:"var(--text-dim)", letterSpacing:"0.1em", textTransform:"uppercase" }}>
                          Chunks
                        </span>
                        <div style={{ display:"flex", alignItems:"center", gap:8 }}>
                          <span style={{ fontFamily:"var(--mono)", fontSize:8, color:"var(--text-dim)" }}>
                            {job.chunks.completed.length}/{job.chunks.total}
                          </span>
                          {job.chunks.completed.length > 0 && job.chunks.completed.length < job.chunks.total && (
                            <button
                              onClick={() => browseTo(`/home/owner/Documents/47911b4f-b8b8-4453-90c9-360918fbf53a/Pro-Video-Reverser/jobs/${job.id}/reversed`)}
                              style={{ fontFamily:"var(--mono)", fontSize:7, color:"var(--amber)", background:"none", border:"none", cursor:"pointer", textDecoration:"underline", opacity:0.7 }}>
                              preview done chunks →
                            </button>
                          )}
                        </div>
                      </div>
                      <div style={{ display:"flex", flexWrap:"wrap", gap:3 }}>
                        {Array.from({ length: job.chunks.total }).map((_, i) => {
                          const name = `part_${String(i).padStart(5,"0")}.mp4`;
                          const done = job.chunks?.completed.includes(name);
                          return (
                            <div key={i} className="chunk-dot"
                              style={{
                                background: done ? "var(--amber)" : "rgba(255,255,255,0.06)",
                                cursor: done ? "pointer" : "default",
                                opacity: job.status === "paused" && !done ? 0.4 : 1,
                              }}
                              title={done ? `Chunk ${i+1}: done — click to browse reversed` : `Chunk ${i+1}: pending`}
                              onClick={() => done && browseTo(
                                `/home/owner/Documents/47911b4f-b8b8-4453-90c9-360918fbf53a/Pro-Video-Reverser/jobs/${job.id}/reversed`
                              )}
                            />
                          );
                        })}
                      </div>
                    </div>
                  )}

                  {/* ── Error ── */}
                  {job.status === "failed" && (
                    <div style={{ margin:"8px 12px", padding:"8px 10px", background:"rgba(239,68,68,0.08)", border:"1px solid rgba(239,68,68,0.15)", borderRadius:"var(--radius)", display:"flex", gap:6 }}>
                      <AlertCircle size={12} color="#ef4444" style={{ flexShrink:0, marginTop:1 }} />
                      <span style={{ fontFamily:"var(--mono)", fontSize:9, color:"rgba(239,68,68,0.8)", lineHeight:1.6 }}>{job.error}</span>
                    </div>
                  )}

                  {/* ── Controls: Pause/Resume + Delete ── */}
                  <div style={{ padding:"8px 12px", borderBottom:"var(--panel)", display:"flex", alignItems:"center", gap:6, flexWrap:"wrap" }}>
                    {/* Pause / Resume */}
                    {jobPaused ? (
                      <button className="pause-btn" disabled={isResuming} onClick={resumeJob}
                        style={{ borderColor:"rgba(96,165,250,0.3)", color:"var(--blue)", background:"rgba(96,165,250,0.08)" }}>
                        {isResuming ? <Loader2 size={9} className="animate-spin" /> : <Play size={9} />}
                        {isResuming ? "Resuming…" : "Resume"}
                      </button>
                    ) : (jobActive && (
                      <button className="pause-btn" disabled={isPausing} onClick={pauseJob}>
                        {isPausing ? <Loader2 size={9} className="animate-spin" /> : <span style={{ fontSize:9 }}>⏸</span>}
                        {isPausing ? "Pausing…" : "Pause"}
                      </button>
                    ))}

                    <div style={{ flex:1 }} />

                    <button className="del-btn" disabled={isDeleting} onClick={deleteJob}>
                      {isDeleting ? <Loader2 size={9} className="animate-spin" /> : <Trash2 size={9} />}
                      {isDeleting ? "Wiping…" : "Delete"}
                    </button>
                  </div>
                  {deleteError && (
                    <div style={{ padding:"4px 12px", fontFamily:"var(--mono)", fontSize:8, color:"var(--red)" }}>{deleteError}</div>
                  )}

                  {/* ── Logs with filter ── */}
                  <div>
                    <div className="rp-section-header" onClick={() => setLogsOpen(p => !p)}>
                      <span className="panel-label"><Terminal size={9} /> Logs</span>
                      <div style={{ display:"flex", alignItems:"center", gap:8 }} onClick={e => e.stopPropagation()}>
                        <div className="log-filter">
                          <button className={`log-filter-opt ${logFilter === "key" ? "active" : ""}`}
                            onClick={() => setLogFilter("key")}>Key</button>
                          <button className={`log-filter-opt ${logFilter === "all" ? "active" : ""}`}
                            onClick={() => setLogFilter("all")}>All</button>
                        </div>
                        <span style={{ fontFamily:"var(--mono)", fontSize:9, color:"var(--text-dim)", cursor:"pointer" }}
                          onClick={() => setLogsOpen(p => !p)}>
                          {logsOpen ? "▲" : "▼"}
                        </span>
                      </div>
                    </div>
                    {logsOpen && (
                      <div style={{ maxHeight:260, overflowY:"auto", paddingBottom:8 }}>
                        {job.logs
                          .filter(line => logFilter === "all" || isKeyLog(line))
                          .map((line, i) => (
                          <div key={i} className="log-line"
                            style={{ borderLeftColor: isErrorLog(line) ? "var(--red)" : isPhaseLog(line) ? "var(--amber)" : "transparent" }}>
                            <span className="ln">{i + 1}</span>
                            <span style={{
                              wordBreak:"break-all",
                              color: isErrorLog(line) ? "rgba(239,68,68,0.8)" : isPhaseLog(line) ? "var(--amber)" : undefined,
                            }}>{line}</span>
                          </div>
                        ))}
                        <div ref={logEndRef} />
                      </div>
                    )}
                  </div>

                </motion.div>
              ) : (
                <motion.div key="idle" initial={{ opacity:0 }} animate={{ opacity:1 }} exit={{ opacity:0 }}>
                  <div className="empty" style={{ height:160, gap:8 }}>
                    <ArrowLeftRight size={20} color="rgba(245,158,11,0.15)" />
                    <span style={{ fontSize:9 }}>No active job</span>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>

            {/* ── Queue ── */}
            {queue.length > 0 && (
              <div style={{ borderTop:"var(--panel)" }}>
                <div className="rp-section-header">
                  <span className="panel-label">Up Next <span className="queue-badge" style={{ marginLeft:4 }}>{queue.length}</span></span>
                </div>
                {queue.map((q, idx) => (
                  <div key={q.id} className="queue-item">
                    <div className="queue-pos">{idx + 1}</div>
                    <span style={{ flex:1, minWidth:0, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>
                      {(q.url || "").length > 30 ? (q.url || "").slice(0,28) + "…" : (q.url || "")}
                    </span>
                    <button onClick={() => {
                      const qi = queue.indexOf(q);
                      if (qi !== -1) {
                        fetch(`/api/jobs/${q.id}`, { method:"DELETE" });
                      }
                    }} style={{ background:"none", border:"none", color:"var(--text-dim)", cursor:"pointer", fontSize:10, lineHeight:1 }}
                      title="Remove from queue">✕</button>
                  </div>
                ))}
              </div>
            )}

            {/* ── History ── */}
            <div style={{ borderTop:"var(--panel)" }}>
              <div className="rp-section-header" onClick={() => setHistoryOpen(p => !p)}>
                <span className="panel-label">History</span>
                <span style={{ fontFamily:"var(--mono)", fontSize:9, color:"var(--text-dim)" }}>
                  {historyOpen ? "▲" : "▼"}
                </span>
              </div>
              {historyOpen && (
                <div>
                  {history.length === 0 ? (
                    <div style={{ padding:"12px", fontFamily:"var(--mono)", fontSize:9, color:"var(--text-dim)", textAlign:"center" }}>
                      No completed jobs yet
                    </div>
                  ) : history.map(h => (
                    <div key={h.id} className="hist-row"
                      onClick={() => h.outputFile && setSelectedFile(h.outputFile)}>
                      <div className="hist-dot"
                        style={{ background: h.status === "completed" ? "var(--amber)" : "var(--red)" }} />
                      <div style={{ flex:1, minWidth:0 }}>
                        <div style={{ fontFamily:"var(--mono)", fontSize:9, color:"var(--text-mid)", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>
                          {h.url.length > 30 ? h.url.slice(0, 28) + "…" : h.url}
                        </div>
                        <div style={{ fontFamily:"var(--mono)", fontSize:7, color:"var(--text-dim)", marginTop:1 }}>
                          {new Date(h.finished_at).toLocaleDateString()} {new Date(h.finished_at).toLocaleTimeString([], { hour:"2-digit", minute:"2-digit" })}
                        </div>
                      </div>
                      <div style={{ display:"flex", alignItems:"center", gap:6, flexShrink:0 }}>
                        {h.outputFile && (
                          <button
                            title="Re-reverse this file"
                            onClick={e => { e.stopPropagation(); reverseHistoryEntry(h); }}
                            style={{ background:"none", border:"none", color:"var(--text-dim)", cursor:"pointer", display:"flex", padding:2 }}>
                            <ArrowLeftRight size={9} />
                          </button>
                        )}
                        {h.outputFile && (
                          <a href={`/api/media?path=${encodeURIComponent(h.outputFile)}`}
                            download onClick={e => e.stopPropagation()}
                            style={{ color:"var(--text-dim)", display:"flex" }}>
                            <Download size={9} />
                          </a>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

          </div>
        </div>

      </div>
    </>
  );
}

