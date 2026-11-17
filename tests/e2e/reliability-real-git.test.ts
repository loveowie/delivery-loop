import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RuntimeFactory } from '../../src/runtime/runtime-factory.js';
import { StateStore } from '../../src/state/state-store.js';
import { DEFAULT_CONFIG } from '../../src/config/config.js';
import type { RunState, TaskNode } from '../../src/domain/types.js';
const exec=promisify(execFile);

test('real Git repair carries failed implementation through candidate integration and final review',async()=>{
  const repo=await mkdtemp(join(tmpdir(),'delivery-real-repair-'));
  const git=async(...args:string[]) => (await exec('git',args,{cwd:repo})).stdout.trim();
  await git('init','-q');await git('config','user.email','fixture@example.invalid');await git('config','user.name','Fixture');
  await writeFile(join(repo,'feature.txt'),'baseline\n');await git('add','feature.txt');await git('commit','-qm','base');
  const baseline=await git('rev-parse','HEAD');
  const command=`node -e "const fs=require('fs');if(fs.readFileSync('feature.txt','utf8')!=='correct\\n')process.exit(1)"`;
  const task:TaskNode={id:'T1',type:'implementation',title:'feature',status:'READY',priority:'normal',risk:'low',origin:'initial_plan',depends_on:[],requirement_ids:['R'],acceptance_ids:['A'],scope_paths:['feature.txt'],required_outputs:[],worker_role:'implementer',capability_profile:'portable',attempt:0,max_attempts:3,verification_commands:[command],review_policy:'none'};
  const config=structuredClone(DEFAULT_CONFIG);config.verification.execution={backend:'trusted-host'};config.verification.baseline=false;config.runtime.max_parallel_workers=1;
  const state:RunState={state_schema_version:1,run_id:'run',repo_root:repo,status:'RUNNING',baseline_commit:baseline,created_at:new Date().toISOString(),updated_at:new Date().toISOString(),config,graph:{run_id:'run',tasks:[task],requirements:[{id:'R',description:'correct feature',status:'PENDING'}],acceptance:[{id:'A',requirement_id:'R',description:'correct bytes',verification:{type:'command',command,expected_exit_code:0},mandatory:true,risk:'low'}]},current_task_ids:[],pending_decision_ids:[],pause_requested:false};
  const store=await StateStore.open(repo);await store.createRun(state);await store.writeArtifact('run','spec.md','# Required correct feature');
  const roles:string[]=[];let sawFailed=false;
  const factory=new RuntimeFactory({pluginRoot:process.cwd(),workerAdapter:{async run(request){
    roles.push(request.role);
    if(request.role==='debugger') {sawFailed=(await readFile(join(request.workdir,'feature.txt'),'utf8'))==='failed implementation\n';assert.match(JSON.stringify(request.context),/failed|Required correct/);await writeFile(join(request.workdir,'feature.txt'),'correct\n');}
    else if(request.role==='implementer') {const current=await readFile(join(request.workdir,'feature.txt'),'utf8');if(current==='baseline\n')await writeFile(join(request.workdir,'feature.txt'),'failed implementation\n');}
    return {task_id:request.task_id,status:'completed',summary:'fixture',files_changed:request.role==='reviewer'?[]:['feature.txt'],commands_run:[],findings:[],remaining_risks:[],suggested_tasks:[],blockers:[],token_usage:11};
  }}});
  const runtime=await factory.create(repo,'run');let latest=state;
  for(let i=0;i<12;i++){latest=await runtime.controller.tick('run');if(['COMPLETED','BLOCKED','WAITING_HUMAN'].includes(latest.status))break;}
  assert.equal(latest.status,'COMPLETED',latest.last_error ?? '');assert.equal(sawFailed,true);assert.ok(roles.includes('reviewer'));
  assert.equal(await readFile(join(latest.integration_worktree!,'feature.txt'),'utf8'),'correct\n');
  assert.equal(await readFile(join(repo,'feature.txt'),'utf8'),'baseline\n');
  const patchPath=join(store.getRunDirectory('run'),'delivery.patch');const patch=await readFile(patchPath,'utf8');assert.match(patch,/correct/);
  const fresh=join(repo,'fresh');await git('worktree','add','--detach',fresh,baseline);await exec('git',['apply',patchPath],{cwd:fresh});assert.equal(await readFile(join(fresh,'feature.txt'),'utf8'),'correct\n');
  const records=await runtime.evidenceLedger.readAll('run');assert.ok(records.some(e=>e.result==='failed'));assert.ok(records.some(e=>e.task_id==='FINAL-VERIFICATION'&&e.code_snapshot_id===latest.integration_snapshot_id));
});

test('later task verifies every earlier acceptance on the final combined content',async()=>{
  const repo=await mkdtemp(join(tmpdir(),'delivery-real-combined-'));const git=async(...args:string[])=>(await exec('git',args,{cwd:repo})).stdout.trim();
  await git('init','-q');await git('config','user.name','Fixture');await git('config','user.email','fixture@example.invalid');await writeFile(join(repo,'a.txt'),'old');await writeFile(join(repo,'b.txt'),'old');await git('add','.');await git('commit','-qm','base');const baseline=await git('rev-parse','HEAD');
  const commandA=`node -e "if(require('fs').readFileSync('a.txt','utf8')!=='A')process.exit(1)"`;
  const commandB=`node -e "if(require('fs').readFileSync('b.txt','utf8')!=='B')process.exit(1)"`;
  const config=structuredClone(DEFAULT_CONFIG);config.verification.baseline=false;config.verification.execution={backend:'trusted-host'};
  const make=(id:string,file:string,command:string):TaskNode=>({id,type:'implementation',title:id,status:'PENDING',priority:'normal',risk:'low',origin:'initial_plan',depends_on:id==='T2'?['T1']:[],requirement_ids:[id==='T1'?'R1':'R2'],acceptance_ids:[id==='T1'?'A1':'A2'],scope_paths:[file],required_outputs:[],worker_role:'implementer',capability_profile:'portable',attempt:0,max_attempts:3,verification_commands:[command],review_policy:'none'});
  const state:RunState={state_schema_version:1,run_id:'combined',status:'RUNNING',repo_root:repo,baseline_commit:baseline,created_at:'now',updated_at:'now',config,graph:{run_id:'combined',tasks:[make('T1','a.txt',commandA),make('T2','b.txt',commandB)],requirements:[{id:'R1',description:'A',status:'PENDING'},{id:'R2',description:'B',status:'PENDING'}],acceptance:[{id:'A1',requirement_id:'R1',description:'A',verification:{type:'command',command:commandA,expected_exit_code:0},mandatory:true,risk:'low'},{id:'A2',requirement_id:'R2',description:'B',verification:{type:'command',command:commandB,expected_exit_code:0},mandatory:true,risk:'low'}]},current_task_ids:[],pending_decision_ids:[],pause_requested:false};
  const store=await StateStore.open(repo);await store.createRun(state);await store.writeArtifact('combined','spec.md','# Both features');
  const runtime=await new RuntimeFactory({pluginRoot:process.cwd(),workerAdapter:{async run(request){if(request.task_id==='T1')await writeFile(join(request.workdir,'a.txt'),'A');if(request.task_id==='T2')await writeFile(join(request.workdir,'b.txt'),'B');return {task_id:request.task_id,status:'completed',summary:'done',files_changed:[],commands_run:[],findings:[],remaining_risks:[],suggested_tasks:[],blockers:[]};}}}).create(repo,'combined');
  let current=state;for(let n=0;n<8;n++){current=await runtime.controller.tick('combined');if(['COMPLETED','BLOCKED'].includes(current.status))break;}
  assert.equal(current.status,'COMPLETED',current.last_error??'');
  const records=await runtime.evidenceLedger.readAll('combined');for(const id of ['A1','A2'])assert.ok(records.some(e=>e.task_id==='FINAL-VERIFICATION'&&e.acceptance_ids.includes(id)&&e.code_snapshot_id===current.integration_snapshot_id&&e.result==='passed'));
  assert.equal(await readFile(join(current.integration_worktree!,'a.txt'),'utf8'),'A');assert.equal(await readFile(join(current.integration_worktree!,'b.txt'),'utf8'),'B');
});
