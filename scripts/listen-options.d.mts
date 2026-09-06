export function parseListenOptions(
  argv: string[],
  defaults: { port: number | string; host?: string },
): { port: number; host: string };
