import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { ProviderConfig } from '../server/personal/provider-config.ts'

test('persists private overrides, masks keys, and falls back field by field after clearing', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'banana-provider-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const dataFile = path.join(root, 'gallery-data.json')
  const env = {
    GEMINI_API_KEY: 'env-google-key',
    GOOGLE_CLOUD_LOCATION: 'us-central1',
    OPENAI_IMAGE_API_KEY: 'env-openai-key',
    OPENAI_IMAGE_BASE_URL: 'https://env.example.test/v1',
    OPENAI_IMAGE_MODEL: 'env-image',
  }
  const config = new ProviderConfig(dataFile, env)
  config.update({
    google: { apiKey: 'ui-google-abcd', location: 'global' },
    openaiCompatible: { apiKey: 'abc', model: 'ui-image' },
  })
  const reopened = new ProviderConfig(dataFile, env)
  assert.equal(reopened.status().google.apiKeyMasked, '...abcd')
  assert.equal(reopened.status().openaiCompatible.apiKeyMasked, '...')
  assert.equal(reopened.status().openaiCompatible.baseUrl, env.OPENAI_IMAGE_BASE_URL)
  assert.equal(reopened.status().openaiCompatible.source, 'ui')
  assert.equal(reopened.resolve().google?.mode, 'apiKey')
  assert.equal(reopened.resolve().openai.openaiImageApiKey, 'abc')
  assert.equal(fs.existsSync(dataFile), false)
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(root, '.provider-config.json')).mode & 0o777, 0o600)
  reopened.update({ google: { apiKey: '', location: ' ' }, openaiCompatible: { apiKey: '' } })
  assert.equal(reopened.status().google.apiKeySource, 'ui')
  assert.throws(() => reopened.update({ openaiCompatible: { baseUrl: 'https://user:secret@env.example.test' } }), /Base URL/)
  reopened.update({ google: { apiKey: null, location: null }, openaiCompatible: { apiKey: null, model: null } })
  assert.equal(reopened.status().google.apiKeySource, 'env')
  assert.equal(reopened.status().google.location, 'us-central1')
  assert.equal(reopened.status().openaiCompatible.source, 'env')
  assert.equal(reopened.status().openaiCompatible.model, 'env-image')
})

test('validates uploads, uses Vertex first and restores the environment service account after clearing', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'banana-vertex-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const envFile = path.join(root, 'env-account.json')
  const account = { type: 'service_account', project_id: 'env-project', client_email: 'env@example.test', private_key: 'fixture-env-private-key' }
  fs.writeFileSync(envFile, JSON.stringify(account))
  const config = new ProviderConfig(path.join(root, 'gallery-data.json'), {
    GOOGLE_APPLICATION_CREDENTIALS: envFile, GOOGLE_CLOUD_PROJECT: 'env-override', GEMINI_API_KEY: 'fixture-api-key',
  })
  const file = path.join(root, '.vertex-service-account.json')
  assert.throws(() => config.upload({ ...account, type: 'external_account' }), /service_account/)
  assert.throws(() => config.upload({ ...account, private_key: ' ' }), /private_key/)
  assert.equal(fs.existsSync(file), false)
  config.upload({ ...account, project_id: 'ui-project', private_key: 'fixture-ui-private-key' })
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600)
  assert.equal(config.status().google.activeMode, 'vertex')
  assert.equal(config.status().google.projectId, 'ui-project')
  assert.ok(!JSON.stringify(config.status()).includes('fixture-ui-private-key'))
  assert.equal(config.resolve().credentials?.private_key, 'fixture-ui-private-key')
  config.update({ google: { clearServiceAccount: true } })
  assert.equal(fs.existsSync(file), false)
  assert.equal(config.status().google.serviceAccountSource, 'env')
  assert.equal(config.status().google.projectId, 'env-override')
  assert.equal(config.status().google.clientEmail, account.client_email)
})
