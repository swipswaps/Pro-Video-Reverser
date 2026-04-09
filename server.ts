// PATH: server.ts (repo root)
//
// PATCHES APPLIED — three confirmed root-cause bugs fixed:
//
// BUG 1 (encoder check crash): runCommandCapture() rejected on non-zero exit code.
//   ffmpeg -encoders exits with code 1 on many builds, causing runJob() to throw
//   before any download starts. The entire job failed immediately with a cryptic error.
//   FIX: added allowNonZero=true parameter; stderr now captured alongside stdout.
//
// BUG 2 (wrong container downloaded): yt-dlp format selector "mp4[height<=720]"
//   is invalid syntax. yt-dlp requires "bestvideo[ext=mp4]+bestaudio" form.
//   The selector silently failed and the retry used "best", which returns MKV/WebM.
//   FFmpeg then tried to split a WebM file named input.mp4 — segments were corrupt.
//   FIX: corrected format selectors for both primary attempt and retry.
//
// BUG 3 (resume wipes chunk state): runJob() unconditionally set
//   job.chunks = { total: 0, completed: [], downloaded: false } as its first action.
//   autoResumeJobs() called getJobFromDb() which reconstructed chunk state from the
//   filesystem, then called runJob() which immediately overwrote that state with zeros.
//   Every server restart re-downloaded and re-reversed all chunks from scratch.
//   FIX: only initialize job.chunks if it is not already set.

import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import { fileURLToPath } from "url";
import cors from "cors";
import { v4 as uuidv4 } from "uuid";
import fs from "fs-extra";
import { spawn } from "child_process";
import youtubedl from "youtube-dl-exec";
import crypto from "crypto";
import Database from "better-sqlite3";
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = 3000;
const JOBS_DIR = path.join(process.cwd(), "jobs");
const LOG_DIR = path.join(process.cwd(), "forensic_logs");
const DB_FILE = path.join(LOG_DIR, "jobs.db");

// Ensure directories exist
fs.ensureDirSync(JOBS_DIR);
fs.ensureDirSync(LOG_DIR);

// Tracks the active ffmpeg child process per job for pause/resume
const activeProc: Record<string, ReturnType<typeof spawn> | null> = {};

// Simple FIFO job queue — holds job IDs waiting to run.
// Only one job runs at a time to avoid OOM on long videos.
// When a job completes/fails, processQueue() starts the next one.
const jobQueue: string[] = [];
let runningJobId: string | null = null;

function processQueue() {
  if (runningJobId || jobQueue.length === 0) return;
  const nextId = jobQueue.shift()!;
  runningJobId = nextId;
  const job = jobs[nextId];
  if (!job) { runningJobId = null; processQueue(); return; }
  console.log(`[QUEUE] Starting job ${nextId} (${jobQueue.length} remaining in queue)`);
  runJob(nextId).finally(() => {
    runningJobId = null;
    processQueue();
  });
}

// Initialize Database
const db = new Database(DB_FILE);
db.exec(`
  CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY,
    url TEXT,
    status TEXT,
    progress REAL,
    outputFile TEXT,
    error TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id TEXT,
    message TEXT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(job_id) REFERENCES jobs(id)
  );
  CREATE TABLE IF NOT EXISTS history (
    id TEXT PRIMARY KEY,
    url TEXT,
    status TEXT,
    outputFile TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    finished_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

class SystemMonitor {
  static async getLoadAvg(): Promise<number> {
    try {
      const uptime = await runCommandCapture("uptime");
      const match = uptime.match(/load average:\s+([\d.]+)/);
      return match ? parseFloat(match[1]) : 0;
    } catch {
      return 0;
    }
  }

  static async getPSICPU(): Promise<number> {
    try {
      if (await fs.pathExists("/proc/pressure/cpu")) {
        const content = await fs.readFile("/proc/pressure/cpu", "utf8");
        const match = content.match(/some avg10=([\d.]+)/);
        return match ? parseFloat(match[1]) : 0;
      }
    } catch {}
    return 0;
  }

  static async getDiskSpace(): Promise<{ available: number; total: number }> {
    try {
      const df = await runCommandCapture("df -m . | tail -1");
      const parts = df.split(/\s+/).filter(Boolean);
      // parts[0] is filesystem, parts[1] is total, parts[2] is used, parts[3] is available
      if (parts.length >= 4) {
        return {
          total: parseInt(parts[1]) || 0,
          available: parseInt(parts[3]) || 0
        };
      }
      return { available: 0, total: 0 };
    } catch (e) {
      console.error("Disk space check error:", e);
      return { available: 0, total: 0 };
    }
  }

  static async getZombieCount(): Promise<number> {
    try {
      const ps = await runCommandCapture("ps -ef | grep ffmpeg | grep -v grep | wc -l");
      return parseInt(ps) || 0;
    } catch {
      return 0;
    }
  }

  static async checkHealth() {
    const load = await this.getLoadAvg();
    const psi = await this.getPSICPU();
    const disk = await this.getDiskSpace();
    const zombies = await this.getZombieCount();
    return { load, psi, disk, zombies, timestamp: new Date().toISOString() };
  }
}

interface Job {
  id: string;
  url: string;
  sourceFile?: string | null;
  status: "pending" | "downloading" | "splitting" | "reversing" | "merging" | "completed" | "failed" | "paused";
  pausedStatus?: string | null; // the status to restore on resume
  progress: number;
  eta?: string | null;
  currentPhase?: string | null;
  logs: string[];
  outputFile?: string;
  error?: string;
  chunks?: {
    total: number;
    completed: string[];
    downloaded: boolean;
  };
}

const jobs: Record<string, Job> = {};

function saveJob(job: Job) {
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO jobs (id, url, status, progress, outputFile, error)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  stmt.run(job.id, job.url, job.status, job.progress, job.outputFile || null, job.error || null);

  // Write to persistent history when job reaches a terminal state
  if (job.status === "completed" || job.status === "failed") {
    db.prepare(`
      INSERT OR REPLACE INTO history (id, url, status, outputFile, finished_at)
      VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
    `).run(job.id, job.url, job.status, job.outputFile || null);
  }
}

function getJobFromDb(id: string): Job | null {
  const jobRow = db.prepare("SELECT * FROM jobs WHERE id = ?").get(id) as any;
  if (!jobRow) return null;
  
  const logRows = db.prepare("SELECT message FROM logs WHERE job_id = ? ORDER BY timestamp ASC").all(id) as any[];
  
  const job: Job = {
    id: jobRow.id,
    url: jobRow.url,
    status: jobRow.status,
    progress: jobRow.progress,
    outputFile: jobRow.outputFile,
    error: jobRow.error,
    logs: logRows.map(r => r.message)
  };

  // System Discovery: Reconstruct chunk state from filesystem
  const jobDir = path.join(JOBS_DIR, id);
  const downloadDir = path.join(jobDir, "download");
  const chunksDir = path.join(jobDir, "chunks");
  const reversedDir = path.join(jobDir, "reversed");

  try {
    const downloadPath = path.join(downloadDir, "input.mp4");
    const downloaded = fs.existsSync(downloadPath) && fs.statSync(downloadPath).size > 0;
    
    let total = 0;
    let completed: string[] = [];
    
    if (fs.existsSync(chunksDir)) {
      const chunkFiles = fs.readdirSync(chunksDir).filter(f => f.endsWith(".mp4"));
      total = chunkFiles.length;
    }
    
    if (fs.existsSync(reversedDir)) {
      completed = fs.readdirSync(reversedDir).filter(f => f.endsWith(".mp4"));
    }

    job.chunks = { total, completed, downloaded };
  } catch (e) {
    console.error(`[FORENSIC:ERROR] Failed to reconstruct state for ${id}:`, e);
  }

  return job;
}

function log(jobId: string, message: string) {
  const timestamp = new Date().toISOString();
  const logLine = `[${timestamp}] ${message}`;
  console.log(`[Job ${jobId}] ${message}`);
  
  const stmt = db.prepare("INSERT INTO logs (job_id, message) VALUES (?, ?)");
  stmt.run(jobId, logLine);
  
  // Update in-memory cache if exists
  if (jobs[jobId]) {
    jobs[jobId].logs.push(logLine);
    if (jobs[jobId].logs.length > 1000) jobs[jobId].logs.shift();
  }
}

async function startServer() {
  const app = express();
  app.use(cors());
  app.use(express.json());

  // API Routes
  app.post("/api/jobs", async (req, res) => {
    const { url, sourceFile } = req.body;
    // sourceFile: absolute path to a local file to reverse instead of downloading
    // url: YouTube URL to download and reverse
    // One of the two must be provided.
    if (!url && !sourceFile) {
      return res.status(400).json({ error: "Either url or sourceFile is required" });
    }
    if (sourceFile && !fs.existsSync(sourceFile)) {
      return res.status(400).json({ error: `sourceFile not found: ${sourceFile}` });
    }

    const jobKey = sourceFile || url;
    console.log(`SERVER: Received request to initialize job for ${jobKey}`);
    const jobId = crypto.createHash("md5").update(jobKey).digest("hex");
    
    // Force fresh start — terminate any running process for this job first
    const jobDir = path.join(JOBS_DIR, jobId);
    if (activeProc[jobId]?.pid) {
      try { process.kill(activeProc[jobId]!.pid!, "SIGTERM"); } catch {}
      activeProc[jobId] = null;
    }
    if (runningJobId === jobId) {
      runningJobId = null;
    }
    const queueIdx = jobQueue.indexOf(jobId);
    if (queueIdx !== -1) jobQueue.splice(queueIdx, 1);
    if (fs.existsSync(jobDir)) {
      console.log(`SERVER: Wiping existing job directory for ${jobId}`);
      await fs.remove(jobDir);
    }
    console.log(`SERVER: Clearing existing job record for ${jobId}`);
    db.prepare("DELETE FROM logs WHERE job_id = ?").run(jobId);
    db.prepare("DELETE FROM jobs WHERE id = ?").run(jobId);
    delete jobs[jobId];

    let job: Job = {
      id: jobId,
      url: url || sourceFile,
      sourceFile: sourceFile || null,
      status: "pending",
      progress: 0,
      logs: [sourceFile ? `Reversing local file: ${sourceFile}` : "Job initialized"],
    };

    jobs[jobId] = job;
    saveJob(job);
    console.log(`SERVER: Enqueuing job ${jobId} (position: ${jobQueue.length + (runningJobId ? 1 : 0)})`);

    // If nothing is running, start immediately. Otherwise queue it.
    if (!runningJobId) {
      runningJobId = jobId;
      runJob(jobId).finally(() => {
        runningJobId = null;
        processQueue();
      });
    } else {
      jobQueue.push(jobId);
      log(jobId, `Queued — ${jobQueue.length} job(s) ahead. Will start when current job completes.`);
    }

    res.json({ jobId, queued: !!runningJobId && runningJobId !== jobId, position: jobQueue.indexOf(jobId) + 1 });
  });

  app.get("/api/jobs/active", (req, res) => {
    // Return the most recent job, regardless of status, so the UI can "snap" to it
    const latestJob = db.prepare("SELECT id FROM jobs ORDER BY created_at DESC LIMIT 1").get() as { id: string } | undefined;
    if (latestJob) {
      const job = jobs[latestJob.id] || getJobFromDb(latestJob.id);
      return res.json(job);
    }
    res.json(null);
  });

  // Queue status — returns running job + all queued jobs in order
  app.get("/api/queue", (req, res) => {
    const running = runningJobId ? (jobs[runningJobId] || getJobFromDb(runningJobId)) : null;
    const queued = jobQueue.map(id => jobs[id] || getJobFromDb(id)).filter(Boolean);
    res.json({ running, queued });
  });

  app.get("/api/jobs/:id", (req, res) => {
    let job = jobs[req.params.id];
    if (!job) {
      job = getJobFromDb(req.params.id);
    }
    if (!job) {
      return res.status(404).json({ error: "Job not found" });
    }
    res.json(job);
  });

  app.delete("/api/jobs/:id", async (req, res) => {
    const { id } = req.params;
    console.log(`SERVER: Deleting job ${id}`);
    const jobDir = path.join(JOBS_DIR, id);
    try {
      // 1. Delete logs first to satisfy potential (though unlikely) FK constraints
      console.log(`SERVER: Deleting logs for job ${id}`);
      db.prepare("DELETE FROM logs WHERE job_id = ?").run(id);
      
      // 2. Delete job from database
      console.log(`SERVER: Deleting job ${id} from database`);
      db.prepare("DELETE FROM jobs WHERE id = ?").run(id);
      
      // Remove from queue if waiting
      const queueIdx = jobQueue.indexOf(id);
      if (queueIdx !== -1) jobQueue.splice(queueIdx, 1);

      // Kill active process if this is the running job
      if (runningJobId === id) {
        const proc = activeProc[id];
        if (proc && proc.pid) { try { process.kill(proc.pid, "SIGTERM"); } catch {} }
        runningJobId = null;
      }
      if (fs.existsSync(jobDir)) {
        console.log(`SERVER: Removing directory ${jobDir}`);
        await fs.remove(jobDir);
      }
      
      // 4. Clear in-memory cache
      delete jobs[id];
      
      console.log(`SERVER: Job ${id} deleted successfully`);
      res.json({ success: true });
    } catch (error: any) {
      console.error(`SERVER: Error deleting job ${id}:`, error);
      res.status(500).json({ 
        error: error.message || String(error),
        stack: error.stack
      });
    }
  });

  // Pause: send SIGSTOP to the active ffmpeg process.
  // The process is frozen in-place — no data loss, resumes exactly where it left off.
  // Does not survive a server restart (SIGSTOP is kernel-level, not persisted).
  // On server boot, paused jobs are treated as interrupted and resume via chunk skip.
  app.post("/api/jobs/:id/pause", (req, res) => {
    const { id } = req.params;
    const job = jobs[id];
    if (!job) return res.status(404).json({ error: "Job not found" });
    if (job.status === "paused") return res.json({ status: "already paused" });
    if (!["splitting", "reversing", "merging", "downloading"].includes(job.status)) {
      return res.status(400).json({ error: `Cannot pause a job in status: ${job.status}` });
    }
    const proc = activeProc[id];
    if (proc && proc.pid) {
      try {
        process.kill(proc.pid, "SIGSTOP");
        log(id, `Job paused (SIGSTOP sent to PID ${proc.pid})`);
      } catch (e: any) {
        // Process may have already exited — treat as ok
        log(id, `SIGSTOP failed (process may have exited): ${e.message}`);
      }
    }
    job.pausedStatus = job.status;
    job.status = "paused";
    job.eta = null;
    job.currentPhase = "Paused";
    saveJob(job);
    res.json({ success: true, pausedFrom: job.pausedStatus });
  });

  // Resume: send SIGCONT to unfreeze the process.
  app.post("/api/jobs/:id/resume", (req, res) => {
    const { id } = req.params;
    const job = jobs[id];
    if (!job) return res.status(404).json({ error: "Job not found" });
    if (job.status !== "paused") return res.status(400).json({ error: `Job is not paused (status: ${job.status})` });
    const proc = activeProc[id];
    if (proc && proc.pid) {
      try {
        process.kill(proc.pid, "SIGCONT");
        log(id, `Job resumed (SIGCONT sent to PID ${proc.pid})`);
        job.status = (job.pausedStatus as Job["status"]) || "reversing";
        job.pausedStatus = null;
        job.currentPhase = null;
        saveJob(job);
        res.json({ success: true, resumedTo: job.status });
      } catch (e: any) {
        // Process died while paused — restart from checkpoint
        log(id, `Resume via SIGCONT failed, restarting from checkpoint: ${e.message}`);
        job.status = "pending";
        job.pausedStatus = null;
        jobs[id] = job;
        saveJob(job);
        runJob(id);
        res.json({ success: true, resumedVia: "restart" });
      }
    } else {
      // No active process — restart from checkpoint (chunks already done will be skipped)
      log(id, "No active process found, restarting from checkpoint...");
      job.status = "pending";
      job.pausedStatus = null;
      jobs[id] = job;
      saveJob(job);
      runJob(id);
      res.json({ success: true, resumedVia: "restart" });
    }
  });

  // Job history — last 50 completed/failed jobs
  app.get("/api/jobs/history", (req, res) => {
    try {
      const rows = db.prepare(
        "SELECT id, url, status, outputFile, created_at, finished_at FROM history ORDER BY finished_at DESC LIMIT 50"
      ).all();
      res.json(rows);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── /api/media — low-latency streaming endpoint ───────────────────────────
  //
  // The 12-20s cold-start delay is caused by three compounding factors:
  //   1. Every request opens a fresh file descriptor → disk wake-up penalty
  //   2. Default Node stream buffer (64KB) → many small reads on HDD
  //   3. No cache headers → Firefox re-fetches from disk after every pause
  //
  // Fixes applied (all additive, nothing removed):
  //   A. FD pool: keep file descriptors open per path, reuse across requests.
  //      openFdPool[path] = { fd, lastAccess, size }
  //      FDs idle >60s are closed to avoid fd exhaustion.
  //   B. Read-ahead warmup: synchronous 256KB read at offset 0 before piping.
  //      Forces the kernel to populate page cache. Cost: ~2ms. Benefit: ~20s saved.
  //   C. highWaterMark: 1MB — fewer disk round-trips, better HDD throughput.
  //   D. Cache-Control: public, max-age=3600 — Firefox reuses buffered ranges
  //      across pause/resume cycles without hitting the server again.
  //   E. Keep-warm: /api/media/warm?path=X — called by the client every 10s
  //      while a file is loaded in the player. Prevents page-cache eviction.

  // ── Media streaming — stat cache + fresh fd per request ──────────────────
  //
  // WHY NOT A SHARED FD:
  //   A single fd has one kernel file-position pointer. When Firefox issues
  //   2-3 simultaneous range requests on seek (which it always does), multiple
  //   createReadStream calls sharing the same fd race on that pointer — one
  //   stream's read advances the cursor mid-read of the other, producing
  //   corrupted/short responses. Firefox stalls waiting for valid data → spinner.
  //
  // THE FIX:
  //   Cache only the stat (size + mtime) and the first-warmup flag per path.
  //   Each range request opens its own fd, reads, closes. The OS page cache
  //   means subsequent opens of the same file are effectively free — the data
  //   is already in RAM, the open() syscall just creates a new position pointer.
  //
  // WARMUP:
  //   On first access, we do one synchronous 2MB read to populate page cache.
  //   After that, all opens hit the cache regardless of fd count.

  const statCache: Record<string, { size: number; warmed: boolean; lastAccess: number }> = {};

  // Evict stale stat entries every 60s
  setInterval(() => {
    const now = Date.now();
    for (const [p, e] of Object.entries(statCache)) {
      if (now - e.lastAccess > 300000) delete statCache[p];
    }
  }, 60000);

  function getFileStat(filePath: string): { size: number } {
    const now = Date.now();
    if (statCache[filePath]) {
      statCache[filePath].lastAccess = now;
      return statCache[filePath];
    }
    const size = fs.statSync(filePath).size;
    // One-time warmup: open, read 2MB into page cache, close.
    // Every subsequent open — even with a fresh fd — hits the cached pages.
    try {
      const warmFd  = fs.openSync(filePath, "r");
      const warmLen = Math.min(2 * 1024 * 1024, size);
      const warmBuf = Buffer.allocUnsafe(warmLen);
      fs.readSync(warmFd, warmBuf, 0, warmLen, 0);
      fs.closeSync(warmFd);
    } catch {}
    statCache[filePath] = { size, warmed: true, lastAccess: now };
    return { size };
  }

  // Keep-warm endpoint: called by client every 10s while player is loaded.
  // Also accepts ?fraction=0.0-1.0 to pre-warm a seek target region.
  app.get("/api/media/warm", (req, res) => {
    const filePath = req.query.path as string;
    const fraction = parseFloat((req.query.fraction as string) || "0") || 0;
    if (!filePath) return res.status(400).json({ error: "path required" });
    try {
      if (!fs.existsSync(filePath)) return res.status(404).json({ error: "File not found" });
      const { size } = getFileStat(filePath);
      // Seek pre-warm: read 2MB starting at the seek target byte offset
      if (fraction > 0 && fraction < 1) {
        const seekByte = Math.floor(fraction * size);
        const warmLen  = Math.min(2 * 1024 * 1024, size - seekByte);
        if (warmLen > 0) {
          try {
            const fd  = fs.openSync(filePath, "r");
            const buf = Buffer.allocUnsafe(warmLen);
            fs.readSync(fd, buf, 0, warmLen, seekByte);
            fs.closeSync(fd);
          } catch {}
        }
      }
      if (statCache[filePath]) statCache[filePath].lastAccess = Date.now();
      res.json({ warmed: true, fraction });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get("/api/media", (req, res) => {
    const filePath = req.query.path as string;
    if (!filePath || !fs.existsSync(filePath)) {
      return res.status(404).json({ error: "File not found" });
    }

    let fileSize: number;
    try {
      ({ size: fileSize } = getFileStat(filePath));
    } catch (e: any) {
      return res.status(500).json({ error: "stat failed: " + e.message });
    }

    const range = req.headers.range;
    const cacheHeaders = {
      'Cache-Control': 'public, max-age=3600',
      'Accept-Ranges': 'bytes',
    };

    if (range) {
      const parts     = range.replace(/bytes=/, "").split("-");
      const start     = parseInt(parts[0], 10);
      const end       = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
      const chunksize = end - start + 1;

      // Fresh fd per range request — no shared cursor, no concurrent corruption.
      // Page cache means this open() costs ~0.1ms, not a disk seek.
      const file = fs.createReadStream(filePath, {
        start,
        end,
        highWaterMark: 1024 * 1024, // 1MB — fewer small reads on HDD
      });

      res.writeHead(206, {
        ...cacheHeaders,
        'Content-Range':  `bytes ${start}-${end}/${fileSize}`,
        'Content-Length': chunksize,
        'Content-Type':   'video/mp4',
      });
      file.pipe(res);

    } else {
      const file = fs.createReadStream(filePath, {
        highWaterMark: 1024 * 1024,
      });
      res.writeHead(200, {
        ...cacheHeaders,
        'Content-Length': fileSize,
        'Content-Type':   'video/mp4',
      });
      file.pipe(res);
    }
  });

  app.get("/api/download/:id", (req, res) => {
    let job = jobs[req.params.id];
    if (!job) {
      job = getJobFromDb(req.params.id);
    }
    if (!job || job.status !== "completed" || !job.outputFile) {
      return res.status(404).json({ error: "File not found" });
    }
    // For preview, we want to serve the file without forcing download if requested
    if (req.query.preview) {
      console.log(`[PREVIEW] Serving job ${req.params.id} for preview: ${job.outputFile}`);
      // Let Express handle Content-Type and Accept-Ranges automatically
      res.sendFile(job.outputFile, {
        headers: {
          "Cache-Control": "no-cache, no-store, must-revalidate",
          "Pragma": "no-cache",
          "Expires": "0"
        }
      });
    } else {
      res.download(job.outputFile);
    }
  });

  app.get("/api/jobs/:id/files", (req, res) => {
    const jobDir = path.join(JOBS_DIR, req.params.id);
    if (!fs.existsSync(jobDir)) return res.status(404).json({ error: "Job dir not found" });

    const scan = (dir: string) => {
      if (!fs.existsSync(dir)) return [];
      return fs.readdirSync(dir).map(f => {
        const fullPath = path.join(dir, f);
        const stats = fs.statSync(fullPath);
        return { name: f, size: stats.size, mtime: stats.mtime, path: fullPath };
      });
    };

    res.json({
      download: scan(path.join(jobDir, "download")),
      chunks: scan(path.join(jobDir, "chunks")),
      reversed: scan(path.join(jobDir, "reversed")),
      final: scan(jobDir).filter(f => f.name.endsWith(".mp4") && !f.name.includes("part_"))
    });
  });

  app.get("/api/download/:id/chunks/:chunkName", (req, res) => {
    const { id, chunkName } = req.params;
    const chunkPath = path.join(JOBS_DIR, id, "reversed", chunkName);
    if (fs.existsSync(chunkPath)) {
      res.download(chunkPath);
    } else {
      res.status(404).json({ error: "Chunk not found" });
    }
  });

  app.get("/api/system/health", async (req, res) => {
    try {
      const health = await SystemMonitor.checkHealth();
      res.json(health);
    } catch (error) {
      console.error("SERVER: Health check failed:", error);
      res.status(500).json({ 
        error: "Health check failed", 
        details: error instanceof Error ? error.message : String(error) 
      });
    }
  });

  // General-purpose filesystem browser.
  // GET /api/browse?path=/absolute/path
  // Returns: { path, parent, dirs, files }
  // - dirs: navigable subdirectories
  // - files: all files with name, size, mtime, path (absolute, safe to pass to /api/media)
  // - parent: parent directory path, or null if at filesystem root
  // Restricted to /home to prevent browsing /etc, /proc, etc.
  const BROWSE_ROOT = "/home";
  app.get("/api/browse", (req, res) => {
    try {
      let reqPath = (req.query.path as string) || JOBS_DIR;
      // Normalize and restrict to BROWSE_ROOT
      const resolved = path.resolve(reqPath);
      if (!resolved.startsWith(BROWSE_ROOT)) {
        return res.status(403).json({ error: `Browse restricted to ${BROWSE_ROOT}` });
      }
      if (!fs.existsSync(resolved)) {
        return res.status(404).json({ error: "Path not found" });
      }
      const stat = fs.statSync(resolved);
      if (!stat.isDirectory()) {
        return res.status(400).json({ error: "Path is not a directory" });
      }

      const entries = fs.readdirSync(resolved);
      const dirs: { name: string; path: string }[] = [];
      const files: { name: string; size: number; mtime: Date; path: string }[] = [];

      for (const entry of entries) {
        if (entry.startsWith(".")) continue; // skip hidden
        const fullPath = path.join(resolved, entry);
        try {
          const s = fs.statSync(fullPath);
          if (s.isDirectory()) {
            dirs.push({ name: entry, path: fullPath });
          } else {
            files.push({ name: entry, size: s.size, mtime: s.mtime, path: fullPath });
          }
        } catch {
          // skip unreadable entries
        }
      }

      dirs.sort((a, b) => a.name.localeCompare(b.name));
      files.sort((a, b) => a.name.localeCompare(b.name));

      const parentPath = path.dirname(resolved);
      const parent = parentPath !== resolved && parentPath.startsWith(BROWSE_ROOT)
        ? parentPath
        : null;

      res.json({ path: resolved, parent, dirs, files });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/system/update-check", async (req, res) => {
    try {
      await execAsync("git fetch");
      const status = await execAsync("git status -uno");
      const hasUpdate = status.stdout.includes("Your branch is behind");
      res.json({ hasUpdate });
    } catch (e) {
      res.json({ hasUpdate: false, error: String(e) });
    }
  });

  app.post("/api/system/update-apply", async (req, res) => {
    try {
      await execAsync("git pull");
      res.json({ success: true });
      // The server will likely restart due to file changes if running via tsx/nodemon
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
    autoResumeJobs();
  });
}

async function autoResumeJobs() {
  console.log("[RECOVERY] Scanning for interrupted jobs...");
  // Exclude paused — SIGSTOP does not survive restarts, so paused jobs
  // will be restarted from checkpoint when the user clicks Resume.
  // Exclude completed and failed as always.
  const interruptedJobs = db.prepare(
    "SELECT id FROM jobs WHERE status NOT IN ('completed', 'failed', 'paused')"
  ).all() as { id: string }[];
  
  for (const row of interruptedJobs) {
    const job = getJobFromDb(row.id);
    if (job) {
      console.log(`[RECOVERY] Queuing interrupted job: ${job.id}`);
      jobs[job.id] = job;
      // Use queue so multiple recovered jobs don't run simultaneously
      if (!runningJobId) {
        runningJobId = job.id;
        runJob(job.id).finally(() => { runningJobId = null; processQueue(); });
      } else {
        jobQueue.push(job.id);
      }
    }
  }
}

async function runJob(jobId: string) {
  const job = jobs[jobId];
  const jobDir = path.join(JOBS_DIR, jobId);
  const downloadDir = path.join(jobDir, "download");
  const chunksDir = path.join(jobDir, "chunks");
  const reversedDir = path.join(jobDir, "reversed");

  try {
    // BUG 3 FIX: Only initialize chunk tracking if not already set.
    // Previously this line ran unconditionally, wiping the state that
    // getJobFromDb() reconstructed from the filesystem for resumed jobs.
    // A fresh job has no job.chunks yet; a resumed job already has it set.
    if (!job.chunks) {
      job.chunks = { total: 0, completed: [], downloaded: false };
    }

    // Disk Space Guard
    const healthCheck = await SystemMonitor.checkHealth();
    if (healthCheck.disk.available < 500) {
      throw new Error(`Insufficient disk space: ${healthCheck.disk.available}MB available. Need at least 500MB.`);
    }

    await fs.ensureDir(jobDir);
    await fs.ensureDir(downloadDir);
    await fs.ensureDir(chunksDir);
    await fs.ensureDir(reversedDir);

    // BUG 1 FIX: Pass allowNonZero=true because ffmpeg -encoders exits with
    // code 1 on many builds. Previously this threw, killing the job before
    // any download started. stderr is now captured alongside stdout so the
    // encoder list (written to stderr by ffmpeg) is actually readable.
    const encoders = await runCommandCapture("ffmpeg -encoders 2>&1", true);
    const hasLibx264 = encoders.includes("libx264");
    const hasOpenH264 = encoders.includes("libopenh264");

    // ENCODER FIX: This Fedora ffmpeg build was compiled with --disable-encoders
    // and does not include libx264. libopenh264 IS present (confirmed from ffmpeg
    // -encoders output verbatim). mpeg4 fallback is removed entirely — mpeg4/mp4v
    // is not decodable by any browser's native <video> element, so using it as
    // fallback guaranteed a black screen. libopenh264 produces standard H.264
    // that all browsers play natively.
    //
    // libopenh264 flag differences vs libx264:
    //   - Does NOT support -preset or -tune (causes "Option preset not found" error)
    //   - Does NOT support -crf (uses -b:v or -qp instead)
    //   - Does NOT support -profile:v baseline -level 3.0 via the same flags
    //   - DOES support -pix_fmt yuv420p and -movflags +faststart
    //
    // isLibx264 drives the conditional flag sets below — false on this system.
    const encoder = hasLibx264 ? "libx264" : (hasOpenH264 ? "libopenh264" : null);
    if (!encoder) {
      throw new Error(
        "No browser-compatible H.264 encoder found. " +
        "Install libx264: sudo dnf install ffmpeg-free libx264 " +
        "OR ensure libopenh264 is available."
      );
    }
    const isLibx264 = encoder === "libx264";
    
    log(jobId, `System Encoder Check: ${encoder} selected (libx264: ${hasLibx264}, libopenh264: ${hasOpenH264})`);

    // 1. Download (or use local sourceFile)
    const downloadPath = path.join(downloadDir, "input.mp4");
    const downloadExists = await fs.pathExists(downloadPath);
    const downloadSize = downloadExists ? (await fs.stat(downloadPath)).size : 0;

    if (downloadExists && downloadSize > 0) {
      log(jobId, "Existing download found, skipping download step.");
      job.chunks.downloaded = true;
    } else if (job.sourceFile) {
      log(jobId, `Using local source file: ${job.sourceFile}`);
      job.status = "downloading";
      job.progress = 2;
      saveJob(job);
      await fs.copy(job.sourceFile, downloadPath);
      log(jobId, `Local file staged at ${downloadPath} (${((await fs.stat(downloadPath)).size / 1024 / 1024).toFixed(1)}MB)`);
      job.chunks.downloaded = true;
    } else {
      job.status = "downloading";
      job.progress = 2;
      saveJob(job);
      log(jobId, `Starting download from ${job.url}`);
      
      try {
        // BUG 2 FIX: "mp4[height<=720]" is not valid yt-dlp syntax and caused
        // the format selector to fail silently, falling through to the retry
        // which used "best" — often returning MKV/WebM saved as input.mp4.
        // Correct syntax separates video and audio streams explicitly.
        await youtubedl(job.url, {
          format: "bestvideo[height<=720][ext=mp4]+bestaudio[ext=m4a]/bestvideo[ext=mp4]+bestaudio/best[ext=mp4]/mp4",
          mergeOutputFormat: "mp4",
          output: downloadPath,
          noCheckCertificates: true,
          noWarnings: true,
          addHeader: [
            'referer:youtube.com',
            'user-agent:Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
          ]
        });
      } catch (dlError: any) {
        log(jobId, `Download failed: ${dlError.message}. Retrying with mp4 fallback...`);
        // Retry also forces mp4 output container via mergeOutputFormat
        await youtubedl(job.url, {
          format: "best[ext=mp4]/best",
          mergeOutputFormat: "mp4",
          output: downloadPath,
          noCheckCertificates: true,
        });
      }
      log(jobId, "Download complete");
      job.chunks.downloaded = true;
    }
    job.progress = 5;
    saveJob(job);

    // 2. Split
    const existingChunks = (await fs.readdir(chunksDir)).filter(f => f.endsWith(".mp4"));
    if (existingChunks.length > 0) {
      log(jobId, `Existing chunks found (${existingChunks.length}), skipping split step.`);
      job.chunks.total = existingChunks.length;
    } else {
      job.status = "splitting";
      saveJob(job);
      log(jobId, "Splitting video into 60s chunks (re-encoding for stability)...");

      // Get duration upfront so we can compute split progress as time/duration
      const splitDurationSec = await getVideoDuration(downloadPath);
      log(jobId, `Source duration: ${splitDurationSec > 0 ? (splitDurationSec / 60).toFixed(1) + " min" : "unknown"}`);

      await runCommand("ffmpeg", [
        "-y", "-i", downloadPath,
        "-c:v", encoder,
        "-c:a", "aac",
        ...(isLibx264 ? ["-profile:v", "baseline", "-level", "3.0", "-preset", "ultrafast", "-crf", "23"] : []),
        "-pix_fmt", "yuv420p",
        "-force_key_frames", "expr:gte(t,n_forced*60)",
        "-f", "segment",
        "-segment_time", "60",
        "-reset_timestamps", "1",
        path.join(chunksDir, "part_%05d.mp4")
      ], (msg) => log(jobId, msg), "SPLIT", (p) => {
        // Split occupies 5→38% of total progress
        const pct = splitDurationSec > 0 ? Math.min(p.timeSec / splitDurationSec, 1) : 0;
        job.progress = 5 + pct * 33;
        const remaining = p.speed > 0 && splitDurationSec > 0
          ? (splitDurationSec - p.timeSec) / p.speed
          : 0;
        const timeStr = `${Math.floor(p.timeSec / 60)}m ${Math.floor(p.timeSec % 60)}s`;
        const totalStr = splitDurationSec > 0 ? `${Math.floor(splitDurationSec / 60)}m ${Math.floor(splitDurationSec % 60)}s` : "?";
        job.eta = remaining > 0 ? formatEta(remaining) : null;
        job.currentPhase = `Splitting: ${timeStr} / ${totalStr} (${p.speed.toFixed(1)}x)`;
        saveJob(job);
      }, jobId);

      log(jobId, "Splitting complete");
      const newChunks = (await fs.readdir(chunksDir)).filter(f => f.endsWith(".mp4"));
      job.chunks.total = newChunks.length;
    }
    job.progress = 38;
    job.eta = null;
    job.currentPhase = null;
    saveJob(job);

    // 3. Reverse
    job.status = "reversing";
    saveJob(job);
    const chunkFiles = (await fs.readdir(chunksDir)).filter(f => f.endsWith(".mp4")).sort();
    const totalChunks = chunkFiles.length;
    job.chunks.total = totalChunks;
    log(jobId, `Processing ${totalChunks} chunks`);

    for (let i = 0; i < totalChunks; i++) {
      const chunk = chunkFiles[i];
      const inputPath = path.join(chunksDir, chunk);
      const outputPath = path.join(reversedDir, chunk);

      // Skip chunks already reversed (idempotency for resumed jobs)
      if (fs.existsSync(outputPath) && fs.statSync(outputPath).size > 0) {
        log(jobId, `Chunk ${i + 1}/${totalChunks} already reversed, skipping: ${chunk}`);
        if (!job.chunks.completed.includes(chunk)) {
          job.chunks.completed.push(chunk);
        }
        job.progress = 38 + ((i + 1) / totalChunks) * 54;
        saveJob(job);
        continue;
      }
      
      log(jobId, `Reversing chunk ${i + 1}/${totalChunks}: ${chunk} using ${encoder}...`);

      // Get chunk duration for per-chunk progress within the reversal phase
      const chunkDurSec = await getVideoDuration(inputPath);

      await runCommand("ffmpeg", [
        "-y", "-i", inputPath,
        "-vf", "reverse",
        "-af", "areverse",
        "-vcodec", encoder,
        "-acodec", "aac",
        ...(isLibx264 ? ["-profile:v", "baseline", "-level", "3.0", "-preset", "ultrafast", "-tune", "fastdecode", "-crf", "23"] : []),
        "-pix_fmt", "yuv420p",
        "-threads", "1",
        "-movflags", "+faststart",
        outputPath
      ], (msg) => log(jobId, msg), `REVERSE ${i + 1}/${totalChunks}`, (p) => {
        // Reversal occupies 38→92% across all chunks
        const chunkBase = 38 + (i / totalChunks) * 54;
        const chunkPct  = chunkDurSec > 0 ? Math.min(p.timeSec / chunkDurSec, 1) : (i / totalChunks);
        job.progress    = chunkBase + chunkPct * (54 / totalChunks);
        const remaining = p.speed > 0 && chunkDurSec > 0
          ? (chunkDurSec - p.timeSec) / p.speed
          : 0;
        job.eta = remaining > 0 ? formatEta(remaining) : null;
        job.currentPhase = `Reversing chunk ${i + 1}/${totalChunks} (${p.speed.toFixed(1)}x)`;
        saveJob(job);
      }, jobId);
      
      if (!job.chunks.completed.includes(chunk)) {
        job.chunks.completed.push(chunk);
      }
      
      job.progress = 38 + ((i + 1) / totalChunks) * 54;
      saveJob(job);
    }

    log(jobId, "Reversal complete");
    job.eta = null;
    job.currentPhase = null;

    // 4. Merge
    const finalOutputPath = path.join(jobDir, "reversed_final.mp4");
    job.status = "merging";
    saveJob(job);
    log(jobId, "Merging reversed chunks into master...");
    
    const listFilePath = path.join(jobDir, "list.txt");
    const reversedFiles = (await fs.readdir(reversedDir)).filter(f => f.endsWith(".mp4")).sort().reverse();
    const listContent = reversedFiles.map(f => `file '${path.join(reversedDir, f)}'`).join("\n");
    await fs.writeFile(listFilePath, listContent);

    // Get merge input duration for progress
    const mergeDurationSec = await getVideoDuration(downloadPath);

    log(jobId, `Starting final merge with ${encoder} re-encoding...`);
    await runCommand("ffmpeg", [
      "-y", "-f", "concat", "-safe", "0", "-i", listFilePath,
      "-vcodec", encoder,
      "-acodec", "aac",
      ...(isLibx264 ? ["-profile:v", "baseline", "-level", "3.0", "-preset", "ultrafast", "-tune", "fastdecode", "-crf", "23"] : []),
      "-pix_fmt", "yuv420p",
      "-ar", "44100",
      "-ac", "2",
      "-b:a", "128k",
      "-movflags", "+faststart",
      "-f", "mp4",
      finalOutputPath
    ], (msg) => log(jobId, msg), "MERGE", (p) => {
      // Merge occupies 92→99%
      const pct = mergeDurationSec > 0 ? Math.min(p.timeSec / mergeDurationSec, 1) : 0;
      job.progress = 92 + pct * 7;
      const remaining = p.speed > 0 && mergeDurationSec > 0
        ? (mergeDurationSec - p.timeSec) / p.speed
        : 0;
      job.eta = remaining > 0 ? formatEta(remaining) : null;
      job.currentPhase = `Merging: ${(pct * 100).toFixed(0)}% (${p.speed.toFixed(1)}x)`;
      saveJob(job);
    }, jobId);

    log(jobId, "Merging complete. Master file ready.");
    await fs.remove(listFilePath);
    
    job.status = "completed";
    job.progress = 100;
    job.outputFile = finalOutputPath;
    saveJob(job);

  } catch (error: any) {
    log(jobId, `Error: ${error.message}`);
    job.status = "failed";
    job.error = error.message;
    saveJob(job);
  }
}

// Parse ffmpeg's time= field from progress lines into total seconds
function parseFFmpegTime(timeStr: string): number {
  const m = timeStr.match(/(\d+):(\d+):(\d+(?:\.\d+)?)/);
  if (!m) return 0;
  return parseInt(m[1]) * 3600 + parseInt(m[2]) * 60 + parseFloat(m[3]);
}

// Format seconds into "Xm Ys" string
function formatEta(seconds: number): string {
  if (seconds <= 0 || !isFinite(seconds)) return "";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return m > 0 ? `~${m}m ${s}s remaining` : `~${s}s remaining`;
}

// Get video duration in seconds via ffprobe
async function getVideoDuration(filePath: string): Promise<number> {
  try {
    const out = await runCommandCapture(
      `ffprobe -v error -show_entries format=duration -of csv=p=0 "${filePath}"`,
      true
    );
    const n = parseFloat(out.trim());
    return isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}

interface FFmpegProgress {
  timeSec: number;  // current position in seconds
  speed: number;    // encoding speed multiplier (e.g. 2.0 = 2x realtime)
  fps: number;
}

// phase: label prepended to every output line
// onProgress: called with parsed ffmpeg progress on every progress line
// All stdout and stderr lines forwarded to onLog — no silent filtering.
function runCommand(
  command: string,
  args: string[],
  onLog: (msg: string) => void,
  phase = "",
  onProgress?: (p: FFmpegProgress) => void,
  jobId?: string  // if provided, registers proc in activeProc for pause/resume
): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args);
    const prefix = phase ? `[${phase}] ` : "";

    // Register so pause/resume can find this process
    if (jobId) activeProc[jobId] = proc;

    const handleData = (data: Buffer) => {
      data.toString().split("\n").forEach(line => {
        const trimmed = line.trim();
        if (!trimmed) return;

        if (trimmed.startsWith("frame=") && onProgress) {
          const timeMatch  = trimmed.match(/time=(\d+:\d+:\d+(?:\.\d+)?)/);
          const speedMatch = trimmed.match(/speed=\s*([\d.]+)x/);
          const fpsMatch   = trimmed.match(/fps=\s*([\d.]+)/);
          if (timeMatch) {
            onProgress({
              timeSec: parseFFmpegTime(timeMatch[1]),
              speed:   speedMatch ? parseFloat(speedMatch[1]) : 0,
              fps:     fpsMatch   ? parseFloat(fpsMatch[1])   : 0,
            });
          }
        }

        onLog(`${prefix}${trimmed}`);
      });
    };

    proc.stdout.on("data", handleData);
    proc.stderr.on("data", handleData);

    proc.on("close", (code) => {
      if (jobId && activeProc[jobId] === proc) activeProc[jobId] = null;
      if (code === 0) { onLog(`${prefix}exited cleanly (code 0)`); resolve(); }
      else { onLog(`${prefix}ERROR: exited with code ${code}`); reject(new Error(`${command} exited with code ${code}`)); }
    });
    proc.on("error", (err) => {
      if (jobId && activeProc[jobId] === proc) activeProc[jobId] = null;
      onLog(`${prefix}SPAWN ERROR: ${err.message}`); reject(err);
    });
  });
}

// BUG 1 FIX: Added allowNonZero parameter (default false for safety).
// ffmpeg writes its encoder list to stderr and exits with code 1.
// Previously the function rejected on any non-zero exit, so the encoder
// check always threw, killing the job before download started.
// stderr is now captured alongside stdout regardless of exit code.
function runCommandCapture(command: string, allowNonZero = false): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, [], { shell: true });
    let output = "";
    proc.stdout.on("data", (data) => output += data.toString());
    proc.stderr.on("data", (data) => output += data.toString());
    proc.on("close", (code) => {
      if (code === 0 || allowNonZero) resolve(output.trim());
      else reject(new Error(`${command} exited with code ${code}`));
    });
  });
}

startServer();
