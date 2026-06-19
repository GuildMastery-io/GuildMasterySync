import { useState, useEffect, useRef, useCallback } from 'react'
import {
  Box, Group, Stack, Text, Title, Card, TextInput, PasswordInput,
  Switch, Badge, Button, Divider, ThemeIcon, Tooltip, ActionIcon,
} from '@mantine/core'
import {
  IconRefresh, IconFolder, IconCheck, IconAlertTriangle,
  IconCloudUpload, IconSettings, IconLink, IconPlugConnected,
  IconWifi, IconKey, IconClock,
} from '@tabler/icons-react'

// ── Types ──────────────────────────────────────────────────────────

interface SyncStatus {
  status: 'watching' | 'syncing' | 'success' | 'duplicate' | 'error' | 'waiting'
  message: string
  time?: string
  sessionCount?: number | string
  exportTimestamp?: string
  duplicate?: boolean
}

interface AppSettings {
  wowPath: string
  apiUrl: string
  autoStart: boolean
  apiKey: string
  lastSync: string
}

const SAVE_DEBOUNCE_MS = 600

// ── App ────────────────────────────────────────────────────────────

export default function App() {
  const [settings, setSettings] = useState<AppSettings>({
    wowPath: '',
    apiUrl: 'https://guildmastery.io',
    autoStart: false,
    apiKey: '',
    lastSync: '',
  })

  const [syncStatus, setSyncStatus] = useState<SyncStatus>({
    status: 'waiting',
    message: 'Initializing…',
  })

  const [saveSuccess, setSaveSuccess] = useState(false)

  interface StatusEntry { ok: boolean | null; message: string }
  const [serverStatus, setServerStatus] = useState<StatusEntry>({ ok: null, message: '' })
  const [apiKeyStatus, setApiKeyStatus] = useState<StatusEntry>({ ok: null, message: '' })
  const [checking, setChecking] = useState(false)
  const [logs, setLogs] = useState<string[]>([])
  const logsEndRef = useRef<HTMLDivElement>(null)

  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const checkTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // ── Connection check (debounced) ────────────────────────────────
  const scheduleCheck = useCallback((s: AppSettings) => {
    if (checkTimerRef.current) clearTimeout(checkTimerRef.current)
    setChecking(true)
    checkTimerRef.current = setTimeout(async () => {
      if (!s.apiUrl) {
        setServerStatus({ ok: false, message: 'No URL provided' })
        setApiKeyStatus({ ok: null, message: '' })
        setChecking(false)
        return
      }
      const result = await window.api.testConnection({ apiUrl: s.apiUrl, apiKey: s.apiKey })
      setServerStatus(result.server)
      setApiKeyStatus(result.apiKey)
      setChecking(false)
    }, 800)
  }, [])

  // ── Persist settings (debounced) ────────────────────────────────
  const scheduleSave = useCallback((next: AppSettings) => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    saveTimerRef.current = setTimeout(async () => {
      await window.api.saveSettings(next)
      setSaveSuccess(true)
      setTimeout(() => setSaveSuccess(false), 2000)
    }, SAVE_DEBOUNCE_MS)
  }, [])

  /** Update local state + schedule persistence + schedule connection check. */
  const update = useCallback((next: AppSettings, opts?: { immediate?: boolean }) => {
    setSettings(next)
    if (opts?.immediate) {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
      void window.api.saveSettings(next).then(() => {
        setSaveSuccess(true)
        setTimeout(() => setSaveSuccess(false), 2000)
      })
    } else {
      scheduleSave(next)
    }
    scheduleCheck(next)
  }, [scheduleSave, scheduleCheck])

  // ── Bootstrap ───────────────────────────────────────────────────
  useEffect(() => {
    window.api.getSettings().then(s => {
      setSettings(s)
      scheduleCheck(s)
    })

    const offSync = window.api.onSyncStatus((data) => {
      setSyncStatus(data)
      if ((data.status === 'success' || data.status === 'duplicate') && data.time) {
        setSettings(prev => ({ ...prev, lastSync: data.time! }))
      }
    })
    const offLog = window.api.onLog((msg) => {
      setLogs(prev => {
        const next = [...prev, msg]
        return next.length > 200 ? next.slice(-200) : next
      })
    })
    return () => {
      offSync()
      offLog()
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
      if (checkTimerRef.current) clearTimeout(checkTimerRef.current)
    }
  }, [scheduleCheck])

  // Auto-scroll log panel
  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [logs])

  const pickWowPath = async () => {
    const p = await window.api.selectWowPath()
    if (p) update({ ...settings, wowPath: p }, { immediate: true })
  }

  // helpers
  const configured = Boolean(settings.wowPath && serverStatus.ok === true && apiKeyStatus.ok === true)
  const syncing    = syncStatus.status === 'syncing'

  const statusColor =
    syncStatus.status === 'success'   ? 'teal'   :
    syncStatus.status === 'duplicate' ? 'orange' :
    syncStatus.status === 'error'     ? 'red'    :
    syncStatus.status === 'syncing'   ? 'yellow' :
    syncStatus.status === 'watching'  ? 'blue'   : 'gray'

  // ── Render ──────────────────────────────────────────────────────

  return (
    <Box h="100vh" bg="#1a1b1e" style={{ display: 'flex', flexDirection: 'column' }}>

      {/* ═══ TOP BAR ═══ */}
      <Box
        className="app-drag"
        px="lg"
        bg="#141517"
        style={{ borderBottom: '1px solid #2c2e33', flexShrink: 0, height: 44, display: 'flex', alignItems: 'center' }}
      >
        <Group justify="space-between" align="center" w="100%">
          <Group gap="sm">
            <img
              src="/logo.png"
              alt=""
              style={{ height: 24, width: 24, objectFit: 'contain' }}
              onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }}
            />
            <Title order={5} c="white" fw={600} style={{ letterSpacing: '.5px' }}>
              GuildMastery Sync
            </Title>
          </Group>

          <Group gap="md" className="app-no-drag">
            <Group gap={6}>
              <Text size="xs" c="dimmed">Auto‑start</Text>
              <Switch
                size="sm"
                color="teal"
                checked={settings.autoStart}
                onChange={() => update({ ...settings, autoStart: !settings.autoStart }, { immediate: true })}
              />
            </Group>
            {/* space for native window buttons (minimize/maximize/close) */}
            <Box w={120} />
          </Group>
        </Group>
      </Box>

      {/* ═══ CONTENT ═══ */}
      <Box p="lg" style={{ flex: 1, overflowY: 'auto' }}>

        {/* saved toast */}
        {saveSuccess && (
          <Badge color="teal" variant="light" size="lg"
            style={{ position: 'fixed', top: 56, right: 20, zIndex: 99 }}>
            ✓ Saved
          </Badge>
        )}

        {/* ─── Status Banner ─── */}
        <Card bg="#25262b" radius="md" p="md" mb="lg"
          style={{ border: '1px solid #2c2e33' }}>
          <Group justify="space-between" align="center">
            <div>
              <Title order={4} c="white">GuildMastery Companion</Title>
              <Text size="sm" c="dimmed" mt={4}>Automatic sync of your RCLootCouncil data</Text>
            </div>
            <Badge
              size="lg"
              color={
                checking                  ? 'yellow' :
                configured                ? 'teal'   :
                serverStatus.ok === false ? 'orange' :
                apiKeyStatus.ok === false ? 'red'    :
                apiKeyStatus.ok === null  ? 'yellow' : 'gray'
              }
              variant="light"
              leftSection={
                checking                  ? <IconClock size={14} />        :
                configured                ? <IconCheck size={14} />        :
                serverStatus.ok === false ? <IconWifi size={14} />         :
                apiKeyStatus.ok === false ? <IconKey size={14} />          :
                                            <IconAlertTriangle size={14} />
              }
            >
              {checking
                ? 'Checking…'
                : configured
                  ? 'Active'
                  : serverStatus.ok === false
                    ? 'Server unreachable'
                    : apiKeyStatus.ok === false
                      ? 'Invalid API key'
                      : apiKeyStatus.ok === null && serverStatus.ok === true
                        ? 'Key not verifiable'
                        : 'Configuration required'}
            </Badge>
          </Group>
        </Card>

        {/* ─── Two‑column grid ─── */}
        <Box style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>

          {/* LEFT – Sync Status */}
          <Card bg="#25262b" radius="md" p={0}
            style={{ border: '1px solid #2c2e33', display: 'flex', flexDirection: 'column' }}>
            <Box px="md" py="sm" bg="#1f2024"
              style={{ borderBottom: '1px solid #2c2e33' }}>
              <Group justify="space-between">
                <Group gap={8}>
                  <ThemeIcon variant="light" color={statusColor} size="sm" radius="xl">
                    <IconCloudUpload size={14} />
                  </ThemeIcon>
                  <Text fw={600} size="sm" c="white">RCLootCouncil Integration</Text>
                </Group>
                <Badge size="sm" color={statusColor} variant="dot">
                  {syncStatus.status === 'success'   ? 'Synced' :
                   syncStatus.status === 'duplicate' ? 'Duplicate' :
                   syncStatus.status === 'error'     ? 'Error' :
                   syncing ? 'Syncing…' : 'Idle'}
                </Badge>
              </Group>
            </Box>

            <Stack p="md" gap="md" style={{ flex: 1 }}>

              {/* Loot history card */}
              <Card bg="#1a1b1e" radius="sm" p="sm"
                style={{ border: '1px solid #2c2e33' }}>
                <Group justify="space-between" mb={6}>
                  <Text size="sm" c="white" fw={500}>Loot & vote sync</Text>
                  <Tooltip label="Re-run sync">
                    <ActionIcon
                      variant="subtle"
                      color="gray"
                      size="sm"
                      onClick={() => {
                        setSyncStatus({ status: 'syncing', message: 'Manual sync…' })
                        void window.api.forceSync()
                      }}
                      disabled={!configured || syncing}
                    >
                      <IconRefresh size={14} className={syncing ? 'spin' : ''} />
                    </ActionIcon>
                  </Tooltip>
                </Group>
                <Text size="xs" c="dimmed" lh={1.6}>
                  {configured
                    ? 'The app is watching your WoW folder. Do a /reload in game to trigger a sync.'
                    : 'Configure your WoW folder and API key in the right panel to get started.'}
                </Text>
                <Divider my="xs" color="#2c2e33" />
                <Group gap={4}>
                  <Text size="xs" c="dimmed">Last sync:</Text>
                  <Text size="xs" c={settings.lastSync ? 'teal' : 'dimmed'} fw={500}>
                    {settings.lastSync || 'None'}
                  </Text>
                </Group>
                {(syncStatus.status === 'success' || syncStatus.status === 'duplicate') && (
                  <Group gap={4} mt={2}>
                    {syncStatus.sessionCount !== undefined && (
                      <Text size="xs" c="dimmed">
                        {syncStatus.sessionCount} vote(s)
                        {syncStatus.status === 'duplicate' && (
                          <Text span c="orange"> · already known by the server</Text>
                        )}
                      </Text>
                    )}
                    {syncStatus.exportTimestamp && (
                      <Text size="xs" c="dimmed" style={{ marginLeft: 'auto' }}>
                        export: {new Date(syncStatus.exportTimestamp).toLocaleString()}
                      </Text>
                    )}
                  </Group>
                )}
                {syncStatus.status === 'error' && (
                  <Text size="xs" c="red" mt={4}>{syncStatus.message}</Text>
                )}
              </Card>

              {/* Connection check card */}
              <Card bg="#1a1b1e" radius="sm" p="sm"
                style={{ border: '1px solid #2c2e33' }}>
                <Group justify="space-between" mb={8}>
                  <Text size="sm" c="white" fw={500}>Server Connection</Text>
                  <ThemeIcon variant="light" size="sm" radius="xl"
                    color={configured ? 'teal' : 'gray'}>
                    <IconPlugConnected size={14} />
                  </ThemeIcon>
                </Group>

                <Group gap={6} mb={4}>
                  <ThemeIcon variant="subtle" size={16} radius="xl"
                    color={checking ? 'yellow' : serverStatus.ok === true ? 'teal' : serverStatus.ok === false ? 'orange' : 'gray'}>
                    {checking ? <IconClock size={11} /> : serverStatus.ok === true ? <IconCheck size={11} /> : serverStatus.ok === false ? <IconWifi size={11} /> : <IconClock size={11} />}
                  </ThemeIcon>
                  <Text size="xs" c="dimmed" style={{ flex: 1 }}>
                    Server:{' '}
                    <Text span ff="monospace" size="xs" c="white">{settings.apiUrl || '—'}</Text>
                  </Text>
                </Group>
                {!checking && serverStatus.ok === false && (
                  <Text size="xs" c="orange" ml={22} mb={4}>{serverStatus.message}</Text>
                )}

                <Group gap={6} mb={4} align="flex-start">
                  <ThemeIcon variant="subtle" size={16} radius="xl"
                    color={
                      checking                                        ? 'gray'   :
                      apiKeyStatus.ok === true                        ? 'teal'   :
                      apiKeyStatus.ok === false                       ? 'red'    :
                      apiKeyStatus.ok === null && serverStatus.ok     ? 'yellow' : 'gray'
                    }>
                    {apiKeyStatus.ok === true ? <IconCheck size={11} /> : <IconKey size={11} />}
                  </ThemeIcon>
                  <div>
                    <Text size="xs" c="dimmed">API Key</Text>
                    {!checking && apiKeyStatus.message && (
                      <Text size="xs"
                        c={
                          apiKeyStatus.ok === true  ? 'teal'   :
                          apiKeyStatus.ok === false ? 'red'    :
                          apiKeyStatus.ok === null && serverStatus.ok ? 'yellow' : 'dimmed'
                        }>
                        {apiKeyStatus.message}
                      </Text>
                    )}
                  </div>
                </Group>
              </Card>
            </Stack>
          </Card>

          {/* RIGHT – Configuration */}
          <Card bg="#25262b" radius="md" p={0}
            style={{ border: '1px solid #2c2e33', display: 'flex', flexDirection: 'column' }}>
            <Box px="md" py="sm" bg="#1f2024"
              style={{ borderBottom: '1px solid #2c2e33' }}>
              <Group gap={8}>
                <ThemeIcon variant="light" color="gray" size="sm" radius="xl">
                  <IconSettings size={14} />
                </ThemeIcon>
                <Text fw={600} size="sm" c="white">Configuration</Text>
              </Group>
            </Box>

            <Stack p="md" gap="md" style={{ flex: 1 }} className="app-no-drag">

              {!configured && (
                <Card bg="rgba(34, 139, 230, .08)" radius="sm" p="sm"
                  style={{ border: '1px solid rgba(34,139,230,.2)' }}>
                  <Text size="xs" c="blue.4" lh={1.6}>
                    Enter your World of Warcraft folder and API key to get started.
                  </Text>
                </Card>
              )}

              {/* WoW Folder */}
              <div>
                <Text size="xs" fw={500} c="dimmed" mb={6}>World of Warcraft folder</Text>
                <Button
                  variant="default"
                  fullWidth
                  justify="space-between"
                  leftSection={<IconFolder size={16} />}
                  onClick={pickWowPath}
                  styles={{
                    root: { backgroundColor: '#1a1b1e', border: '1px solid #2c2e33', height: 40 },
                    label: { fontFamily: 'monospace', fontSize: 12, color: settings.wowPath ? '#c1c2c5' : '#5c5f66' },
                    inner: { justifyContent: 'flex-start' },
                  }}
                >
                  {settings.wowPath || 'Not configured – Browse…'}
                </Button>
                {settings.wowPath && (
                  <Group gap={4} mt={4}>
                    <IconCheck size={12} color="#40c057" />
                    <Text size="xs" c="teal">Folder detected</Text>
                  </Group>
                )}
              </div>

              {/* API Key */}
              <PasswordInput
                label="API Key"
                placeholder="gm_live_••••••••••••••••••••••••"
                value={settings.apiKey}
                onChange={e => update({ ...settings, apiKey: e.currentTarget.value })}
                styles={{
                  input: { backgroundColor: '#1a1b1e', border: '1px solid #2c2e33', fontFamily: 'monospace', fontSize: 12 },
                  label: { fontSize: 12, fontWeight: 500, color: '#909296', marginBottom: 6 },
                }}
              />

              <Divider color="#2c2e33" />

              {/* API Endpoint */}
              <TextInput
                label="API Endpoint"
                description="e.g. https://guildmastery.io"
                placeholder="https://guildmastery.io"
                value={settings.apiUrl}
                onChange={e => update({ ...settings, apiUrl: e.currentTarget.value })}
                leftSection={<IconLink size={14} />}
                styles={{
                  input: { backgroundColor: '#1a1b1e', border: '1px solid #2c2e33', fontSize: 12 },
                  label: { fontSize: 12, fontWeight: 500, color: '#909296', marginBottom: 4 },
                  description: { fontSize: 11 },
                }}
              />
            </Stack>
          </Card>

        </Box>

        {/* ─── Log Panel ─── */}
        <Box mt="md">
          <Group justify="space-between" mb={4}>
            <Text size="xs" fw={500} c="dimmed">Sync logs</Text>
            <Text
              size="xs" c="dimmed"
              style={{ cursor: 'pointer', textDecoration: 'underline' }}
              onClick={() => setLogs([])}
            >
              Clear
            </Text>
          </Group>
          <Box
            style={{
              backgroundColor: '#0d0e0f',
              border: '1px solid #2c2e33',
              borderRadius: 6,
              padding: '8px 10px',
              height: 130,
              overflowY: 'auto',
              fontFamily: 'monospace',
              fontSize: 11,
              userSelect: 'text',
              cursor: 'text',
            }}
          >
            {logs.length === 0
              ? <Text size="xs" c="dimmed" ff="monospace">Waiting for logs…</Text>
              : logs.map((line, i) => (
                <div key={i} style={{
                  color: line.includes('❌') ? '#ff6b6b'
                       : line.includes('✅') ? '#69db7c'
                       : line.includes('⚠️') ? '#ffa94d'
                       : line.includes('Server response') ? '#74c0fc'
                       : '#909296',
                  lineHeight: 1.5,
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-all',
                }}>{line}</div>
              ))
            }
            <div ref={logsEndRef} />
          </Box>
        </Box>

      </Box>
    </Box>
  )
}
