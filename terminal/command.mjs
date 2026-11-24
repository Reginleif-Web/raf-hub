// CreateProcessW cannot launch .cmd/.bat. Keep the two cmd.exe parses
// explicit and refuse their syntax, as Rig already does for cswap paths.
export function ptyCommand(command, args, platform = process.platform, comspec = process.env.ComSpec ?? 'cmd.exe') {
  if (platform !== 'win32' || !/\.(cmd|bat)$/i.test(command)) return { command, args };
  if ([command, ...args].some(value => /[\x00-\x1f"&|<>^%!]/.test(value))) throw new Error('Batch launcher contains shell syntax');
  const line = `""${command}" ${args.map(value => `"${value}"`).join(' ')}"`;
  // node-pty's Windows raw command-line form avoids CRT escaping the cmd
  // program text a second time (which turns a quoted drive into a UNC path).
  return { command: comspec, args: `/d /v:off /s /c ${line}` };
}
