"""Generate Live Translation brand assets: social banner + square logo."""
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.patches import FancyBboxPatch, Circle, Rectangle, Wedge
import numpy as np

BG     = "#0d1117"
PANEL  = "#161b22"
BLUE   = "#3b82f6"
CYAN   = "#22d3ee"
GREEN  = "#22c55e"
WHITE  = "#f4f6fb"
MUTED  = "#8b949e"
CHIP   = "#1f2733"


def broadcast(ax, cx, cy, s, color=CYAN):
    """A node emitting concentric broadcast arcs (one speaker -> many)."""
    ax.add_patch(Circle((cx, cy), 0.12*s, fc=BLUE, ec="none", zorder=6))
    ax.add_patch(Circle((cx, cy), 0.055*s, fc=WHITE, ec="none", zorder=7))
    for i, r in enumerate([0.30, 0.50, 0.72]):
        for sign in (1, -1):
            w = Wedge((cx, cy), r*s, -38, 38, width=0.02*s, fc=color,
                      ec="none", alpha=0.85 - i*0.22, zorder=3)
            # rotate wedge to point right (toward languages)
            w.set_theta1(-38); w.set_theta2(38)
            ax.add_patch(w)


def chip(ax, x, y, w, h, text, fg=WHITE):
    ax.add_patch(FancyBboxPatch((x, y), w, h,
                 boxstyle="round,pad=0,rounding_size=" + str(h*0.45),
                 fc=CHIP, ec=BLUE, lw=1.4, zorder=4))
    ax.text(x + w/2, y + h/2, text, color=fg, fontsize=h*32, va="center",
            ha="center", fontweight="bold", zorder=5)


def live_pill(ax, x, y, s):
    ax.add_patch(Circle((x, y), 0.06*s, fc=GREEN, ec="none", zorder=6))
    ax.text(x + 0.16*s, y, "LIVE", color=GREEN, fontsize=14*s, fontweight="bold",
            va="center", ha="left", zorder=6)


# ── Banner 1280x640 ──────────────────────────────────────────────────────────
def make_banner():
    fig = plt.figure(figsize=(12.8, 6.4), dpi=100)
    ax = fig.add_axes([0, 0, 1, 1]); ax.axis("off")
    ax.set_xlim(0, 12.8); ax.set_ylim(0, 6.4)
    ax.add_patch(Rectangle((0, 0), 12.8, 6.4, fc=BG, ec="none"))
    ax.add_patch(Rectangle((0, 6.26), 12.8, 0.14, fc=BLUE, ec="none"))

    live_pill(ax, 1.25, 5.5, 1.0)

    broadcast(ax, 1.75, 3.95, 1.95)

    ax.text(3.75, 4.0, "Live Translation", color=WHITE, fontsize=48,
            fontweight="bold", va="center", ha="left")
    ax.text(3.78, 3.02, "Real-time speech translation for live rooms",
            color=CYAN, fontsize=20, fontweight="bold", va="center", ha="left")
    ax.text(3.78, 2.46, "one QR · every language · interpreter-style latency",
            color=MUTED, fontsize=15, va="center", ha="left")

    # language chips row — centered, with safe margins
    langs = ["English", "Hindi", "Tamil", "Telugu", "Kannada", "Bengali"]
    h, fs = 0.6, 0.55
    widths = [0.55 + 0.135 * len(lg) for lg in langs]
    gap = 0.28
    total = sum(widths) + gap * (len(langs) - 1)
    x = (12.8 - total) / 2
    for lg, w in zip(langs, widths):
        chip(ax, x, 0.82, w, h, lg)
        x += w + gap

    fig.savefig("banner.png", facecolor=BG)
    plt.close(fig)
    print("saved banner.png (1280x640)")


# ── Square logo 512x512 ──────────────────────────────────────────────────────
def make_logo():
    fig = plt.figure(figsize=(5.12, 5.12), dpi=100)
    ax = fig.add_axes([0, 0, 1, 1]); ax.axis("off")
    ax.set_xlim(0, 5.12); ax.set_ylim(0, 5.12)
    ax.add_patch(Rectangle((0, 0), 5.12, 5.12, fc=BG, ec="none"))
    ax.add_patch(FancyBboxPatch((0.5, 0.5), 4.12, 4.12,
                 boxstyle="round,pad=0,rounding_size=0.7", fc=PANEL, ec=BLUE, lw=3))
    broadcast(ax, 1.95, 2.56, 3.0)
    # target language chips (stacked)
    for i, lg in enumerate(["EN", "HI", "TA"]):
        chip(ax, 3.15, 1.65 + i*0.78, 1.0, 0.6, lg)
    live_pill(ax, 1.2, 4.05, 1.2)
    fig.savefig("logo.png", facecolor=BG)
    plt.close(fig)
    print("saved logo.png (512x512)")


make_banner()
make_logo()
