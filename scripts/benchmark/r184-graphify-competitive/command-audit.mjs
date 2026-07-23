export function splitPowerShellCommands(command) {
  const commandArgument = command.match(/\s-(?:Command|c)\s+([\s\S]+)$/iu)?.[1]?.trim()
    ?? command.trim();
  let script = commandArgument;
  // Codex records the argv rendering used to start PowerShell. Nested quotes in
  // that rendering can make the two wrapper quote characters differ even
  // though neither belongs to the script. Remove each boundary independently.
  if (script[0] === '"' || script[0] === "'") script = script.slice(1);
  if (script.at(-1) === '"' || script.at(-1) === "'") script = script.slice(0, -1);

  const parts = [];
  let current = '';
  let quote = null;
  let escaped = false;
  const explicitCommandHead = /^(?:(?:rg|Get-Content|Select-String|Select-Object|Sort-Object|ForEach-Object|Where-Object|Test-Path|git|python|py|node|npm|npx|pnpm|yarn|curl|wget|Invoke-WebRequest|Invoke-RestMethod|Get-ChildItem|Remove-Item|Set-Content|Add-Content|Out-File|New-Item|Copy-Item|Move-Item|sqlite3|jq|findstr|where)(?:\.exe|\.cmd)?|[A-Za-z]+-[A-Za-z]+|foreach|for|if|while|switch)\s/iu;
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
    const tail = script.slice(index + 1).trimStart().replace(/^["']+/u, '');
    const commandBoundary = tail.startsWith('$')
      || explicitCommandHead.test(`${tail} `);
    const separatorBoundary = (
      (character === '|' || character === ';') && commandBoundary
    ) || character === '\n';
    if (separatorBoundary) {
      if (current.trim()) parts.push(current.trim());
      current = '';
      continue;
    }
    current += character;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

function commandHead(part) {
  let candidate = part.trim();
  while (candidate[0] === '"' || candidate[0] === "'") candidate = candidate.slice(1);
  if (candidate.startsWith('&')) candidate = candidate.slice(1).trimStart();
  const token = candidate.match(/^[^\s"'`]+/u)?.[0] ?? '';
  return token.replace(/\.(?:exe|cmd)$/iu, '');
}

export function auditCommand(command) {
  const normalized = command.replaceAll('\r', ' ');
  const commands = splitPowerShellCommands(normalized);
  if (commands.length === 0) {
    return 'command does not contain an allowed evidence reader';
  }
  let hasEvidenceReader = false;
  for (const part of commands) {
    const head = commandHead(part);
    if (!head) continue;
    if (!/^(?:rg|Get-Content|Select-String|Select-Object)$/iu.test(head)) {
      return `forbidden pipeline command: ${head}`;
    }
    if (/^(?:rg|Get-Content|Select-String)$/iu.test(head)) hasEvidenceReader = true;
  }
  return hasEvidenceReader
    ? null
    : 'command does not contain an allowed evidence reader';
}
