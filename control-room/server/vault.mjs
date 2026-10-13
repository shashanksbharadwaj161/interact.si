import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises';
import path from 'node:path';

export async function powershell(script, input = '') {
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile','-NonInteractive','-Command', script], { windowsHide:true, env:{...process.env,PSModulePath:path.join(process.env.SystemRoot||'C:/Windows','System32','WindowsPowerShell','v1.0','Modules')}, stdio:['pipe','pipe','pipe'] });
    const timeout=setTimeout(()=>child.kill(),15000);
    let output = ''; child.stdout.on('data', b => output += b);
    child.stderr.resume(); // Never echo helper stderr: it may contain sensitive input.
    child.on('error', () => reject(new Error('Windows credential helper unavailable')));
    child.on('close', code => {clearTimeout(timeout);code === 0 ? resolve(output.trim()) : reject(new Error('Windows credential protection failed'));});
    child.stdin.on('error', () => {}); child.stdin.end(input);
  });
}
export async function protectDirectory(dir) {
  await mkdir(dir, {recursive:true});
  if (process.platform !== 'win32') throw new Error('Protected key storage requires Windows; demo remains available');
  const encoded = Buffer.from(dir).toString('base64');
  await powershell(`$ErrorActionPreference='Stop'; $p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}')); $acl=New-Object Security.AccessControl.DirectorySecurity; $acl.SetAccessRuleProtection($true,$false); $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User; $rule=New-Object Security.AccessControl.FileSystemAccessRule($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow'); $acl.AddAccessRule($rule); [IO.Directory]::SetAccessControl($p,$acl)`);
}
export class Vault {
  constructor(dir) {this.dir=dir; this.file=path.join(dir,'anthropic.dpapi'); this.cached=null;}
  async status() {try {await readFile(this.file); return true;} catch {return false;}}
  async save(value) {
    if (typeof value !== 'string' || !/^sk-ant-[A-Za-z0-9_-]{12,}$/.test(value)) throw new Error('Enter a valid Anthropic API key');
    await protectDirectory(this.dir);
    const cipher = await powershell("$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security; $v=[Console]::In.ReadToEnd(); $b=[Text.Encoding]::UTF8.GetBytes($v); [Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser))",value);
    await writeFile(this.file,cipher,{mode:0o600}); this.cached=value;
  }
  async get() {
    if(this.cached) return this.cached;
    let cipher; try {cipher=await readFile(this.file,'utf8');} catch {throw new Error('Add your Anthropic key in Providers first');}
    this.cached = await powershell("$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security; $b=[Convert]::FromBase64String([Console]::In.ReadToEnd()); [Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser))",cipher);
    return this.cached;
  }
  async remove() {this.cached=null; await unlink(this.file).catch(e=>{if(e.code!=='ENOENT')throw e;});}
}
