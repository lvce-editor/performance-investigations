"""Plot saved TypeScript comparison medians. Requires matplotlib."""
import json
import sys
from pathlib import Path
import matplotlib.pyplot as plt

with open(sys.argv[1], encoding="utf-8") as source:
    data = json.load(source)

fig, axes = plt.subplots(1, 2, figsize=(12, 4.4), constrained_layout=True)
fig.suptitle("TypeScript 6.0.3 on the same about-view project", fontsize=15)

values = [data["node"]["tsc"]["processElapsedMs"], data["node"]["native"]["diagnosticRequestMs"], data["node"]["lvce"]["diagnosticRequestMs"], data["browser"]["diagnosticRequestMs"]]
labels = ["Whole-project CLI*", "Standard Node host", "LVCE Node host", "LVCE browser worker"]
bars = axes[0].barh(labels, [value / 1000 for value in values], color=["#64748b", "#0284c7", "#0891b2", "#d97706"])
axes[0].invert_yaxis()
axes[0].set_xlim(0, max(values) / 1000 * 1.25)
axes[0].set_xlabel("Seconds (median of five unprofiled runs)")
axes[0].set_title("CLI checks every file; hosts diagnose one file")
for bar, value in zip(bars, values):
    axes[0].text(bar.get_width() + .07, bar.get_y() + bar.get_height() / 2, f"{value / 1000:.2f} s", va="center")

browser = data["browser"]
parts = [("Existence IPC", browser["methods"]["SyncApi.exists"]["durationMs"], "#dc2626"), ("Read-file IPC", browser["methods"]["SyncApi.readFileSync"]["durationMs"], "#ea580c"), ("Other IPC", browser["methods"]["SyncApi.readDirSync"]["durationMs"], "#f59e0b"), ("Remaining work", browser["remainingMs"], "#0891b2")]
offset = 0
for label, value, color in parts:
    axes[1].barh([0], [value / 1000], height=.35, left=offset, label=f"{label}: {value / 1000:.2f} s", color=color)
    offset += value / 1000
axes[1].set_xlim(0, 5)
axes[1].set_ylim(-1.5, .65)
axes[1].set_yticks([0], ["Browser request"])
axes[1].set_xlabel("Seconds (component medians; rounding may differ)")
axes[1].set_title("Synchronous IPC dominates the browser request")
axes[1].legend(loc="lower center", bbox_to_anchor=(.5, -.02), frameon=False)
for axis in axes:
    axis.spines[["top", "right"]].set_visible(False)
fig.text(.01, -.04, "*CLI includes process/module startup. Host timers exclude it; browser timer excludes activation and UI rendering.", fontsize=9)
fig.savefig(sys.argv[2], bbox_inches="tight")
destination = Path(sys.argv[2])
if destination.suffix == ".svg":
    destination.write_text("\n".join(line.rstrip() for line in destination.read_text(encoding="utf-8").splitlines()) + "\n", encoding="utf-8")
