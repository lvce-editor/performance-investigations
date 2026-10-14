"""Sample native CPU stacks at the benchmark's process-entry/window boundary.

Use the pinned benchmark's launcher, isolated profile, cgroup membership, window
test and acknowledged cutoff. Sampling runs are diagnostic, never instruction
measurements. No report is published by this script.
"""
import argparse
import importlib
import json
import os
from pathlib import Path
import platform
import re
import signal
import subprocess
import sys


def stop_recording(process, profile, log):
    process.send_signal(signal.SIGINT)
    process.wait(timeout=10)
    log.flush()
    # perf record re-raises the requested SIGINT after writing its data. A
    # completed capture therefore commonly has returncode -SIGINT, unlike stat.
    raw = Path(log.name).read_text()
    samples = re.search(r'Captured and wrote .*\((\d+) samples\)', raw)
    if (process.returncode not in (0, -signal.SIGINT) or not profile.is_file()
            or not samples or int(samples[1]) == 0):
        raise RuntimeError(f'perf record did not complete with samples: exit {process.returncode}; inspect record.log')
    return {'recordExitCode': process.returncode, 'recordedSamples': int(samples[1])}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--benchmark', required=True, type=Path)
    parser.add_argument('--perf', required=True)
    parser.add_argument('--editor', required=True, choices=['lvce', 'basic-electron'])
    parser.add_argument('--output', required=True, type=Path)
    args = parser.parse_args()
    if platform.machine() != 'aarch64':
        parser.error('requires Linux ARM64')
    sys.path.insert(0, str(args.benchmark.resolve() / 'scripts'))
    benchmark = importlib.import_module('benchmark')
    counters = importlib.import_module('counters')
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=False)
    profiles = []

    class SampleCapture(counters.Capture):
        def __enter__(self):
            self.group.mkdir()
            try:
                for name in ['control', 'ack']:
                    path = self.directory / name
                    os.mkfifo(path)
                    self.fds.append(os.open(path, os.O_RDWR | os.O_NONBLOCK))
                trial_output = output / f'trial-{len(profiles) + 1}'
                trial_output.mkdir()
                profiles.append(trial_output)
                self.profile = trial_output / 'perf.data'
                self.log = (trial_output / 'record.log').open('w')
                self.process = subprocess.Popen([
                    self.perf, 'record', '-a', '-e', 'cycles:u', '-F', '997',
                    '--call-graph', 'dwarf,16384', '-G', self.group.name,
                    '-D', '-1', '--control', f'fd:{self.fds[0]},{self.fds[1]}',
                    '-o', str(self.profile),
                ], pass_fds=tuple(self.fds), stdout=subprocess.DEVNULL,
                    stderr=self.log, start_new_session=True)
                self.control('enable')
                return self
            except BaseException:
                self.__exit__(None, None, None)
                raise

        def finish(self):
            if self.disabled_at is None:
                raise RuntimeError('profile has no acknowledged cutoff')
            recorded = stop_recording(self.process, self.profile, self.log)
            return {'source': 'sampled user-space cycles, per-CPU cgroup',
                    'cutoffAcknowledged': True,
                    'profile': str(self.profile.relative_to(output)),
                    'instrumented': True, **recorded}

    benchmark.Capture = SampleCapture
    editor = next(e for e in json.loads((benchmark.ROOT / 'config/editors.lock.json').read_text())
                  if e['id'] == args.editor)
    results = []
    for repeat in range(1, 4):
        result = dict(benchmark.trial(editor, args.perf), repeat=repeat)
        results.append(result)
        # Persist each trial immediately, including invalid launches.
        (output / 'results.json').write_text(json.dumps({
            'editor': editor, 'benchmarkProtocol': benchmark.PROTOCOL,
            'benchmarkCommit': subprocess.check_output(
                ['git', '-C', str(args.benchmark), 'rev-parse', 'HEAD'], text=True).strip(),
            'host': {'machine': platform.machine(), 'kernel': platform.release(),
                     'cpuinfo': Path('/proc/cpuinfo').read_text(),
                     'perf': subprocess.check_output([args.perf, '--version'], text=True).strip()},
            'sampling': {'event': 'cycles:u', 'frequency': 997,
                         'callGraph': 'dwarf,16384', 'instrumented': True,
                         'comparison': 'not an unprofiled instruction measurement'},
            'trials': results,
        }, indent=2) + '\n')
        if not result['valid']:
            raise RuntimeError(f'invalid sampling trial {repeat}: {result.get("error")}')
        for name, options in [
            ('report.txt', ['report', '--stdio', '--no-children', '--sort', 'comm,dso,symbol']),
            ('stacks.txt', ['script']),
            ('header.txt', ['report', '--header-only', '--stdio']),
        ]:
            with (profiles[-1] / name).open('w') as report:
                subprocess.run([args.perf, *options, '-i', str(profiles[-1] / 'perf.data')],
                               stdout=report, check=True, timeout=120,
                               env={**os.environ, 'DEBUGINFOD_URLS': ''})
        if (profiles[-1] / 'stacks.txt').stat().st_size == 0:
            raise RuntimeError('recorded profile contains no readable samples')


if __name__ == '__main__':
    main()
