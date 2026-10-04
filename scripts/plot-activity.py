"""Optional trace heatmap: python3 scripts/plot-activity.py summary.json timeline.svg."""
import json
import sys
import numpy as np
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt

summary = json.load(open(sys.argv[1], encoding='utf8'))
profiles = summary['profiles']
seconds = max((bucket['second'] for profile in profiles for bucket in profile['timeline']), default=0) + 1
activity = np.zeros((len(profiles), seconds))
for index, profile in enumerate(profiles):
    for bucket in profile['timeline']:
        activity[index, bucket['second']] = bucket['nonIdleMs'] / 1000
labels = [profile['role'].rsplit('/', 1)[-1].replace('.js', '') for profile in profiles]
plt.rcParams['svg.fonttype'] = 'none'
figure, axes = plt.subplots(figsize=(13, max(5, len(profiles) * 0.28)))
image = axes.imshow(activity, aspect='auto', interpolation='none', cmap='magma', vmin=0, vmax=1, extent=(0, seconds, len(profiles), 0))
axes.set_yticks(np.arange(len(profiles)) + 0.5, labels)
axes.set_xlabel('Seconds since first recorded profile (trace begins after app ready)')
axes.set_title('LVCE startup capture: estimated non-idle sample residency per thread')
figure.colorbar(image, ax=axes, label='Fraction of second with non-idle samples')
figure.tight_layout()
figure.savefig(sys.argv[2])
