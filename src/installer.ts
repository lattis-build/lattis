import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, readFile, lstat, realpath, writeFile } from 'node:fs/promises';
import { resolve, join, basename, relative } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { parseEnv } from 'node:util';
import { z } from 'zod';
import { atomicFile, boundedFile } from './security-files.js';

const database = z.string().refine(value=>{
  try { const url=new URL(value);return ['postgres:','postgresql:','mysql:','mariadb:'].includes(url.protocol)&&!!url.hostname&&!!url.username&&url.pathname.length>1&&!url.hash&&!['sslmode','ssl','tls','multipleStatements'].some(name=>url.searchParams.has(name)); }
  catch{return false;}
},'Use a PostgreSQL or MariaDB URL including a database and user; configure TLS separately');
const origin = z.string().refine(value=>{
  try {const url=new URL(value);return ['http:','https:'].includes(url.protocol)&&!url.username&&!url.password&&url.pathname==='/'&&!url.hash&&!url.search;}
  catch{return false;}
},'Use an HTTP(S) origin without a path, query or credentials').transform(value=>new URL(value).origin);
const optionalUrl=z.union([z.literal(''),z.url().refine(value=>{try{const url=new URL(value);return ['http:','https:'].includes(url.protocol)&&!url.username&&!url.password&&!url.hash;}catch{return false;}},'Use an HTTP(S) URL without credentials')]);
const configuration=z.object({
  APP_DATABASE_URL:database,
  APP_MIGRATION_DATABASE_URL:z.union([z.literal(''),database]).default(''),
  APP_DATABASE_CA_FILE:z.string().default(''),
  APP_BASE_URL:origin.default('http://127.0.0.1:4100'),
  APP_PORT:z.coerce.number().int().min(1).max(65535).default(4100),
  APP_HOST:z.string().regex(/^[a-zA-Z0-9.:-]+$/).default('127.0.0.1'),
  LATTIS_OWNER_EMAIL:z.email().max(191).transform(value=>value.toLowerCase()),
  LATTIS_TRUSTED_ORIGINS:z.string().default('http://127.0.0.1:3000').refine(value=>value.split(',').map(part=>part.trim()).filter(Boolean).every(part=>origin.safeParse(part).success),'Use comma-separated HTTP(S) origins').transform(value=>value.split(',').map(part=>part.trim()).filter(Boolean).map(part=>origin.parse(part)).join(',')),
  LATTIS_SIGNUP_OPEN:z.enum(['true','false']).default('false'),
  LATTIS_ADMIN_BASE_URL:z.union([z.literal(''),origin]).default(''),
  LATTIS_MAIL_WEBHOOK_URL:optionalUrl.default(''),
  LATTIS_MAIL_WEBHOOK_TOKEN:z.string().default(''),
}).strict().refine(value=>!value.LATTIS_MAIL_WEBHOOK_URL||value.LATTIS_MAIL_WEBHOOK_TOKEN.length>=32,'Mail delivery requires a token of at least 32 characters')
.refine(value=>!value.LATTIS_ADMIN_BASE_URL||value.LATTIS_ADMIN_BASE_URL!==value.APP_BASE_URL,'Admin and application must use separate origins');
const fields=[
  ['APP_DATABASE_URL','Application database URL',true,undefined],
  ['APP_BASE_URL','Application public URL',false,'http://127.0.0.1:4100'],
  ['APP_PORT','Application listen port',false,'4100'],
  ['APP_HOST','Application listen address',false,'127.0.0.1'],
  ['LATTIS_OWNER_EMAIL','Instance owner email',false,undefined],
  ['LATTIS_TRUSTED_ORIGINS','Frontend origins, comma-separated',false,'http://127.0.0.1:3000'],
  ['LATTIS_SIGNUP_OPEN','Allow public signup (true/false)',false,'false'],
  ['LATTIS_ADMIN_BASE_URL','Optional Admin origin',false,''],
  ['APP_MIGRATION_DATABASE_URL','Optional separate migration database URL',true,''],
  ['APP_DATABASE_CA_FILE','Optional database CA certificate path',false,''],
  ['LATTIS_MAIL_WEBHOOK_URL','Optional mail delivery webhook URL',false,''],
  ['LATTIS_MAIL_WEBHOOK_TOKEN','Mail webhook token (required when URL is set)',true,''],
] as const;
function problems(error:unknown):string {
  return error instanceof z.ZodError ? error.issues.map(issue=>`${issue.path.join('.')||'Configuration'}: ${issue.message}`).join('\n') : 'Invalid configuration';
}
async function collect(previous:Record<string,string>,configFile?:string):Promise<Record<string,string>> {
  let input:Record<string,unknown>={};
  if(configFile) {
    const path=resolve(configFile),info=await lstat(path);
    if(process.platform!=='win32' && (info.mode & 0o077))throw new Error('Configuration JSON must be private (chmod 600)');
    let value:unknown;
    try{value=JSON.parse((await boundedFile(path,64*1024)).toString('utf8'));}catch{throw new Error('Configuration JSON is invalid or unavailable');}
    if(!value || typeof value!=='object'||Array.isArray(value))throw new Error('Configuration file must be a JSON object');
    input=value as Record<string,unknown>;
  } else {
    if(!process.stdin.isTTY||!process.stdout.isTTY)throw new Error('Interactive configuration needs a terminal. Use --config-file /private/setup.json or init for scaffolding only');
    let hidden=false;
    const terminal=Object.assign(new Writable({write(chunk,_encoding,callback){if(!hidden)process.stdout.write(chunk);callback();}}),{isTTY:true,columns:process.stdout.columns});
    const rl=createInterface({input:process.stdin,output:terminal,terminal:true});
    const abort=new AbortController();
    rl.once('SIGINT',()=>{abort.abort();rl.close();});
    rl.once('close',()=>abort.abort());
    try {
      process.stdout.write('Configure Lattis. Database URLs and tokens are hidden. Leave optional fields empty.\n');
      while(true) {
        for(const [name,label,secret,fallback] of fields) {
          const current=typeof input[name]==='string'?input[name] as string:previous[name]??fallback;
          const hint=secret?(current?' [Enter to keep]':current===''?' [optional]':''):current?` [${current}]`:current===''?' [optional]':'';
          const answer=rl.question(`${label}${hint}: `,{signal:abort.signal});hidden=secret;
          let value:string;
          try{value=(await answer).trim();}finally{hidden=false;if(secret)process.stdout.write('\n');}
          input[name]=value||current||'';
        }
        const parsed=configuration.safeParse(input);
        if(parsed.success)break;
        process.stdout.write(`${problems(parsed.error)}\nPlease correct the configuration.\n`);
      }
    } finally {hidden=false;rl.close();terminal.end();}
  }
  const parsed=configuration.safeParse(input);
  if(!parsed.success)throw new Error(problems(parsed.error));
  return Object.fromEntries(Object.entries(parsed.data).map(([key,value])=>[key,String(value)]));
}
function dotenv(values:Record<string,string>):string {
  return '# Lattis configuration. Keep this file private and outside version control.\n'+Object.entries(values).map(([key,value])=>{
    if(!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)||/[\u0000\r\n]/.test(value))throw new Error(`Cannot serialize configuration key ${key}; keep multiline secrets in the secret provider`);
    const quote=["'",'"','`'].find(candidate=>!value.includes(candidate));
    if(!quote)throw new Error(`Unsupported quoting in configuration key ${key}`);
    return `${key}=${quote}${value}${quote}`;
  }).join('\n')+'\n';
}
async function existingEnvironment(directory:string):Promise<{values:Record<string,string>;bytes:Buffer|null}> {
  try {
    const path=join(directory,'.env'),info=await lstat(path);
    if(!info.isFile()||info.isSymbolicLink())throw new Error('.env must be a regular file');
    const bytes=await boundedFile(path,1024*1024);return {values:parseEnv(bytes.toString('utf8')),bytes};
  }catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return {values:{},bytes:null};throw error;}
}
async function saveConfiguration(directory:string,values:Record<string,string>,previous:Awaited<ReturnType<typeof existingEnvironment>>):Promise<void> {
  const next={...previous.values,...values};
  for(const key of ['APP_MIGRATION_DATABASE_URL','APP_DATABASE_CA_FILE','LATTIS_ADMIN_BASE_URL','LATTIS_MAIL_WEBHOOK_URL','LATTIS_MAIL_WEBHOOK_TOKEN'])if(!next[key])delete next[key];
  if(!next.BETTER_AUTH_SECRET || next.BETTER_AUTH_SECRET.length<32 || next.BETTER_AUTH_SECRET.startsWith('replace-with-'))next.BETTER_AUTH_SECRET=randomBytes(48).toString('base64url');
  for(const key of ['LATTIS_VAULT_KEY','LATTIS_IMPORT_KEY'])if(!next[key])next[key]=randomBytes(32).toString('base64');
  if(next.NODE_ENV==='production')throw new Error('Configure in an offline development workspace before preparing an authorized production release');
  next.LATTIS_REGISTRY_MODE??='official';
  next.GEODE_PUBLISHER_SLUG??='owner';
  const text=dotenv(next);
  if(previous.bytes)await atomicFile(join(directory,'.lattis','config-backups',`${Date.now()}-${randomBytes(6).toString('hex')}.env`),previous.bytes,0o600);
  await atomicFile(join(directory,'.env'),text,0o600);
}
export async function initializeProject(target:string,coreRoot:string):Promise<string> {
  const directory=resolve(target);
  if(directory===coreRoot)throw new Error('Choose a new application directory');
  const core=JSON.parse(await readFile(join(coreRoot,'package.json'),'utf8')) as {version:string};
  await mkdir(directory,{recursive:false});
  for(const path of ['packages/local','migrations','extensions'])await mkdir(join(directory,path),{recursive:true});
  const name=basename(directory).toLowerCase().replace(/[^a-z0-9-]/g,'-').slice(0,100)||'lattis-app';
  const json=async(path:string,value:unknown)=>writeFile(join(directory,path),JSON.stringify(value,null,2)+'\n',{flag:'wx'});
  await json('lattis.config.json',{schemaVersion:1,applicationId:name,localPublisher:'owner',releaseComponents:['app','admin'],trustedModules:[],extensions:[],trustedPublishers:{},migrations:[]});
  await json('lattis.lock',{schemaVersion:2,core:core.version,packages:{}});
  await json('tsconfig.json',{compilerOptions:{target:'ES2022',module:'NodeNext',moduleResolution:'NodeNext',strict:true,noEmit:true,types:['node']},include:['packages/**/*.ts']});
  const source=relative(directory,coreRoot).split('\\').join('/');
  // A checkout remains a local dependency; an installed package uses its exact version.
  const dependency=coreRoot.split(/[\\/]/).includes('node_modules')?core.version:`file:${source.startsWith('.')?source:`./${source}`}`;
  await json('package.json',{name,private:true,type:'module',scripts:{lattis:'lattis',configure:'lattis configure',app:'lattis serve-app',admin:'lattis serve-admin','mcp:local':'lattis mcp-local','mcp:remote':'lattis mcp-remote'},dependencies:{lattis:dependency,auth:'^1.7.6',zod:'^4.1.12'},devDependencies:{'@types/node':'^22.18.6','@types/pg':'^8.15.5',typescript:'^5.9.2'}});
  await writeFile(join(directory,'.env.example'),await readFile(join(coreRoot,'.env.example')),{flag:'wx'});
  await writeFile(join(directory,'.gitignore'),'node_modules/\n.env\n.env.*\n!.env.example\n.lattis/\n',{flag:'wx'});
  return directory;
}
export async function configureProject(target:string,configFile?:string):Promise<void> {
  const directory=await realpath(resolve(target));
  await lstat(join(directory,'lattis.config.json'));
  const previous=await existingEnvironment(directory),values=await collect(previous.values,configFile);
  await saveConfiguration(directory,values,previous);
  process.stdout.write(`Configuration written to ${join(directory,'.env')} (0600). Secrets are not printed.\n`);
}
export async function installApplication(target:string,coreRoot:string,options:{configFile?:string;skipDependencies:boolean}):Promise<void> {
  const values=await collect({},options.configFile);
  const directory=await initializeProject(target,coreRoot);
  await saveConfiguration(directory,values,{values:{},bytes:null});
  if(!options.skipDependencies) {
    const child=spawn(process.platform==='win32'?'npm.cmd':'npm',['install','--ignore-scripts','--no-audit','--no-fund'],{cwd:directory,env:{...process.env,npm_config_ignore_scripts:'true'},stdio:'inherit',shell:false});
    const code=await new Promise<number>((yes,no)=>{child.on('error',no);child.on('exit',value=>yes(value??1));});
    if(code!==0)throw new Error(`Project and configuration were saved in ${directory}; dependency installation failed (${code}). Retry npm install --ignore-scripts --no-audit --no-fund there`);
  }
  process.stdout.write(`\nLattis project: ${directory}\nConfiguration: .env (0600)\nNext, from that directory:\n${options.skipDependencies?'  npm install --ignore-scripts --no-audit --no-fund\n':''}  npm run lattis -- db:app\n  npm run lattis -- db:auth\n  npm run lattis -- db:admin  # when using Admin\n  npm run lattis -- app:owner\n  npm run app\nAfter starting the server, open ${values.APP_BASE_URL}/health/live\nThis command does not create the database, run migrations or start services. Production requires an authorized release.\n`);
}
export function installerArguments(args:string[]):{target:string;targetProvided:boolean;configFile?:string;skipDependencies:boolean} {
  let target:string|undefined,configFile:string|undefined,skipDependencies=false;
  for(let i=0;i<args.length;i++){
    const arg=args[i];
    if(arg==='--skip-dependencies')skipDependencies=true;
    else if(arg==='--config-file'){configFile=args[++i];if(!configFile||configFile.startsWith('--'))throw new Error('--config-file requires a private JSON file');}
    else if(arg.startsWith('--')||target!==undefined)throw new Error(`Unknown installer argument: ${arg}`);
    else target=arg;
  }
  return {target:target??'my-app',targetProvided:target!==undefined,configFile,skipDependencies};
}
