declare module 'gifencoder' {
  import type { Readable, Writable } from 'node:stream';

  class GIFEncoder {
    constructor(width: number, height: number);
    createReadStream(): Readable;
    createWriteStream(options?: { repeat?: number; delay?: number; quality?: number }): Writable;
    start(): void;
    finish(): void;
    setRepeat(repeat: number): void;
    setDelay(ms: number): void;
    setQuality(quality: number): void;
    setTransparent(color: number): void;
    addFrame(
      imageData:
        | Buffer
        | Uint8Array
        | {
            getImageData: (
              x: number,
              y: number,
              w: number,
              h: number,
            ) => { data: Uint8ClampedArray };
          },
    ): void;
  }

  export default GIFEncoder;
}
