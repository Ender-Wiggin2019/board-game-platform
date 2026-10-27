/** Build-time contribution; paths are resolved by the game client package. */
export interface GameClientAssets {
  readonly publicDirectories: readonly string[];
  readonly sourceDirectories: readonly string[];
  /** Public URL roots whose files participate in content hashing. */
  readonly assetRoots?: readonly string[];
  /** Regular-expression policies for runtime-composed asset basenames. */
  readonly dynamicPathPatterns?: readonly (string | RegExp)[];
  /** Drop source URL aliases from the composed production public tree after hashing. */
  readonly omitSourceAliases?: boolean;
  readonly jsonEditors?: readonly {
    readonly route: string;
    readonly file: string;
  }[];
}
