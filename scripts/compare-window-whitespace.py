"""Alternate repeated baseline/candidate launches using production instruction accounting."""
import argparse
import importlib
import json
import os
from pathlib import Path
import platform
import subprocess
import sys
import time


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--benchmark', required=True, type=Path)
    parser.add_argument('--candidate', required=True, type=Path)
    parser.add_argument('--baseline', type=Path, help='Explicit integrated baseline; defaults to the screenshot package')
    parser.add_argument('--perf', required=True)
    parser.add_argument('--output', required=True, type=Path)
    parser.add_argument('--hold-seconds', type=int, choices=[0, 5], default=0)
    parser.add_argument('--repeats', type=int, choices=[3, 9], default=9)
    args = parser.parse_args()
    if platform.machine() != 'aarch64':
        parser.error('requires Linux ARM64')
    sys.path.insert(0, str(args.benchmark.resolve() / 'scripts'))
    benchmark = importlib.import_module('benchmark')
    editor = next(e for e in json.loads((benchmark.ROOT / 'config/editors.lock.json').read_text()) if e['id'] == 'lvce')
    command_for = benchmark.command_for
    baseline_root = args.baseline.resolve() if args.baseline else benchmark.ROOT / '.tmp/apps/lvce'
    baseline_binary = baseline_root / editor['binary']
    candidate_binary = args.candidate.resolve() / editor['binary']
    original_capture = benchmark.Capture

    class ExtendedCapture(original_capture):
        def cutoff(self):
            # A separate cumulative-work experiment. Never publish these trials
            # as first-window measurements. The normal experiment uses 0 delay.
            if args.hold_seconds:
                time.sleep(args.hold_seconds)
            super().cutoff()

    benchmark.Capture = ExtendedCapture
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=False)
    result = {
        'editor': editor, 'protocol': benchmark.PROTOCOL,
        'baselineRoot': str(baseline_root), 'candidateRoot': str(args.candidate.resolve()),
        'additionalWorkIntervalSeconds': args.hold_seconds,
        'boundary': 'first visible normal window' if not args.hold_seconds else 'five seconds after first visible normal window (cumulative-work guard)',
        'host': {'machine': platform.machine(), 'kernel': platform.release(), 'cpuinfo': Path('/proc/cpuinfo').read_text()},
        'runUrl': os.environ.get('BENCHMARK_RUN_URL'),
        'benchmarkCommit': subprocess.check_output(['git', '-C', str(args.benchmark), 'rev-parse', 'HEAD'], text=True).strip(),
        'trials': [],
    }
    for repeat in range(1, args.repeats + 1):
        for variant, binary in [('baseline', baseline_binary), ('candidate', candidate_binary)]:
            def launch_command(entry, home):
                command = command_for(entry, home)
                command[0] = str(binary)
                return command
            benchmark.command_for = launch_command
            trial = dict(benchmark.trial(editor, args.perf), repeat=repeat, variant=variant)
            result['trials'].append(trial)
            (output / 'results.json').write_text(json.dumps(result, indent=2) + '\n')
            if not trial['valid']:
                raise RuntimeError(f'{variant} trial {repeat} invalid: {trial.get("error")}')


if __name__ == '__main__':
    main()
