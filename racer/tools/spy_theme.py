# An original 1960s-style spy theme for the Silver Agent: twangy surf guitar,
# an octave-jumping bass riff, brass stabs and a driving drum beat, in E minor at
# 128 BPM. 32 bars (60 s) that loop seamlessly. Everything here is synthesised
# from scratch (Karplus-Strong strings, additive brass, noise drums).
import numpy as np
from scipy.signal import butter, sosfilt, resample_poly
import wave, sys

SR = 44100
BPM = 128
E8 = 60 / BPM / 2            # one eighth note, in seconds
BAR = 8 * E8
BARS = 32
LOOP = int(round(BARS * BAR * SR))
rng = np.random.default_rng(7)

def hz(m): return 440.0 * 2 ** ((m - 69) / 12)

# ---------------------------------------------------------------- the score
# Chords, one per bar.
CH = (['Em'] * 3 + ['B7'] +                                   # intro
      ['Em', 'Em', 'C', 'B7', 'Em', 'Am', 'B7', 'Em'] +       # A
      ['Am', 'Am', 'Em', 'Em', 'C', 'C', 'B7', 'B7'] +        # B
      ['Em', 'Em', 'C', 'B7', 'Em', 'Am', 'B7', 'Em'] +       # A'
      ['Em', 'C', 'Am', 'B7'])                                # turnaround
ROOT = {'Em': 40, 'C': 36, 'Am': 45, 'B7': 35}               # bass roots
RIFF = {'Em': [0, 0, 7, 0, 10, 0, 7, 5], 'C': [0, 0, 7, 0, 10, 0, 7, 4],
        'Am': [0, 0, 7, 0, 10, 0, 7, 5], 'B7': [0, 0, 7, 0, 10, 0, 7, 4]}
BRASS = {'Em': [52, 55, 59, 62, 66], 'C': [55, 59, 60, 64], 'Am': [57, 60, 64, 67], 'B7': [57, 60, 63, 66]}
GTR = {'Em': [52, 59, 64, 67, 71], 'C': [48, 55, 60, 64, 67], 'Am': [45, 52, 57, 60, 64], 'B7': [47, 54, 57, 63, 66]}

# The guitar tune (bars of [midi, start, length] in eighths).
TUNE_A = [
    [(71, 0, 3), (67, 3, 1), (64, 4, 2), (66, 6, 2)],
    [(67, 0, 2), (71, 2, 2), (75, 4, 3), (76, 7, 1)],
    [(76, 0, 3), (74, 3, 1), (72, 4, 2), (71, 6, 2)],
    [(69, 0, 2), (66, 2, 2), (63, 4, 4)],
    [(71, 0, 3), (67, 3, 1), (64, 4, 2), (59, 6, 2)],
    [(60, 0, 2), (64, 2, 2), (69, 4, 3), (72, 7, 1)],
    [(71, 0, 2), (69, 2, 1), (67, 3, 1), (66, 4, 2), (63, 6, 2)],
    [(64, 0, 8)],
]
# The brass tune for the middle section.
TUNE_B = [
    [(76, 0, 2), (72, 2, 1), (69, 3, 1), (76, 6, 1), (74, 7, 1)],
    [(72, 0, 3), (71, 3, 1), (69, 4, 4)],
    [(71, 0, 2), (67, 2, 1), (64, 3, 1), (67, 6, 1), (69, 7, 1)],
    [(71, 0, 6)],
    [(72, 0, 2), (76, 2, 1), (79, 3, 1), (79, 6, 1), (78, 7, 1)],
    [(76, 0, 3), (74, 3, 1), (72, 4, 2), (71, 6, 2)],
    [(75, 0, 2), (78, 2, 2), (81, 4, 2), (78, 6, 2)],
    [(75, 0, 4), (71, 4, 4)],
]

# ---------------------------------------------------------------- instruments
def env_adsr(n, a, d, s, r, sustain_len):
    t = np.arange(n) / SR
    e = np.where(t < a, t / max(a, 1e-4), s + (1 - s) * np.exp(-(t - a) / max(d, 1e-4)))
    rel = t > sustain_len
    e[rel] *= np.exp(-(t[rel] - sustain_len) / max(r, 1e-4))
    return e

def ks(freq, dur, decay=0.996, bright=0.7, sr=SR):
    """A plucked string (Karplus-Strong), computed a period at a time."""
    N = max(2, int(round(sr / freq - 0.5)))
    n = int(dur * sr) + N + 1
    y = np.zeros(n)
    x = rng.uniform(-1, 1, N)
    for _ in range(int((1 - bright) * 6)):          # a darker pluck
        x = 0.5 * (x + np.roll(x, 1))
    y[:N] = x - x.mean()
    for start in range(N + 1, n, N):
        end = min(start + N, n)
        y[start:end] = decay * 0.5 * (y[start - N:end - N] + y[start - N - 1:end - N - 1])
    return y[N + 1:]

def guitar(m, dur, vel=1.0, tremolo=False, bright=0.75):
    """Twangy surf guitar (rendered at 2x and brought down, for tuning)."""
    if tremolo:  # tremolo picking: repicked every 32nd note
        step = E8 / 4; k = int(dur / step); out = np.zeros(int(dur * SR) + SR)
        for i in range(k):
            p = guitar(m, step * 1.6, vel * (0.8 + 0.2 * rng.random()), False, bright)
            s0 = int(i * step * SR); out[s0:s0 + len(p)] += p[:len(out) - s0]
        return out[:int(dur * SR) + int(0.25 * SR)]
    y = ks(hz(m), dur + 0.6, decay=0.9985, bright=bright, sr=2 * SR)
    y = resample_poly(y, 1, 2)
    y = np.tanh(2.2 * y) * 0.6                      # a little drive
    e = env_adsr(len(y), 0.002, 0.6, 0.55, 0.06, dur)
    return y * e * vel

def bass(m, dur, vel=1.0):
    y = ks(hz(m), dur + 0.3, decay=0.997, bright=0.45)
    t = np.arange(len(y)) / SR
    y = y + 0.5 * np.sin(2 * np.pi * hz(m) * t) * np.exp(-t / 0.5)
    e = env_adsr(len(y), 0.003, 0.4, 0.7, 0.04, dur)
    return np.tanh(1.5 * y * e) * vel

def brass(m, dur, vel=1.0, attack=0.018):
    """A brass section voice: two slightly detuned saws with a brightness swell."""
    n = int((dur + 0.15) * SR); t = np.arange(n) / SR; f = hz(m)
    amp = env_adsr(n, attack, 0.25, 0.75, 0.07, dur)
    bright = 900 + 3800 * env_adsr(n, attack * 1.5, 0.18, 0.35, 0.07, dur) * vel
    vib = 1 + 0.004 * np.sin(2 * np.pi * 5.5 * t) * np.clip((t - 0.25) / 0.3, 0, 1)
    out = np.zeros(n)
    for det in (-0.003, 0.003):
        ph = 2 * np.pi * f * (1 + det) * np.cumsum(vib) / SR
        for k in range(1, int(9000 / f)):
            out += np.sin(k * ph) / k / (1 + (k * f / bright) ** 4)
    return out * amp * 0.22 * vel

def kick(vel=1.0):
    n = int(0.35 * SR); t = np.arange(n) / SR
    f = 45 + 110 * np.exp(-t / 0.035)
    y = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t / 0.16)
    y[:60] += rng.uniform(-0.4, 0.4, 60)
    return np.tanh(1.6 * y) * vel

_bp_snare = butter(2, [1200, 7000], btype='band', fs=SR, output='sos')
_hp_hat = butter(4, 7000, btype='high', fs=SR, output='sos')
_hp_cym = butter(2, 3500, btype='high', fs=SR, output='sos')
def snare(vel=1.0):
    n = int(0.3 * SR); t = np.arange(n) / SR
    nz = sosfilt(_bp_snare, rng.uniform(-1, 1, n)) * np.exp(-t / 0.11) * 1.8
    tone = np.sin(2 * np.pi * 185 * t) * np.exp(-t / 0.05) * 0.6
    return (nz + tone) * vel * 0.8

def hat(vel=1.0, open_=False):
    n = int((0.35 if open_ else 0.08) * SR); t = np.arange(n) / SR
    return sosfilt(_hp_hat, rng.uniform(-1, 1, n)) * np.exp(-t / (0.12 if open_ else 0.022)) * vel * 0.5

def ride(vel=1.0):
    n = int(0.9 * SR); t = np.arange(n) / SR
    tones = sum(np.sign(np.sin(2 * np.pi * f * t)) for f in (512, 731, 1043, 1555)) * 0.08
    y = sosfilt(_hp_cym, rng.uniform(-1, 1, n) * 0.5 + tones)
    return y * np.exp(-t / 0.35) * vel * 0.35

def crash(vel=1.0):
    n = int(2.2 * SR); t = np.arange(n) / SR
    return sosfilt(_hp_cym, rng.uniform(-1, 1, n)) * np.exp(-t / 0.7) * vel * 0.45

def tom(f0, vel=1.0):
    n = int(0.4 * SR); t = np.arange(n) / SR
    f = f0 * (1 + 0.5 * np.exp(-t / 0.03))
    return np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t / 0.18) * vel * 0.9

# ---------------------------------------------------------------- rendering
TOTAL = 2 * LOOP + 3 * SR    # two passes, so the second starts with the first's tails
stems = {k: np.zeros((TOTAL, 2)) for k in ('drums', 'bass', 'gtr', 'brass')}
send = np.zeros((TOTAL, 2))  # into the reverb

def put(stem, sig, at, pan=0.0, rev=0.0):
    i = int(at * SR + rng.normal(0, 0.003) * SR) if stem != 'drums' else int(at * SR)
    i = max(0, i); j = min(TOTAL, i + len(sig)); sig = sig[:j - i]
    l, r = np.cos((pan + 1) * np.pi / 4), np.sin((pan + 1) * np.pi / 4)
    stems[stem][i:j, 0] += sig * l; stems[stem][i:j, 1] += sig * r
    if rev: send[i:j, 0] += sig * l * rev; send[i:j, 1] += sig * r * rev

def at(bar, eighth): return bar * BAR + eighth * E8

def drums_bar(t0, b, ch, section):
    def k(e, v=1.0): put('drums', kick(v), t0 + e * E8, 0, 0.05)
    def s(e, v=1.0): put('drums', snare(v), t0 + e * E8, 0.05, 0.25)
    def h(e, v=1.0, o=False): put('drums', hat(v, o), t0 + e * E8, 0.35, 0.05)
    if section == 'turn' and b == 31:            # the fill back to the top
        for i in range(8): k(i, 0.6) if i % 4 == 0 else None
        for i in range(16):
            f = [210, 210, 180, 180, 150, 150, 120, 120][i // 2]
            put('drums', tom(f, 0.55 + 0.03 * i), t0 + i * E8 / 2, -0.3 + i * 0.04, 0.15)
        return
    if b == 3:                                   # end of the intro: a snare build
        k(0); s(2); k(4)
        for i in range(8): s(4 + i / 2, 0.35 + 0.08 * i)
        return
    k(0); s(2); k(4); s(6)
    if section in ('A', 'A2'): k(3, 0.7);
    if section == 'B': k(5, 0.6)
    for i in range(8):
        if section == 'B': put('drums', ride(0.8 if i % 2 == 0 else 0.55), t0 + i * E8, 0.4, 0.1)
        else: h(i, 0.8 if i % 2 == 0 else 0.5, o=(i == 7 and b % 2 == 1))

for p in range(2):
    base = p * LOOP / SR
    for b, ch in enumerate(CH):
        t0 = base + b * BAR
        section = 'intro' if b < 4 else 'A' if b < 12 else 'B' if b < 20 else 'A2' if b < 28 else 'turn'
        if b in (0, 12, 20, 28): put('drums', crash(0.9), t0, -0.3, 0.3)
        drums_bar(t0, b, ch, section)
        # bass riff (a walk up into the top on the last bar)
        if b == 31:
            for e, m, l in [(0, 35, 2), (2, 39, 2), (4, 42, 2), (6, 45, 1), (7, 39, 1)]: put('bass', bass(m, l * E8 * 0.9), t0 + e * E8, 0)
        else:
            for e, off in enumerate(RIFF[ch]):
                put('bass', bass(ROOT[ch] + off, E8 * (0.85 if e % 2 == 0 else 0.6), 0.95 if e % 2 == 0 else 0.8), t0 + e * E8, 0)
        # brass stabs
        def stab(e, l, v=1.0, chord=ch, att=0.018):
            for m in BRASS[chord]: put('brass', brass(m, l * E8, v, att), t0 + e * E8, 0.25, 0.3)
        if section == 'intro':
            if b < 3: stab(0, 1.5); stab(3, 1, 0.8); stab(6, 2)
            else: stab(0, 1); stab(2, 1, 0.8); stab(4, 4, 1.0, att=0.12)
        elif section == 'A':
            if ch == 'B7': stab(4, 1, 0.7); stab(6, 1.5, 0.8)
        elif section == 'A2':
            for m in BRASS[ch]: put('brass', brass(m, BAR * 0.95, 0.45, 0.25) * 0.6, t0, 0.25, 0.35)   # soft pads
            stab(6, 1, 0.75)
        elif section == 'turn':
            if b < 31: stab(0, 1.5); stab(3, 1, 0.8); stab(6, 1.5, 0.9)
            else: stab(0, 8, 0.9, att=0.3)
        # guitar
        if section == 'intro':   # tremolo-picked chord swell
            for m in GTR[ch][1:4]: put('gtr', guitar(m, BAR, 0.18 + 0.05 * b, tremolo=True), t0, -0.35, 0.5)
        elif section in ('A', 'A2'):
            bar_tune = TUNE_A[b - (4 if section == 'A' else 20)]
            for m, e, l in bar_tune:
                long_ = l >= 6
                put('gtr', guitar(m, l * E8 * 0.95, 0.9, tremolo=long_), t0 + e * E8, -0.3, 0.45)
                if section == 'A2': put('gtr', guitar(m + 12, l * E8 * 0.95, 0.35, tremolo=long_, bright=0.9), t0 + e * E8, 0.45, 0.6)
        elif section == 'B':     # backbeat chops while the brass sings
            for e in (2, 6):
                for m in GTR[ch][1:5]: put('gtr', guitar(m, E8 * 0.35, 0.22), t0 + e * E8 + 0.004 * (m % 5), -0.4, 0.3)
            for m, e, l in TUNE_B[b - 12]:
                put('brass', brass(m, l * E8 * 0.92, 0.95, 0.03) * 1.6, t0 + e * E8, 0.1, 0.35)
        elif section == 'turn':
            for e in (2, 6):
                for m in GTR[ch][1:5]: put('gtr', guitar(m, E8 * 0.35, 0.22), t0 + e * E8, -0.4, 0.3)
    print('pass', p + 1, 'done', file=sys.stderr)

# ---------------------------------------------------------------- reverb and mix
def comb(x, D, g):
    y = x.copy()
    for s in range(D, len(x), D):
        e = min(s + D, len(x)); y[s:e] += g * y[s - D:e - D]
    return y
def allpass(x, D, g):
    y = np.zeros_like(x); y[:D] = -g * x[:D]
    for s in range(D, len(x), D):
        e = min(s + D, len(x)); y[s:e] = -g * x[s:e] + x[s - D:e - D] + g * y[s - D:e - D]
    return y
def reverb(x, spread=0):
    ds = [1557, 1617, 1491, 1422, 1277, 1356]
    y = sum(comb(x, d + spread, 0.82) for d in ds) / len(ds)
    for d in (225, 556, 341):
        y = allpass(y, d + spread // 2, 0.6)
    return sosfilt(butter(1, 5500, fs=SR, output='sos'), y)

wet = np.stack([reverb(send[:, 0]), reverb(send[:, 1], 23)], axis=1) * 0.55
gains = {'drums': 0.72, 'bass': 0.6, 'gtr': 1.6, 'brass': 0.8}
mix = sum(stems[k] * g for k, g in gains.items()) + wet
mix = sosfilt(butter(2, 32, btype='high', fs=SR, output='sos'), mix, axis=0)
loop = mix[LOOP:2 * LOOP].copy()
# The seam: the last few milliseconds blend into what came just before the
# start in the render, so the end runs straight on into the beginning.
k = int(0.006 * SR); w = np.linspace(0, 1, k)[:, None]
loop[-k:] = loop[-k:] * (1 - w) + mix[LOOP - k:LOOP] * w
loop = np.tanh(loop / np.max(np.abs(loop)) * 1.6) # gentle saturation for loudness
loop = loop / np.max(np.abs(loop)) * 0.89          # -1 dBFS peaks
pcm = (loop * 32767).astype('<i2')
with wave.open(sys.argv[1] if len(sys.argv) > 1 else 'spy_theme.wav', 'wb') as w:
    w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR); w.writeframes(pcm.tobytes())
print('wrote', len(loop) / SR, 's; rms dBFS', round(20 * np.log10(np.sqrt(np.mean(loop ** 2))), 1), file=sys.stderr)
