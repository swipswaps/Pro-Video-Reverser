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

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = 3000;
const JOBS_DIR = path.join(process.cwd(), "jobs");

// Ensure jobs directory exists
fs.ensureDirSync(JOBS_DIR);

interface Job {
  id: string;
  url: string;
  status: "pending" | "downloading" | "splitting" | "reversing" | "merging" | "completed" | "failed";
  progress: number;
  logs: string[];
  outputFile?: string;
  error?: string;
}

const jobs: Record<string, Job> = {};

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
    
    if (jobs[jobId] && (jobs[jobId].status !== "failed")) {
      return res.json({ jobId });
    }

    const job: Job = {
      id: jobId,
      url,
      status: "pending",
      progress: 0,
      logs: ["Job initialized"],
    };

    jobs[jobId] = job;
    runJob(jobId);

    res.json({ jobId });
  });

  app.get("/api/jobs/:id", (req, res) => {
    const job = jobs[req.params.id];
    if (!job) {
      return res.status(404).json({ error: "Job not found" });
    }
    res.json(job);
  });

  app.get("/api/download/:id", (req, res) => {
    const job = jobs[req.params.id];
    if (!job || job.status !== "completed" || !job.outputFile) {
      return res.status(404).json({ error: "File not found" });
    }
    res.download(job.outputFile);
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
  });
}

function log(jobId: string, message: string) {
  const job = jobs[jobId];
  if (job) {
    const timestamp = new Date().toISOString();
    const logLine = `[${timestamp}] ${message}`;
    console.log(`[Job ${jobId}] ${message}`);
    job.logs.push(logLine);
    // Keep only last 1000 logs
    if (job.logs.length > 1000) job.logs.shift();
  }
}

async function runJob(jobId: string) {
  const job = jobs[jobId];
  const jobDir = path.join(JOBS_DIR, jobId);
  const downloadDir = path.join(jobDir, "download");
  const chunksDir = path.join(jobDir, "chunks");
  const reversedDir = path.join(jobDir, "reversed");

  try {
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
    } else {
      job.status = "downloading";
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
    }
    job.progress = 25;

    // 2. Split
    const existingChunks = (await fs.readdir(chunksDir)).filter(f => f.endsWith(".mp4"));
    if (existingChunks.length > 0) {
      log(jobId, `Existing chunks found (${existingChunks.length}), skipping split step.`);
    } else {
      job.status = "splitting";
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
    }
    job.progress = 40;

    // 3. Reverse
    job.status = "reversing";
    const chunkFiles = (await fs.readdir(chunksDir)).filter(f => f.endsWith(".mp4")).sort();
    const totalChunks = chunkFiles.length;
    log(jobId, `Processing ${totalChunks} chunks`);

    for (let i = 0; i < totalChunks; i++) {
      const chunk = chunkFiles[i];
      const inputPath = path.join(chunksDir, chunk);
      const outputPath = path.join(reversedDir, chunk);
      
      if (await fs.pathExists(outputPath) && (await fs.stat(outputPath)).size > 0) {
        log(jobId, `Chunk ${i + 1}/${totalChunks} already reversed, skipping.`);
      } else {
        log(jobId, `Reversing chunk ${i + 1}/${totalChunks}: ${chunk}`);
        
        await runCommand("ffmpeg", [
          "-y", "-i", inputPath,
          "-vf", "reverse",
          "-af", "areverse",
          "-preset", "ultrafast",
          "-threads", "1",
          outputPath
        ], (msg) => {});
      }
      
      job.progress = 40 + ((i + 1) / totalChunks) * 50;
    }

    log(jobId, "Reversal complete");

    // 4. Merge
    const finalOutputPath = path.join(jobDir, "reversed_final.mp4");
    if (await fs.pathExists(finalOutputPath) && (await fs.stat(finalOutputPath)).size > 0) {
      log(jobId, "Final output already exists, skipping merge.");
    } else {
      job.status = "merging";
      log(jobId, "Merging reversed chunks...");
      
      const listFilePath = path.join(jobDir, "list.txt");
      const reversedFiles = (await fs.readdir(reversedDir)).filter(f => f.endsWith(".mp4")).sort().reverse();
      const listContent = reversedFiles.map(f => `file '${path.join(reversedDir, f)}'`).join("\n");
      await fs.writeFile(listFilePath, listContent);

      await runCommand("ffmpeg", [
        "-y", "-f", "concat", "-safe", "0", "-i", listFilePath,
        "-c", "copy",
        finalOutputPath
      ], (msg) => log(jobId, msg));

      log(jobId, "Merging complete");
      await fs.remove(listFilePath);
    }
    
    job.status = "completed";
    job.progress = 100;
    job.outputFile = finalOutputPath;

    // Optional: Keep intermediate files for idempotency across restarts
    // If you want to save space, you could delete them only if the job is truly "finished" and user downloaded it.
    // For now, let's NOT remove them so that idempotency works if the server restarts or job is re-run.
    // await fs.remove(downloadDir);
    // await fs.remove(chunksDir);
    // await fs.remove(reversedDir);

  } catch (error: any) {
    log(jobId, `Error: ${error.message}`);
    job.status = "failed";
    job.error = error.message;
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

startServer();
