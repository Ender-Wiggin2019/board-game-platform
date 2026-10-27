declare module 'virtual:platform-shared-modules' {
  export const catalog: Readonly<
    Record<
      string,
      {
        readonly version: string;
        readonly load: () => Promise<Readonly<Record<string, unknown>>>;
      }
    >
  >;
}
