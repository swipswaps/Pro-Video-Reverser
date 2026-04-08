#!/usr/bin/env python3
# =============================================================================
# forensic_latency_probe_v13.py
# =============================================================================
# CANONICAL FORENSIC LATENCY ANALYZER v13.3.0
# =============================================================================

import os
import sys
import subprocess
import shutil
import datetime
import traceback
import argparse
import time
import re
import sqlite3
import signal
from threading import Thread

# =============================================================================
# CONFIGURATION & CONSTANTS
# =============================================================================

LOG_DIR = os.path.abspath("./forensic_logs")
os.makedirs(LOG_DIR, exist_ok=True)
DB_FILE = os.path.join(LOG_DIR, "forensic_audit.db")
HTML_FILE = os.path.abspath("./forensic_summary.html")
DEPS_MARKER = os.path.join(LOG_DIR, ".deps_installed")

REQUIRED_TOOLS = [
    "vmstat", "iostat", "pidstat", "mpstat",
    "ss", "ping", "lsof", "uptime"
]

SUMMARY_LINES = []
CURRENT_RUN_ID = None

# =============================================================================
# DATABASE MANAGEMENT
# =============================================================================

class DatabaseManager:
    @staticmethod
    def init_db():
        try:
            conn = sqlite3.connect(DB_FILE)
            cursor = conn.cursor()
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS runs (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    timestamp TEXT DEFAULT CURRENT_TIMESTAMP,
                    mode TEXT,
                    status TEXT,
                    log_path TEXT,
                    html_path TEXT,
                    summary TEXT
                )
            """)
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS metrics (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    run_id INTEGER,
                    key TEXT,
                    value REAL,
                    timestamp TEXT DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY(run_id) REFERENCES runs(id)
                )
            """)
            conn.commit()
            conn.close()
        except Exception:
            pass

    @staticmethod
    def start_run(mode):
        try:
            conn = sqlite3.connect(DB_FILE)
            cursor = conn.cursor()
            cursor.execute("INSERT INTO runs (mode, status) VALUES (?, ?)", (mode, "RUNNING"))
            run_id = cursor.lastrowid
            conn.commit()
            conn.close()
            return run_id
        except Exception:
            return None

    @staticmethod
    def update_run_status(run_id, status, log_path=None, html_path=None, summary=None):
        if not run_id: return
        try:
            conn = sqlite3.connect(DB_FILE)
            cursor = conn.cursor()
            cursor.execute(
                "UPDATE runs SET status = ?, log_path = ?, html_path = ?, summary = ? WHERE id = ?",
                (status, log_path, html_path, summary, run_id)
            )
            conn.commit()
            conn.close()
        except Exception:
            pass

    @staticmethod
    def log_metric(run_id, key, value):
        if not run_id: return
        try:
            conn = sqlite3.connect(DB_FILE)
            cursor = conn.cursor()
            cursor.execute("INSERT INTO metrics (run_id, key, value) VALUES (?, ?, ?)", (run_id, key, value))
            conn.commit()
            conn.close()
        except Exception:
            pass

# =============================================================================
# CORE MODULES
# =============================================================================

def psi():
    print("\n[MODULE:PSI] PRESSURE STALL INFORMATION")
    for f in ["cpu", "memory", "io"]:
        path = f"/proc/pressure/{f}"
        if os.path.exists(path):
            try:
                with open(path, "r") as file:
                    content = file.read().strip()
                    print(f"[PSI:{f.upper()}] {content}")
                    match = re.search(r"some avg10=([\d.]+)", content)
                    if match:
                        val = float(match.group(1))
                        DatabaseManager.log_metric(CURRENT_RUN_ID, f"{f.upper()}_PRESSURE", val)
                        if val > 10.0:
                            SUMMARY_LINES.append(f"CRITICAL: High {f.upper()} pressure: {val}%")
            except Exception:
                pass

def cpu_sched():
    print("\n[MODULE:CPU] LOAD AND UPTIME")
    try:
        out = subprocess.check_output(["uptime"], text=True).strip()
        print(f"[UPTIME] {out}")
        match = re.search(r"load average:\s+([\d.]+)", out)
        if match:
            val = float(match.group(1))
            DatabaseManager.log_metric(CURRENT_RUN_ID, "LOAD_AVG", val)
            print(f"[METRIC:LOAD_AVG] {val}")
    except Exception:
        pass

def run_probe(module=None):
    global SUMMARY_LINES
    SUMMARY_LINES = []
    global CURRENT_RUN_ID

    DatabaseManager.init_db()
    CURRENT_RUN_ID = DatabaseManager.start_run("MODULE:" + module if module else "STANDARD")

    if module == "DEPS":
        missing = [t for t in REQUIRED_TOOLS if shutil.which(t) is None]
        if missing:
            print(f"[DEPS:MISSING] {missing}")
        else:
            print("[DEPS:OK] All core tools present.")
    else:
        psi()
        cpu_sched()

    DatabaseManager.update_run_status(CURRENT_RUN_ID, "SUCCESS", summary="\n".join(SUMMARY_LINES))
    print("\n[COMPLETE]")

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--module", type=str, default=None)
    args = parser.parse_args()
    run_probe(module=args.module)
