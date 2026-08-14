# Realtime voice for Pi across remote Macs

Status: research + design, not implemented.
Date: 2026-08-14.
Author: agent research pass (Rusty child session).
Scope: a ChatGPT-style spoken conversation with a Pi agent, where the microphone
and speakers live on `old-mbp-13` and the agent runtime lives on `m2-max`.

Everything in "Evidence" was measured on the two machines on 2026-08-14, or read
out of locally installed binaries. Nothing here required bypassing auth or DRM,
and no credential values are reproduced.

---

## 1. The problem, concretely

Luke wants to talk to a Pi agent the way he talks to ChatGPT voice mode: speak,
be interrupted-able, hear a reply, and have the agent actually do work — while
the agent's tools, repos and credentials stay on `m2-max`.

The naive version fails immediately. `old-mbp-13` has the mic, so the obvious
move is "SSH from m2-max to old-mbp-13 and record". That produces a file of
digital silence, not an error. Measured:

```
$ ssh old-mbp-13 /tmp/mictest          # AVAudioEngine, 1.5s tap
inputFormat: 24000.0Hz ch=1
RESULT status=engine_started peak=0.0
```

The engine starts. The format is right. Every sample is zero. macOS TCC denies
microphone data to a process with no GUI session, and it does so silently — the
API reports success. A pipeline built on SSH would appear to work in code review
and be permanently deaf in production.

The same probe, run as a launchd agent in the GUI session on the same machine,
captures real audio:

```
$ launchctl bootstrap gui/501 /tmp/mic.plist   # same binary, GUI domain
inputFormat: 24000.0Hz ch=1
RESULT status=engine_started peak=0.00082419685
```

That single asymmetry — SSH is deaf, `gui/501` hears — determines the whole
architecture. The audio process on `old-mbp-13` must be a GUI-domain launchd
agent, and m2-max must reach it over a network socket rather than by spawning it
over SSH.

---

## 2. Evidence

### 2.1 The two machines and the link

| Fact | Value | How measured |
|---|---|---|
| m2-max | MacBook Pro Mac14,5, M2 Max, 32 GB | `system_profiler SPHardwareDataType` |
| old-mbp-13 | MacBook Pro, M1, 8 GB, macOS 15.7.7 | `ssh old-mbp-13 sw_vers` |
| old-mbp-13 Tailscale IP | `100.76.223.116` | `tailscale status` |
| Path | **direct, over WAN** `197.242.203.79:5551` | `tailscale ping old-mbp-13` |
| RTT (10 pings) | min 12.9 / avg 21.9 / max 68.5 ms | `ping -c 10 -q` |
| RTT (60 pings @200ms) | min 11.7 / **avg 28.0** / max 149.2 / stddev 28.3 ms | `ping -c 60 -i 0.2 -q` |
| Packet loss | 0.0% over 60 packets | same |
| Bulk throughput | 8 MB over SSH in 2.93 s ≈ **22 Mbit/s** | `dd | ssh 'cat >/dev/null'` |
| old-mbp-13 load | load avg 3.50 on 8 cores, up 5 days | `uptime` |

Two things matter here and both are easy to get wrong.

**old-mbp-13 is not on the LAN.** It is a direct Tailscale path over the public
internet, not a `192.168.3.x` peer. The design cannot assume LAN jitter.

**The jitter is the constraint, not the bandwidth.** Average RTT is a fine 28 ms,
but stddev is 28 ms and the worst of 60 packets was 149 ms. Bandwidth is
irrelevant by comparison: 24 kHz mono 16-bit PCM is 384 kbit/s, under 2% of the
measured 22 Mbit/s. Uncompressed PCM is affordable; unbuffered PCM is not. Any
design that streams raw frames with no jitter buffer will produce audible gaps
several times a minute.

### 2.2 Audio hardware and permissions on old-mbp-13

Default input and output are both `Lue's AirPods Pro` — Bluetooth, input at
24 kHz, output at 48 kHz (`system_profiler SPAudioDataType`). Other inputs
present: `MacBook Pro Microphone`, `HD Pro Webcam C920` (16 kHz), and an iPhone
Continuity mic.

Two consequences. AirPods input is 24 kHz mono, which happens to match the
OpenAI realtime PCM rate, so the capture path needs no resampling in the common
case — but the design must not assume it, because the C920 is 16 kHz and the
device can change mid-call. And Bluetooth adds its own 100–200 ms of latency
that no amount of protocol work will remove; if voice feels sluggish, wired
output is the first lever, not a code change.

Permissions, from the TCC database:

```
kTCCServiceMicrophone|com.openai.codex|2          # ChatGPT: authorized
kTCCServiceMicrophone|ru.starmel.OpenSuperWhisper|2
kTCCServiceMicrophone|com.cmuxterm.app|2
kTCCServiceMicrophone|com.kitlangton.Hex|0        # denied
/private/tmp/mictest|2                            # our probe, after GUI run
```

Note the last line: the GUI-domain probe was granted microphone access and
recorded in TCC keyed by **executable path**. A shipped agent must therefore live
at a stable path — moving or rebuilding to a new path re-triggers the prompt.

Playback asymmetry, measured:

```
$ ssh old-mbp-13 afplay /tmp/tone.wav                  # exit 0, audible
$ ssh old-mbp-13 launchctl asuser 501 afplay ...       # exit 1
Could not switch to audit session: Operation not permitted
```

Output over SSH works; input does not. This is a real asymmetry, not an
inconsistency in the probe: CoreAudio output has no TCC gate, input does.
`launchctl asuser` from an SSH session is itself blocked, which rules out the
common "just re-enter the GUI session" workaround.

Sleep is already inhibited on old-mbp-13 (`pmset -g`: `sleep 0`, prevented by
`coreaudiod`, `ChatGPT`, others), and `luke` is logged in on console since
Aug 8. The GUI-session prerequisite holds today, but it is a prerequisite the
design must state and monitor, not assume.

Missing tooling on old-mbp-13: no `sox`, `ffmpeg`, `websocat`, or
`SwitchAudioSource`. Present: `swift`/`swiftc` 
(so a native capture binary can be built on the box), `afplay`, `afconvert`,
`say`, Homebrew, Node v24.18.0, Bun, and `OpenSuperWhisper.app`.
Tailscale on old-mbp-13 is the **GUI app**, not the CLI — `tailscale` is not on
`PATH`; the binary is at
`/Applications/Tailscale.app/Contents/MacOS/Tailscale`. Scripts must use the
full path or they will fail in a way that looks like a network problem.

### 2.3 How the ChatGPT desktop app actually does it

Inspected: `/Applications/ChatGPT.app` (bundle id `com.openai.codex`, version
26.810.41047). Read-only inspection of an app the user has installed and is
licensed to run — `plutil`, `codesign -d --entitlements`, `strings`, and
`@electron/asar extract` of the app's own unencrypted resource archive. No
protection was circumvented, no credentials read, no traffic intercepted.

**Entitlements** (`codesign -d --entitlements -`):

```
com.apple.security.device.audio-input => true
com.apple.security.device.camera      => true
com.apple.security.network.client     => true
com.apple.security.cs.allow-jit       => true
```

**The architecture is a split.** The app is Electron (`app.asar`, 280 MB) plus a
219 MB native Mach-O `codex` binary in `Resources/`. The native binary is a Rust
app-server. Symbol and string evidence from it shows the realtime work is
implemented there, not in the web layer: `core/src/realtime_conversation.rs`,
`core/src/realtime_context.rs`, and
`codex-api/src/endpoint/realtime_websocket/methods.rs`.

**The app-server exposes a realtime RPC surface.** From the webview bundle,
the exact method names:

```
thread/realtime/start          thread/realtime/started
thread/realtime/stop           thread/realtime/closed
thread/realtime/appendSpeech   thread/realtime/outputAudio/delta
thread/realtime/appendText     thread/realtime/transcript/delta
thread/realtime/listVoices     thread/realtime/transcript/done
                               thread/realtime/itemAdded
                               thread/realtime/sdp
                               thread/realtime/error
```

Requests go down, notifications come up. Crucially `appendSpeech` /
`outputAudio/delta` mean the app-server can take **PCM in and give PCM out over
the RPC channel** — the UI process is not required to own the audio device. The
matching Rust types confirm the shape: `ThreadRealtimeAudioChunk { data,
sample_rate, num_channels, samples_per_channel }`,
`ThreadRealtimeStartParams` (19 fields incl. `transport`, `voice`,
`realtimeSessionId`, `initialItems`), `ThreadRealtimeSdpNotification { sdp }`.

**Transport is a documented switch.** The config enum `RealtimeTransport` has
exactly two variants, `webrtc` and `websocket`, with knobs
`experimental_realtime_ws_base_url` and
`experimental_realtime_webrtc_call_base_url`. Audio device selection is separate
config: `RealtimeAudioToml { microphone, speaker }`. Server-side VAD is
configured on the session (`turn_detection`, `server_vad`, `near_field`,
`silence_duration_ms`, `interrupt_response`, `create_response`).

So ChatGPT's own design already separates *who owns the audio device* from *who
owns the model session*, and already supports a non-WebRTC websocket path
carrying PCM chunks. That is the same seam this lane needs.

**The jitter answer, lifted from their worklet.** `realtime-buffered-audio-
worklet.js` registers `codex-realtime-buffered-audio`, an `AudioWorkletProcessor`
with a ring buffer of `sampleRate * 30` samples and three phases:
`buffering` → `replaying` → `live`. It buffers on start, and on `release` it
scans for the first sample above a `0.003` amplitude threshold, rewinds by
`sampleRate * 0.1` (100 ms pre-roll), and replays from there before going live.

That is worth copying exactly. It solves two problems at once: it hides startup
jitter, and the leading-silence trim plus 100 ms pre-roll means the user never
loses the first syllable of a reply — the classic failure of naive PCM playback.

**Interruption is a first-class control path**, not a side effect: the escape-key
handler resolves to a discrete `stop-realtime-session` action, and the session
config carries `interrupt_response`. Barge-in must be modelled as a control
message, not inferred from input energy.

**Delegation exists.** Strings `realtime_delegation`, `realtime-delegation-`,
`transcript_delta`, `client_managed_handoffs`, `delegation_ack_filler`, and
`flush_transcript_tail_on_session_end` show the realtime layer hands work to a
background agent and speaks filler while waiting. Luke's harbor repo
(`docs/voice-orchestration-friction-2026-08-05.md`) documents that transcript text
arrives inside `<realtime_delegation><transcript_delta>` blocks. The voice model
and the working agent are two different things joined by a handoff — which is
exactly the shape proposed in §4.

### 2.4 Prior art: the realtime API works with Luke's existing auth

`~/Projects/oss/clawrouter-realtime-voice-proof-artifacts-2026-07-24` contains 12
captured runs from 2026-07-24 with `summary.json`, `manifest.json`, WAVs and
`events.jsonl`. A full audio round trip is already proven, both direct and
through clawrouter:

```json
{ "mode": "direct",
  "endpoint": "wss://api.openai.com/v1/realtime?model=gpt-realtime-2.1",
  "authEvidence": { "source": "~/.codex/auth.json",
                    "grantType": "chatgpt_subscription_oauth",
                    "planType": "pro" },
  "sessionCreated": true, "responseDone": true,
  "audioRoundTripProof": true, "durationMs": 3032 }
```

The event stream is the standard OpenAI realtime vocabulary
(`session.created`, `input_audio_buffer.committed`,
`conversation.item.input_audio_transcription.delta`,
`response.output_audio.delta` at 19200 bytes/chunk, `response.done`).

Two conclusions. The websocket realtime path is reachable with Luke's existing
ChatGPT subscription credential, and `19200` bytes at 24 kHz 16-bit mono is a
400 ms audio chunk — the server emits in large-ish blocks, which reinforces the
need for a receive-side jitter buffer.

`~/.codex/auth.json` is present on m2-max. **It stays on m2-max.** See §6.

### 2.5 What Pi already has

Pi has no audio, voice, speech or realtime code at all — searched
`packages/**/*.ts`, only `vi.useRealTimers` and pricing fields match. This lane
is greenfield inside Pi.

But Pi already has the right seam, and it is better than expected:

- `packages/protocol` — a transport-neutral CBOR protocol,
  `PROTOCOL_VERSION = 1`, length-prefixed framing (`encodeFrame`: u32 BE prefix,
  `DEFAULT_MAX_FRAME_LENGTH` 16 MB), typebox-validated schemas.
- `packages/client` — `ByteTransport` is a two-method interface
  (`send(Uint8Array)`, `close()`) with a `ByteTransportFactory`. A Unix socket
  factory exists (`client/src/unix.ts`); **any** byte transport plugs in.
- `packages/server` — `PiServerService` / `PiSessionRuntime`
  (`prompt`, `steer`, `abort`, `subscribe`, `snapshot`), plus a Unix listener.
- `packages/coding-agent/src/client/remote-session.ts` — `RemoteSession` already
  drives a remote agent over that protocol.
- Extensions (`pi.registerTool`, `pi.registerCommand`, `pi.on`) and RPC mode
  (JSONL over stdio) for in-process integration.

The gap is specific and small: `CommandSchema` and `ServerEventSchema` are
text-and-metadata only. There is no audio frame type, and the framing is
request/response plus events — fine for control, wrong for a continuous PCM
stream sharing one socket with 16 MB-capable frames.

That gap is the design decision in §4: **do not put PCM on Pi's control
protocol.** Keep control on the CBOR protocol; give audio its own stream.

---

## 3. What we are actually building

One sentence: `old-mbp-13` runs a dumb, credential-free audio endpoint; `m2-max`
runs everything that thinks.

Three processes.

**`pi-voiced` (old-mbp-13, GUI launchd agent).** Owns CoreAudio. Captures mic to
24 kHz mono PCM16, plays received PCM through the buffered-worklet algorithm from
§2.3. Holds no credentials, makes no outbound calls to OpenAI, contains no agent
logic. Small enough to be obviously correct. Must be a GUI-domain agent (§2.1)
and must live at a stable path (§2.2).

**`pi-voice-bridge` (m2-max).** The only process holding credentials. Opens the
realtime session upstream, forwards mic PCM up and model PCM down, owns VAD/
barge-in policy, and turns speech into Pi agent work.

**Pi agent session (m2-max).** Unmodified Pi. Receives prompts and returns
results through the existing `PiSessionRuntime` / `RemoteSession` surface.

```
old-mbp-13 (GUI session)                m2-max
┌──────────────────────┐                ┌───────────────────────────────┐
│ pi-voiced            │                │ pi-voice-bridge               │
│  CoreAudio in ───────┼── audio ──────▶│  ─▶ OpenAI realtime (wss)     │
│  CoreAudio out ◀─────┼── audio ───────┤  ◀─ PCM + transcript deltas   │
│  jitter buffer       │  (Tailscale)   │                               │
│  no credentials      │                │  auth: ~/.codex/auth.json     │
└──────────────────────┘                │      ▲ transcript / control   │
                                        │      ▼                        │
                                        │  Pi agent session (PiServer)  │
                                        └───────────────────────────────┘
```

### Why not the three alternatives

**Run the agent on old-mbp-13.** Rejected. 8 GB M1 already at load 3.5; repos,
credentials and tools live on m2-max. This inverts the requirement.

**Route audio with CoreAudio/AirPlay/BlackHole tricks.** Rejected. No virtual
device or loopback driver is installed on old-mbp-13, `sox`/`ffmpeg` are absent,
and this smuggles the problem into an audio driver where failures are invisible
and unversioned.

**Put PCM frames on Pi's existing CBOR protocol.** Rejected, and this is the
closest call. It reuses the transport and would work. But it couples a 20 ms
real-time cadence to a request/response control channel with 16 MB frames, where
one large snapshot event ahead of an audio frame in the write queue adds a
latency spike. Separate streams let audio be lossy-tolerant and control be
reliable — which is the correct pairing, since a dropped 20 ms audio frame is
inaudible and a dropped "stop speaking" is a bug.

---

## 4. Design

### 4.1 Transport

**Control: Pi's existing CBOR protocol over Tailscale TCP.** Reliable, ordered,
already implemented, already typed. Extend with a `voice` command family
(§4.4).

**Audio: a separate connection, Tailscale-only.** Phase 1 uses a second TCP
connection with the same u32-length framing (reuse `encodeFrame`/`FrameDecoder`
— it is transport-agnostic and already tested). Phase 3 upgrades to WebRTC/Opus
if measurement justifies it (§7).

Deliberate non-decision: TCP for audio is normally wrong, because head-of-line
blocking turns loss into delay. It is right *here* and only because measurement
says so — 0.0% loss over 60 packets on a direct Tailscale path (§2.1). If loss
appears on a different network, this is the first assumption to revisit; that is
why the audio stream is separate and replaceable.

**Tailscale is the security boundary.** Both sockets bind to the Tailscale
interface only, never `0.0.0.0`.

### 4.2 Audio format

24 kHz, mono, PCM16, little-endian, 20 ms frames = 480 samples = 960 bytes.
384 kbit/s each way; 2% of measured capacity (§2.1).

24 kHz because it is what the OpenAI realtime API uses (§2.4) *and* what the
AirPods input already produces (§2.2) — zero resampling in the common path.
`pi-voiced` resamples when the selected device differs (e.g. the 16 kHz C920) so
the wire format is invariant.

Every frame carries a monotonic `seq` and a capture-time `ts`. Both are needed:
`seq` detects loss, `ts` measures one-way delay and drives the buffer.

### 4.3 Jitter buffer and playback

Port the ChatGPT worklet algorithm (§2.3) directly — it is the measured-correct
answer to this exact problem:

- ring buffer, 30 s capacity;
- `buffering` → `replaying` → `live` phases;
- on release, find first sample with amplitude ≥ 0.003, rewind 100 ms, replay;
- underrun fills with silence rather than stalling the device.

Target depth **120 ms**, adaptive 80–240 ms. Derivation: RTT avg 28 ms with
stddev 28 ms (§2.1), so ~2σ of jitter is ~56 ms one-way-ish; 120 ms absorbs the
routine case, and the 149 ms outlier is covered by the adaptive ceiling at the
cost of one audible stretch rather than a gap.

### 4.4 Control plane

New CBOR commands (mirroring the ChatGPT app-server vocabulary in §2.3, which is
a proven-sufficient set):

```
voice_start   { sessionId, deviceHint?, voice? }   -> { voiceSessionId, audioPort, token }
voice_stop    { voiceSessionId }
voice_mute    { voiceSessionId, muted }
voice_barge   { voiceSessionId }        # user interrupted; stop playback now
```

New events:

```
voice_started     { voiceSessionId }
voice_transcript  { voiceSessionId, role, delta, final }
voice_state       { voiceSessionId, state: listening|thinking|speaking }
voice_closed      { voiceSessionId, reason }
voice_error       { voiceSessionId, code, message }
```

Two rules learned from §2.3 and from the harbor friction review:

**Barge-in is an explicit control message.** `voice_barge` travels on the
reliable control channel and immediately drops queued playback. Never infer
interruption from audio energy alone.

**Transcripts are events, not audio.** `voice_transcript` is what reaches the Pi
agent and the session record. Audio frames are never persisted by default (§6).

### 4.5 Voice-to-agent handoff

Do not let the realtime model drive tools directly. Use the delegation shape
ChatGPT itself uses (§2.3) and that the harbor friction review already argues
for:

1. Realtime model converses, and holds the turn.
2. When the user asks for work, the bridge emits a final transcript and calls
   `PiSessionRuntime.prompt()` on the Pi session.
3. The bridge speaks a short acknowledgement while Pi works
   (`delegation_ack_filler`).
4. Pi's result is summarised to one or two spoken sentences and injected via
   `appendText`-equivalent.

The harbor repo's `docs/voice-orchestration-friction-2026-08-05.md` documents the
failure mode to avoid: acknowledging instead of acting, and dumping a screenful
of options at someone with no screen. The bridge must speak *decisions and
outcomes*, and keep detail in the transcript.

---

## 5. Latency budget

Target: user stops speaking → first audible word ≤ 1.2 s. ChatGPT voice feels
good at roughly this number.

| Stage | Budget | Basis |
|---|---|---|
| Mic capture + frame | 20 ms | one frame |
| Bluetooth input (AirPods) | 100–150 ms | AirPods, not removable in software (§2.2) |
| old-mbp-13 → m2-max | ~14 ms | half of 28 ms avg RTT (§2.1) |
| Server VAD end-of-speech | 200–500 ms | `silence_duration_ms`, tunable (§2.3) |
| Model first audio | 300–500 ms | realtime API, consistent with §2.4 runs |
| m2-max → old-mbp-13 | ~14 ms | §2.1 |
| Jitter buffer | 120 ms | §4.3 |
| Bluetooth output | 100–150 ms | AirPods (§2.2) |
| **Total** | **~870–1270 ms** | |

The budget closes, but with little margin, and the two largest controllable
terms are VAD silence and the jitter buffer. The two largest terms overall are
Bluetooth in and out (200–300 ms combined) — **wired headphones on old-mbp-13
are the single biggest latency win available and require no code**. Measure with
AirPods, since that is the real configuration, but state the wired number too.

Agent-work turns are a different regime: Pi may take 30 s. That is what the
filler and `voice_state: thinking` exist for — never leave silence unexplained.

---

## 6. Security

**Credentials never leave m2-max.** `~/.codex/auth.json` (present on m2-max,
ChatGPT subscription OAuth per §2.4) is read only by `pi-voice-bridge`.
`pi-voiced` on old-mbp-13 holds no credential and cannot reach OpenAI. If
old-mbp-13 is compromised, the attacker gets a microphone they already had
physical access to — not Luke's account.

**Tailscale is the only network boundary.** Both listeners bind to the Tailscale
address exclusively. No port is exposed to the LAN or the internet. Note that
the path is a *direct WAN* path (§2.1), so this depends on WireGuard encryption,
not on network topology.

**Per-session token.** `voice_start` returns a single-use token that the audio
connection must present in its first frame; the audio listener rejects anything
else and closes. This prevents a local process on old-mbp-13 from attaching to
the audio stream.

**Audio is not persisted by default.** Frames are forwarded and dropped.
Transcripts persist in the session record as normal text. A `--record` flag for
debugging must write only under an explicit path and be off by default — this is
a live microphone in Luke's house.

**A hot mic needs a visible state and a hard stop.** `voice_state` drives an
indicator, and `voice_stop` must tear down capture, not just mute. Mute that
keeps capturing is the wrong default for a permanent household listener.

**TCC is path-keyed** (§2.2): the `pi-voiced` binary must live at a stable
absolute path, and re-granting must be an expected step after relocation, not a
mystery failure.

---

## 7. Failure handling

| Failure | Detection | Response |
|---|---|---|
| **Silent mic** (the §1 trap) | RMS of captured frames is exactly 0 for > 2 s | Emit `voice_error{code:"mic_silent"}`, do not pretend to listen. Almost always "not running in GUI session". |
| Tailscale drop | audio frame gap > 500 ms, or control disconnect | Playback fades to silence (never loops the buffer); control reconnects with backoff; realtime session resumed if within window, else new session with transcript carry-over |
| Jitter spike | buffer depth < 40 ms | Grow target depth toward 240 ms; stretch rather than gap |
| Model session drop | websocket close from upstream | Speak a short "lost the connection" cue, retain transcript, offer resume — the friction review records a real dropped-call incident (§2.3 ref) where losing context was the actual damage |
| old-mbp-13 sleeps | control heartbeat lost | Nothing clever. Sleep is currently inhibited (§2.2); if that changes, fail loudly |
| Audio device changes mid-call | CoreAudio device-change notification | Re-open at new rate, resample to 24 kHz, keep the session |
| Pi agent turn is slow | no result within 5 s | `voice_state: thinking` + filler; never silence |
| Both machines try to speak | two `voice_start` for one session | Second gets `busy` (already in `ProtocolErrorCodeSchema`) — ChatGPT has this exact toast (§2.3) |

Recurring principle: **fail audibly**. A voice system with no screen must never
degrade into silence that looks like thinking.

---

## 8. Phased prototype

**Phase 0 — prove the audio endpoint (0.5 day).**
Swift binary on old-mbp-13, GUI launchd agent, captures 5 s and writes a WAV.
Success: non-zero RMS, matching §2.1's probe. This is already demonstrated by
the probe in §2.1; Phase 0 is making it a real, installed, stably-pathed agent.

**Phase 1 — audio over Tailscale, no model (1 day).**
`pi-voiced` streams PCM to m2-max; m2-max echoes it back; old-mbp-13 plays it
with the §4.3 buffer. Success: intelligible loopback, measured RTT, buffer
underrun count over 5 minutes. This isolates the transport from the model — if
loopback is choppy, no amount of model work will help.

**Phase 2 — realtime model in the loop (1–2 days).**
`pi-voice-bridge` opens the realtime session using the §2.4 proven path.
Success: spoken conversation, end-to-end latency measured against §5, barge-in
works.

**Phase 3 — Pi agent delegation (2 days).**
Wire `voice_transcript` → `PiSessionRuntime.prompt()`, filler, spoken summary.
Success: "check the CI on that branch" produces real tool work and a spoken
answer.

**Phase 4 — hardening (ongoing).**
Reconnect, device changes, sleep, indicator, ship as launchd agents.

Phases 1 and 2 are the risky ones and they are deliberately separated: Phase 1
answers "is this network good enough", Phase 2 answers "is the model fast
enough". Answering them together makes a bad result undiagnosable.

---

## 9. The exact next slice

**Build `pi-voiced` Phase 0 + Phase 1 sender: a Swift GUI-domain launchd agent
on old-mbp-13 that captures 24 kHz mono PCM16 and streams 20 ms framed chunks to
a TCP listener on m2-max's Tailscale address, plus a Node receiver on m2-max
that writes a WAV.**

Concretely:

1. `tools/voice/pi-voiced/main.swift` — `AVAudioEngine` tap, convert to 24 kHz
   mono PCM16, frame as `[u32 length][u64 seq][u64 ts_us][960 bytes PCM]`,
   write to a TCP socket at `100.75.234.50:7061`. Log RMS every second.
2. `tools/voice/pi-voiced/dev.pi.voiced.plist` — `gui/501` launchd agent,
   `RunAtLoad`, stable install path `/usr/local/libexec/pi-voiced`
   (stable path matters, §2.2).
3. `tools/voice/receiver.ts` — Node TCP listener on the Tailscale address,
   decodes frames with `FrameDecoder` from `@earendil-works/pi-protocol`, writes
   `out.wav`, prints seq gaps, per-frame arrival jitter, and RMS.
4. `tools/voice/README.md` — install, grant mic, run, and the §1 warning that
   testing over SSH will silently capture zeros.

**Done when:** 30 s of speech captured on old-mbp-13 lands on m2-max as an
intelligible WAV with zero sequence gaps, and the receiver reports arrival
jitter — which is the number that decides whether the §4.3 target depth of
120 ms is right, and whether Phase 3's WebRTC upgrade is needed at all.

**Explicitly not in this slice:** no credentials, no OpenAI, no Pi protocol
changes, no playback path. It is the smallest thing that proves the two facts
everything else rests on — that GUI-domain capture works when installed
properly, and that the Tailscale path carries real-time audio.

---

## 10. Open questions for Luke

1. **Wired output on old-mbp-13?** AirPods cost 200–300 ms of the 1.2 s budget
   (§5). Wired is the cheapest latency win and needs no code.
2. **Which credential path** — the ChatGPT subscription OAuth proven in §2.4, or
   a plain API key? Affects rate limits and terms, not architecture.
3. **Is old-mbp-13 always-on and always-logged-in?** The GUI-session requirement
   (§2.1) makes this load-bearing. True today; needs to be a commitment.
4. **Should voice sessions be recorded?** Default is no (§6). A household
   always-on mic is a decision for Luke, not for the design.

---

## Appendix: reproducing the evidence

```bash
# Link
ping -c 60 -i 0.2 -q old-mbp-13
tailscale ping old-mbp-13
dd if=/dev/zero bs=1M count=8 | ssh old-mbp-13 'cat > /dev/null'

# The silent-mic trap (expect peak=0.0)
ssh old-mbp-13 /tmp/mictest

# GUI session capture (expect peak>0)
ssh old-mbp-13 'launchctl bootstrap gui/501 /tmp/mic.plist'

# Audio devices and permissions
ssh old-mbp-13 'system_profiler SPAudioDataType'
ssh old-mbp-13 'sqlite3 ~/Library/Application\ Support/com.apple.TCC/TCC.db \
  "select service,client,auth_value from access where service like \"%Microphone%\""'

# ChatGPT app (read-only, local, licensed install)
codesign -d --entitlements - --xml /Applications/ChatGPT.app | plutil -p -
npx @electron/asar list /Applications/ChatGPT.app/Contents/Resources/app.asar
strings -a /Applications/ChatGPT.app/Contents/Resources/codex | grep realtime

# Prior art
cat ~/Projects/oss/clawrouter-realtime-voice-proof-artifacts-2026-07-24/\
realtime-voice-proof/2026-07-24T13-58-33-534Z/summary.json
```
