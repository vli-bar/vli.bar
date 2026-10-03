"""Rebuild NEON DOOR: original stereo music + an authored VRM dance.

Requires Python 3 and NumPy. No samples, pretrained motion, melodies or external
assets are used. The fixed seed makes the output deterministic. VRM rotations
are radians in the normalized VRM 1.0 T-pose (left arm +X, right arm -X).
"""
from pathlib import Path
import json
import math
import wave
import numpy as np

OUT = Path(__file__).resolve().parents[1] / 'public' / 'demo'
OUT.mkdir(parents=True, exist_ok=True)
SR = 32000
DURATION = 72
BPM = 120
BEAT = 60 / BPM
BAR = BEAT * 4
START = 6
FPS = 30
RNG = np.random.default_rng(1025)
MIX = np.zeros((SR * DURATION, 2), dtype=np.float64)
SECTIONS = [
    {'id': 'curtain', 'label': '幕の向こうへ', 'start': 0, 'end': 6},
    {'id': 'intro', 'label': 'INTRO / WELCOME', 'start': 6, 'end': 14},
    {'id': 'verse', 'label': 'VERSE / NEON DOOR', 'start': 14, 'end': 30},
    {'id': 'build', 'label': 'BUILD / LIGHT UP', 'start': 30, 'end': 38},
    {'id': 'chorus', 'label': 'CHORUS / TOGETHER', 'start': 38, 'end': 54},
    {'id': 'bridge', 'label': 'BRIDGE / FLOAT', 'start': 54, 'end': 62},
    {'id': 'outro', 'label': 'OUTRO / THANK YOU', 'start': 62, 'end': 70},
    {'id': 'finale', 'label': 'SEE YOU AGAIN', 'start': 70, 'end': 72},
]


def hz(midi):
    return 440 * 2 ** ((midi - 69) / 12)


def clock(length):
    return np.arange(round(length * SR), dtype=np.float64) / SR


def envelope(t, length, attack=.012, release=.1, decay=None):
    env = np.minimum(t / attack, 1) * np.minimum(np.maximum(length - t, 0) / release, 1)
    if decay is not None:
        env *= np.exp(-t * decay)
    return env


def add(signal, at, gain=1, pan=0, echo=False):
    offset = round(at * SR)
    if offset >= len(MIX):
        return
    first = max(0, -offset)
    offset = max(0, offset)
    take = min(len(signal) - first, len(MIX) - offset)
    if take <= 0:
        return
    signal = signal[first:first + take]
    left = math.cos((pan + 1) * math.pi / 4)
    right = math.sin((pan + 1) * math.pi / 4)
    MIX[offset:offset + take, 0] += signal * gain * left
    MIX[offset:offset + take, 1] += signal * gain * right
    if echo:
        for delay, strength, direction in [(BEAT * .75, .23, -pan), (BEAT * 1.5, .105, pan)]:
            add(signal, at + delay, gain * strength, direction)


def smooth_noise(t, width=12):
    noise = RNG.normal(0, 1, len(t))
    smooth = np.convolve(noise, np.ones(width) / width, mode='same')
    return noise - smooth


def pluck(note, length, soft=False):
    t = clock(length)
    phase = 2 * np.pi * hz(note) * t
    if soft:
        tone = np.sin(phase) + .22 * np.sin(phase * 2) * np.exp(-t * 9)
    else:
        tone = np.sin(phase) + .25 * np.sin(phase * 2) * np.exp(-t * 5) + .12 * np.sin(phase * 3) * np.exp(-t * 9)
        tone += .08 * np.sin(phase * 1.003)
    return tone * envelope(t, length, .008, min(.15, length * .4), 1.8 if soft else 2.5)


def pad(notes, length):
    t = clock(length)
    signal = np.zeros(len(t))
    for j, note in enumerate(notes):
        phase = 2 * np.pi * hz(note) * t
        for detune in [-.0027, .0027]:
            signal += np.sin(phase * (1 + detune) + j * .3)
            signal += .13 * np.sin(phase * 3 * (1 + detune) + j * .3)
    return signal / (len(notes) * 2) * envelope(t, length, .24, .7)


def bass(note, length):
    t = clock(length)
    phase = 2 * np.pi * hz(note) * t
    # Filtered harmonic voice with a sine sub; short attack leaves room for kick.
    body = np.sin(phase) + .27 * np.sin(phase * 2) * np.exp(-t * 4) + .12 * np.sin(phase * 3) * np.exp(-t * 7)
    return body * envelope(t, length, .018, .075) * (.75 + .25 * np.exp(-t * 4))


def kick():
    t = clock(.36)
    phase = 2 * np.pi * (47 * t + 105 * .022 * (1 - np.exp(-t / .022)))
    body = np.sin(phase) * np.exp(-t * 12)
    click = smooth_noise(t, 6) * np.exp(-t * 500) * .12
    return (body + click) * np.minimum(t / .001, 1)


def snare():
    t = clock(.24)
    snap = smooth_noise(t, 24) * np.exp(-t * 23) * .32
    body = (np.sin(2 * np.pi * 185 * t) + .4 * np.sin(2 * np.pi * 330 * t)) * np.exp(-t * 35) * .35
    # A restrained layered clap gives the backbeat breadth without harsh peaks.
    clap = np.zeros(len(t))
    for at in [.005, .017, .029]:
        age = np.maximum(t - at, 0)
        clap += (t >= at) * smooth_noise(t, 10) * np.exp(-age * 85) * .10
    return (snap + body + clap) * np.minimum(t / .001, 1)


def hat(open_hat=False):
    length = .27 if open_hat else .065
    t = clock(length)
    signal = smooth_noise(t, 5) * .3
    for freq in [6271, 8437, 10153]:
        signal += .045 * np.sin(2 * np.pi * freq * t)
    return signal * np.exp(-t * (18 if open_hat else 70)) * np.minimum(t / .001, 1)


def cymbal(length=1.5):
    t = clock(length)
    return smooth_noise(t, 8) * envelope(t, length, .003, .3, 4)


CHORDS = {
    'Em': ([55, 59, 64, 66], 40),
    'C': ([55, 59, 64, 67], 36),
    'G': ([54, 59, 62, 67], 43),
    'D': ([57, 62, 64, 66], 38),
    'Am': ([55, 60, 64, 69], 45),
}
PROGRESSION = (
    ['Em', 'C', 'G', 'D'] +
    ['Em', 'C', 'G', 'D'] * 2 +
    ['C', 'D', 'Em', 'D'] +
    ['C', 'D', 'Em', 'G'] * 2 +
    ['Am', 'Em', 'C', 'D'] +
    ['C', 'D', 'Em', 'Em']
)
# Original eight-bar themes, in beats (offset, scale pitch, duration).
VERSE = [
    [(0, 71, .65), (1, 67, .45), (1.75, 66, .6), (3, 64, .7)],
    [(.5, 67, .45), (1.25, 71, .45), (2, 72, .65), (3, 71, .65)],
    [(0, 74, .7), (1, 71, .45), (2, 69, .45), (2.75, 67, .85)],
    [(.5, 66, .7), (1.5, 69, .7), (3, 74, .6)],
    [(0, 71, .65), (1, 74, .45), (1.75, 76, .6), (3, 74, .7)],
    [(.5, 72, .45), (1.25, 71, .45), (2, 67, 1.1)],
    [(0, 71, .65), (1, 69, .45), (2, 67, .65), (3, 66, .45)],
    [(0, 69, .8), (1.5, 66, .8), (3, 64, .8)],
]
CHORUS = [
    [(0, 76, .75), (1, 74, .45), (1.75, 72, .8), (3, 71, .6)],
    [(0, 74, .75), (1.5, 78, .45), (2.25, 76, .45), (3, 74, .7)],
    [(0, 79, 1), (1.5, 78, .45), (2.25, 76, 1.3)],
    [(0, 74, .75), (1, 71, .45), (2, 67, 1.25)],
    [(0, 76, .75), (1, 79, .45), (1.75, 81, .8), (3, 79, .6)],
    [(0, 78, .7), (1, 76, .45), (2, 74, .65), (3, 69, .65)],
    [(0, 71, .6), (1, 74, .45), (1.75, 76, .8), (3, 79, .65)],
    [(0, 78, .6), (1, 76, .6), (2, 74, 1.5)],
]

# An airy opening sound follows the descending curtain.
add(pad(CHORDS['Em'][0], 6.8), 0, .15, -.2)
add(pad([76, 79, 83], 6.3), .3, .065, .35)
for beat, note in enumerate([64, 71, 76, 78, 79, 83]):
    add(pluck(note, 1.7, True), 1.5 + beat * .55, .085, -.5 + beat * .2, True)

for bar, name in enumerate(PROGRESSION):
    at = START + bar * BAR
    notes, root = CHORDS[name]
    is_intro = bar < 4
    is_build = 12 <= bar < 16
    is_chorus = 16 <= bar < 24
    is_bridge = 24 <= bar < 28
    is_outro = bar >= 28
    energy = .55 if is_intro else .6 if is_bridge else .78 if is_outro else 1
    add(pad(notes, BAR + .65), at, .14 * energy, -.45)
    add(pad([n + 12 for n in notes[:3]], BAR + .8), at + .017, .075 * energy, .45)

    # Deliberate bass syncopation rather than a note on every kick.
    for offset, length, octave in [(0, .65, 0), (.75, .35, 0), (1.5, .4, 12), (2, .65, 0), (2.75, .35, 0), (3.5, .4, 0)]:
        if is_intro and bar < 2:
            continue
        if is_bridge and offset not in [0, 2]:
            continue
        add(bass(root + octave, length * BEAT), at + offset * BEAT, .29 * energy)

    for step in range(8):
        if is_bridge and step % 2:
            continue
        arp_note = notes[[0, 2, 1, 3, 2, 1, 3, 2][step]] + 12
        gain = (.062 if is_chorus else .055) * energy
        add(pluck(arp_note, .32, True), at + step * BEAT / 2, gain, -.65 if step % 2 else .65, True)

    if 4 <= bar < 12:
        phrase = VERSE[(bar - 4) % 8]
    elif is_chorus:
        phrase = CHORUS[(bar - 16) % 8]
    elif is_outro:
        phrase = VERSE[[0, 3, 7, 7][bar - 28]] if bar < 31 else [(0, 76, 3.5)]
    elif is_bridge:
        phrase = [(0, [72, 71, 67, 69][bar - 24], 2.7)]
    elif is_build:
        phrase = [(.5, [72, 74, 76, 78][bar - 12], .6), (2.5, [76, 78, 79, 81][bar - 12], .8)]
    else:
        phrase = []
    for offset, note, length in phrase:
        add(pluck(note, length * BEAT + .17), at + offset * BEAT, .19 if is_chorus else .145, .08, True)
        if is_chorus:
            add(pluck(note - 12, length * BEAT + .11, True), at + offset * BEAT + .008, .063, -.12)

    for beat in range(4):
        beat_at = at + beat * BEAT
        if not (is_intro and bar < 2) and not (is_bridge and beat % 2) and not (bar == 31 and beat > 0):
            add(kick(), beat_at, .43 if is_chorus else .36)
        if beat % 2 and not (is_intro and bar < 2) and not is_bridge and bar != 31:
            add(snare(), beat_at, .35 if is_chorus else .28, -.08)
        if bar != 31:
            add(hat(False), beat_at, .08 * energy, -.25)
            add(hat(is_chorus), beat_at + BEAT / 2, .11 * energy, .3)
        if is_chorus or (is_build and bar > 13):
            add(hat(False), beat_at + BEAT * .75, .043, -.4)
    if bar in [4, 16, 24, 28]:
        add(cymbal(), at, .075, .25)
    if bar in [11, 23, 27]:
        for fill in range(3):
            add(snare(), at + 1.5 + fill * .125, .10 + fill * .025, -.25 + fill * .25)
    if is_build:
        divisions = [2, 4, 4, 8][bar - 12]
        for step in range(divisions):
            add(snare(), at + step * BAR / divisions, .055 + step / divisions * .07, -.25 + step / divisions * .5)

# Build-up sweep and resolving chord. Gentle tails are retained through the bow.
t = clock(7.8)
noise = np.convolve(RNG.normal(0, 1, len(t)), np.ones(16) / 16, mode='same')
sweep = np.sin(2 * np.pi * (450 * t + 100 * t ** 2)) * .08 + noise * .25
add(sweep * envelope(t, 7.8, 6.5, .12), 30.1, .16, .2)
add(pad([52, 59, 64, 67, 71], 5), 67, .17, -.1)
add(pluck(88, 3, True), 68.3, .035, .5, True)

# Short decorrelated room reflections; the longer rhythmic echoes are per voice.
original = MIX.copy()
for delay, gain in [(.041, .08), (.067, .055), (.103, .037)]:
    shift = round(delay * SR)
    MIX[shift:, 0] += original[:-shift, 1] * gain
    MIX[shift:, 1] += original[:-shift, 0] * gain
MIX -= MIX.mean(axis=0)
# A light, linked stereo soft saturator catches transient peaks, then leaves 1 dB
# of headroom. This is deliberately quieter than a clipped loudness-maximized demo.
MIX = np.tanh(MIX * 1.35) / 1.35
MIX *= .89 / max(float(np.max(np.abs(MIX))), .001)
fades = np.ones(len(MIX))
fades[:round(SR * .05)] = np.linspace(0, 1, round(SR * .05))
fades[-SR * 2:] = np.linspace(1, 0, SR * 2) ** 1.5
MIX *= fades[:, None]
assert np.isfinite(MIX).all()
assert np.max(np.abs(MIX)) < .91
PCM = np.rint(MIX * 32767).astype('<i2')
with wave.open(str(OUT / 'neon-door.wav'), 'wb') as audio:
    audio.setparams((2, 2, SR, 0, 'NONE', 'not compressed'))
    audio.writeframes(PCM.tobytes())

# The dance is authored as musical poses, with smooth phrase transitions.
REST = {
    'hips': [0, 0, 0], 'spine': [0, 0, 0], 'chest': [0, 0, 0],
    'neck': [0, 0, 0], 'head': [0, 0, 0],
    'leftUpperArm': [0, 0, -1.26], 'rightUpperArm': [0, 0, 1.26],
    'leftLowerArm': [0, -.06, -.12], 'rightLowerArm': [0, .06, .12],
    'leftHand': [0, 0, 0], 'rightHand': [0, 0, 0],
    'leftUpperLeg': [0, 0, 0], 'rightUpperLeg': [0, 0, 0],
    'leftLowerLeg': [0, 0, 0], 'rightLowerLeg': [0, 0, 0],
    'leftFoot': [0, 0, 0], 'rightFoot': [0, 0, 0],
}


def posed(**bones):
    return {**REST, **bones}


POSES = {
    'rest': REST,
    'welcome': posed(leftUpperArm=[-.10, .08, -.20], leftLowerArm=[0, -.15, 1.20], leftHand=[.1, 0, .08], rightUpperArm=[-.05, 0, 1.06], rightLowerArm=[0, .2, -.35], head=[0, -.14, -.07]),
    'sway_left': posed(hips=[0, .08, .045], spine=[-.02, -.12, -.04], head=[0, -.12, -.025], leftUpperArm=[-.10, .12, -.72], rightUpperArm=[-.12, -.12, 1.0], leftLowerArm=[0, -.25, .70], rightLowerArm=[0, .25, -.45]),
    'sway_right': posed(hips=[0, -.08, -.045], spine=[-.02, .12, .04], head=[0, .12, .025], leftUpperArm=[-.12, .12, -1.0], rightUpperArm=[-.10, -.12, .72], leftLowerArm=[0, -.25, .45], rightLowerArm=[0, .25, -.70]),
    'heart': posed(chest=[-.025, 0, 0], head=[-.035, 0, -.05], leftUpperArm=[-.40, .18, -.58], rightUpperArm=[-.40, -.18, .58], leftLowerArm=[-.20, -.45, 1.0], rightLowerArm=[-.20, .45, -1.0], leftHand=[.10, .12, -.16], rightHand=[.10, -.12, .16]),
    'reach_left': posed(hips=[0, .10, .035], spine=[0, -.10, -.05], head=[-.07, -.12, -.05], leftUpperArm=[-.15, 0, .60], rightUpperArm=[-.08, -.1, .80], leftLowerArm=[0, -.10, .24], rightLowerArm=[0, .15, -.65]),
    'reach_right': posed(hips=[0, -.10, -.035], spine=[0, .10, .05], head=[-.07, .12, .05], leftUpperArm=[-.08, .1, -.80], rightUpperArm=[-.15, 0, -.60], leftLowerArm=[0, -.15, .65], rightLowerArm=[0, .10, -.24]),
    'open': posed(chest=[-.04, 0, 0], head=[-.05, 0, 0], leftUpperArm=[-.15, .05, -.10], rightUpperArm=[-.15, -.05, .10], leftLowerArm=[0, -.10, .20], rightLowerArm=[0, .10, -.20], leftHand=[0, 0, .14], rightHand=[0, 0, -.14]),
    'celebrate': posed(chest=[-.035, 0, 0], head=[-.055, 0, 0], leftUpperArm=[-.1, 0, .63], rightUpperArm=[-.1, 0, -.63], leftLowerArm=[0, -.1, .27], rightLowerArm=[0, .1, -.27]),
    'float': posed(spine=[0, -.10, .035], head=[-.03, .13, -.03], leftUpperArm=[-.16, .1, -.55], rightUpperArm=[-.12, -.1, .55], leftLowerArm=[0, -.2, .25], rightLowerArm=[0, .2, -.25]),
    'bow': posed(hips=[.18, 0, 0], spine=[.36, 0, 0], chest=[.08, 0, 0], head=[.13, 0, 0], leftUpperArm=[.2, 0, -1.36], rightUpperArm=[.2, 0, 1.36], leftLowerArm=[0, -.08, .12], rightLowerArm=[0, .08, -.12], leftUpperLeg=[-.12, 0, 0], rightUpperLeg=[-.12, 0, 0], leftLowerLeg=[.15, 0, 0], rightLowerLeg=[.15, 0, 0]),
}
# Pose changes happen on phrase boundaries and are eased, never snapped.
KEYS = [
    (0, 'rest'), (5.2, 'rest'), (6, 'welcome'), (9, 'welcome'),
    (10, 'open'), (12, 'sway_left'), (14, 'sway_right'),
    (16, 'sway_left'), (18, 'heart'), (20, 'sway_right'),
    (22, 'sway_left'), (24, 'reach_left'), (26, 'sway_right'), (28, 'heart'),
    (30, 'open'), (32, 'reach_left'), (34, 'reach_right'), (36, 'celebrate'),
    (38, 'open'), (40, 'reach_left'), (42, 'reach_right'), (44, 'heart'),
    (46, 'celebrate'), (48, 'reach_right'), (50, 'reach_left'), (52, 'open'),
    (54, 'float'), (56, 'sway_left'), (58, 'float'), (60, 'sway_right'),
    (62, 'welcome'), (64, 'open'), (66, 'heart'), (67.8, 'rest'),
    (68.5, 'bow'), (69.8, 'bow'), (70.7, 'rest'), (72, 'rest'),
]


def smoothstep(x):
    x = min(1., max(0., x))
    return x * x * (3 - 2 * x)


def pose_at(t):
    index = 0
    while index + 1 < len(KEYS) and KEYS[index + 1][0] <= t:
        index += 1
    at, name = KEYS[index]
    before = KEYS[max(index - 1, 0)][1]
    blend = smoothstep((t - at) / (.65 if name == 'bow' else .48))
    bones = {}
    for bone in REST:
        bones[bone] = [a + (b - a) * blend for a, b in zip(POSES[before][bone], POSES[name][bone])]
    return bones, name


frames = []
for i in range(DURATION * FPS + 1):
    t = i / FPS
    bones, pose_name = pose_at(t)
    active = smoothstep((t - 6) / 1) * (1 - smoothstep((t - 66.6) / 1.2))
    intensity = (.35 if 54 <= t < 62 else 1.0 if 38 <= t < 54 else .65) * active
    beat = (t - START) / BEAT
    sway = math.sin(beat * math.pi / 2)
    pulse = (.5 - .5 * math.cos(beat * math.tau)) * intensity
    bones['hips'][1] += .035 * sway * intensity
    bones['hips'][2] += .018 * sway * intensity
    bones['spine'][2] -= .015 * sway * intensity
    bones['head'][0] += .012 * math.sin(beat * math.tau) * intensity
    bones['head'][1] += .025 * math.sin(beat * math.pi / 4) * active
    # Small planted-foot pulse avoids sliding the character around the stage.
    bones['leftUpperLeg'][0] -= .035 * pulse
    bones['rightUpperLeg'][0] -= .035 * pulse
    bones['leftLowerLeg'][0] += .070 * pulse
    bones['rightLowerLeg'][0] += .070 * pulse
    bones['leftFoot'][0] -= .035 * pulse
    bones['rightFoot'][0] -= .035 * pulse
    if pose_name == 'welcome':
        waving = smoothstep((t - (6 if t < 10 else 62)) / .6)
        bones['leftLowerArm'][2] += math.sin(beat * math.pi * 2) * .16 * waving
        bones['leftHand'][2] += math.sin(beat * math.pi * 2 + .5) * .20 * waving
    if pose_name in ['reach_left', 'reach_right', 'celebrate']:
        bones['leftHand'][2] += .06 * math.sin(beat * math.pi)
        bones['rightHand'][2] -= .06 * math.sin(beat * math.pi)
    # Natural occasional blinks, independent of the beat.
    blink = 0.
    for blink_at in [3.4, 8.3, 12.7, 17.2, 22.9, 27.4, 31.6, 37.2, 41.8, 46.3, 51.5, 55.7, 60.4, 65.2, 70.9]:
        distance = abs(t - blink_at)
        if distance < .13:
            blink = max(blink, math.cos(distance / .13 * math.pi / 2) ** 2)
    frames.append({
        't': round(t, 6),
        'bones': {name: [round(value, 5) for value in rotation] for name, rotation in bones.items()},
        'root': [round(.012 * sway * intensity, 5), round(-.006 * pulse, 5), 0],
        'aa': 0,
        'happy': round(.24 + .14 * active, 4),
        'blink': round(blink, 4),
    })

motion = {
    'version': 1,
    'title': 'NEON DOOR / first light',
    'description': 'Original instrumental and authored stage choreography. No vocals or recorded performer.',
    'duration': DURATION, 'fps': FPS, 'bpm': BPM,
    'coordinateSystem': 'VRM1 normalized humanoid; XYZ Euler radians; root meters relative to hips rest position',
    'sampleRate': SR, 'channels': 2,
    'sections': SECTIONS,
    'choreography': [{'t': at, 'pose': name} for at, name in KEYS],
    'frames': frames,
}
(OUT / 'motion.json').write_text(json.dumps(motion, ensure_ascii=False, separators=(',', ':')) + '\n')
(OUT / 'CREDITS.txt').write_text('''NEON DOOR / first light
Original vli.bar demonstration music and choreography, 2026.

Audio: 72 seconds, 120 BPM, 32 kHz / 16-bit stereo PCM.
Synthesized from oscillators and seeded noise by scripts/generate-demo.py.
No third-party music, samples, lyrics, voices or motion-capture recordings used.
Instrumental: an electronic stage theme with an opening, verse, build, chorus,
bridge and ending. No singing or MC is represented in this demo.

Motion: authored normalized VRM 1.0 humanoid rotations, 30 frames per second.
Euler XYZ radians; root values are meters relative to the hips rest position.
Small knee/ankle pulses, wave, alternating reaches, celebration and a final bow.
This generated choreography is a demo, not PICO body-tracking data.

These original music and motion assets are distributed with this repository
for use, modification and redistribution in vli.bar demos and derivative works.
No attribution is required. The separately supplied user VRM is not included.
''')
peak = float(np.max(np.abs(MIX)))
rms = float(np.sqrt(np.mean(MIX ** 2)))
print(f'Generated {DURATION}s stereo audio; peak={peak:.4f}, RMS={rms:.4f}, {len(frames)} motion frames')
