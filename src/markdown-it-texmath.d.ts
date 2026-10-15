declare module 'markdown-it-texmath' {
  import type { PluginWithOptions } from 'markdown-it';
  const plugin: PluginWithOptions<{
    engine: unknown;
    delimiters: string[];
    katexOptions: { trust: boolean; throwOnError: boolean; output: string };
  }>;
  export default plugin;
}
