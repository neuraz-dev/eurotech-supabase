import assert from 'node:assert/strict'
import {test} from 'node:test'
import {syncIsActive,syncMessage,type ManualSyncRun,startManualSync} from '../src/lib/manual-sync.ts'
const run=(status:ManualSyncRun['status'])=>({id:'run',status} as ManualSyncRun)
test('no completion message until every persisted task is terminal',()=>{
  for(const state of ['queued','running'] as const){assert.equal(syncIsActive(run(state)),true);assert.equal(syncMessage(run(state)),'Actualizando…')}
  assert.equal(syncMessage(run('completed')),'Actualización finalizada')
  assert.equal(syncMessage(run('partial')),'Actualizados con algunos fallos')
  assert.equal(syncMessage(run('warnings')),'Actualización finalizada con advertencias')
  assert.equal(syncMessage(run('failed')),'No se pudo completar la actualización')
})
test('manual initiation returns a persisted run rather than a successful first page',async()=>{
  const original=globalThis.fetch
  try{
    globalThis.fetch=async(input,init)=>{
      assert.equal(input,'/api/manual-sync')
      const request=JSON.parse(String(init?.body))
      assert.equal(request.action,'all');assert.equal(request.requestKey,'same-request')
      return Response.json({accepted:true,run:run('queued')},{status:202})
    }
    assert.equal((await startManualSync('all','productos',undefined,'same-request')).status,'queued')
    globalThis.fetch=async()=>Response.json({error:'No se pudo guardar'},{status:503})
    await assert.rejects(()=>startManualSync('all','productos'),/No se pudo guardar/)
  }finally{globalThis.fetch=original}
})
