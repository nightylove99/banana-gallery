import assert from 'node:assert/strict'
import test from 'node:test'
import { analyzeChangedFiles, countActiveGenerationTasks } from '../scripts/update.mjs'

test('countActiveGenerationTasks detects active queued/running items in array or paginated shape', () => {
  assert.equal(countActiveGenerationTasks([
    { id: '1', status: 'succeeded' },
    { id: '2', status: 'queued' },
    { id: '3', status: 'running' },
    { id: '4', status: 'failed' },
  ]), 2)

  assert.equal(countActiveGenerationTasks({
    items: [
      { id: 'a', status: 'completed' },
      { id: 'b', status: 'processing' },
    ],
  }), 1)

  assert.equal(countActiveGenerationTasks({ items: [{ id: 'c', status: 'failed' }] }), 0)
  assert.equal(countActiveGenerationTasks(null), 0)
})

test('countActiveGenerationTasks reads the local generation queue response', () => {
  assert.equal(countActiveGenerationTasks({
    tasks: [
      { status: 'queued' },
      { status: 'running' },
      { status: 'completed' },
    ],
    error: null,
    canPurge: true,
  }), 2)
})

test('analyzeChangedFiles detects dependency, skill, and env example changes', () => {
  assert.deepEqual(analyzeChangedFiles(['src/App.tsx', 'README.md']), {
    needsInstall: false,
    skillChanged: false,
    envExampleChanged: false,
  })

  assert.deepEqual(analyzeChangedFiles([
    'package-lock.json',
    'skills\\banana-gallery\\SKILL.md',
    '.env.example',
  ]), {
    needsInstall: true,
    skillChanged: true,
    envExampleChanged: true,
  })
})
