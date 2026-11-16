import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DeliveryController } from '../../src/controller/delivery-controller.js';
import { StateStore } from '../../src/state/state-store.js';
import { DEFAULT_CONFIG } from '../../src/config/config.js';
import type { AgentRequest, AgentResult, RunState, TaskNode } from '../../src/domain/types.js';
import type { VerificationRequest } from '../../src/verification/command-runner.js';

async function fixture() {
  const repo = await mkdtemp(join(tmpdir(), 'delivery-reliability-'));
  const store = await StateStore.open(repo);
  const task: TaskNode = { id: 'T1', type: 'implementation', title: 'implement feature', status: 'READY', priority: 'normal', risk: 'low', origin: 'initial_plan', depends_on: [], requirement_ids: ['R1'], acceptance_ids: ['A1'], scope_paths: [], required_outputs: [], worker_role: 'implementer', capability_profile: 'portable', attempt: 0, max_attempts: 3, verification_commands: ['task-test'], review_policy: 'none' };
  const state: RunState = { state_schema_version: 1, run_id: 'run', repo_root: repo, baseline_commit: 'base', status: 'RUNNING', created_at: new Date().toISOString(), updated_at: new Date().toISOString(), config: structuredClone(DEFAULT_CONFIG), graph: {run_id: 'run', tasks: [task], requirements: [{id:'R1',description:'feature specification',status:'PENDING'}], acceptance: [{id:'A1',requirement_id:'R1',description:'feature acceptance',mandatory:true,risk:'low',verification:{type:'command',command:'acceptance-test',expected_exit_code:0}}]}, current_task_ids: [], pause_requested:false,pending_decision_ids:[] };
  state.config.review.final_review = false;
  state.config.verification.commands = {build:[],test:[],lint:[],e2e:[]};
  const requests: AgentRequest[] = []; const checks: VerificationRequest[] = []; const seeds: Array<string | undefined> = []; let integrations = 0; let digest = 'content';
  let worker = async (request: AgentRequest): Promise<AgentResult> => ({task_id:request.task_id,status:'completed',summary:'done',files_changed:[],commands_run:[],findings:[],remaining_risks:[],suggested_tasks:[],blockers:[],token_usage:7});
  let verify = async (_request: VerificationRequest): Promise<boolean | 'error'> => true;
  const controller = new DeliveryController({repoRoot:repo,store,workers:{async run(request){requests.push(request);return await worker(request);}},skills:{async resolve(){return [];},async verifyAll(){}},worktrees:{async prepare(_state, task, seed){seeds.push(seed);return {path:join(repo,task.id),async cleanup(){}};}},snapshots:{async create(){return {id:digest,baseline_commit:'base',worktree_digest:digest,created_at:new Date().toISOString(),untracked_files:[]};}},verifier:{async run(request){checks.push(request);const passed=await verify(request);return {id:`E-${checks.length}`,run_id:'run',task_id:request.task_id,acceptance_ids:request.acceptance_ids,code_snapshot_id:request.code_snapshot_id,command:request.command,cwd:request.cwd,started_at:'now',finished_at:'now',exit_code:passed?0:1,stdout_path:'',stderr_path:'',result:passed==='error'?'error':passed?'passed':'failed'};}},integrator:{async integrate(){integrations++;return {ok:true,workdir:join(repo,'accepted'),snapshot_id:digest};}}});
  await store.createRun(state);
  await store.writeArtifact('run','spec.md','# Frozen detailed specification');
  return {repo,store,state,task,requests,checks,seeds,controller,setWorker(value:typeof worker){worker=value;},setVerifier(value:typeof verify){verify=value;},setDigest(value:string){digest=value;},get integrations(){return integrations;},async save(){await store.updateRun('run',()=>state);},async tick(){return await controller.tick('run');}};
}

test('final review is an observation and never integrates an empty patch',async()=>{
  const f=await fixture();f.state.config.review.final_review=true;await f.save();await f.tick();const state=await f.tick();
  assert.equal(state.status,'COMPLETED');assert.equal(f.integrations,1);assert.equal(state.graph.tasks.find(t=>t.id==='FINAL-REVIEW')?.status,'DONE');
});
test('failed workers are metered and repair receives frozen context',async()=>{
  const f=await fixture();f.setWorker(async request=>({task_id:request.task_id,status:'failed',summary:'compiler diagnostic with failed implementation',files_changed:['src/fail.ts'],commands_run:[],findings:[],remaining_risks:[],suggested_tasks:[],blockers:[],token_usage:19}));
  const state=await f.tick();assert.equal(state.total_tokens_used,19);await f.tick();
  const context=JSON.stringify(f.requests.at(-1));assert.match(context,/Frozen detailed specification/);assert.match(context,/compiler diagnostic/);assert.match(context,/feature acceptance/);
});
test('verification repair seeds from failed implementation instead of accepted baseline',async()=>{
  const f=await fixture();f.setVerifier(async()=>false);const state=await f.tick();const fix=state.graph.tasks.find(t=>t.repairs_task_id==='T1');assert.ok(fix);await f.tick();assert.equal(f.seeds[1],join(f.repo,'T1'));
});
test('final plan runs mandatory acceptance commands missing from task commands',async()=>{
  const f=await fixture();const state=await f.tick();assert.equal(state.status,'COMPLETED');assert.ok(f.checks.some(c=>c.command==='acceptance-test'));assert.equal(state.graph.tasks.length,1);
});
test('a verifier changing content cannot complete with stale evidence',async()=>{
  const f=await fixture();f.setVerifier(async request=>{if(request.task_id==='FINAL-VERIFICATION') f.setDigest('mutated');return true;});
  const state=await f.tick();assert.notEqual(state.status,'COMPLETED');assert.match(state.last_error??'',/content|snapshot|mutat/i);
});
test('global always review cannot be bypassed by task review none',async()=>{
  const f=await fixture();f.state.config.review.task_review_policy='always';await f.save();await f.tick();assert.ok(f.requests.some(r=>r.role==='reviewer'));
});

test('failed candidate verification does not publish the integration pointer',async()=>{
  const f=await fixture();f.state.integration_worktree=join(f.repo,'previous');f.state.integration_snapshot_id='previous';await f.save();
  f.setVerifier(async request=>request.cwd!==join(f.repo,'accepted'));
  const state=await f.tick();assert.equal(state.integration_worktree,join(f.repo,'previous'));assert.equal(state.integration_snapshot_id,'previous');
});

test('all decisions for a task must be answered before it becomes runnable',async()=>{
  const f=await fixture();f.setWorker(async request=>({task_id:request.task_id,status:'blocked',summary:'two choices',files_changed:[],commands_run:[],findings:[],remaining_risks:[],suggested_tasks:[],blockers:['D1','D2'].map(decision_id=>({decision_id,type:'requirement' as const,question:decision_id,options:['yes'],affected_task_ids:['T1']}))}));
  await f.tick();const state=await f.controller.respond('run','D1','chosen approach');assert.equal(state.graph.tasks[0]?.status,'INTERRUPTED');await f.tick();assert.equal(f.requests.length,1);
  const resumed=await f.controller.respond('run','D2','second approach');assert.equal(resumed.graph.tasks[0]?.status,'READY');
});

test('completion records a certificate bound to current snapshot and evidence',async()=>{
  const f=await fixture();const state=await f.tick();assert.equal(state.status,'COMPLETED');
  const certificate=JSON.parse(await readFile(join(f.store.getRunDirectory('run'),'completion.json'),'utf8'));
  assert.equal(certificate.snapshot_id,state.integration_snapshot_id);assert.ok(certificate.evidence.some((e:{command:string})=>e.command==='acceptance-test'));
  assert.ok(state.completion_ref);assert.match(await readFile(join(f.store.getRunDirectory('run'),'reports','final.md'),'utf8'),/acceptance-test/);
});

test('cancellation signals every concurrent worker before returning',async()=>{
  const f=await fixture();f.state.graph.tasks.push({...f.task,id:'T2'});await f.save();
  let started=0;let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});let ready!:()=>void;const both=new Promise<void>(resolve=>{ready=resolve;});const signals:AbortSignal[]=[];
  const workers=(f.controller as unknown as {options:{workers:{run:Function}}}).options.workers;
  workers.run=async(request:AgentRequest,options:{signal:AbortSignal})=>{signals.push(options.signal);options.signal.addEventListener('abort',()=>{if(signals.every(s=>s.aborted))release();});if(++started===2)ready();await gate;return {task_id:request.task_id,status:'completed',summary:'done',files_changed:[],commands_run:[],findings:[],remaining_risks:[],suggested_tasks:[],blockers:[]};};
  const running=f.tick();await both;await f.controller.cancel('run');assert.ok(signals.every(s=>s.aborted));release();await running;
});

test('review findings preserve full description and evidence in repair context',async()=>{
  const f=await fixture();f.state.config.review.task_review_policy='always';await f.save();f.setWorker(async request=>({task_id:request.task_id,status:'completed',summary:'review summary',files_changed:[],commands_run:[],findings:request.role==='reviewer'?[{id:'F',severity:'P1',title:'boundary case',description:'the exact bug description',evidence:'feature.ts:42 failing path'}]:[],remaining_risks:[],suggested_tasks:[],blockers:[]}));
  const state=await f.tick();const fix=state.graph.tasks.find(t=>t.origin==='review_finding');assert.match(JSON.stringify(fix),/the exact bug description/);assert.match(JSON.stringify(fix),/feature.ts:42/);
});

test('blocked task failures cannot release another task human decision',async()=>{
  const f=await fixture();f.state.graph.tasks.push({...f.task,id:'T2'});await f.save();
  let blocked!:()=>void;const gate=new Promise<void>(resolve=>{blocked=resolve;});
  f.setWorker(async request=>{if(request.task_id==='T2')await gate;else blocked();return {task_id:request.task_id,status:request.task_id==='T1'?'blocked':'completed',summary:'decision pending',files_changed:[],commands_run:[],findings:[],remaining_risks:[],suggested_tasks:[],blockers:request.task_id==='T1'?[{decision_id:'D',type:'requirement',question:'choice',options:['A'],affected_task_ids:['T1']}]:[]};});
  f.setVerifier(async()=>false);const state=await f.tick();assert.equal(state.status,'WAITING_HUMAN');assert.deepEqual(state.pending_decision_ids,['D']);
});

test('task verification honors acceptance expected exit codes',async()=>{
  const f=await fixture();const condition=f.state.graph.acceptance![0]!;condition.verification={type:'command',command:'task-test',expected_exit_code:2};await f.save();
  const verifier=(f.controller as unknown as {options:{verifier:{run:Function}}}).options.verifier;
  verifier.run=async(request:VerificationRequest)=>({id:'E',run_id:'run',task_id:request.task_id,acceptance_ids:request.acceptance_ids,code_snapshot_id:request.code_snapshot_id,command:request.command,cwd:request.cwd,started_at:'now',finished_at:'now',exit_code:2,stdout_path:'',stderr_path:'',result:request.expected_exit_code===2?'passed':'failed'});
  assert.equal((await f.tick()).status,'COMPLETED');
});

test('completion rechecks the actual accepted content even after final verification was cached',async()=>{
  const f=await fixture();f.state.graph.tasks=[];f.state.integration_worktree=join(f.repo,'accepted');f.state.integration_snapshot_id='old';f.state.final_verification_snapshot_id='old';await f.save();f.setDigest('external-change');
  const result=await f.tick();assert.notEqual(result.status,'COMPLETED');assert.match(result.last_error??'',/snapshot|content/);
});

test('repair reuses outputs already produced by its failed implementation',async()=>{
  const f=await fixture();f.state.graph.tasks[0]!.required_outputs=['code','test'];await f.save();let calls=0;
  f.setWorker(async request=>({task_id:request.task_id,status:'completed',summary:'done',files_changed:request.task_id==='T1'?['src/feature.ts','tests/feature.test.ts']:['src/feature.ts'],commands_run:[],findings:[],remaining_risks:[],suggested_tasks:[],blockers:[]}));
  f.setVerifier(async()=>++calls>1);await f.tick();const repaired=await f.tick();assert.notEqual(repaired.status,'BLOCKED',repaired.last_error??'');
});

test('unmeasured worker usage is marked unknown in completion accounting',async()=>{
  const f=await fixture();f.setWorker(async request=>({task_id:request.task_id,status:'completed',summary:'done',files_changed:[],commands_run:[],findings:[],remaining_risks:[],suggested_tasks:[],blockers:[]}));
  const state=await f.tick();assert.equal(state.usage_incomplete,true);const certificate=JSON.parse(await readFile(join(f.store.getRunDirectory('run'),'completion.json'),'utf8'));assert.equal(certificate.usage_incomplete,true);
});


test('verification environment errors block without spending repair attempts',async()=>{
  const f=await fixture();f.setVerifier(async()=> 'error');const state=await f.tick();
  assert.equal(state.status,'BLOCKED');assert.equal(state.graph.tasks.length,1);assert.equal(state.graph.tasks[0]!.attempt,0);assert.match(state.last_error??'',/verification.*error/i);
});

test('baseline environment errors prevent worker dispatch',async()=>{
  const f=await fixture();f.state.config.verification.baseline=true;f.state.config.verification.commands.test=['baseline-test'];await f.save();f.setVerifier(async()=> 'error');
  const state=await f.controller.start('run');assert.equal(state.status,'BLOCKED');await f.tick();assert.equal(f.requests.length,0);assert.equal(state.baseline_verification_id,undefined);
});

test('cancelling task verification does not create repair tasks or overwrite cancellation',async()=>{
  const f=await fixture();let ready!:()=>void;const started=new Promise<void>(resolve=>{ready=resolve;});
  f.setVerifier(async request=>{ready();await new Promise<void>(resolve=>{request.signal!.addEventListener('abort',()=>resolve(),{once:true});});return 'error';});
  const running=f.tick();await started;await f.controller.cancel('run');const state=await running;assert.equal(state.status,'CANCELLED');assert.equal(state.graph.tasks.length,1);assert.equal(state.graph.tasks[0]!.attempt,0);
});

test('final verification environment errors block instead of producing arbitrary repairs',async()=>{
  const f=await fixture();f.setVerifier(async request=> request.task_id==='FINAL-VERIFICATION'?'error':true);const state=await f.tick();
  assert.equal(state.status,'BLOCKED');assert.equal(state.graph.tasks.length,1);assert.match(state.last_error??'',/verification.*error/i);
});

test('global final failures without an attributable task block instead of widening scope',async()=>{
  const f=await fixture();f.state.graph.tasks[0]!.scope_paths=['src/feature'];f.state.config.verification.commands.test=['global-check'];await f.save();f.setVerifier(async request=>request.command!=='global-check');const state=await f.tick();
  assert.equal(state.status,'BLOCKED');assert.equal(state.graph.tasks.length,1);assert.match(state.last_error??'',/repair target|attribut/i);
});


test('cancelled runs cannot be reactivated by a stale decision response',async()=>{
  const f=await fixture();f.state.status='WAITING_HUMAN';f.state.pending_decision_ids=['D'];f.state.pending_decision_tasks={D:['T1']};f.state.graph.tasks[0]!.status='INTERRUPTED';await f.save();
  await f.controller.cancel('run');const state=await f.controller.respond('run','D','yes');assert.equal(state.status,'CANCELLED');assert.equal(state.graph.tasks[0]!.status,'CANCELLED');
});

test('cancellation settles queued tasks and repeated cancellation remains safe',async()=>{
  const f=await fixture();f.state.graph.tasks[0]!.status='PENDING';await f.save();const state=await f.controller.cancel('run');assert.equal(state.graph.tasks[0]!.status,'CANCELLED');assert.equal((await f.controller.cancel('run')).status,'CANCELLED');
});


test('explicit resume after verification environment repair reruns the blocked task',async()=>{
  const f=await fixture();f.setVerifier(async()=> 'error');await f.tick();f.setVerifier(async()=>true);
  await f.controller.resume('run');const state=await f.tick();assert.equal(state.status,'COMPLETED');assert.equal(f.requests.length,2);assert.equal(f.seeds[1],join(f.repo,'T1'));
});


test('task-local attempt settings cannot exceed the configured run retry limit',async()=>{
  const f=await fixture();f.state.graph.tasks[0]!.max_attempts=100;f.state.config.runtime.max_task_attempts=1;await f.save();
  f.setWorker(async request=>({task_id:request.task_id,status:'failed',summary:'failed once',files_changed:[],commands_run:[],findings:[],remaining_risks:[],suggested_tasks:[],blockers:[],token_usage:1}));
  const state=await f.tick();assert.equal(state.status,'BLOCKED');assert.equal(state.graph.tasks[0]!.attempt,1);
});

test('final acceptance repair chains respect the original task retry budget',async()=>{
  const f=await fixture();f.state.config.runtime.max_task_attempts=2;await f.save();
  f.setVerifier(async request=> request.task_id!=='FINAL-VERIFICATION');
  const first=await f.tick();assert.equal(first.status,'RUNNING');const second=await f.tick();assert.equal(second.status,'BLOCKED');assert.equal(second.graph.tasks.filter(task=>task.origin!=='initial_plan').length,1);
});
