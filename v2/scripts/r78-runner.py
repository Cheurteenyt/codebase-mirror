#!/usr/bin/env python3
# r78-runner.py — Single-run wrapper for V1/V2 benchmark.
#
# Spawns the given command as a child, measures:
#   - wall time (time.perf_counter_ns, high-precision monotonic)
#   - peak RSS (resource.getrusage(RUSAGE_CHILDREN).ru_maxrss — Linux: KB)
#   - exit code
# Captures stdout and stderr to files for post-run parsing.
#
# Usage:
#   python3 r78-runner.py <stdout_file> <stderr_file> <env_files>... -- <cmd> <args>...
# Where <env_files> are KEY=VALUE pairs to set as env vars.
#
# Output (JSON to stdout):
#   {"wall_ms": <float>, "peak_rss_kb": <int>, "exit_code": <int>}

import sys
import os
import json
import time
import resource
import subprocess

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
    
    # Get baseline RSS from RUSAGE_CHILDREN (max over all prior children)
    rusage_before = resource.getrusage(resource.RUSAGE_CHILDREN)
    baseline_maxrss = rusage_before.ru_maxrss  # KB on Linux
    
    start = time.perf_counter_ns()
    try:
        with open(stdout_file, 'wb') as fout, open(stderr_file, 'wb') as ferr:
            proc = subprocess.run(
                cmd,
                stdout=fout,
                stderr=ferr,
                env=env,
                timeout=60,
            )
        exit_code = proc.returncode
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
    
    # After child exits, RUSAGE_CHILDREN.ru_maxrss is the max RSS of any child
    # ever run by THIS Python process. Since this Python process has only ever
    # run this ONE child, ru_maxrss is exactly this child's peak RSS.
    rusage_after = resource.getrusage(resource.RUSAGE_CHILDREN)
    peak_rss_kb = rusage_after.ru_maxrss
    
    print(json.dumps({
        'wall_ms': wall_ms,
        'peak_rss_kb': peak_rss_kb,
        'exit_code': exit_code,
    }))

if __name__ == '__main__':
    main()
