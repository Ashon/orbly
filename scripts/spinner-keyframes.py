"""Keyframes for Pace's spinner (apps/web/src/components/pace-spinner.tsx).

Pace looks around like a camera finding its subject: irregular saccades on the
ring, each with a small overshoot and two corrections, uneven holds with a
faint tremor. Twice per loop the pupil opens into an arc along the ring like a
lens, hunts back and forth for focus while the eye trembles, locks, then closes
back to a dot and the eye moves on. The track's opening follows the pupil, so
the gap stays the same and everything stays on the ring. Two full turns per
loop, landing back on the rest position. The path is seeded random.

    pnpm spinner                        # writes pace-spinner.css (Prettier'd)
    pnpm spinner --seed 11 --move 1.5 --svg /tmp/spinner.svg

--svg also writes a standalone SVG to preview in a browser.
"""

import argparse
import math
import os
import random
import subprocess

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CSS = os.path.join(ROOT, "apps/web/src/components/pace-spinner.css")

SACC = "cubic-bezier(.15,.85,.3,1)"  # saccade: fast start, hard stop
END = 720  # two full turns, lands back on rest
FIRST_REST = 150  # ms still before the first look
LAST_REST = 350  # ms resting after the last one (with tremor)
# How much slower each move (the saccade and its settling) is than an eye's.
# At app sizes (24-48px) a real eye's speed jumps the dot several pixels a
# frame; twice as slow reads smooth. Holds keep their length.
MOVE = 2.0

# Sizes come from a fixed bag so big and small moves are spread across the loop
# instead of clustering: no two small moves (or look-backs) in a row, and the
# loop always ends with one decisive large move into a calm rest.
BAG = ["L", "L", "L", "M", "M", "M", "M", "S", "S", "B", "B"]
RANGE = {"L": (115, 165), "M": (55, 100), "S": (22, 40), "B": (18, 45)}
HOLD = {"L": (300, 560), "M": (170, 330), "S": (70, 150), "B": (120, 240)}
STRETCH = 62.0  # locked pupil arc, in degrees along the ring (0 = a dot)
HUNT = STRETCH / 36.0  # focus hunting grows with the stretch

# Ring geometry: radius, half stroke (round cap radius), and the gap between
# the pupil's cap and each track end, measured along the ring. At rest this
# gives the logo's 78 degree opening.
R, HALF = 164.0, 42.0
CIRC = 2 * math.pi * R
DEG = CIRC / 360
CLEAR = 39 * DEG - 2 * HALF


def half_gap(stretch):
    """Arc length from the pupil center to each track end: half the pupil arc,
    the two round caps and the clearance, so the opening follows the pupil."""
    return stretch * DEG / 2 + 2 * HALF + CLEAR


def track(z):
    h = half_gap(z)
    return (
        f"stroke-dasharray: {CIRC - 2 * h:.2f} {2 * h:.2f}; "
        f"stroke-dashoffset: {-h:.2f}"
    )


def pupil(z):
    length = max(1.0, z * DEG)  # a dash of 0 is not drawn; 1 draws the dot
    return (
        f"stroke-dasharray: {length:.2f} {CIRC - length:.2f}; "
        f"stroke-dashoffset: {length / 2:.2f}"
    )


def plan_path(rng):
    small = {"S", "B"}
    while True:
        kinds = BAG[:]
        rng.shuffle(kinds)
        kinds.append("L")
        if kinds[0] == "B" or kinds[-2] in small:
            continue
        if any(a in small and b in small for a, b in zip(kinds, kinds[1:])):
            continue
        break
    jumps = [(-1 if k == "B" else 1) * rng.uniform(*RANGE[k]) for k in kinds]
    fwd = sum(j for j in jumps if j > 0)
    back = -sum(j for j in jumps if j < 0)
    scale = (END + back) / fwd  # stretch forward moves to land on END
    plan, cur = [], 0.0
    for k, j in zip(kinds, jumps):
        cur += j * scale if j > 0 else j
        plan.append([k, round(cur, 1), round(rng.uniform(*HOLD[k])), False])
    plan[-1][1:3] = [END, LAST_REST]
    # Focus on two big or medium stops, one in each half of the loop: the pair
    # farthest apart on the ring (lenses on one side lean the whole mark) and
    # about half a loop apart.
    half = len(plan) // 2
    first = [i for i in range(1, half) if plan[i][0] in ("L", "M")]
    second = [i for i in range(half, len(plan) - 1) if plan[i][0] in ("L", "M")]
    for picks in (first, second):
        if picks:
            rng.choice(picks)  # drawn as before, so the motion stays the same
    pairs = [(i, j) for i in first for j in second]
    if pairs:
        i, j = max(pairs, key=lambda pair: balance(plan, pair, half))
        plan[i][3] = plan[j][3] = True
    elif first or second:
        plan[(first or second)[0]][3] = True
    return plan


def where(angle):
    """Where the pupil sits after turning by angle: degrees clockwise from 3
    o'clock (it rests at the top right, 315)."""
    return (315 + angle) % 360


def balance(plan, pair, half):
    """2 for two stops on opposite sides of the ring, half a loop apart."""
    i, j = pair
    d = abs(where(plan[i][1]) - where(plan[j][1]))
    apart = min(d, 360 - d) / 180
    spacing = 1 - abs((j - i) - half) / half
    return apart + spacing


def build(rng, plan, move):
    """Rotation and pupil frames (ms, value, timing) and the loop's length."""
    rot, zoom = [(0, 0.0, None)], [(0, 0.0, None)]
    t, cur = FIRST_REST, 0.0
    for _kind, target, hold, focus in plan:
        jump = target - cur
        sign = 1 if jump > 0 else -1
        ov = max(1.5, abs(jump) * rng.uniform(0.04, 0.09)) * sign
        rot.append((t, cur, SACC))
        t += round(
            (rng.uniform(45, 70) + abs(jump) * rng.uniform(0.35, 0.55)) * move
        )
        rot.append((t, target + ov, "ease-out"))
        t += round(rng.uniform(30, 50) * move)
        rot.append((t, target - ov * rng.uniform(0.25, 0.45), "linear"))
        t += round(rng.uniform(22, 38) * move)
        rot.append((t, target + ov * rng.uniform(0.08, 0.18), None))
        t += round(rng.uniform(22, 38) * move)
        rot.append((t, target, None))
        if focus:
            t = add_focus(rng, t, target, rot, zoom)
        # tremor while holding: a few tiny, uneven twitches
        left = hold
        while left > 140:
            step = round(rng.uniform(60, 180))
            if step >= left - 40:
                break
            t += step
            left -= step
            rot.append((t, target + rng.uniform(-0.6, 0.6), None))
        t += left
        rot.append((t, target, None))
        cur = target
    return rot, zoom, t


def add_focus(rng, t, angle, rot, zoom):
    """Open the pupil into an arc fast, hunt back and forth for focus while the
    eye trembles, lock, hold, then close it back to a dot with a small
    after-bounce."""
    zoom.append((t, 0.0, "cubic-bezier(.2,.8,.3,1)"))
    t += round(rng.uniform(130, 160))
    zoom.append((t, STRETCH + HUNT * rng.uniform(6, 9), "ease-in-out"))
    hunt = [
        STRETCH - HUNT * rng.uniform(7, 10),
        STRETCH + HUNT * rng.uniform(3, 5),
        STRETCH - HUNT * rng.uniform(2, 4),
        STRETCH + HUNT * rng.uniform(0.5, 1.5),
        STRETCH,
    ]
    for z in hunt:
        t += round(rng.uniform(55, 95))
        zoom.append((t, z, "ease-in-out"))
        rot.append((t, angle + rng.uniform(-1.6, 1.6), None))
    rot.append((t + 30, angle, None))
    t += round(rng.uniform(380, 620))  # locked: look closely
    zoom.append((t, STRETCH, "cubic-bezier(.5,0,.7,.4)"))
    rot.append((t, angle + rng.uniform(-0.4, 0.4), None))
    t += round(rng.uniform(150, 180))
    zoom.append((t, 0.0, "ease-out"))
    t += round(rng.uniform(50, 70))
    zoom.append((t, rng.uniform(4, 6), "ease-in-out"))
    t += round(rng.uniform(50, 70))
    zoom.append((t, 0.0, None))
    rot.append((t, angle, None))
    return t


def keyframes(name, frames, total, declare):
    """One frame per offset (a hold's end and the next move's start merge), and
    a last frame at 100% when the frames end early."""
    merged = []
    for ms, v, tf in frames:
        if merged and merged[-1][0] == ms:
            merged[-1] = (ms, v, tf or merged[-1][2])
        else:
            merged.append((ms, v, tf))
    if merged[-1][0] < total:
        merged.append((total, merged[-1][1], None))
    lines = [f"@keyframes {name} {{"]
    for ms, v, tf in merged:
        timing = f" animation-timing-function: {tf};" if tf else ""
        lines.append(f"  {ms / total * 100:.3f}% {{ {declare(v)};{timing} }}")
    lines.append("}")
    return "\n".join(lines)


def css(seed, move):
    rng = random.Random(seed)
    rot, zoom, total = build(rng, plan_path(rng), move)
    secs = f"{total / 1000:.2f}s"
    look = keyframes(
        "pace-spinner-look", rot, total, lambda v: f"transform: rotate({v:.1f}deg)"
    )
    return f"""/*
 * Generated by scripts/spinner-keyframes.py (seed {seed}, move {move}): run
 * `pnpm spinner` instead of editing. Three animations of the same length, so
 * they stay in step: the eye turning, the pupil opening into an arc, and the
 * track's opening following it.
 */
.pace-spinner-eye {{
  transform-box: view-box;
  transform-origin: 256px 256px;
  animation: pace-spinner-look {secs} infinite;
}}
.pace-spinner-track {{
  {track(0.0)};
  animation: pace-spinner-open {secs} infinite;
}}
.pace-spinner-pupil {{
  {pupil(0.0)};
  animation: pace-spinner-focus {secs} infinite;
}}
{look}
{keyframes("pace-spinner-focus", zoom, total, pupil)}
{keyframes("pace-spinner-open", zoom, total, track)}
/* Reduced motion: still, and a slow fade says it is still working. */
@media (prefers-reduced-motion: reduce) {{
  .pace-spinner-eye,
  .pace-spinner-track,
  .pace-spinner-pupil {{
    animation: none;
  }}
  .pace-spinner {{
    animation: pace-spinner-pulse 1.6s ease-in-out infinite;
  }}
}}
@keyframes pace-spinner-pulse {{
  50% {{ opacity: 0.45; }}
}}
"""


# The ring as a full circle starting at the pupil (both paths draw it), as in
# pace-spinner.tsx.
CIRCLE = "M372 140A164 164 0 1 0 140 372A164 164 0 1 0 372 140"


def preview_svg(style):
    ring = (
        f'd="{CIRCLE}" pathLength="{CIRC:.2f}" fill="none" stroke="#fff" '
        'stroke-width="84" stroke-linecap="round"'
    )
    return f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"
  width="512" height="512" class="pace-spinner">
  <defs>
    <linearGradient id="g" gradientUnits="userSpaceOnUse"
      x1="54" y1="314" x2="458" y2="198">
      <stop offset="0" stop-color="#01ab78"/>
      <stop offset="0.46" stop-color="#1fc289"/>
      <stop offset="1" stop-color="#48c89c"/>
    </linearGradient>
    <mask id="m" maskUnits="userSpaceOnUse" x="0" y="0" width="512" height="512">
      <g class="pace-spinner-eye">
        <path class="pace-spinner-track" {ring}/>
        <path class="pace-spinner-pupil" {ring}/>
      </g>
    </mask>
    <style>{style}</style>
  </defs>
  <rect width="512" height="512" fill="url(#g)" mask="url(#m)"/>
</svg>
"""


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--seed", type=int, default=2)
    parser.add_argument("--move", type=float, default=MOVE)
    parser.add_argument("--svg", help="also write a standalone preview SVG")
    args = parser.parse_args()
    style = css(args.seed, args.move)
    with open(CSS, "w") as f:
        f.write(style)
    subprocess.run(
        ["pnpm", "exec", "prettier", "--write", CSS],
        cwd=ROOT,
        check=True,
        stdout=subprocess.DEVNULL,
    )
    if args.svg:
        with open(args.svg, "w") as f:
            f.write(preview_svg(style))
    print(f"wrote {os.path.relpath(CSS, ROOT)}")


if __name__ == "__main__":
    main()
