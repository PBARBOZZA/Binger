declare module 'sharp' {
  export type SharpOptions = { failOn?: 'none' | 'truncated' | 'error' | 'warning'; limitInputPixels?: number | boolean };
  export type Metadata = { format?: string; width?: number; height?: number };
  export type OutputInfo = { format: string; width: number; height: number; size: number };
  export interface Sharp {
    metadata(): Promise<Metadata>;
    rotate(): Sharp;
    webp(options?: { quality?: number; effort?: number }): Sharp;
    toBuffer(options: { resolveWithObject: true }): Promise<{ data: Buffer; info: OutputInfo }>;
  }
  export interface SharpConstructor {
    (input: Buffer, options?: SharpOptions): Sharp;
  }
  const sharp: SharpConstructor;
  export default sharp;
}
