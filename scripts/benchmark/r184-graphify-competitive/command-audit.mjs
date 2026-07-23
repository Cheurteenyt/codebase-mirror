export function splitPowerShellCommands(command) {
  const commandArgument = command.match(/\s-(?:Command|c)\s+([\s\S]+)$/iu)?.[1]?.trim()
    ?? command.trim();
  let script = commandArgument;
  if (
    script.length >= 2
    && (script[0] === '"' || script[0] === "'")
    && script.at(-1) === script[0]
  ) {
    script = script.slice(1, -1);
  }
  const parts = [];
  let current = '';
  let quote = null;
  let escaped = false;
  for (let index = 0; index < script.length; index += 1) {
    const character = script[index];
    if (escaped) {
      current += character;
      escaped = false;
      continue;
    }
    if (character === '`') {
      current += character;
      escaped = true;
      continue;
    }
    if (quote) {
      current += character;
      if (character === quote) {
        if (quote === "'" && script[index + 1] === "'") {
          current += script[index + 1];
          index += 1;
        } else {
          quote = null;
        }
      }
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      current += character;
      continue;
    }
    if (character === '|' || character === ';' || character === '\n') {
      if (current.trim()) parts.push(current.trim());
      current = '';
      continue;
    }
    current += character;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

export function auditCommand(command) {
  const normalized = command.replaceAll('\r', ' ');
  const forbidden = [
    /\bgit(?:\.exe)?\b/i,
    /\b(?:python|py|node|npm|npx|pnpm|yarn)(?:\.exe|\.cmd)?\b/i,
    /\b(?:curl|wget|Invoke-WebRequest|Invoke-RestMethod)\b/i,
    /\b(?:Get-ChildItem|Remove-Item|Set-Content|Add-Content|Out-File|New-Item|Copy-Item|Move-Item)\b/i,
    /\b(?:sqlite3|jq|findstr|where\.exe)\b/i,
  ];
  for (const pattern of forbidden) {
    if (pattern.test(normalized)) return `forbidden command token: ${pattern}`;
  }
  const commands = splitPowerShellCommands(normalized);
  if (commands.length === 0 || !/\b(?:rg|Get-Content|Select-String)\b/i.test(normalized)) {
    return 'command does not contain an allowed evidence reader';
  }
  for (const part of commands) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    if (!/^(?:rg|Get-Content|Select-String|Select-Object)\b/i.test(trimmed)) {
      return `forbidden pipeline command: ${trimmed.split(/\s+/)[0]}`;
    }
  }
  return null;
}
