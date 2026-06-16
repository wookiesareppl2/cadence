// Terminal command cheat sheet data. `name` is the form you actually type at the
// console — for PowerShell that's the alias (ls, cd, cat …), since aliases are the
// documented best practice for interactive use; the canonical cmdlet lives in
// `fullName` (use it in saved scripts). Lists are ordered most-used first.

export type CommandShell = 'powershell' | 'wsl'

export type CheatCommand = {
  id: string
  shell: CommandShell
  // What you type at the prompt (PowerShell alias, or the bash command).
  name: string
  // Canonical form shown in the tooltip — e.g. the PowerShell cmdlet behind an alias.
  fullName?: string
  description: string
  // Usage examples shown in the tooltip.
  examples: string[]
}

export const DEFAULT_COMMANDS: CheatCommand[] = [
  // ── PowerShell (Windows) ──────────────────────────────────────────────────
  { id: 'ps-ls', shell: 'powershell', name: 'ls', fullName: 'Get-ChildItem', description: 'List files and folders in a directory.', examples: ['ls', 'ls -Force', 'ls -Recurse -Filter *.ts'] },
  { id: 'ps-cd', shell: 'powershell', name: 'cd', fullName: 'Set-Location', description: 'Change the current directory.', examples: ['cd C:\\Projects', 'cd ..'] },
  { id: 'ps-cat', shell: 'powershell', name: 'cat', fullName: 'Get-Content', description: 'Show the contents of a file.', examples: ['cat app.log', 'cat app.log -Tail 50'] },
  { id: 'ps-cp', shell: 'powershell', name: 'cp', fullName: 'Copy-Item', description: 'Copy files or folders.', examples: ['cp a.txt b.txt', 'cp src dst -Recurse'] },
  { id: 'ps-mv', shell: 'powershell', name: 'mv', fullName: 'Move-Item', description: 'Move or rename files and folders.', examples: ['mv old.txt new.txt'] },
  { id: 'ps-rm', shell: 'powershell', name: 'rm', fullName: 'Remove-Item', description: 'Delete files or folders.', examples: ['rm temp.txt', 'rm node_modules -Recurse -Force'] },
  { id: 'ps-pwd', shell: 'powershell', name: 'pwd', fullName: 'Get-Location', description: 'Print the current directory.', examples: ['pwd'] },
  { id: 'ps-mkdir', shell: 'powershell', name: 'mkdir', fullName: 'New-Item / md', description: 'Create a directory (parents included).', examples: ['mkdir build', 'mkdir build\\out'] },
  { id: 'ps-ni', shell: 'powershell', name: 'ni', fullName: 'New-Item', description: 'Create a new file or item.', examples: ['ni notes.txt', 'New-Item -ItemType File .env'] },
  { id: 'ps-echo', shell: 'powershell', name: 'echo', fullName: 'Write-Output', description: 'Print text or a value to output.', examples: ['echo "Hello"', 'echo $PWD'] },
  { id: 'ps-cls', shell: 'powershell', name: 'cls', fullName: 'Clear-Host', description: 'Clear the console screen.', examples: ['cls'] },
  { id: 'ps-ps', shell: 'powershell', name: 'ps', fullName: 'Get-Process', description: 'List running processes.', examples: ['ps', 'ps node'] },
  { id: 'ps-kill', shell: 'powershell', name: 'kill', fullName: 'Stop-Process', description: 'Terminate a running process.', examples: ['kill -Name node -Force', 'kill 1234'] },
  { id: 'ps-sls', shell: 'powershell', name: 'sls', fullName: 'Select-String', description: 'Search files or input for text (grep).', examples: ['sls -Path *.ts -Pattern TODO', 'ls -r *.ts | sls TODO'] },
  { id: 'ps-ren', shell: 'powershell', name: 'ren', fullName: 'Rename-Item', description: 'Rename a file or folder.', examples: ['ren a.txt b.txt'] },
  { id: 'ps-where', shell: 'powershell', name: 'where', fullName: 'Where-Object', description: 'Filter pipeline objects by a condition.', examples: ['ps | where CPU -gt 100', 'ps | ? CPU -gt 100'] },
  { id: 'ps-foreach', shell: 'powershell', name: 'foreach', fullName: 'ForEach-Object', description: 'Run an action once per pipeline item.', examples: ['1..5 | foreach { $_ * 2 }', 'ls | % Name'] },
  { id: 'ps-select', shell: 'powershell', name: 'select', fullName: 'Select-Object', description: 'Pick properties, or the first/last N items.', examples: ['ps | select Name, CPU -First 5'] },
  { id: 'ps-sort', shell: 'powershell', name: 'sort', fullName: 'Sort-Object', description: 'Sort objects by a property.', examples: ['ls | sort Length -Descending'] },
  { id: 'ps-measure', shell: 'powershell', name: 'measure', fullName: 'Measure-Object', description: 'Count, sum, or average values.', examples: ['cat f.txt | measure -Line'] },
  { id: 'ps-gm', shell: 'powershell', name: 'gm', fullName: 'Get-Member', description: "Inspect an object's properties and methods.", examples: ['ps | gm'] },
  { id: 'ps-iwr', shell: 'powershell', name: 'iwr', fullName: 'Invoke-WebRequest', description: 'Make an HTTP request or download a file.', examples: ['iwr https://example.com -OutFile page.html', 'curl https://example.com'] },
  { id: 'ps-irm', shell: 'powershell', name: 'irm', fullName: 'Invoke-RestMethod', description: 'Call a REST/JSON API and parse the result.', examples: ['irm https://api.example.com/data'] },
  { id: 'ps-gcm', shell: 'powershell', name: 'gcm', fullName: 'Get-Command', description: 'Discover available commands and cmdlets.', examples: ['gcm *service*'] },
  { id: 'ps-help', shell: 'powershell', name: 'help', fullName: 'Get-Help', description: 'Show help and examples for a command.', examples: ['help ls -Examples', 'man Get-Process'] },
  { id: 'ps-gal', shell: 'powershell', name: 'gal', fullName: 'Get-Alias', description: 'See what an alias maps to, or list aliases.', examples: ['gal ls', 'gal'] },
  { id: 'ps-start', shell: 'powershell', name: 'start', fullName: 'Start-Process', description: 'Launch a program, or open a file/folder.', examples: ['start notepad', 'start .'] },
  { id: 'ps-ft', shell: 'powershell', name: 'ft', fullName: 'Format-Table', description: 'Format pipeline output as an aligned table.', examples: ['ps | ft Name, CPU -AutoSize'] },
  { id: 'ps-testpath', shell: 'powershell', name: 'Test-Path', description: 'Test whether a file or folder path exists.', examples: ['Test-Path .\\package.json'] },
  { id: 'ps-sc', shell: 'powershell', name: 'sc', fullName: 'Set-Content', description: 'Write text to a file, overwriting it.', examples: ['sc notes.txt "first line"', '"hi" | Set-Content notes.txt'] },
  { id: 'ps-ac', shell: 'powershell', name: 'ac', fullName: 'Add-Content', description: 'Append text to the end of a file.', examples: ['ac notes.txt "another line"'] },
  { id: 'ps-outfile', shell: 'powershell', name: 'Out-File', description: 'Write output to a file (like > redirection).', examples: ['ps | Out-File procs.txt', 'ps > procs.txt'] },
  { id: 'ps-gsv', shell: 'powershell', name: 'gsv', fullName: 'Get-Service', description: 'List Windows services and their status.', examples: ['gsv', 'gsv | where Status -eq Running'] },
  { id: 'ps-tojson', shell: 'powershell', name: 'ConvertTo-Json', description: 'Serialize an object to JSON text.', examples: ['$obj | ConvertTo-Json -Depth 5'] },
  { id: 'ps-fromjson', shell: 'powershell', name: 'ConvertFrom-Json', description: 'Parse JSON text into an object.', examples: ['cat data.json | ConvertFrom-Json'] },
  { id: 'ps-tnc', shell: 'powershell', name: 'tnc', fullName: 'Test-NetConnection', description: 'Check connectivity and a specific TCP port.', examples: ['tnc github.com -Port 443'] },
  { id: 'ps-ping', shell: 'powershell', name: 'Test-Connection', description: 'Send ICMP pings to test connectivity.', examples: ['Test-Connection github.com -Count 2'] },
  { id: 'ps-execpolicy', shell: 'powershell', name: 'Set-ExecutionPolicy', description: 'Allow scripts to run (common first-run fix).', examples: ['Set-ExecutionPolicy -Scope CurrentUser RemoteSigned'] },
  { id: 'ps-date', shell: 'powershell', name: 'Get-Date', description: 'Get or format the current date and time.', examples: ['Get-Date -Format "yyyy-MM-dd"'] },

  // ── WSL · Ubuntu (bash) ───────────────────────────────────────────────────
  { id: 'wsl-ls', shell: 'wsl', name: 'ls', description: 'List directory contents.', examples: ['ls', 'ls -lah'] },
  { id: 'wsl-cd', shell: 'wsl', name: 'cd', description: 'Change the current directory.', examples: ['cd /var/log', 'cd ~'] },
  { id: 'wsl-pwd', shell: 'wsl', name: 'pwd', description: 'Print the current working directory.', examples: ['pwd'] },
  { id: 'wsl-cat', shell: 'wsl', name: 'cat', description: 'Print the contents of a file.', examples: ['cat app.log'] },
  { id: 'wsl-cp', shell: 'wsl', name: 'cp', description: 'Copy files or directories.', examples: ['cp a.txt b.txt', 'cp -r src/ dst/'] },
  { id: 'wsl-mv', shell: 'wsl', name: 'mv', description: 'Move or rename files and directories.', examples: ['mv old.txt new.txt'] },
  { id: 'wsl-rm', shell: 'wsl', name: 'rm', description: 'Remove files or directories.', examples: ['rm file.txt', 'rm -rf node_modules'] },
  { id: 'wsl-mkdir', shell: 'wsl', name: 'mkdir', description: 'Create directories (-p makes parents).', examples: ['mkdir build', 'mkdir -p build/out'] },
  { id: 'wsl-touch', shell: 'wsl', name: 'touch', description: 'Create an empty file or update its timestamp.', examples: ['touch .env'] },
  { id: 'wsl-grep', shell: 'wsl', name: 'grep', description: 'Search text in files or input.', examples: ['grep -rn "TODO" src/'] },
  { id: 'wsl-find', shell: 'wsl', name: 'find', description: 'Find files and folders by name or criteria.', examples: ['find . -name "*.ts"'] },
  { id: 'wsl-man', shell: 'wsl', name: 'man', description: 'Open the manual page for a command.', examples: ['man tar'] },
  { id: 'wsl-echo', shell: 'wsl', name: 'echo', description: 'Print text or a variable to output.', examples: ['echo "$HOME"'] },
  { id: 'wsl-sudo', shell: 'wsl', name: 'sudo', description: 'Run a command with superuser privileges.', examples: ['sudo apt update'] },
  { id: 'wsl-apt', shell: 'wsl', name: 'apt', fullName: 'apt / apt-get', description: 'Install and manage packages (Debian/Ubuntu).', examples: ['sudo apt install ripgrep', 'sudo apt update && sudo apt upgrade'] },
  { id: 'wsl-chmod', shell: 'wsl', name: 'chmod', description: 'Change file permissions.', examples: ['chmod +x script.sh'] },
  { id: 'wsl-chown', shell: 'wsl', name: 'chown', description: 'Change file owner and group.', examples: ['sudo chown user:user file'] },
  { id: 'wsl-ps', shell: 'wsl', name: 'ps', description: 'List running processes.', examples: ['ps aux'] },
  { id: 'wsl-kill', shell: 'wsl', name: 'kill', description: 'Send a signal to a process (default: terminate).', examples: ['kill 1234', 'kill -9 1234'] },
  { id: 'wsl-top', shell: 'wsl', name: 'top', fullName: 'top / htop', description: 'Live view of processes and resource use.', examples: ['top', 'htop'] },
  { id: 'wsl-df', shell: 'wsl', name: 'df', description: 'Show free and used disk space.', examples: ['df -h'] },
  { id: 'wsl-du', shell: 'wsl', name: 'du', description: 'Show file and directory sizes.', examples: ['du -sh *'] },
  { id: 'wsl-tar', shell: 'wsl', name: 'tar', description: 'Create or extract .tar / .tar.gz archives.', examples: ['tar -xzf archive.tar.gz', 'tar -czf out.tar.gz dir/'] },
  { id: 'wsl-curl', shell: 'wsl', name: 'curl', description: 'Transfer data and call HTTP APIs.', examples: ['curl -s https://api.example.com'] },
  { id: 'wsl-wget', shell: 'wsl', name: 'wget', description: 'Download files over HTTP/FTP.', examples: ['wget https://example.com/file.zip'] },
  { id: 'wsl-ssh', shell: 'wsl', name: 'ssh', description: 'Open a secure shell to a remote host.', examples: ['ssh user@host'] },
  { id: 'wsl-tail', shell: 'wsl', name: 'tail', description: 'Show the end of a file (-f to follow).', examples: ['tail -f app.log'] },
  { id: 'wsl-head', shell: 'wsl', name: 'head', description: 'Show the first lines of a file.', examples: ['head -n 20 app.log'] },
  { id: 'wsl-less', shell: 'wsl', name: 'less', description: 'Scroll through a file one page at a time.', examples: ['less big.log'] },
  { id: 'wsl-nano', shell: 'wsl', name: 'nano', fullName: 'nano / vim', description: 'Edit a file in a terminal text editor.', examples: ['nano file.txt'] },
  { id: 'wsl-wc', shell: 'wsl', name: 'wc', description: 'Count lines, words, or bytes.', examples: ['wc -l file.txt'] },
  { id: 'wsl-which', shell: 'wsl', name: 'which', description: "Show the path of a command's executable.", examples: ['which node'] },
  { id: 'wsl-history', shell: 'wsl', name: 'history', description: 'List previously run commands.', examples: ['history | grep git'] },
  { id: 'wsl-clear', shell: 'wsl', name: 'clear', description: 'Clear the terminal screen.', examples: ['clear'] },
  { id: 'wsl-export', shell: 'wsl', name: 'export', description: 'Set an environment variable for the session.', examples: ['export NODE_ENV=production'] },
  { id: 'wsl-ln', shell: 'wsl', name: 'ln', description: 'Create links, usually symbolic (-s).', examples: ['ln -s target linkname'] },
  { id: 'wsl-sed', shell: 'wsl', name: 'sed', description: 'Stream-edit text (find/replace, etc.).', examples: ["sed 's/foo/bar/g' file"] },
  { id: 'wsl-awk', shell: 'wsl', name: 'awk', description: 'Field-based text processing.', examples: ["awk '{print $1}' file"] },
  { id: 'wsl-ping', shell: 'wsl', name: 'ping', description: 'Test network connectivity to a host.', examples: ['ping -c 2 github.com'] }
]

export function filterCommands(commands: CheatCommand[], shell: CommandShell, query: string): CheatCommand[] {
  const needle = query.trim().toLowerCase()
  return commands.filter((entry) => {
    if (entry.shell !== shell) return false
    if (!needle) return true
    const haystack = [entry.name, entry.fullName ?? '', entry.description, ...entry.examples]
    return haystack.some((value) => value.toLowerCase().includes(needle))
  })
}
