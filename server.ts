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

const jobs: Record<string, Job> = {};

function saveJob(job: Job) {
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO jobs (id, url, status, progress, outputFile, error)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  stmt.run(job.id, job.url, job.status, job.progress, job.outputFile || null, job.error || null);
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
    const { url } = req.body;
    if (!url) {
      return res.status(400).json({ error: "URL is required" });
    }

    console.log(`SERVER: Received request to initialize job for ${url}`);
    // Use a stable jobId based on URL hash for idempotency
    const jobId = crypto.createHash("md5").update(url).digest("hex");
    
    // Force fresh start if job already exists but user is re-initializing
    const jobDir = path.join(JOBS_DIR, jobId);
    if (fs.existsSync(jobDir)) {
      console.log(`SERVER: Wiping existing job directory for ${jobId}`);
      await fs.remove(jobDir);
    }
    // Also clear from DB to ensure fresh runJob
    console.log(`SERVER: Clearing existing job record for ${jobId}`);
    db.prepare("DELETE FROM logs WHERE job_id = ?").run(jobId);
    db.prepare("DELETE FROM jobs WHERE id = ?").run(jobId);
    delete jobs[jobId];

    let job: Job = {
      id: jobId,
      url,
      status: "pending",
      progress: 0,
      logs: ["Job initialized"],
    };

    jobs[jobId] = job;
    saveJob(job);
    console.log(`SERVER: Starting runJob for ${jobId}`);
    runJob(jobId);

    res.json({ jobId });
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
      
      // 3. Remove files from disk
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

  app.get("/api/media", (req, res) => {
    const filePath = req.query.path as string;
    if (!filePath || !fs.existsSync(filePath)) {
      console.error(`SERVER: Media not found: ${filePath}`);
      return res.status(404).json({ error: "File not found" });
    }

    const stat = fs.statSync(filePath);
    const fileSize = stat.size;
    const range = req.headers.range;

    if (range) {
      const parts = range.replace(/bytes=/, "").split("-");
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
      const chunksize = (end - start) + 1;
      const file = fs.createReadStream(filePath, { start, end });
      const head = {
        'Content-Range': `bytes ${start}-${end}/${fileSize}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunksize,
        'Content-Type': 'video/mp4',
      };
      res.writeHead(206, head);
      file.pipe(res);
    } else {
      const head = {
        'Content-Length': fileSize,
        'Content-Type': 'video/mp4',
      };
      res.writeHead(200, head);
      fs.createReadStream(filePath).pipe(res);
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
  const interruptedJobs = db.prepare("SELECT id FROM jobs WHERE status NOT IN ('completed', 'failed')").all() as { id: string }[];
  
  for (const row of interruptedJobs) {
    const job = getJobFromDb(row.id);
    if (job) {
      console.log(`[RECOVERY] Resuming Job: ${job.id}`);
      jobs[job.id] = job;
      runJob(job.id);
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

    // 1. Download
    const downloadPath = path.join(downloadDir, "input.mp4");
    const downloadExists = await fs.pathExists(downloadPath);
    const downloadSize = downloadExists ? (await fs.stat(downloadPath)).size : 0;

    if (downloadExists && downloadSize > 0) {
      log(jobId, "Existing download found, skipping download step.");
      job.chunks.downloaded = true;
    } else {
      job.status = "downloading";
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
    job.progress = 25;
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
      
      // Re-encoding during split ensures keyframes are at the start of each segment.
      // -preset/-tune/-crf are libx264-only; libopenh264 ignores or errors on them.
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
      ], (msg) => log(jobId, msg));

      log(jobId, "Splitting complete");
      const newChunks = (await fs.readdir(chunksDir)).filter(f => f.endsWith(".mp4"));
      job.chunks.total = newChunks.length;
    }
    job.progress = 40;
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
        job.progress = 40 + ((i + 1) / totalChunks) * 50;
        saveJob(job);
        continue;
      }
      
      log(jobId, `Reversing chunk ${i + 1}/${totalChunks}: ${chunk} using ${encoder}...`);
      
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
      ], (msg) => {
        if (msg.includes("Error") || msg.includes("Unknown encoder") || msg.includes("Option") && msg.includes("not found")) {
          log(jobId, `FFmpeg Error: ${msg}`);
        }
      });
      
      if (!job.chunks.completed.includes(chunk)) {
        job.chunks.completed.push(chunk);
      }
      
      job.progress = 40 + ((i + 1) / totalChunks) * 50;
      saveJob(job);
    }

    log(jobId, "Reversal complete");

    // 4. Merge
    const finalOutputPath = path.join(jobDir, "reversed_final.mp4");
    job.status = "merging";
    saveJob(job);
    log(jobId, "Merging reversed chunks into master...");
    
    const listFilePath = path.join(jobDir, "list.txt");
    const reversedFiles = (await fs.readdir(reversedDir)).filter(f => f.endsWith(".mp4")).sort().reverse();
    const listContent = reversedFiles.map(f => `file '${path.join(reversedDir, f)}'`).join("\n");
    await fs.writeFile(listFilePath, listContent);

    // Re-encode during merge to ensure absolute browser compatibility.
    // libopenh264 produces H.264 Main Profile by default — fully browser-compatible.
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
    ], (msg) => log(jobId, msg));

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

function runCommand(command: string, args: string[], onLog: (msg: string) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args);
    
    proc.stdout.on("data", (data) => onLog(data.toString().trim()));
    proc.stderr.on("data", (data) => onLog(data.toString().trim()));
    
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with code ${code}`));
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
