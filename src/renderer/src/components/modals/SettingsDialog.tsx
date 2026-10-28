import { useEffect, useState, type JSX } from 'react'
import { Modal, Row, Section, Toggle } from '@/components/ui/controls'
import { useUi } from '@/store/ui'
import {
  KIND_LABELS, MOCK_KEY, higgsfield, ipcErrorMessage, isValidEndpoint, loadCustomModels, parseRawParams, saveCustomModels,
  type HfCustomModel, type HfKind
} from '@/lib/higgsfield'
import { uid } from '@/lib/ids'
import './SettingsDialog.css'

const KEYS_URL = 'https://console.higgsfield.ai'
const KEY_ID = 'higgsfield.keyId'
const KEY_SECRET = 'higgsfield.keySecret'
const CUSTOM_KINDS: HfKind[] = ['text-to-video', 'image-to-video', 'text-to-image', 'audio']

type TestState = { state: 'idle' } | { state: 'testing' } | { state: 'ok' | 'error'; message: string }

// App settings incl. Higgsfield API credentials.
export function SettingsDialog(props: { onClose(): void }): JSX.Element {
  const [loaded, setLoaded] = useState(false)
  const [keyId, setKeyId] = useState('')
  const [keySecret, setKeySecret] = useState('')
  const [showSecret, setShowSecret] = useState(false)
  const [mock, setMock] = useState(false)
  const [envMock, setEnvMock] = useState(false)
  const [custom, setCustom] = useState<HfCustomModel[]>([])
  const [mediaDir, setMediaDir] = useState('')
  const [test, setTest] = useState<TestState>({ state: 'idle' })
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    const s = window.cineply.settings
    Promise.all([
      s.getSecret(KEY_ID), s.getSecret(KEY_SECRET), s.get<boolean>(MOCK_KEY), loadCustomModels(),
      window.cineply.paths.mediaDir(), higgsfield.status().catch(() => null)
    ]).then(([id, secret, mockSetting, models, dir, status]) => {
      setKeyId(id ?? '')
      setKeySecret(secret ?? '')
      setMock(mockSetting === true)
      setEnvMock(!!status?.mock && mockSetting !== true)
      setCustom(models)
      setMediaDir(dir)
      setLoaded(true)
    }).catch((e) => {
      useUi.getState().showToast(`Couldn’t load settings: ${ipcErrorMessage(e)}`, 'error')
      setLoaded(true)
    })
  }, [])

  useEffect(() => setTest({ state: 'idle' }), [keyId, keySecret])

  const customErrors = custom.map((c) => {
    if (!c.endpoint.trim()) return 'Enter an endpoint ID.'
    if (!isValidEndpoint(c.endpoint)) return 'Endpoint IDs look like vendor/model/variant, without https:// or spaces.'
    const parsed = parseRawParams(c.params)
    return 'error' in parsed ? parsed.error : null
  })

  const testConnection = async (): Promise<void> => {
    if (!keyId.trim() || !keySecret.trim()) {
      setTest({ state: 'error', message: 'Enter both the key ID and the secret.' })
      return
    }
    setTest({ state: 'testing' })
    try {
      const r = await higgsfield.testCredentials({ keyId: keyId.trim(), keySecret: keySecret.trim() })
      setTest({ state: r.ok ? 'ok' : 'error', message: r.message })
    } catch (e) {
      setTest({ state: 'error', message: ipcErrorMessage(e) })
    }
  }

  const save = async (): Promise<void> => {
    if (customErrors.some(Boolean)) {
      useUi.getState().showToast('Fix the custom model errors before saving.', 'error')
      return
    }
    setSaving(true)
    try {
      const s = window.cineply.settings
      await s.setSecret(KEY_ID, keyId.trim())
      await s.setSecret(KEY_SECRET, keySecret.trim())
      await s.set(MOCK_KEY, mock)
      await saveCustomModels(custom.map((c) => ({ ...c, endpoint: c.endpoint.trim(), label: c.label.trim() })))
      useUi.getState().showToast('Settings saved')
      props.onClose()
    } catch (e) {
      useUi.getState().showToast(`Couldn’t save settings: ${ipcErrorMessage(e)}`, 'error')
    } finally {
      setSaving(false)
    }
  }

  const updateCustom = (id: string, patch: Partial<HfCustomModel>): void =>
    setCustom(custom.map((c) => (c.id === id ? { ...c, ...patch } : c)))

  const addCustom = (): void =>
    setCustom([...custom, { id: uid(), label: '', kind: 'text-to-video', endpoint: '', params: '{\n  "duration": 5\n}' }])

  return (
    <Modal
      title="Settings"
      width={600}
      onClose={props.onClose}
      footer={
        <>
          <button className="btn" onClick={props.onClose}>Cancel</button>
          <button className="btn primary" disabled={!loaded || saving} onClick={() => void save()}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </>
      }
    >
      <div className="settings">
        <Section title="Higgsfield AI">
          <div className="settings-hint">
            Cineply Cut uses your own Higgsfield API key for AI video, images and soundtracks. Generations are billed
            to your Higgsfield account. Keys are encrypted on this computer and never saved in project files.
          </div>
          <Row label="Key ID">
            <input
              className="input grow mono"
              value={keyId}
              placeholder={loaded ? 'Paste your API key ID' : 'Loading…'}
              spellCheck={false}
              autoComplete="off"
              onChange={(e) => setKeyId(e.target.value)}
            />
          </Row>
          <Row label="Secret">
            <input
              className="input grow mono"
              type={showSecret ? 'text' : 'password'}
              value={keySecret}
              placeholder={loaded ? 'Paste your API key secret' : 'Loading…'}
              spellCheck={false}
              autoComplete="off"
              onChange={(e) => setKeySecret(e.target.value)}
            />
            <button className="btn ghost small" onClick={() => setShowSecret(!showSecret)}>{showSecret ? 'Hide' : 'Show'}</button>
          </Row>
          <div className="settings-actions">
            <button className="btn" disabled={test.state === 'testing'} onClick={() => void testConnection()}>
              {test.state === 'testing' ? 'Testing…' : 'Test connection'}
            </button>
            <button className="btn ghost" onClick={() => void window.cineply.shell.openExternal(KEYS_URL)}>Get API keys ↗</button>
            {(keyId || keySecret) && (
              <button className="btn ghost danger" onClick={() => { setKeyId(''); setKeySecret('') }}>Remove key</button>
            )}
          </div>
          {(test.state === 'ok' || test.state === 'error') && (
            <div className={`settings-status ${test.state}`}>{test.state === 'ok' ? '✓ ' : ''}{test.message}</div>
          )}
          <Row label="Mock mode" title="Fake generations made locally, for trying the flow without a key">
            <Toggle value={mock || envMock} onChange={setMock} label="Simulate Higgsfield locally (free, no network)" />
          </Row>
          {envMock && <div className="settings-hint">Mock mode is forced on by the CINEPLY_HF_MOCK=1 environment variable.</div>}
        </Section>

        <Section
          title="Custom Higgsfield models"
          defaultOpen={custom.length > 0}
          right={<button className="btn ghost small" onClick={addCustom}>+ Add</button>}
        >
          <div className="settings-hint">
            Model availability varies by account. Add any endpoint ID from docs.higgsfield.ai with its request
            params as JSON; the prompt (and the input image for Image → Video) is added automatically.
          </div>
          {custom.length === 0 && <div className="muted">No custom models yet.</div>}
          {custom.map((c, i) => (
            <div key={c.id} className="settings-custom">
              <div className="settings-custom-row">
                <input className="input" style={{ flex: 1 }} placeholder="Name" value={c.label} onChange={(e) => updateCustom(c.id, { label: e.target.value })} />
                <select className="select" value={c.kind} onChange={(e) => updateCustom(c.id, { kind: e.target.value as HfKind })}>
                  {CUSTOM_KINDS.map((k) => <option key={k} value={k}>{KIND_LABELS[k]}</option>)}
                </select>
                <button className="btn ghost icon" title="Remove" onClick={() => setCustom(custom.filter((x) => x.id !== c.id))}>✕</button>
              </div>
              <input
                className="input mono"
                placeholder="Endpoint ID, e.g. kling-video/v3.0/pro/text-to-video"
                spellCheck={false}
                value={c.endpoint}
                onChange={(e) => updateCustom(c.id, { endpoint: e.target.value })}
              />
              <textarea
                className="textarea mono"
                rows={3}
                spellCheck={false}
                value={c.params}
                onChange={(e) => updateCustom(c.id, { params: e.target.value })}
              />
              {c.kind === 'audio' && (
                <div className="settings-hint">Soundtrack models must return a video with sound; include the model’s sound switch in the params.</div>
              )}
              {customErrors[i] && <div className="settings-status error">{customErrors[i]}</div>}
            </div>
          ))}
        </Section>

        <Section title="General">
          <Row label="Media folder" title="Generated media (AI results, voiceovers, processed audio) is saved here">
            <input className="input grow mono" readOnly value={mediaDir} />
            <button className="btn small" disabled={!mediaDir} onClick={() => void window.cineply.shell.openPath(mediaDir)}>Open folder</button>
          </Row>
        </Section>
      </div>
    </Modal>
  )
}
