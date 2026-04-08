import blessed from 'blessed';
import contrib from 'blessed-contrib';
import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs-extra';
import os from 'os';
import { execSync } from 'child_process';

const DB_PATH = path.join(process.cwd(), 'forensic_logs', 'jobs.db');
const JOBS_DIR = path.join(process.cwd(), 'jobs');
const db = new Database(DB_PATH);

const screen = blessed.screen({
  smartCSR: true,
  title: 'PRO VIDEO REVERSER - TUI MISSION CONTROL'
});

const grid = new contrib.grid({rows: 12, cols: 12, screen: screen});

// 1. System Health (Load)
const loadLine = grid.set(0, 0, 4, 6, contrib.line, {
  style: { line: "yellow", text: "white", baseline: "black" },
  xLabelPadding: 3,
  xPadding: 5,
  label: ' SYSTEM LOAD (1m) '
});

// 2. Disk Usage
const diskDonut = grid.set(0, 6, 4, 3, contrib.donut, {
  label: ' DISK USAGE ',
  radius: 8,
  arcWidth: 3,
  remainColor: 'black',
  yPadding: 2
});

// 3. Active Job Status
const jobTable = grid.set(4, 0, 4, 9, contrib.table, {
  keys: true,
  fg: 'white',
  selectedFg: 'white',
  selectedBg: 'blue',
  interactive: true,
  label: ' ACTIVE JOBS ',
  width: '100%',
  height: '100%',
  border: {type: "line", fg: "cyan"},
  columnSpacing: 10,
  columnWidth: [32, 12, 10, 30]
});

// 4. File Explorer
const fileTree = grid.set(0, 9, 8, 3, contrib.tree, {
  label: ' FORENSIC FILE EXPLORER ',
  style: { text: "white" }
});

// 5. Update Status
const updateBox = grid.set(8, 9, 4, 3, blessed.box, {
  label: ' UPDATE STATUS ',
  content: 'Checking for updates...',
  style: { fg: 'green' },
  border: { type: 'line', fg: 'green' }
});

// 6. Logs
const logBox = grid.set(8, 0, 4, 9, contrib.log, {
  fg: "green",
  selectedFg: "green",
  label: ' SYSTEM LOGS '
});

const loadData = {
  title: 'Load',
  x: Array.from({length: 20}, (_, i) => i.toString()),
  y: Array.from({length: 20}, () => 0)
};

function update() {
  // Update Load
  const load = os.loadavg()[0];
  loadData.y.shift();
  loadData.y.push(load);
  loadLine.setData([loadData]);

  // Update Disk
  try {
    const stats = fs.statfsSync('/');
    const total = Number(stats.blocks * stats.bsize);
    const free = Number(stats.bfree * stats.bsize);
    const used = total - free;
    const percent = (used / total) * 100;
    diskDonut.setData([
      {percent: Math.round(percent), label: 'Used', color: 'red'}
    ]);
  } catch (e) {}

  // Update Logs
  try {
    const rows = db.prepare("SELECT id, status, progress, url FROM jobs ORDER BY created_at DESC LIMIT 5").all() as any[];
    
    // Update Status Box
    try {
      execSync('git fetch');
      const status = execSync('git status -uno').toString();
      if (status.includes('Your branch is behind')) {
        updateBox.setContent('{center}{bold}UPDATE AVAILABLE{/bold}\n\nRun "npm run dev" to apply updates.{/center}');
        updateBox.style.fg = 'yellow';
        updateBox.style.border.fg = 'yellow';
      } else {
        updateBox.setContent('{center}System Up to Date{/center}');
        updateBox.style.fg = 'green';
        updateBox.style.border.fg = 'green';
      }
    } catch (e) {
      updateBox.setContent('{center}Update Check Failed{/center}');
    }

    const tableData = rows.map(r => [r.id, r.status, `${Math.round(r.progress)}%`, r.url]);
    jobTable.setData({
      headers: ['JOB ID', 'STATUS', 'PROGRESS', 'SOURCE URL'],
      data: tableData
    });

    // Update File Tree for latest job
    if (rows.length > 0) {
      const latestJobId = rows[0].id;
      const jobDir = path.join(JOBS_DIR, latestJobId);
      if (fs.existsSync(jobDir)) {
        const treeData: any = {
          name: latestJobId,
          extended: true,
          children: {}
        };

        const dirs = ['download', 'chunks', 'reversed'];
        dirs.forEach(d => {
          const dPath = path.join(jobDir, d);
          if (fs.existsSync(dPath)) {
            treeData.children[d] = {
              name: d,
              children: fs.readdirSync(dPath).slice(0, 10).map(f => ({name: f}))
            };
          }
        });
        fileTree.setData(treeData);
      }
    }

    // Update Logs
    if (rows.length > 0) {
      const logs = db.prepare("SELECT message FROM logs WHERE job_id = ? ORDER BY timestamp DESC LIMIT 10").all(rows[0].id) as any[];
      logs.reverse().forEach(l => logBox.log(l.message));
    }
  } catch (e) {}

  screen.render();
}

setInterval(update, 2000);

screen.key(['escape', 'q', 'C-c'], () => {
  return process.exit(0);
});

update();
