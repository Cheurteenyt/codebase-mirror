#!/usr/bin/env python3
# r78-runner.py — Single-run wrapper for V1/V2 benchmark.
#
# Spawns the given command as a child, measures:
#   - wall time (time.perf_counter_ns, high-precision monotonic)
#   - peak RSS (reads /proc/<pid>/status VmHWM — the child's actual peak,
#     NOT RUSAGE_CHILDREN which includes Python parent overhead)
#   - exit code
# Captures stdout and stderr to files for post-run parsing.
#
# Usage:
#   python3 r78-runner.py <stdout_file> <stderr_file> <env_files>... -- <cmd> <args>...
# Where <env_files> are KEY=VALUE pairs to set as env vars.
#
# Output (JSON to stdout):
#   {"wall_ms": <float>, "peak_rss_kb": <int>, "exit_code": <int>}
#
# R78 revision 2: switched from RUSAGE_CHILDREN to /proc VmHWM polling.
# RUSAGE_CHILDREN includes shared pages from the Python parent (fork overhead),
# inflating 'true' from 4KB to 13MB. VmHWM gives the child's true peak RSS.

import sys
import os
import json
import time
import subprocess
import threading

def read_vmhwm(pid):
    """Read VmHWM (peak RSS) from /proc/<pid>/status. Returns KB or 0 on error."""
    try:
        with open(f'/proc/{pid}/status') as f:
            for line in f:
                if line.startswith('VmHWM:'):
                    # Format: "VmHWM:\t     12345 kB\n"
                    return int(line.split()[1])
    except (FileNotFoundError, ValueError, IndexError):
        return 0
    return 0

def main():
    args = sys.argv[1:]
    # Parse: stdout_file stderr_file [ENV=VAL ...] -- cmd [args...]
    stdout_file = args[0]
    stderr_file = args[1]
    rest = args[2:]
    
    # Find the separator '--'
    sep_idx = rest.index('--')
    env_pairs = rest[:sep_idx]
    cmd = rest[sep_idx + 1:]
    
    env = os.environ.copy()
    for pair in env_pairs:
        if '=' in pair:
            k, v = pair.split('=', 1)
            env[k] = v
    
    start = time.perf_counter_ns()
    
    try:
        with open(stdout_file, 'wb') as fout, open(stderr_file, 'wb') as ferr:
            proc = subprocess.Popen(
                cmd,
                stdout=fout,
                stderr=ferr,
                env=env,
                start_new_session=True,  # isolate process group
            )
            
            # Poll VmHWM every 5ms while the child runs.
            # VmHWM only goes up (it's a high-water mark), so we just need
            # the last reading before the child exits. But the child might
            # exit between polls, so we take the max of all readings.
            # Final read after wait() may fail (/proc gone), so we read
            # while the process is alive.
            peak_rss_kb = 0
            return_code = None
            while return_code is None:
                rss = read_vmhwm(proc.pid)
                if rss > peak_rss_kb:
                    peak_rss_kb = rss
                try:
                    return_code = proc.wait(timeout=0.005)
                except subprocess.TimeoutExpired:
                    pass
            
            # Try one last read (process might still be in /proc briefly)
            rss = read_vmhwm(proc.pid)
            if rss > peak_rss_kb:
                peak_rss_kb = rss
            
            exit_code = return_code
    except subprocess.TimeoutExpired:
        end = time.perf_counter_ns()
        print(json.dumps({
            'wall_ms': (end - start) / 1e6,
            'peak_rss_kb': 0,
            'exit_code': -1,
            'error': 'timeout',
        }))
        return
    except Exception as e:
        end = time.perf_counter_ns()
        print(json.dumps({
            'wall_ms': (end - start) / 1e6,
            'peak_rss_kb': 0,
            'exit_code': -2,
            'error': str(e),
        }))
        return
    end = time.perf_counter_ns()
    wall_ms = (end - start) / 1e6
    
    print(json.dumps({
        'wall_ms': wall_ms,
        'peak_rss_kb': peak_rss_kb,
        'exit_code': exit_code,
    }))

if __name__ == '__main__':
    main()
