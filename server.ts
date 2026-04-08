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

class SystemForensics {
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
      const parts = df.split(/\s+/);
      return {
        total: parseInt(parts[1]),
        available: parseInt(parts[3])
      };
    } catch {
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

  // Forensic Discovery: Reconstruct chunk state from filesystem
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

    // Use a stable jobId based on URL hash for idempotency
    const jobId = crypto.createHash("md5").update(url).digest("hex");
    
    let job = getJobFromDb(jobId);
    if (job && (job.status !== "failed")) {
      jobs[jobId] = job; // Cache it
      return res.json({ jobId });
    }

    job = {
      id: jobId,
      url,
      status: "pending",
      progress: 0,
      logs: ["Job initialized"],
    };

    jobs[jobId] = job;
    saveJob(job);
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
      res.sendFile(job.outputFile);
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
        const stats = fs.statSync(path.join(dir, f));
        return { name: f, size: stats.size, mtime: stats.mtime };
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
    const health = await SystemForensics.checkHealth();
    res.json(health);
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
    // Initialize chunk tracking
    job.chunks = { total: 0, completed: [], downloaded: false };

    // Disk Space Guard
    const healthCheck = await SystemForensics.checkHealth();
    if (healthCheck.disk.available < 500) {
      throw new Error(`Insufficient disk space: ${healthCheck.disk.available}MB available. Need at least 500MB.`);
    }

    await fs.ensureDir(jobDir);
    await fs.ensureDir(downloadDir);
    await fs.ensureDir(chunksDir);
    await fs.ensureDir(reversedDir);

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
      
      await youtubedl(job.url, {
        format: "bestvideo+bestaudio/best",
        mergeOutputFormat: "mp4",
        output: downloadPath,
        noCheckCertificates: true,
        noWarnings: true,
        addHeader: [
          'referer:youtube.com',
          'user-agent:Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
        ]
      });
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
      log(jobId, "Splitting video into 60s chunks...");
      
      await runCommand("ffmpeg", [
        "-y", "-i", downloadPath,
        "-c", "copy",
        "-map", "0",
        "-segment_time", "60",
        "-f", "segment",
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
      
      if (await fs.pathExists(outputPath) && (await fs.stat(outputPath)).size > 0) {
        log(jobId, `Chunk ${i + 1}/${totalChunks} already reversed, skipping.`);
        job.chunks.completed.push(chunk);
      } else {
        // Forensic Throttling
        let health = await SystemForensics.checkHealth();
        while (health.load > 4.0 || health.psi > 20.0) {
          log(jobId, `System load high (Load: ${health.load}, PSI: ${health.psi}%). Throttling...`);
          await new Promise(r => setTimeout(r, 5000));
          health = await SystemForensics.checkHealth();
        }

        log(jobId, `Reversing chunk ${i + 1}/${totalChunks}: ${chunk}`);
        
        await runCommand("ffmpeg", [
          "-y", "-i", inputPath,
          "-vf", "reverse",
          "-af", "areverse",
          "-c:v", "libx264",
          "-pix_fmt", "yuv420p",
          "-c:a", "aac",
          "-preset", "ultrafast",
          "-crf", "23",
          "-threads", "1",
          outputPath
        ], (msg) => {});
        job.chunks.completed.push(chunk);
      }
      
      job.progress = 40 + ((i + 1) / totalChunks) * 50;
      saveJob(job);
    }

    log(jobId, "Reversal complete");

    // 4. Merge
    const finalOutputPath = path.join(jobDir, "reversed_final.mp4");
    if (await fs.pathExists(finalOutputPath) && (await fs.stat(finalOutputPath)).size > 0) {
      log(jobId, "Final output already exists, skipping merge.");
    } else {
      job.status = "merging";
      saveJob(job);
      log(jobId, "Merging reversed chunks into master...");
      
      const listFilePath = path.join(jobDir, "list.txt");
      const reversedFiles = (await fs.readdir(reversedDir)).filter(f => f.endsWith(".mp4")).sort().reverse();
      const listContent = reversedFiles.map(f => `file '${path.join(reversedDir, f)}'`).join("\n");
      await fs.writeFile(listFilePath, listContent);

      // Re-encode during merge to ensure absolute browser compatibility (H.264 High Profile, YUV420P)
      await runCommand("ffmpeg", [
        "-y", "-f", "concat", "-safe", "0", "-i", listFilePath,
        "-c:v", "libx264",
        "-pix_fmt", "yuv420p",
        "-preset", "ultrafast",
        "-crf", "23",
        "-c:a", "aac",
        "-movflags", "+faststart",
        finalOutputPath
      ], (msg) => log(jobId, msg));

      log(jobId, "Merging complete. Master file ready.");
      await fs.remove(listFilePath);
    }
    
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

function runCommandCapture(command: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, [], { shell: true });
    let output = "";
    proc.stdout.on("data", (data) => output += data.toString());
    proc.on("close", (code) => {
      if (code === 0) resolve(output.trim());
      else reject(new Error(`${command} exited with code ${code}`));
    });
  });
}

startServer();
