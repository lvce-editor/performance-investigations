"""Plot the retained combined release comparison; requires matplotlib/numpy."""
import json
import statistics
from pathlib import Path
import matplotlib.pyplot as plt

runs = json.loads(Path('investigations/combined-released-overview.json').read_text())
metrics = [
    ('Trace duration', lambda row: row['traceDurationMs']),
    ('ESLint resolver residency', lambda row: next(p['nonIdleMs'] for p in row['profiles'] if 'moduleResolutionWorkerMain' in p['role'])),
    ('TypeScript worker residency', lambda row: next(p['nonIdleMs'] for p in row['profiles'] if 'typescriptWorkerMain' in p['role'])),
]
fig, axes = plt.subplots(1, 3, figsize=(12, 4.4))
for ax, (title, value) in zip(axes, metrics):
    groups = [[value(row) / 1000 for row in runs if row['variant'] == variant] for variant in ['baseline', 'candidate']]
    medians = [statistics.median(group) for group in groups]
    ax.bar([0, 1], medians, width=.58, color=['#64748b', '#168a7b'])
    for x, group in enumerate(groups):
        ax.scatter([x-.06, x, x+.06], group, color='#172033', s=22, zorder=3)
        ax.text(x, max(group)+1.5, f'{medians[x]:.1f}s', ha='center', fontsize=10)
    ax.set_xticks([0, 1], ['Baseline', 'Optimized'])
    ax.set_ylim(0, max(max(group) for group in groups)*1.2)
    ax.set_title(title, fontsize=11)
    ax.set_ylabel('Seconds')
    ax.spines[['right', 'top']].set_visible(False)
    ax.text(.5, -.22, f'{(1-medians[1]/medians[0])*100:.1f}% lower median', transform=ax.transAxes, ha='center', fontsize=10)
fig.suptitle('Cold diagnostic startup with released extensions', fontsize=14)
fig.text(.5, .90, 'Same LVCE runtime and workspace · three alternating runs · dots show individual runs', ha='center', fontsize=10)
fig.text(.5, .025, 'Residency includes blocking RPC waits; it is not OS CPU time. Trace duration includes profiling. Worker times overlap.', ha='center', fontsize=9)
fig.subplots_adjust(top=.80, bottom=.25, wspace=.32)
fig.savefig('investigations/combined-release-comparison.svg', bbox_inches='tight')
