// PATH: src/App.tsx  v1.4
// Layout: three-panel workstation — left browser | center stage | right pipeline
// Design: IBM Plex Mono, amber accent, deep charcoal, razor panel borders
// New: CSS transform flip/mirror controls (zero server cost, instant, lossless)

import React, { useState, useEffect, useRef, useCallback, useMemo } from "react";
import {
  Play, Download, AlertCircle, CheckCircle2, Loader2,
  ArrowLeftRight, ChevronRight, Folder, Trash2, PlayCircle,
  RefreshCw, Link2, HardDrive, FlipHorizontal, FlipVertical,
  RotateCcw, Maximize2, Terminal,
} from "lucide-react";
import { motion, AnimatePresence } from "motion/react";

// ── Types ────────────────────────────────────────────────────────────────────
interface Job {
  id: string;
  url: string;
  sourceFile?: string | null;
  status: "pending" | "downloading" | "splitting" | "reversing" | "merging" | "completed" | "failed";
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

  // input
  const [youtubeUrl, setYoutubeUrl]         = useState("");
  const [activeTab, setActiveTab]           = useState<"browser" | "url">("browser");

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

  const toggleXform = (key: keyof Transform) =>
    setXform(p => ({ ...p, [key]: !p[key] }));

  const resetXform = () => setXform({ flipH: false, flipV: false, rot180: false });

  const jobActive = job && job.status !== "completed" && job.status !== "failed";
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

        /* update pill */
        .update-pill {
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
              <span style={{ fontFamily:"var(--mono)", fontSize:9, color: health.load < 4 ? "var(--amber)" : "#ef4444", letterSpacing:"0.1em" }}>
                LOAD {health.load.toFixed(1)}
              </span>
              <span style={{ fontFamily:"var(--mono)", fontSize:9, color: health.psi < 10 ? "var(--text-dim)" : "#ef4444", letterSpacing:"0.1em" }}>
                PSI {health.psi.toFixed(0)}%
              </span>
              <span style={{ fontFamily:"var(--mono)", fontSize:9, color:"var(--text-dim)", letterSpacing:"0.1em" }}>
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

        {/* ── LEFT PANEL: File Browser ── */}
        <div className="panel">
          {/* Tab strip: Browser / URL */}
          <div className="tab-strip">
            <button className={`tab ${activeTab === "browser" ? "active" : ""}`} onClick={() => setActiveTab("browser")}>
              <HardDrive size={10} /> Files
            </button>
            <button className={`tab ${activeTab === "url" ? "active" : ""}`} onClick={() => setActiveTab("url")}>
              <Link2 size={10} /> YouTube
            </button>
          </div>

          {activeTab === "browser" ? (
            <>
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
            </>
          ) : (
            <div style={{ padding:12, display:"flex", flexDirection:"column", gap:10 }}>
              <p style={{ fontFamily:"var(--mono)", fontSize:9, color:"var(--text-dim)", lineHeight:1.7 }}>
                Paste a YouTube URL to download &amp; reverse it.
              </p>
              <input
                className="url-input"
                type="text"
                value={youtubeUrl}
                onChange={e => setYoutubeUrl(e.target.value)}
                placeholder="https://www.youtube.com/watch?v=..."
                disabled={!!jobActive || isSubmitting}
                onKeyDown={e => e.key === "Enter" && youtubeUrl && startJob({ url: youtubeUrl })}
              />
              <button className="reverse-btn" style={{ justifyContent:"center" }}
                disabled={!youtubeUrl || !!jobActive || isSubmitting}
                onClick={() => youtubeUrl && startJob({ url: youtubeUrl })}>
                {isSubmitting ? <Loader2 size={11} className="animate-spin" /> : <ArrowLeftRight size={11} />}
                {isSubmitting ? "Starting…" : "Download & Reverse"}
              </button>
            </div>
          )}
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
          </div>

          <div className="panel-scroll">
            <AnimatePresence mode="wait">
              {job ? (
                <motion.div key="job" initial={{ opacity:0, y:6 }} animate={{ opacity:1, y:0 }} exit={{ opacity:0 }}>

                  {/* Status row */}
                  <div style={{
                    display:"flex", alignItems:"center", gap:8, padding:"10px 12px",
                    borderBottom:"var(--panel)",
                  }}>
                    <div className={`status-dot ${jobActive ? "pulse" : ""}`}
                      style={{ background: statusColor(job.status) }} />
                    <span style={{
                      fontFamily:"var(--mono)", fontSize:10, fontWeight:500, letterSpacing:"0.08em",
                      textTransform:"uppercase", color: statusColor(job.status), flex:1,
                    }}>
                      {job.status}
                    </span>
                    <span style={{ fontFamily:"var(--mono)", fontSize:16, fontWeight:600, color:"var(--text)" }}>
                      {Math.round(job.progress)}%
                    </span>
                  </div>

                  {/* Phase + ETA */}
                  {(job.currentPhase || job.eta) && (
                    <div style={{
                      display:"flex", justifyContent:"space-between", alignItems:"center",
                      padding:"6px 12px", borderBottom:"var(--panel)",
                      background:"rgba(245,158,11,0.04)",
                    }}>
                      {job.currentPhase && (
                        <span style={{ fontFamily:"var(--mono)", fontSize:9, color:"var(--blue)", flex:1, minWidth:0, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>
                          {job.currentPhase}
                        </span>
                      )}
                      {job.eta && (
                        <span style={{ fontFamily:"var(--mono)", fontSize:9, color:"var(--text-dim)", flexShrink:0, marginLeft:8 }}>
                          {job.eta}
                        </span>
                      )}
                    </div>
                  )}

                  {/* Progress bar */}
                  <div style={{ padding:"8px 12px 4px" }}>
                    <div className="progress-track">
                      <motion.div className="progress-fill"
                        initial={{ width:0 }}
                        animate={{ width:`${job.progress}%` }}
                        transition={{ duration:0.5 }}
                        style={{ background: job.status === "failed" ? "var(--red)" : "var(--amber)" }}
                      />
                    </div>
                  </div>

                  {/* Chunk map */}
                  {job.chunks && job.chunks.total > 0 && (
                    <div style={{ padding:"4px 12px 10px", borderBottom:"var(--panel)" }}>
                      <div style={{ display:"flex", justifyContent:"space-between", marginBottom:6 }}>
                        <span style={{ fontFamily:"var(--mono)", fontSize:8, color:"var(--text-dim)", letterSpacing:"0.1em", textTransform:"uppercase" }}>Chunks</span>
                        <span style={{ fontFamily:"var(--mono)", fontSize:8, color:"var(--text-dim)" }}>
                          {job.chunks.completed.length}/{job.chunks.total}
                        </span>
                      </div>
                      <div style={{ display:"flex", flexWrap:"wrap", gap:3 }}>
                        {Array.from({ length: job.chunks.total }).map((_, i) => {
                          const name = `part_${String(i).padStart(5,"0")}.mp4`;
                          const done = job.chunks?.completed.includes(name);
                          return (
                            <div key={i} className="chunk-dot"
                              style={{ background: done ? "var(--amber)" : "rgba(255,255,255,0.06)" }}
                              title={`Chunk ${i+1}: ${done ? "done" : "pending"}`}
                              onClick={() => done && job.id && browseTo(
                                `/home/owner/Documents/47911b4f-b8b8-4453-90c9-360918fbf53a/Pro-Video-Reverser/jobs/${job.id}/reversed`
                              )}
                            />
                          );
                        })}
                      </div>
                    </div>
                  )}

                  {/* Error */}
                  {job.status === "failed" && (
                    <div style={{ margin:"8px 12px", padding:"8px 10px", background:"rgba(239,68,68,0.08)", border:"1px solid rgba(239,68,68,0.15)", borderRadius:"var(--radius)", display:"flex", gap:6 }}>
                      <AlertCircle size={12} color="#ef4444" style={{ flexShrink:0, marginTop:1 }} />
                      <span style={{ fontFamily:"var(--mono)", fontSize:9, color:"rgba(239,68,68,0.8)", lineHeight:1.6 }}>{job.error}</span>
                    </div>
                  )}

                  {/* Delete */}
                  <div style={{ padding:"8px 12px", borderBottom:"var(--panel)", display:"flex", alignItems:"center", gap:8 }}>
                    <span style={{ fontFamily:"var(--mono)", fontSize:8, color:"var(--text-dim)", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap", flex:1 }}>
                      {job.id.slice(0,16)}…
                    </span>
                    <button className="del-btn" disabled={isDeleting} onClick={deleteJob}>
                      {isDeleting ? <Loader2 size={9} className="animate-spin" /> : <Trash2 size={9} />}
                      {isDeleting ? "Wiping…" : "Delete"}
                    </button>
                  </div>
                  {deleteError && (
                    <div style={{ padding:"4px 12px", fontFamily:"var(--mono)", fontSize:8, color:"var(--red)" }}>{deleteError}</div>
                  )}

                  {/* Logs */}
                  <div style={{ borderBottom:"var(--panel)" }}>
                    <div className="rp-section-header" onClick={() => setLogsOpen(p => !p)}>
                      <span className="panel-label"><Terminal size={9} /> Logs</span>
                      <span style={{ fontFamily:"var(--mono)", fontSize:9, color:"var(--text-dim)" }}>{logsOpen ? "▲" : "▼"}</span>
                    </div>
                    {logsOpen && (
                      <div style={{ maxHeight:280, overflowY:"auto", paddingBottom:8 }}>
                        {job.logs.map((line, i) => (
                          <div key={i} className="log-line">
                            <span className="ln">{i + 1}</span>
                            <span style={{ wordBreak:"break-all" }}>{line}</span>
                          </div>
                        ))}
                        <div ref={logEndRef} />
                      </div>
                    )}
                  </div>

                </motion.div>
              ) : (
                <motion.div key="idle" initial={{ opacity:0 }} animate={{ opacity:1 }} exit={{ opacity:0 }}>
                  <div className="empty" style={{ height:200, gap:8 }}>
                    <ArrowLeftRight size={20} color="rgba(245,158,11,0.15)" />
                    <span style={{ fontSize:9 }}>No active job</span>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </div>

      </div>
    </>
  );
}
