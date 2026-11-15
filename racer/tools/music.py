# MushtaqTrack's background music, synthesised from scratch (original tunes, no
# samples): four race themes (race, night, breaks, rock) and a relaxed menu theme.
# Each is rendered twice in a row and the second pass kept, so it loops seamlessly.
# Usage: python3 music.py race|night|breaks|rock|menu out.wav
import numpy as np, sys, wave
from scipy.signal import butter, sosfilt

SR = 44100
rng = np.random.default_rng(11)
def hz(m): return 440.0 * 2 ** ((m - 69) / 12)

# ---------------------------------------------------------------- instruments
def adsr(n, a, d, s, r, hold):
    t = np.arange(n) / SR
    e = np.where(t < a, t / max(a, 1e-4), s + (1 - s) * np.exp(-(t - a) / max(d, 1e-4)))
    late = t > hold; e[late] *= np.exp(-(t[late] - hold) / max(r, 1e-4))
    return e

def saw(f, n, bright, detune=(0.0,), vib=0.0, maxh=60):
    """Band-limited saw (additive); `bright` is a cutoff in Hz (array or number)."""
    t = np.arange(n) / SR; out = np.zeros(n)
    ph0 = 2 * np.pi * np.cumsum(np.ones(n) * f * (1 + vib * np.sin(2 * np.pi * 5.2 * t))) / SR
    for dt in detune:
        ph = ph0 * (1 + dt) + rng.uniform(0, 6.28)
        for k in range(1, min(maxh, int(16000 / f)) + 1):
            out += np.sin(k * ph) / k / (1 + (k * f / bright) ** 3)
    return out / len(detune)

def pluck(m, dur, vel=1.0):   # bright synth pluck
    n = int((dur + 0.25) * SR); t = np.arange(n) / SR
    b = 600 + 5000 * np.exp(-t / 0.09)
    return saw(hz(m), n, b, (-0.004, 0.004), maxh=30) * adsr(n, 0.002, 0.18, 0.25, 0.08, dur) * 0.5 * vel

def supersaw(m, dur, vel=1.0, att=0.25):   # soft pad
    n = int((dur + 0.6) * SR)
    return saw(hz(m), n, 2200, (-0.012, -0.005, 0.0, 0.006, 0.013), maxh=24) * adsr(n, att, 0.6, 0.8, 0.45, dur) * 0.35 * vel

def lead(m, dur, vel=1.0):   # singing lead: saw + square-ish, vibrato after the attack
    n = int((dur + 0.2) * SR); t = np.arange(n) / SR
    v = 0.006 * np.clip((t - 0.12) / 0.2, 0, 1)
    b = 2500 + 2500 * np.exp(-t / 0.15)
    y = saw(hz(m), n, b, (-0.003, 0.003), vib=0, maxh=40)
    ph = 2 * np.pi * hz(m) * np.cumsum(1 + v * np.sin(2 * np.pi * 5.5 * t)) / SR
    y += 0.35 * np.sign(np.sin(ph)) * 0.5
    return y * adsr(n, 0.01, 0.3, 0.7, 0.08, dur) * 0.42 * vel

def bassnote(m, dur, vel=1.0):
    n = int((dur + 0.08) * SR); t = np.arange(n) / SR
    b = 250 + 1400 * np.exp(-t / 0.06)
    y = saw(hz(m), n, b, (0.0,), maxh=30) + 0.8 * np.sin(2 * np.pi * hz(m) * t)
    return np.tanh(1.3 * y) * adsr(n, 0.003, 0.15, 0.7, 0.03, dur) * 0.55 * vel

def epiano(m, dur, vel=1.0):   # FM electric piano
    n = int((dur + 1.2) * SR); t = np.arange(n) / SR; f = hz(m)
    idx = 1.6 * np.exp(-t / 0.35) * vel + 0.2
    y = np.sin(2 * np.pi * f * t + idx * np.sin(2 * np.pi * f * t)) + 0.25 * np.sin(2 * np.pi * 2 * f * t) * np.exp(-t / 0.2)
    trem = 1 + 0.12 * np.sin(2 * np.pi * 4.5 * t)
    return y * trem * adsr(n, 0.004, 1.2, 0.35, 0.5, dur) * 0.3 * vel

def bell(m, dur, vel=1.0):
    n = int((dur + 1.5) * SR); t = np.arange(n) / SR; f = hz(m)
    y = np.sin(2 * np.pi * f * t + 2.0 * np.exp(-t / 0.6) * np.sin(2 * np.pi * 3.5 * f * t))
    return y * np.exp(-t / 0.9) * np.minimum(1, t / 0.003) * 0.28 * vel

def sub(m, dur, vel=1.0):
    n = int((dur + 0.1) * SR); t = np.arange(n) / SR
    return np.sin(2 * np.pi * hz(m) * t) * adsr(n, 0.01, 0.3, 0.8, 0.06, dur) * 0.5 * vel

_hp = butter(4, 7500, btype='high', fs=SR, output='sos'); _bp = butter(2, [900, 6000], btype='band', fs=SR, output='sos')
_hp2 = butter(2, 3000, btype='high', fs=SR, output='sos')
def kick(vel=1.0, soft=False):
    n = int(0.4 * SR); t = np.arange(n) / SR
    f = 48 + (90 if soft else 140) * np.exp(-t / (0.04 if soft else 0.03))
    y = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t / (0.2 if soft else 0.17))
    if not soft: y[:50] += rng.uniform(-0.5, 0.5, 50)
    return np.tanh(1.8 * y) * vel
def clap(vel=1.0):
    n = int(0.3 * SR); t = np.arange(n) / SR; e = np.zeros(n)
    for d in (0, 0.009, 0.019): e += (t >= d) * np.exp(-np.maximum(0, t - d) / (0.012 if d < 0.019 else 0.13))
    return sosfilt(_bp, rng.uniform(-1, 1, n)) * e * vel * 0.9
def rim(vel=1.0):
    n = int(0.12 * SR); t = np.arange(n) / SR
    return (np.sin(2 * np.pi * 1700 * t) * 0.5 + sosfilt(_bp, rng.uniform(-1, 1, n))) * np.exp(-t / 0.025) * vel * 0.5
def hat(vel=1.0, op=False):
    n = int((0.35 if op else 0.07) * SR); t = np.arange(n) / SR
    return sosfilt(_hp, rng.uniform(-1, 1, n)) * np.exp(-t / (0.11 if op else 0.018)) * vel * 0.4
def shaker(vel=1.0):
    n = int(0.09 * SR); t = np.arange(n) / SR
    return sosfilt(_hp2, rng.uniform(-1, 1, n)) * np.sin(np.pi * np.clip(t / 0.09, 0, 1)) ** 2 * vel * 0.22
def crash(vel=1.0):
    n = int(2.0 * SR); t = np.arange(n) / SR
    return sosfilt(_hp2, rng.uniform(-1, 1, n)) * np.exp(-t / 0.6) * vel * 0.35
_snbp = butter(2, [1400, 9000], btype='band', fs=SR, output='sos'); _gbp = butter(2, [700, 6500], btype='band', fs=SR, output='sos')
def snare(vel=1.0, tone=185, decay=0.14):
    n = int(0.35 * SR); t = np.arange(n) / SR
    body = np.sin(2 * np.pi * tone * t) * np.exp(-t / 0.05) * 0.7 + np.sin(2 * np.pi * tone * 1.6 * t) * np.exp(-t / 0.03) * 0.3
    return np.tanh(1.5 * (body + sosfilt(_snbp, rng.uniform(-1, 1, n)) * np.exp(-t / decay) * 1.1)) * vel * 0.75
def gsnare(vel=1.0):   # a big 80s snare: the hit, then a burst of room that stops dead
    n = int(0.42 * SR); t = np.arange(n) / SR
    room = sosfilt(_gbp, rng.uniform(-1, 1, n)) * np.where(t < 0.21, 1 - 0.35 * t / 0.21, 0.65 * np.exp(-(t - 0.21) / 0.012)) * np.minimum(1, t / 0.004)
    hit = np.zeros(n); h = snare(vel, 175, 0.1)[:n]; hit[:len(h)] = h
    return hit + room * 0.55 * vel
def tom(m, vel=1.0):
    n = int(0.45 * SR); t = np.arange(n) / SR; f = hz(m) * (1 + 0.6 * np.exp(-t / 0.03))
    return np.tanh(1.4 * np.sin(2 * np.pi * np.cumsum(f) / SR)) * np.exp(-t / 0.18) * vel * 0.7
def ride(vel=1.0):
    n = int(0.6 * SR); t = np.arange(n) / SR
    y = sosfilt(_hp2, rng.uniform(-1, 1, n)) * 0.6 + sum(np.sin(2 * np.pi * f * t) for f in (3150, 4870, 6230)) * 0.12
    return y * np.exp(-t / 0.3) * vel * 0.25
def reese(m, dur, vel=1.0, lo=350, hi=1100):   # two detuned saws, a filter that slowly opens and closes, and a sine under them
    n = int((dur + 0.06) * SR); t = np.arange(n) / SR
    cut = lo + (hi - lo) * (0.5 - 0.5 * np.cos(2 * np.pi * t / max(dur, 0.3)))
    y = saw(hz(m), n, cut, (-0.011, 0.011), maxh=40) + 0.9 * np.sin(2 * np.pi * hz(m) * t)
    return np.tanh(1.7 * y) * adsr(n, 0.006, 0.3, 0.85, 0.04, dur) * 0.5 * vel
def gtr(m, dur, vel=1.0, mute=False):   # a distorted power chord (root, fifth, octave) through a speaker-ish filter
    n = int((dur + (0.05 if mute else 0.25)) * SR)
    y = sum(saw(hz(x), n, 2600, (-0.004, 0.004), maxh=40) for x in (m, m + 7, m + 12))
    y = sosfilt(butter(2, 1600 if mute else 3800, fs=SR, output='sos'), np.tanh(5 * y))
    return y * adsr(n, 0.002, 0.09 if mute else 0.5, 0.15 if mute else 0.7, 0.05, dur) * 0.33 * vel
def square(m, dur, vel=1.0):   # a bright square lead, a little vibrato once the note is held
    n = int((dur + 0.15) * SR); t = np.arange(n) / SR; f = hz(m)
    ph = 2 * np.pi * f * np.cumsum(1 + 0.005 * np.clip((t - 0.15) / 0.2, 0, 1) * np.sin(2 * np.pi * 5.8 * t)) / SR
    y = sum(np.sin(k * ph) / k / (1 + (k * f / 5000) ** 2) for k in range(1, min(40, int(15000 / f)) + 1, 2))
    return y * adsr(n, 0.004, 0.25, 0.7, 0.06, dur) * 0.45 * vel
def stab(ms, vel=1.0):   # a short chord hit
    n = int(0.45 * SR); t = np.arange(n) / SR
    y = sum(saw(hz(m), n, 900 + 4000 * np.exp(-t / 0.05), (-0.008, 0.0, 0.008), maxh=30) for m in ms) / len(ms)
    return y * np.exp(-t / 0.12) * np.minimum(1, t / 0.002) * 0.6 * vel

def riser(dur):
    n = int(dur * SR); t = np.arange(n) / SR; x = rng.uniform(-1, 1, n); out = np.zeros(n)
    for i in range(0, n, 2048):   # a noise sweep, a block at a time
        f0 = 400 + 6000 * (i / n) ** 2; s = butter(2, [f0, f0 * 1.6], btype='band', fs=SR, output='sos')
        out[i:i + 2048] = sosfilt(s, x[i:i + 2048])
    return out * (t / dur) ** 2 * 0.5

# ---------------------------------------------------------------- the mixer
class Mix:
    def __init__(self, seconds, buses):
        self.n = int(seconds * SR); self.b = {k: np.zeros((self.n, 2)) for k in buses}; self.send = np.zeros((self.n, 2))
    def put(self, bus, sig, at, pan=0.0, rev=0.0, jitter=0.0):
        i = max(0, int((at + (rng.normal(0, jitter) if jitter else 0)) * SR)); j = min(self.n, i + len(sig)); sig = sig[:j - i]
        l, r = np.cos((pan + 1) * np.pi / 4), np.sin((pan + 1) * np.pi / 4)
        self.b[bus][i:j, 0] += sig * l; self.b[bus][i:j, 1] += sig * r
        if rev: self.send[i:j, 0] += sig * l * rev; self.send[i:j, 1] += sig * r * rev

def comb(x, D, g):
    y = x.copy()
    for s in range(D, len(x), D): e = min(s + D, len(x)); y[s:e] += g * y[s - D:e - D]
    return y
def allpass(x, D, g):
    y = np.zeros_like(x); y[:D] = -g * x[:D]
    for s in range(D, len(x), D): e = min(s + D, len(x)); y[s:e] = -g * x[s:e] + x[s - D:e - D] + g * y[s - D:e - D]
    return y
def reverb(x, spread, fb):
    y = sum(comb(x, d + spread, fb) for d in (1557, 1617, 1491, 1422, 1277, 1356)) / 6
    for d in (225, 556, 341): y = allpass(y, d + spread // 2, 0.6)
    return sosfilt(butter(1, 6000, fs=SR, output='sos'), y)
def delay(x, d, fb, mix):
    D = int(d * SR); y = x.copy()
    for s in range(D, len(x), D): e = min(s + D, len(x)); y[s:e] += fb * y[s - D:e - D]
    return x + (y - x) * mix

def finish(mix, loop_n, gains, pump=None, rev_fb=0.8, rev_amt=0.5):
    wet = np.stack([reverb(mix.send[:, 0], 0, rev_fb), reverb(mix.send[:, 1], 23, rev_fb)], 1) * rev_amt
    out = wet.copy()
    for k, g in gains.items():
        s = mix.b[k] * g
        if pump is not None and k in ('pad', 'bass', 'arp', 'keys'): s = s * pump[:, None]
        out += s
    out = sosfilt(butter(2, 30, btype='high', fs=SR, output='sos'), out, axis=0)
    loop = out[loop_n:2 * loop_n].copy()
    k = int(0.006 * SR); w = np.linspace(0, 1, k)[:, None]; loop[-k:] = loop[-k:] * (1 - w) + out[loop_n - k:loop_n] * w
    loop = np.tanh(loop / np.max(np.abs(loop)) * 1.5); return loop / np.max(np.abs(loop)) * 0.89

# ---------------------------------------------------------------- race theme
def race():
    BPM = 140; B = 60 / BPM; BAR = 4 * B; S16 = B / 4
    prog = {'Am': [57, 60, 64], 'F': [53, 57, 60], 'C': [55, 60, 64], 'G': [55, 59, 62], 'E': [56, 59, 64]}
    root = {'Am': 33, 'F': 29, 'C': 36, 'G': 31, 'E': 28}
    secs = [('intro', ['Am', 'F', 'C', 'G']), ('A', ['Am', 'F', 'C', 'G'] * 2), ('B', ['Am', 'F', 'C', 'G', 'Am', 'F', 'C', 'E']),
            ('break', ['F', 'G', 'Am', 'E']), ('C', ['Am', 'F', 'C', 'G', 'Am', 'F', 'C', 'E']), ('out', ['Am', 'F', 'C', 'G'])]
    bars = [(s, c) for s, cs in secs for c in cs]
    HOOK = [[(76, 0, 3), (74, 3, 1), (76, 4, 2), (79, 6, 2)], [(81, 0, 3), (79, 3, 1), (76, 4, 2), (72, 6, 2)],
            [(74, 0, 2), (76, 2, 2), (79, 4, 2), (76, 6, 2)], [(74, 0, 6), (71, 6, 2)],
            [(76, 0, 3), (74, 3, 1), (76, 4, 2), (81, 6, 2)], [(84, 0, 3), (83, 3, 1), (81, 4, 2), (79, 6, 2)],
            [(76, 0, 2), (79, 2, 2), (81, 4, 1), (79, 5, 1), (76, 6, 2)], [(80, 0, 4), (83, 4, 4)]]
    L = len(bars) * BAR; LN = int(round(L * SR)); mix = Mix(2 * L + 3, ['drums', 'bass', 'arp', 'pad', 'lead'])
    for p in range(2):
        hook_i = 0
        for bi, (sec, ch) in enumerate(bars):
            t0 = p * LN / SR + bi * BAR
            # drums
            if sec != 'break':
                for b in range(4): mix.put('drums', kick(1.0 if sec != 'intro' else 0.85), t0 + b * B)
                if sec != 'intro':
                    for b in (1, 3): mix.put('drums', clap(), t0 + b * B, 0.05, 0.2)
                for s in range(16):
                    if s % 4 == 2: mix.put('drums', hat(0.75, op=True), t0 + s * S16, 0.3, 0.05)
                    elif sec not in ('intro',) or s % 2 == 0: mix.put('drums', hat(0.55 if s % 2 else 0.4), t0 + s * S16, 0.3)
            else:
                for s in range(0, 16, 2): mix.put('drums', hat(0.35), t0 + s * S16, 0.3)
                if bi == [i for i, x in enumerate(bars) if x[0] == 'break'][-1]: mix.put('drums', riser(BAR), t0, 0, 0.3)
            if sec in ('A', 'B', 'C') and (bi == [i for i, x in enumerate(bars) if x[0] == sec][0]): mix.put('drums', crash(), t0, -0.2, 0.3)
            # bass: rolling sixteenths, root and octave
            if sec != 'break':
                for s in range(16):
                    m = root[ch] + (12 if s % 2 else 0); mix.put('bass', bassnote(m, S16 * 0.8, 1.0 if s % 4 == 0 else 0.8), t0 + s * S16)
            else:
                mix.put('bass', sub(root[ch] + 12, BAR * 0.95, 0.8), t0)
            # arpeggio
            if sec in ('A', 'B', 'C', 'break', 'out'):
                tones = prog[ch]; pat = [0, 1, 2, 3, 2, 1, 0, 1]
                for s in range(16):
                    k = pat[s % 8]; m = (tones[k] if k < 3 else tones[0] + 12) + 12
                    mix.put('arp', pluck(m, S16 * 0.9, 0.9 if s % 4 == 0 else 0.65) * (0.55 if sec in ('B', 'C') else 1), t0 + s * S16, -0.35 if s % 2 else 0.35, 0.3)
            # pads
            if sec in ('B', 'break', 'C'):
                for m in prog[ch]: mix.put('pad', supersaw(m, BAR * 0.98, 0.8), t0, 0, 0.5)
            # the hook
            if sec in ('B', 'C'):
                for m, s, l in HOOK[hook_i % 8]:
                    mix.put('lead', lead(m + (12 if sec == 'C' else 0) * 0, l * B / 2 * 0.95, 1.0), t0 + s * B / 2, 0.1, 0.35)
                    if sec == 'C': mix.put('lead', lead(m + 12, l * B / 2 * 0.95, 0.4), t0 + s * B / 2, -0.25, 0.4)
                hook_i += 1
        print('race pass', p + 1, file=sys.stderr)
    t = np.arange(mix.n) / SR; ph = (t % B) / B
    pump = 1 - 0.55 * np.exp(-ph / 0.12) * np.minimum(1, ph / 0.01 + 0.5)
    mix.b['lead'] = np.stack([delay(mix.b['lead'][:, c], B * 0.75, 0.3, 0.3) for c in (0, 1)], 1)
    return finish(mix, LN, {'drums': 0.8, 'bass': 0.7, 'arp': 0.55, 'pad': 0.5, 'lead': 0.8}, pump)

# ---------------------------------------------------------------- menu theme
def menu():
    BPM = 92; B = 60 / BPM; BAR = 4 * B
    ch = {'Dm7': [50, 53, 57, 60], 'Bbmaj7': [46, 50, 53, 57], 'Fmaj7': [53, 57, 60, 64], 'C': [48, 52, 55, 60], 'Am7': [45, 48, 52, 55]}
    root = {'Dm7': 38, 'Bbmaj7': 34, 'Fmaj7': 41, 'C': 36, 'Am7': 33}
    prog = ['Dm7', 'Bbmaj7', 'Fmaj7', 'C']
    secs = [('intro', prog), ('A', prog * 2), ('B', prog * 2), ('out', ['Dm7', 'Bbmaj7', 'Am7', 'C'])]
    bars = [(s, c) for s, cs in secs for c in cs]
    MEL = [[(81, 0, 2), (77, 2, 2), (74, 4, 4)], [(74, 0, 2), (77, 2, 2), (81, 4, 2), (79, 6, 2)],
           [(81, 0, 4), (84, 4, 2), (81, 6, 2)], [(79, 0, 6), (76, 6, 2)],
           [(81, 0, 2), (77, 2, 2), (74, 4, 2), (76, 6, 2)], [(77, 0, 4), (74, 4, 4)],
           [(72, 0, 2), (77, 2, 2), (81, 4, 4)], [(79, 0, 8)]]
    L = len(bars) * BAR; LN = int(round(L * SR)); mix = Mix(2 * L + 4, ['drums', 'bass', 'keys', 'lead'])
    sw = B / 2 * 0.14   # a little swing on the off-beat eighths
    for p in range(2):
        mi = 0
        for bi, (sec, c) in enumerate(bars):
            t0 = p * LN / SR + bi * BAR
            # electric piano: the chord on 1, again softly on the "and" of 2
            for m in ch[c]: mix.put('keys', epiano(m, B * 1.6, 0.9), t0, -0.15, 0.45, 0.006)
            for m in ch[c][1:]: mix.put('keys', epiano(m + 12, B * 0.8, 0.45), t0 + 1.5 * B + sw, 0.2, 0.45, 0.006)
            for m in ch[c]: mix.put('keys', epiano(m, B * 1.2, 0.6), t0 + 2.5 * B + sw, -0.15, 0.45, 0.006)
            for e in range(8): mix.put('drums', shaker(0.9 if e % 2 else 0.6), t0 + e * B / 2 + (sw if e % 2 else 0), 0.35)
            if sec in ('A', 'B'):
                mix.put('drums', kick(0.8, soft=True), t0); mix.put('drums', kick(0.6, soft=True), t0 + 2.5 * B + sw)
                for b in (1, 3): mix.put('drums', rim(0.8), t0 + b * B, 0.1, 0.25)
            if sec != 'intro':
                mix.put('bass', sub(root[c], B * 1.8), t0); mix.put('bass', sub(root[c] + (7 if c != 'C' else 5), B * 0.9, 0.7), t0 + 2.5 * B + sw)
            if sec == 'B':
                for m, s, l in MEL[mi % 8]: mix.put('lead', bell(m, l * B / 2, 0.9), t0 + s * B / 2 + (sw if s % 2 else 0), 0.15, 0.5)
                mi += 1
        print('menu pass', p + 1, file=sys.stderr)
    mix.b['lead'] = np.stack([delay(mix.b['lead'][:, c], B * 0.75, 0.35, 0.35) for c in (0, 1)], 1)
    lp = butter(2, 3800, fs=SR, output='sos')   # a warm, slightly dusty top end
    for k in ('keys', 'drums'): mix.b[k] = sosfilt(lp, mix.b[k], axis=0)
    return finish(mix, LN, {'drums': 0.7, 'bass': 0.8, 'keys': 0.8, 'lead': 0.7}, None, 0.84, 0.6)

# ---------------------------------------------------------------- race theme 2: night drive (80s synth)
def night():
    BPM = 118; B = 60 / BPM; BAR = 4 * B; S16 = B / 4
    ch = {'Dm': [62, 65, 69], 'Bb': [58, 62, 65], 'F': [57, 60, 65], 'C': [60, 64, 67], 'A': [61, 64, 69], 'Gm': [62, 67, 70]}
    root = {'Dm': 38, 'Bb': 34, 'F': 41, 'C': 36, 'A': 33, 'Gm': 43}
    secs = [('intro', ['Dm', 'Bb', 'F', 'C']), ('A', ['Dm', 'Bb', 'F', 'C'] * 2), ('B', ['Bb', 'C', 'Dm', 'Dm', 'Bb', 'C', 'A', 'A']),
            ('break', ['Gm', 'A']), ('C', ['Bb', 'C', 'Dm', 'Dm', 'Bb', 'C', 'A', 'A'])]
    bars = [(s, c) for s, cs in secs for c in cs]
    MEL = [[(74, 0, 3), (77, 3, 3), (79, 6, 2)], [(79, 0, 2), (81, 2, 2), (79, 4, 2), (76, 6, 2)], [(77, 0, 6), (74, 6, 2)], [(69, 0, 4), (74, 4, 2), (76, 6, 2)],
           [(77, 0, 3), (79, 3, 3), (81, 6, 2)], [(84, 0, 3), (82, 3, 1), (81, 4, 2), (79, 6, 2)], [(81, 0, 4), (79, 4, 2), (76, 6, 2)], [(73, 0, 4), (76, 4, 4)]]
    L = len(bars) * BAR; LN = int(round(L * SR)); mix = Mix(2 * L + 3, ['drums', 'bass', 'arp', 'pad', 'lead'])
    first = {s: next(i for i, x in enumerate(bars) if x[0] == s) for s, _ in secs}
    for p in range(2):
        mi = 0
        for bi, (sec, c) in enumerate(bars):
            t0 = p * LN / SR + bi * BAR
            if sec != 'break':
                kicks = (0, 1, 2, 3) if sec == 'C' else (0, 2, 2.5) if sec != 'intro' else (0, 2)
                for b in kicks: mix.put('drums', kick(0.95), t0 + b * B)
                if sec != 'intro':
                    for b in (1, 3): mix.put('drums', gsnare(0.9), t0 + b * B, 0.05, 0.15)
                for s in range(16): mix.put('drums', hat(0.5 if s % 2 else 0.32), t0 + s * S16, 0.35)
            else:
                for b in range(4): mix.put('drums', tom(45 - (bi - first['break']) * 4 - b, 0.7), t0 + b * B + 2 * S16 * (b % 2), -0.3 + 0.2 * b)
                if bi == first['break'] + 1: mix.put('drums', riser(BAR), t0, 0, 0.3)
            if bi in (first['A'], first['B'], first['C']): mix.put('drums', crash(0.9), t0, -0.2, 0.3)
            # bass: eighths on the root, octave jumps once the tune is going
            for e in range(8):
                m = root[c] + (12 if sec in ('B', 'C') and e % 2 else 0)
                mix.put('bass', bassnote(m, B / 2 * 0.75, 1.0 if e % 2 == 0 else 0.8), t0 + e * B / 2)
            # the arpeggio: chord tones up and down over two octaves
            tones = ch[c] + [x + 12 for x in ch[c]]; pat = [0, 1, 2, 3, 4, 5, 4, 3, 2, 1, 2, 3, 4, 5, 4, 3]
            for s in range(16): mix.put('arp', pluck(tones[pat[s]], S16 * 0.8, 0.85 if s % 4 == 0 else 0.6) * (0.6 if sec in ('B', 'C') else 0.9), t0 + s * S16, -0.4 if s % 2 else 0.4, 0.35)
            for m in ch[c]: mix.put('pad', supersaw(m - 12, BAR * 0.98, 0.75 if sec != 'intro' else 0.55, att=0.5), t0, 0, 0.5)
            if sec in ('B', 'C'):
                for m, s, l in MEL[mi % 8]:
                    mix.put('lead', lead(m, l * B / 2 * 0.95, 1.0), t0 + s * B / 2, 0.1, 0.4)
                    if sec == 'C': mix.put('lead', lead(m - 12, l * B / 2 * 0.95, 0.45), t0 + s * B / 2, -0.3, 0.4)
                mi += 1
        print('night pass', p + 1, file=sys.stderr)
    t = np.arange(mix.n) / SR; ph = (t % B) / B
    pump = 1 - 0.4 * np.exp(-ph / 0.14) * np.minimum(1, ph / 0.01 + 0.5)
    for k in ('lead', 'arp'): mix.b[k] = np.stack([delay(mix.b[k][:, c], B * 0.75, 0.35, 0.3) for c in (0, 1)], 1)
    return finish(mix, LN, {'drums': 0.8, 'bass': 0.7, 'arp': 0.5, 'pad': 0.45, 'lead': 0.75}, pump, 0.84, 0.55)

# ---------------------------------------------------------------- race theme 3: breakbeat (fast drum and bass)
def breaks():
    BPM = 174; B = 60 / BPM; BAR = 4 * B; S16 = B / 4
    ch = {'Em': [64, 67, 71], 'C': [64, 67, 72], 'G': [62, 67, 71], 'D': [62, 66, 69]}
    root = {'Em': 28, 'C': 24, 'G': 31, 'D': 26}
    phrase = ['Em', 'Em', 'C', 'C', 'G', 'G', 'D', 'D']
    secs = [('intro', ['Em', 'Em', 'D', 'D']), ('drop', phrase * 2), ('break', ['C', 'C', 'D', 'D']), ('drop2', phrase * 2)]
    bars = [(s, c) for s, cs in secs for c in cs]
    MEL = [[(79, 0, 1.5), (78, 1.5, 1.5), (76, 3, 1), (71, 4, 4)], [(72, 0, 1.5), (74, 1.5, 1.5), (76, 3, 1), (79, 4, 3), (76, 7, 1)],
           [(74, 0, 1.5), (76, 1.5, 1.5), (79, 3, 1), (81, 4, 4)], [(78, 0, 3), (76, 3, 1), (74, 4, 2), (78, 6, 2)],
           [(79, 0, 1.5), (78, 1.5, 1.5), (76, 3, 1), (83, 4, 4)], [(84, 0, 1.5), (83, 1.5, 1.5), (79, 3, 1), (76, 4, 4)],
           [(74, 0, 1.5), (76, 1.5, 1.5), (79, 3, 1), (81, 4, 3), (83, 7, 1)], [(81, 0, 3), (79, 3, 1), (78, 4, 4)]]
    L = len(bars) * BAR; LN = int(round(L * SR)); mix = Mix(2 * L + 3, ['drums', 'bass', 'arp', 'pad', 'lead'])
    first = {s: next(i for i, x in enumerate(bars) if x[0] == s) for s, _ in secs}
    for p in range(2):
        for bi, (sec, c) in enumerate(bars):
            t0 = p * LN / SR + bi * BAR; odd = (bi - first[sec]) % 2; drop = sec in ('drop', 'drop2')
            if drop:
                for s in ((0, 10) if not odd else (0, 2, 10)): mix.put('drums', kick(1.0), t0 + s * S16)
                for s in (4, 12): mix.put('drums', snare(1.0), t0 + s * S16, 0.05, 0.12)
                for s in (7, 15) if odd else (15,): mix.put('drums', snare(0.3), t0 + s * S16, 0.1)
                for s in range(16):
                    if s % 2 == 0 or s in (5, 11, 13): mix.put('drums', hat(0.55 if s % 4 == 2 else 0.35), t0 + s * S16, 0.3)
                if sec == 'drop2':
                    for b in range(4): mix.put('drums', ride(0.7), t0 + b * B, -0.35)
                if bi == first[sec]: mix.put('drums', crash(1.0), t0, -0.2, 0.3)
                # the bass: a long note on each chord, and a short push into the next
                if not odd: mix.put('bass', reese(root[c] + 12, BAR * 1.5, 1.0), t0)
                else: mix.put('bass', reese(root[c] + 12, B * 0.4, 0.9, 600, 900), t0 + 14 * S16)
                if not odd:
                    for s in (3, 6): mix.put('arp', stab(ch[c], 0.8), t0 + s * S16, 0.3 if s == 3 else -0.3, 0.3)
            elif sec == 'intro':
                for s in range(0, 16, 2): mix.put('drums', hat(0.35 + 0.3 * (bi - first['intro']) / 4), t0 + s * S16, 0.3)
                if bi >= first['intro'] + 1:
                    for s in (4, 12): mix.put('drums', snare(0.35), t0 + s * S16, 0.05, 0.3)
                if bi == first['drop'] - 2: mix.put('drums', riser(2 * BAR), t0, 0, 0.3)
            else:
                mix.put('bass', sub(root[c] + 24, BAR * 0.95, 0.7), t0)
                for s in range(0, 16, 4): mix.put('drums', hat(0.3), t0 + s * S16 + 2 * S16, 0.3)
            # pads and a rolling pluck that carry the harmony through every section
            if not odd:
                for m in ch[c]: mix.put('pad', supersaw(m - 12, BAR * 1.95, 0.7 if drop else 0.85, att=0.4), t0, 0, 0.55)
            for s in range(0, 16, 2):
                k = [0, 1, 2, 1, 0, 2, 1, 2][s // 2]; mix.put('arp', pluck(ch[c][k] + 12, S16 * 1.5, 0.5 if drop else 0.7), t0 + s * S16, -0.35 if s % 4 else 0.35, 0.4)
            # the tune (half as fast as the drums), in the second drop and softly in the break
            if (sec == 'drop2' or sec == 'break') and not odd:
                k = ((bi - first[sec]) // 2) % 8 if sec == 'drop2' else [1, 3][(bi - first['break']) // 2]
                for m, s, l in MEL[k]:
                    mix.put('lead', lead(m, l * B * 0.95, 1.0 if drop else 0.6), t0 + s * B, 0.1, 0.4)
                    if drop: mix.put('lead', bell(m + 12, l * B, 0.35), t0 + s * B, -0.3, 0.4)
        print('breaks pass', p + 1, file=sys.stderr)
    t = np.arange(mix.n) / SR; ph = (t % (2 * B)) / (2 * B)
    pump = 1 - 0.35 * np.exp(-ph / 0.08) * np.minimum(1, ph / 0.01 + 0.5)
    mix.b['lead'] = np.stack([delay(mix.b['lead'][:, c], B * 0.75, 0.3, 0.3) for c in (0, 1)], 1)
    return finish(mix, LN, {'drums': 0.85, 'bass': 0.75, 'arp': 0.45, 'pad': 0.45, 'lead': 0.7}, pump, 0.82, 0.5)

# ---------------------------------------------------------------- race theme 4: rock (distorted chords)
def rock():
    BPM = 132; B = 60 / BPM; BAR = 4 * B; S16 = B / 4
    root = {'Gm': 43, 'Eb': 39, 'Bb': 46, 'F': 41, 'Cm': 48, 'D': 38}
    tri = {'Gm': [67, 70, 74], 'Eb': [67, 70, 75], 'Bb': [65, 70, 74], 'F': [65, 69, 72], 'Cm': [67, 72, 75], 'D': [66, 69, 74]}
    verse = ['Gm', 'Gm', 'Eb', 'F'] * 2; chorus = ['Gm', 'Eb', 'Bb', 'F'] * 2
    secs = [('intro', ['Gm', 'Gm', 'Eb', 'F']), ('verse', verse), ('chorus', chorus), ('bridge', ['Cm', 'Eb', 'D', 'D']), ('chorus2', chorus)]
    bars = [(s, c) for s, cs in secs for c in cs]
    HOOK = [[(67, 0, 2), (70, 2, 2), (74, 4, 3), (72, 7, 1)], [(70, 0, 2), (67, 2, 2), (70, 4, 2), (72, 6, 2)], [(74, 0, 3), (77, 3, 3), (74, 6, 2)], [(72, 0, 4), (69, 4, 2), (72, 6, 2)],
            [(67, 0, 2), (70, 2, 2), (74, 4, 3), (79, 7, 1)], [(79, 0, 3), (77, 3, 1), (75, 4, 2), (74, 6, 2)], [(74, 0, 2), (72, 2, 2), (70, 4, 2), (72, 6, 2)], [(72, 0, 4), (74, 4, 4)]]
    L = len(bars) * BAR; LN = int(round(L * SR)); mix = Mix(2 * L + 3, ['drums', 'bass', 'keys', 'arp', 'lead'])
    first = {s: next(i for i, x in enumerate(bars) if x[0] == s) for s, _ in secs}
    last = {s: max(i for i, x in enumerate(bars) if x[0] == s) for s, _ in secs}
    for p in range(2):
        hi = 0
        for bi, (sec, c) in enumerate(bars):
            t0 = p * LN / SR + bi * BAR; big = sec in ('chorus', 'chorus2')
            # drums: a rock beat (half time in the bridge), a tom fill into each new part
            fill = bi == last[sec] and sec != 'chorus2'
            if sec == 'bridge':
                mix.put('drums', kick(1.0), t0); mix.put('drums', snare(1.0), t0 + 2 * B, 0.05, 0.3)
                for b in range(4): mix.put('drums', ride(0.6), t0 + b * B, -0.3)
                if fill: mix.put('drums', riser(BAR), t0, 0, 0.3)
            else:
                for s in (0, 6, 8) if sec != 'intro' else (0, 8): mix.put('drums', kick(1.0), t0 + s * S16)
                if sec != 'intro':
                    for b in (1, 3) if not fill else (1,): mix.put('drums', snare(1.0), t0 + b * B, 0.05, 0.15)
                for e in range(8 if not fill else 4): mix.put('drums', hat(0.6, op=big and e % 2 == 1) if not big or e % 2 else hat(0.45), t0 + e * B / 2, 0.3)
                if fill:
                    for k, s in enumerate(range(8, 16)): mix.put('drums', tom([50, 50, 47, 47, 43, 43, 40, 40][k], 0.8 if k % 2 == 0 else 0.6), t0 + s * S16, 0.4 - 0.1 * k)
            if bi in (first['verse'], first['chorus'], first['chorus2']): mix.put('drums', crash(1.0), t0, -0.2, 0.3)
            # guitar: muted eighths in the verse, big open chords in the chorus
            r = root[c] + 12
            if sec in ('intro', 'verse'):
                for e in range(8): mix.put('keys', gtr(r, B / 2 * 0.7, 0.9 if e % 4 == 0 else 0.7, mute=True), t0 + e * B / 2, -0.45 if e % 2 else 0.45)
            elif big:
                for s, l in ((0, 6), (6, 6), (12, 4)): mix.put('keys', gtr(r, l * S16 * 0.95, 1.0), t0 + s * S16, -0.4, 0.15); mix.put('keys', gtr(r, l * S16 * 0.95, 0.9), t0 + s * S16 + 0.012, 0.4, 0.15)
            else:
                mix.put('keys', gtr(r, BAR * 0.95, 0.7), t0, -0.3, 0.3); mix.put('keys', gtr(r + 7, BAR * 0.95, 0.5), t0, 0.3, 0.3)
            # bass follows the kick and the guitar
            if sec != 'intro':
                for e in range(8):
                    if sec == 'bridge' and e % 4: continue
                    mix.put('bass', bassnote(root[c], (B * 2 if sec == 'bridge' else B / 2) * 0.85, 1.0 if e % 2 == 0 else 0.85), t0 + e * B / 2)
            # a square-wave counter-line in the verse
            if sec == 'verse':
                tones = tri[c]; pat = [0, 1, 2, 1, 0, 1, 2, 1]
                for e in range(8): mix.put('arp', square(tones[pat[e]] + 12, B / 2 * 0.5, 0.45), t0 + e * B / 2, 0.25, 0.3)
            if big:
                for m, s, l in HOOK[hi % 8]:
                    mix.put('lead', lead(m + 12, l * B / 2 * 0.95, 1.0), t0 + s * B / 2, 0.1, 0.35)
                    if sec == 'chorus2': mix.put('lead', square(m, l * B / 2 * 0.95, 0.5), t0 + s * B / 2, -0.25, 0.35)
                hi += 1
        print('rock pass', p + 1, file=sys.stderr)
    mix.b['lead'] = np.stack([delay(mix.b['lead'][:, c], B * 0.5, 0.25, 0.25) for c in (0, 1)], 1)
    return finish(mix, LN, {'drums': 0.85, 'bass': 0.75, 'keys': 0.6, 'arp': 0.4, 'lead': 0.75}, None, 0.78, 0.4)

if __name__ == '__main__':
    y = {'race': race, 'menu': menu, 'night': night, 'breaks': breaks, 'rock': rock}[sys.argv[1]]()
    with wave.open(sys.argv[2], 'wb') as w:
        w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR); w.writeframes((y * 32767).astype('<i2').tobytes())
    print(sys.argv[1], round(len(y) / SR, 2), 's, rms', round(20 * np.log10(np.sqrt(np.mean(y ** 2))), 1), 'dB', file=sys.stderr)
