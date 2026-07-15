#!/usr/bin/env python3
# r78-runner.py — Single-run wrapper for V1/V2 benchmark.
#
# Spawns the given command as a child, measures:
#   - wall time (time.perf_counter_ns, high-precision monotonic)
#   - peak RSS (Linux /proc VmHWM, Windows PeakWorkingSetSize, macOS rusage,
#     or sampled ps RSS on other POSIX systems)
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
import platform
import signal

def terminate_process_tree(proc):
    """Terminate the benchmark command and descendants before returning."""
    if proc.poll() is not None:
        return
    if os.name == 'nt':
        try:
            subprocess.run(
                ['taskkill', '/PID', str(proc.pid), '/T', '/F'],
                check=False,
                capture_output=True,
                timeout=5,
            )
        except (FileNotFoundError, subprocess.TimeoutExpired, OSError):
            try:
                proc.kill()
            except OSError:
                pass
    else:
        try:
            os.killpg(proc.pid, signal.SIGTERM)
            proc.wait(timeout=1)
            return
        except (ProcessLookupError, subprocess.TimeoutExpired, OSError):
            pass
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except (ProcessLookupError, OSError):
            try:
                proc.kill()
            except OSError:
                pass

    try:
        proc.wait(timeout=5)
    except subprocess.TimeoutExpired:
        try:
            proc.kill()
            proc.wait(timeout=1)
        except (OSError, subprocess.TimeoutExpired):
            pass

def read_peak_rss_kb(pid):
    """Read child peak/current RSS in KB without third-party dependencies."""
    system = platform.system()
    if system == 'Linux':
        try:
            with open(f'/proc/{pid}/status') as status_file:
                for line in status_file:
                    if line.startswith('VmHWM:'):
                        return int(line.split()[1])
        except (FileNotFoundError, PermissionError, ValueError, IndexError):
            return 0
        return 0

    if system == 'Windows':
        try:
            import ctypes
            from ctypes import wintypes

            class PROCESS_MEMORY_COUNTERS(ctypes.Structure):
                _fields_ = [
                    ('cb', wintypes.DWORD),
                    ('PageFaultCount', wintypes.DWORD),
                    ('PeakWorkingSetSize', ctypes.c_size_t),
                    ('WorkingSetSize', ctypes.c_size_t),
                    ('QuotaPeakPagedPoolUsage', ctypes.c_size_t),
                    ('QuotaPagedPoolUsage', ctypes.c_size_t),
                    ('QuotaPeakNonPagedPoolUsage', ctypes.c_size_t),
                    ('QuotaNonPagedPoolUsage', ctypes.c_size_t),
                    ('PagefileUsage', ctypes.c_size_t),
                    ('PeakPagefileUsage', ctypes.c_size_t),
                ]

            process_query_limited_information = 0x1000
            kernel32 = ctypes.WinDLL('kernel32', use_last_error=True)
            psapi = ctypes.WinDLL('psapi', use_last_error=True)
            kernel32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
            kernel32.OpenProcess.restype = wintypes.HANDLE
            kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
            kernel32.CloseHandle.restype = wintypes.BOOL
            psapi.GetProcessMemoryInfo.argtypes = [
                wintypes.HANDLE,
                ctypes.POINTER(PROCESS_MEMORY_COUNTERS),
                wintypes.DWORD,
            ]
            psapi.GetProcessMemoryInfo.restype = wintypes.BOOL
            handle = kernel32.OpenProcess(
                process_query_limited_information, False, pid
            )
            if not handle:
                return 0
            try:
                counters = PROCESS_MEMORY_COUNTERS()
                counters.cb = ctypes.sizeof(counters)
                ok = psapi.GetProcessMemoryInfo(
                    handle, ctypes.byref(counters), counters.cb
                )
                return int(counters.PeakWorkingSetSize // 1024) if ok else 0
            finally:
                kernel32.CloseHandle(handle)
        except (AttributeError, OSError, ValueError):
            return 0

    if system == 'Darwin':
        try:
            import resource
            # macOS reports ru_maxrss in bytes (Linux reports KB).
            return int(resource.getrusage(resource.RUSAGE_CHILDREN).ru_maxrss // 1024)
        except (AttributeError, ValueError):
            return 0

    # Other POSIX systems expose current RSS through ps. Sampling the maximum
    # keeps the same fail-safe semantics as the Linux polling loop.
    try:
        result = subprocess.run(
            ['ps', '-o', 'rss=', '-p', str(pid)],
            check=False,
            capture_output=True,
            text=True,
            timeout=1,
        )
        return int(result.stdout.strip()) if result.returncode == 0 else 0
    except (FileNotFoundError, subprocess.TimeoutExpired, ValueError):
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

    try:
        timeout_ms = int(env.get('CBM_RUN_TIMEOUT_MS', '60000'))
    except ValueError:
        timeout_ms = 60000
    timeout_ms = max(1, timeout_ms)
    
    start = time.perf_counter_ns()
    
    try:
        with open(stdout_file, 'wb') as fout, open(stderr_file, 'wb') as ferr:
            popen_options = {
                'stdout': fout,
                'stderr': ferr,
                'env': env,
            }
            if os.name == 'nt':
                popen_options['creationflags'] = subprocess.CREATE_NEW_PROCESS_GROUP
            else:
                popen_options['start_new_session'] = True
            proc = subprocess.Popen(cmd, **popen_options)
            
            # Poll every 5ms while the child runs. Linux and Windows expose a
            # high-water mark; other POSIX systems return current RSS, so the
            # maximum sampled value is retained on every platform.
            peak_rss_kb = 0
            return_code = None
            timed_out = False
            deadline_ns = start + timeout_ms * 1_000_000
            while return_code is None:
                rss = read_peak_rss_kb(proc.pid)
                if rss > peak_rss_kb:
                    peak_rss_kb = rss
                try:
                    return_code = proc.wait(timeout=0.005)
                except subprocess.TimeoutExpired:
                    pass
                if return_code is None and time.perf_counter_ns() >= deadline_ns:
                    timed_out = True
                    terminate_process_tree(proc)
                    return_code = proc.poll()
            
            # Try one last read while the process handle/status may still exist.
            rss = read_peak_rss_kb(proc.pid)
            if rss > peak_rss_kb:
                peak_rss_kb = rss
            
            exit_code = return_code if return_code is not None else -1
            if timed_out:
                end = time.perf_counter_ns()
                print(json.dumps({
                    'wall_ms': (end - start) / 1e6,
                    'peak_rss_kb': peak_rss_kb,
                    'exit_code': -1,
                    'error': 'timeout',
                }))
                return
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
