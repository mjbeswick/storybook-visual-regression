declare module 'picomatch' {
  export type PicomatchOptions = {
    nocase?: boolean;
    dot?: boolean;
    cwd?: string;
  };

  export type Matcher = (input: string) => boolean;

  const picomatch: (patterns: string | string[], options?: PicomatchOptions) => Matcher;
  export default picomatch;
}
