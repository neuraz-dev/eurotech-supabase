import assert from 'node:assert/strict'
import { test } from 'node:test'
import { jumpPage, paginationItems } from '../src/lib/pagination.ts'

test('pagination always includes endpoints and two neighbors with clickable gap identities', () => {
  assert.deepEqual(paginationItems(1,31),[1,2,3,'gap-after',31])
  assert.deepEqual(paginationItems(4,31),[1,2,3,4,5,6,'gap-after',31])
  assert.deepEqual(paginationItems(13,31),[1,'gap-before',11,12,13,14,15,'gap-after',31])
  assert.deepEqual(paginationItems(28,31),[1,'gap-before',26,27,28,29,30,31])
  assert.deepEqual(paginationItems(31,31),[1,'gap-before',29,30,31])
})
test('small lists and empty results have no duplicate endpoints or unnecessary gaps', () => {
  assert.deepEqual(paginationItems(1,0),[1])
  assert.deepEqual(paginationItems(1,1),[1])
  assert.deepEqual(paginationItems(2,3),[1,2,3])
  assert.deepEqual(paginationItems(99,3),[1,2,3])
})
test('jump input accepts only existing integer pages', () => {
  for(const input of ['','0','32','-1','1.5','abc','1e1','Infinity']) assert.equal(jumpPage(input,31),null)
  assert.equal(jumpPage('13',31),13)
  assert.equal(jumpPage(' 31 ',31),31)
})
