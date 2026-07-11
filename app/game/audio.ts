export type ArenaSound =
  | "dash"
  | "cinder"
  | "tide"
  | "volt"
  | "swing"
  | "block"
  | "hit"
  | "defeat"
  | "respawn";

export class ArenaAudio {
  private context: AudioContext | null = null;
  private master: GainNode | null = null;
  private noise: AudioBuffer | null = null;

  async unlock(): Promise<void> {
    if (typeof window === "undefined") return;

    if (!this.context) {
      const context = new AudioContext({ latencyHint: "interactive" });
      const master = context.createGain();
      master.gain.value = 0.24;
      master.connect(context.destination);
      this.context = context;
      this.master = master;
      this.noise = this.createNoiseBuffer(context);
    }

    if (this.context.state === "suspended") {
      await this.context.resume();
    }
  }

  play(sound: ArenaSound): void {
    const context = this.context;
    const master = this.master;
    if (!context || !master || context.state !== "running") return;

    const now = context.currentTime;
    switch (sound) {
      case "dash":
        this.noiseSweep(now, 0.11, 1200, 180, 0.22);
        this.tone(now, 150, 68, 0.13, "sine", 0.12);
        break;
      case "cinder":
        this.tone(now, 780, 210, 0.12, "sawtooth", 0.13);
        this.noiseSweep(now, 0.075, 2400, 900, 0.09);
        break;
      case "tide":
        this.tone(now, 170, 72, 0.38, "sine", 0.2);
        this.tone(now + 0.025, 410, 120, 0.3, "triangle", 0.08);
        this.noiseSweep(now, 0.3, 980, 120, 0.12);
        break;
      case "volt":
        this.tone(now, 1260, 260, 0.16, "square", 0.11);
        this.tone(now + 0.035, 1840, 420, 0.11, "sawtooth", 0.08);
        this.noiseSweep(now, 0.14, 3200, 1300, 0.14);
        break;
      case "swing":
        this.noiseSweep(now, 0.17, 1900, 210, 0.16);
        this.tone(now + 0.035, 360, 105, 0.13, "triangle", 0.07);
        break;
      case "block":
        this.tone(now, 165, 78, 0.2, "square", 0.11);
        this.tone(now + 0.018, 960, 270, 0.13, "triangle", 0.07);
        this.noiseSweep(now, 0.09, 2500, 480, 0.08);
        break;
      case "hit":
        this.tone(now, 120, 52, 0.11, "square", 0.11);
        this.noiseSweep(now, 0.08, 720, 90, 0.13);
        break;
      case "defeat":
        this.tone(now, 240, 48, 0.65, "sawtooth", 0.16);
        this.tone(now + 0.08, 360, 62, 0.54, "triangle", 0.1);
        break;
      case "respawn":
        this.tone(now, 180, 620, 0.42, "sine", 0.12);
        this.tone(now + 0.07, 270, 940, 0.36, "triangle", 0.08);
        break;
    }
  }

  destroy(): void {
    const context = this.context;
    this.context = null;
    this.master = null;
    this.noise = null;
    if (context) void context.close();
  }

  private tone(
    start: number,
    from: number,
    to: number,
    duration: number,
    type: OscillatorType,
    volume: number,
  ): void {
    const context = this.context;
    const master = this.master;
    if (!context || !master) return;

    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = type;
    oscillator.frequency.setValueAtTime(from, start);
    oscillator.frequency.exponentialRampToValueAtTime(Math.max(24, to), start + duration);
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(volume, start + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
    oscillator.connect(gain).connect(master);
    oscillator.start(start);
    oscillator.stop(start + duration + 0.02);
  }

  private noiseSweep(
    start: number,
    duration: number,
    from: number,
    to: number,
    volume: number,
  ): void {
    const context = this.context;
    const master = this.master;
    const noise = this.noise;
    if (!context || !master || !noise) return;

    const source = context.createBufferSource();
    const filter = context.createBiquadFilter();
    const gain = context.createGain();
    source.buffer = noise;
    filter.type = "bandpass";
    filter.Q.value = 0.8;
    filter.frequency.setValueAtTime(from, start);
    filter.frequency.exponentialRampToValueAtTime(Math.max(40, to), start + duration);
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(volume, start + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
    source.connect(filter).connect(gain).connect(master);
    source.start(start);
    source.stop(start + duration + 0.02);
  }

  private createNoiseBuffer(context: AudioContext): AudioBuffer {
    const buffer = context.createBuffer(1, context.sampleRate, context.sampleRate);
    const data = buffer.getChannelData(0);
    for (let index = 0; index < data.length; index += 1) {
      data[index] = Math.random() * 2 - 1;
    }
    return buffer;
  }
}
