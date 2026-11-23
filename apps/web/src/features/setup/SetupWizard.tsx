'use client'

import {
  type DatabaseConfig,
  type DatabaseEngine,
  type DatabaseValidationResult,
  MEOFAST_VERSION,
  type SetupStatusResponse,
  type SslMode,
  setupAdminSchema,
  setupAppConfigSchema,
} from '@meofast/shared'
import { useRouter } from 'next/navigation'
import { useEffect, useMemo, useState } from 'react'
import {
  Badge,
  Button,
  Card,
  Icon,
  Input,
  MeofastLogo,
  Select,
  Spinner,
} from '@/components/ui'
import { ApiClientError, apiRequest, setActiveCsrfToken } from '@/lib/api-client'
import { useTheme } from '@/providers/ThemeProvider'
import { cn } from '@/utils/cn'

const WIZARD_STEPS = [
  { step: 1, title: 'Welcome', summary: 'Get started' },
  { step: 2, title: 'Database', summary: 'Select database' },
  { step: 3, title: 'Connection', summary: 'Test connection' },
  { step: 4, title: 'Administrator', summary: 'Create admin' },
  { step: 5, title: 'Application', summary: 'General settings' },
  { step: 6, title: 'Install', summary: 'Run setup' },
  { step: 7, title: 'Finish', summary: 'Open workspace' },
] as const

const ENGINE_OPTIONS: Array<{
  id: DatabaseEngine
  name: string
  defaultPort?: number
  tag: string
  desc: string
}> = [
  {
    id: 'postgresql',
    name: 'PostgreSQL',
    defaultPort: 5432,
    tag: 'Recommended',
    desc: 'Recommended for teams and production servers.',
  },
  {
    id: 'mysql',
    name: 'MySQL',
    defaultPort: 3306,
    tag: 'Production',
    desc: 'Connect to an existing MySQL 8.0+ database.',
  },
  {
    id: 'mariadb',
    name: 'MariaDB',
    defaultPort: 3306,
    tag: 'Production',
    desc: 'Connect to an existing MariaDB 10.6+ database.',
  },
  {
    id: 'sqlite',
    name: 'SQLite',
    tag: 'Lightweight',
    desc: 'Local file database for personal or single-server use.',
  },
]

const COMMON_TIMEZONES = [
  'UTC',
  'Asia/Jakarta',
  'Asia/Singapore',
  'Asia/Tokyo',
  'Europe/London',
  'Europe/Berlin',
  'America/New_York',
  'America/Los_Angeles',
]

export function SetupWizard() {
  const router = useRouter()
  const { theme, toggleTheme } = useTheme()

  const [bootLoading, setBootLoading] = useState(true)
  const [setupCsrf, setSetupCsrf] = useState('')
  const [step, setStep] = useState<number>(1)

  // Step 2: Database state
  const [engine, setEngine] = useState<DatabaseEngine>('postgresql')
  const [dbHost, setDbHost] = useState('localhost')
  const [dbPort, setDbPort] = useState('5432')
  const [dbName, setDbName] = useState('meofast')
  const [dbUser, setDbUser] = useState('postgres')
  const [dbPassword, setDbPassword] = useState('')
  const [sslMode, setSslMode] = useState<SslMode>('disable')
  const [connParams, setConnParams] = useState('')
  const [sqliteDir, setSqliteDir] = useState('./data')
  const [sqliteFile, setSqliteFile] = useState('meofast.sqlite')

  // Step 3: Validation state
  const [validatingDb, setValidatingDb] = useState(false)
  const [creatingDb, setCreatingDb] = useState(false)
  const [dbValidation, setDbValidation] = useState<DatabaseValidationResult | null>(null)
  const [stepError, setStepError] = useState<string | null>(null)

  // Step 4: Admin state
  const [fullName, setFullName] = useState('')
  const [email, setEmail] = useState('')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')

  // Step 5: App configuration
  const [appName, setAppName] = useState('Meetofast')
  const [publicUrl, setPublicUrl] = useState('http://localhost:4780')
  const [timezone, setTimezone] = useState('UTC')
  const [language, setLanguage] = useState<'en' | 'id'>('en')
  const [organizationName, setOrganizationName] = useState('')

  // Step 6 & 7: Execution state
  const [installing, setInstalling] = useState(false)
  const [installProgress, setInstallProgress] = useState(0)
  const [installStageText, setInstallStageText] = useState('Preparing setup...')
  const [completedTasks, setCompletedTasks] = useState<string[]>([])
  const [installSummary, setInstallSummary] = useState<{
    version: string
    engine: DatabaseEngine
    adminEmail: string
    appName: string
  } | null>(null)

  useEffect(() => {
    if (typeof window !== 'undefined') {
      setPublicUrl(window.location.origin)
      const detectedTz = Intl.DateTimeFormat().resolvedOptions().timeZone
      if (detectedTz) setTimezone(detectedTz)
    }

    apiRequest<SetupStatusResponse>('/api/v1/setup/status')
      .then((status) => {
        if (status.installed) {
          router.replace('/')
          return
        }
        setSetupCsrf(status.csrfToken)
        if (status.defaultStorageDir) {
          setSqliteDir(status.defaultStorageDir)
        }
        setBootLoading(false)
      })
      .catch(() => {
        setBootLoading(false)
      })
  }, [router])

  const timezoneOptions = useMemo(() => {
    const set = new Set([timezone, ...COMMON_TIMEZONES])
    return Array.from(set).map((tz) => ({ value: tz, label: tz }))
  }, [timezone])

  const currentDbPayload = useMemo<DatabaseConfig>(() => {
    if (engine === 'sqlite') {
      return {
        engine: 'sqlite',
        storageDir: sqliteDir.trim() || './data',
        filename: sqliteFile.trim() || 'meofast.sqlite',
      }
    }
    return {
      engine,
      host: dbHost.trim(),
      port: Number(dbPort) || (engine === 'postgresql' ? 5432 : 3306),
      database: dbName.trim(),
      username: dbUser.trim(),
      password: dbPassword,
      sslMode,
      connectionParams: connParams.trim(),
    }
  }, [
    engine,
    sqliteDir,
    sqliteFile,
    dbHost,
    dbPort,
    dbName,
    dbUser,
    dbPassword,
    sslMode,
    connParams,
  ])

  const selectEngine = (next: DatabaseEngine) => {
    setEngine(next)
    setDbValidation(null)
    setStepError(null)
    if (next === 'postgresql') {
      setDbPort('5432')
      if (dbUser === 'root') setDbUser('postgres')
    } else if (next === 'mysql' || next === 'mariadb') {
      setDbPort('3306')
      if (dbUser === 'postgres') setDbUser('root')
    }
  }

  const runDatabaseValidation = async () => {
    setValidatingDb(true)
    setStepError(null)
    try {
      const result = await apiRequest<DatabaseValidationResult>('/api/v1/setup/validate-db', {
        method: 'POST',
        csrfToken: setupCsrf,
        body: JSON.stringify(currentDbPayload),
      })
      setDbValidation(result)
    } catch (err) {
      setStepError(err instanceof Error ? err.message : 'Database validation failed')
      setDbValidation(null)
    } finally {
      setValidatingDb(false)
    }
  }

  const handleExplicitCreateDatabase = async () => {
    setCreatingDb(true)
    setStepError(null)
    try {
      const result = await apiRequest<DatabaseValidationResult>('/api/v1/setup/create-db', {
        method: 'POST',
        csrfToken: setupCsrf,
        body: JSON.stringify(currentDbPayload),
      })
      setDbValidation(result)
    } catch (err) {
      setStepError(err instanceof Error ? err.message : 'Failed to create database')
    } finally {
      setCreatingDb(false)
    }
  }

  const passwordChecks = useMemo(
    () => [
      { label: '10+ characters', ok: password.length >= 10 },
      { label: 'Uppercase & lowercase', ok: /[A-Z]/.test(password) && /[a-z]/.test(password) },
      { label: 'Number', ok: /[0-9]/.test(password) },
      { label: 'Symbol', ok: /[^A-Za-z0-9]/.test(password) },
      { label: 'Passwords match', ok: password.length > 0 && password === confirmPassword },
    ],
    [password, confirmPassword],
  )

  const handleAdvanceFromStep4 = () => {
    setStepError(null)
    const check = setupAdminSchema.safeParse({
      fullName,
      email,
      username,
      password,
      confirmPassword,
    })
    if (!check.success) {
      setStepError(check.error.issues[0]?.message ?? 'Please review administrator fields.')
      return
    }
    setStep(5)
  }

  const handleAdvanceFromStep5 = () => {
    setStepError(null)
    const check = setupAppConfigSchema.safeParse({
      appName,
      publicUrl,
      timezone,
      language,
      organizationName,
    })
    if (!check.success) {
      setStepError(check.error.issues[0]?.message ?? 'Please review application settings.')
      return
    }
    setStep(6)
  }

  const handleExecuteInstallation = async () => {
    const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

    setInstalling(true)
    setStepError(null)
    setInstallProgress(12)
    setInstallStageText('Saving database configuration...')
    setCompletedTasks([])

    try {
      const executePromise = apiRequest<{
        installed: boolean
        version: string
        engine: DatabaseEngine
        adminEmail: string
        appName: string
        stepsCompleted: string[]
        csrfToken: string
      }>('/api/v1/setup/execute', {
        method: 'POST',
        csrfToken: setupCsrf,
        body: JSON.stringify({
          database: currentDbPayload,
          admin: {
            fullName,
            email,
            username,
            password,
            confirmPassword,
          },
          appConfig: {
            appName,
            publicUrl,
            timezone,
            language,
            organizationName,
          },
        }),
      })

      await wait(320)
      setInstallProgress(34)
      setCompletedTasks(['database_validated'])
      setInstallStageText('Creating database tables...')

      await wait(360)
      setInstallProgress(58)
      setCompletedTasks(['database_validated', 'migrations_executed'])
      setInstallStageText('Creating administrator account...')

      await wait(360)
      setInstallProgress(82)
      setCompletedTasks(['database_validated', 'migrations_executed', 'administrator_created'])
      setInstallStageText('Setting up default workspace...')

      const res = await executePromise

      setInstallProgress(100)
      setCompletedTasks(res.stepsCompleted)
      setInstallStageText('Setup complete!')
      await wait(450)

      setActiveCsrfToken(res.csrfToken)
      setInstallSummary({
        version: res.version,
        engine: res.engine,
        adminEmail: res.adminEmail,
        appName: res.appName,
      })
      setStep(7)
    } catch (err) {
      if (err instanceof ApiClientError && err.code === 'INSTALLATION_LOCKED') {
        router.replace('/login')
        return
      }
      setInstallProgress(0)
      setStepError(err instanceof Error ? err.message : 'Installation failed')
    } finally {
      setInstalling(false)
    }
  }

  if (bootLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[var(--color-background)]">
        <div className="flex items-center gap-3 text-sm text-[var(--color-text-secondary)]">
          <Spinner size="md" />
          <span>Loading setup...</span>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen flex flex-col bg-[var(--color-background)] text-[var(--color-text)]">
      {/* Setup Header */}
      <header className="border-b border-[var(--color-border)] bg-[var(--color-surface)]">
        <div className="max-w-5xl mx-auto px-6 h-16 flex items-center justify-between gap-4">
          <div className="flex items-center gap-2.5">
            <MeofastLogo size={36} />
            <span className="text-lg font-bold tracking-tight">Meetofast</span>
            <Badge variant="neutral">v{MEOFAST_VERSION}</Badge>
          </div>

          <Button
            variant="outline"
            size="sm"
            onClick={toggleTheme}
            aria-label={`Switch to ${theme === 'light' ? 'dark' : 'light'} theme`}
            leftIcon={<Icon name={theme === 'light' ? 'sun' : 'moon'} size={14} />}
          >
            {theme === 'light' ? 'Light' : 'Dark'}
          </Button>
        </div>
      </header>

      {/* Main Setup Grid */}
      <main className="flex-1 max-w-5xl w-full mx-auto px-6 py-8 grid grid-cols-1 lg:grid-cols-[240px_1fr] gap-8 items-start">
        {/* Step Rail */}
        <nav
          aria-label="Installation steps"
          className="bg-[var(--color-surface)] border border-[var(--color-border)] rounded-[var(--radius-xl)] p-3.5 shadow-[var(--shadow-sm)]"
        >
          <ol className="flex flex-col gap-1 list-none m-0 p-0">
            {WIZARD_STEPS.map((item) => {
              const isDone = step > item.step || step === 7
              const isCurrent = step === item.step
              return (
                <li
                  key={item.step}
                  className={cn(
                    'flex items-center gap-3 px-3 py-2 rounded-[var(--radius-lg)] transition-colors',
                    isCurrent && 'bg-[var(--color-primary-subtle)] text-[var(--color-primary)]',
                    !isCurrent && isDone && 'text-[var(--color-text)]',
                    !isCurrent && !isDone && 'text-[var(--color-text-muted)]',
                  )}
                >
                  <span
                    className={cn(
                      'w-6 h-6 rounded-full text-xs font-semibold inline-flex items-center justify-center shrink-0 tabular-nums border',
                      isCurrent &&
                        'bg-[var(--color-primary)] text-[var(--color-primary-foreground)] border-[var(--color-primary)]',
                      !isCurrent &&
                        isDone &&
                        'bg-[var(--color-success-subtle)] text-[var(--color-success)] border-[var(--color-success-border)]',
                      !isCurrent &&
                        !isDone &&
                        'bg-[var(--color-surface-secondary)] text-[var(--color-text-muted)] border-[var(--color-border)]',
                    )}
                  >
                    {isDone && !isCurrent ? <Icon name="check" size={13} /> : item.step}
                  </span>
                  <div className="min-w-0">
                    <div className="text-xs font-semibold truncate">{item.title}</div>
                    <div className="text-[11px] text-[var(--color-text-muted)] truncate">
                      {item.summary}
                    </div>
                  </div>
                </li>
              )
            })}
          </ol>
        </nav>

        {/* Step Surface */}
        <Card variant="elevated" padding="lg" className="flex flex-col gap-6 rounded-[var(--radius-xl)]">
          {stepError ? (
            <div
              role="alert"
              className="flex items-start gap-2.5 p-3.5 rounded-[var(--radius-lg)] bg-[var(--color-danger-subtle)] border border-[var(--color-danger-border)] text-sm text-[var(--color-danger)]"
            >
              <Icon name="alert" size={17} className="shrink-0 mt-0.5" />
              <span>{stepError}</span>
            </div>
          ) : null}

          {/* STEP 1: WELCOME */}
          {step === 1 ? (
            <div className="flex flex-col gap-6">
              <div className="flex items-center gap-4">
                <MeofastLogo size={64} />
                <div className="flex flex-col gap-1.5">
                  <h1 className="text-2xl font-semibold">Welcome to Meetofast</h1>
                  <p className="text-sm text-[var(--color-text-secondary)] leading-relaxed max-w-[60ch]">
                    Set up your database, create your administrator account, and start testing APIs
                    with your team.
                  </p>
                </div>
              </div>

              <div className="border border-[var(--color-border)] rounded-[var(--radius-lg)] divide-y divide-[var(--color-border)] bg-[var(--color-background)]">
                <div className="px-4 py-3 flex items-center justify-between gap-4 text-sm">
                  <span className="text-[var(--color-text-secondary)]">Version</span>
                  <span className="font-mono text-xs tabular-nums">v{MEOFAST_VERSION}</span>
                </div>
                <div className="px-4 py-3 flex items-center justify-between gap-4 text-sm">
                  <span className="text-[var(--color-text-secondary)]">Supported Databases</span>
                  <span className="font-medium text-right">
                    PostgreSQL, MySQL, MariaDB, SQLite
                  </span>
                </div>
              </div>

              <div className="flex justify-end pt-4 border-t border-[var(--color-border)]">
                <Button size="md" onClick={() => setStep(2)}>
                  Get Started
                </Button>
              </div>
            </div>
          ) : null}

          {/* STEP 2: DATABASE SELECTION */}
          {step === 2 ? (
            <div className="flex flex-col gap-6">
              <div className="flex flex-col gap-1">
                <h1 className="text-xl font-semibold">Database</h1>
                <p className="text-sm text-[var(--color-text-secondary)]">
                  Choose where Meetofast stores workspaces, collections, and environments.
                </p>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {ENGINE_OPTIONS.map((opt) => {
                  const active = engine === opt.id
                  return (
                    <button
                      key={opt.id}
                      type="button"
                      onClick={() => selectEngine(opt.id)}
                      className={cn(
                        'text-left p-4 rounded-[var(--radius-lg)] border transition-all cursor-pointer flex flex-col gap-1.5',
                        active
                          ? 'bg-[var(--color-primary-subtle)] border-[var(--color-primary)] shadow-[var(--shadow-xs)]'
                          : 'bg-[var(--color-surface)] border-[var(--color-border)] hover:bg-[var(--color-surface-hover)] hover:border-[var(--color-border-strong)]',
                      )}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-semibold text-sm text-[var(--color-text)] inline-flex items-center gap-2">
                          <Icon name="database" size={15} className="text-[var(--color-primary)]" />
                          {opt.name}
                        </span>
                        <Badge variant={active ? 'primary' : 'neutral'}>{opt.tag}</Badge>
                      </div>
                      <p className="text-xs text-[var(--color-text-secondary)] leading-relaxed">
                        {opt.desc}
                      </p>
                    </button>
                  )
                })}
              </div>

              {engine === 'sqlite' ? (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-4 border-t border-[var(--color-border)]">
                  <Input
                    label="Storage Directory"
                    value={sqliteDir}
                    onChange={(e) => {
                      setSqliteDir(e.target.value)
                      setDbValidation(null)
                    }}
                    mono
                    required
                  />
                  <Input
                    label="File Name"
                    value={sqliteFile}
                    onChange={(e) => {
                      setSqliteFile(e.target.value)
                      setDbValidation(null)
                    }}
                    mono
                    required
                  />
                </div>
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-4 border-t border-[var(--color-border)]">
                  <Input
                    label="Host"
                    value={dbHost}
                    onChange={(e) => {
                      setDbHost(e.target.value)
                      setDbValidation(null)
                    }}
                    placeholder="localhost"
                    mono
                    required
                  />
                  <Input
                    label="Port"
                    type="number"
                    value={dbPort}
                    onChange={(e) => {
                      setDbPort(e.target.value)
                      setDbValidation(null)
                    }}
                    mono
                    required
                  />
                  <Input
                    label="Database Name"
                    value={dbName}
                    onChange={(e) => {
                      setDbName(e.target.value)
                      setDbValidation(null)
                    }}
                    placeholder="meofast"
                    mono
                    required
                  />
                  <Select
                    label="SSL Mode"
                    value={sslMode}
                    onValueChange={(val) => {
                      setSslMode(val as SslMode)
                      setDbValidation(null)
                    }}
                    options={[
                      { value: 'disable', label: 'Disable' },
                      { value: 'prefer', label: 'Prefer' },
                      { value: 'require', label: 'Require' },
                    ]}
                  />
                  <Input
                    label="Username"
                    value={dbUser}
                    onChange={(e) => {
                      setDbUser(e.target.value)
                      setDbValidation(null)
                    }}
                    mono
                    required
                  />
                  <Input
                    label="Password"
                    type="password"
                    value={dbPassword}
                    onChange={(e) => {
                      setDbPassword(e.target.value)
                      setDbValidation(null)
                    }}
                    placeholder="Enter password"
                  />
                  <div className="sm:col-span-2">
                    <Input
                      label="Connection Parameters (Optional)"
                      value={connParams}
                      onChange={(e) => setConnParams(e.target.value)}
                      placeholder="connect_timeout=10"
                      mono
                    />
                  </div>
                </div>
              )}

              <div className="flex items-center justify-between gap-3 pt-4 border-t border-[var(--color-border)]">
                <Button variant="outline" onClick={() => setStep(1)}>
                  Back
                </Button>
                <Button
                  onClick={() => {
                    setStep(3)
                    void runDatabaseValidation()
                  }}
                >
                  Test Connection
                </Button>
              </div>
            </div>
          ) : null}

          {/* STEP 3: DATABASE VALIDATION */}
          {step === 3 ? (
            <div className="flex flex-col gap-6">
              <div className="flex flex-col gap-1">
                <h1 className="text-xl font-semibold">Connection Check</h1>
                <p className="text-sm text-[var(--color-text-secondary)]">
                  Verifying connection and database permissions before continuing.
                </p>
              </div>

              <div className="border border-[var(--color-border)] rounded-[var(--radius-lg)] p-4 bg-[var(--color-background)] flex flex-col gap-3">
                {validatingDb ? (
                  <div className="flex items-center gap-3 py-4 text-sm text-[var(--color-text-secondary)]">
                    <Spinner size="sm" />
                    <span>Testing connection...</span>
                  </div>
                ) : dbValidation ? (
                  <>
                    <div className="flex items-center justify-between gap-2 pb-2.5 border-b border-[var(--color-border)]">
                      <span className="text-sm font-semibold">Status</span>
                      <Badge variant={dbValidation.valid ? 'success' : 'danger'}>
                        {dbValidation.valid ? 'Connected' : 'Check Failed'}
                      </Badge>
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 text-xs">
                      <div className="flex items-center justify-between p-3 rounded-[var(--radius-md)] bg-[var(--color-surface)] border border-[var(--color-border)]">
                        <span className="text-[var(--color-text-secondary)]">Host Reachable</span>
                        <Badge variant={dbValidation.reachable ? 'success' : 'danger'}>
                          {dbValidation.reachable ? 'Yes' : 'No'}
                        </Badge>
                      </div>
                      <div className="flex items-center justify-between p-3 rounded-[var(--radius-md)] bg-[var(--color-surface)] border border-[var(--color-border)]">
                        <span className="text-[var(--color-text-secondary)]">Authentication</span>
                        <Badge variant={dbValidation.authenticated ? 'success' : 'danger'}>
                          {dbValidation.authenticated ? 'OK' : 'Failed'}
                        </Badge>
                      </div>
                      <div className="flex items-center justify-between p-3 rounded-[var(--radius-md)] bg-[var(--color-surface)] border border-[var(--color-border)]">
                        <span className="text-[var(--color-text-secondary)]">Database</span>
                        <Badge variant={dbValidation.databaseExists ? 'success' : 'warning'}>
                          {dbValidation.databaseExists ? 'Ready' : 'Not Found'}
                        </Badge>
                      </div>
                      <div className="flex items-center justify-between p-3 rounded-[var(--radius-md)] bg-[var(--color-surface)] border border-[var(--color-border)]">
                        <span className="text-[var(--color-text-secondary)]">Permissions</span>
                        <Badge variant={dbValidation.permissionsOk ? 'success' : 'danger'}>
                          {dbValidation.permissionsOk ? 'OK' : 'Missing'}
                        </Badge>
                      </div>
                    </div>

                    <p
                      className={cn(
                        'text-xs font-medium pt-1',
                        dbValidation.valid
                          ? 'text-[var(--color-success)]'
                          : 'text-[var(--color-warning)]',
                      )}
                    >
                      {dbValidation.message}
                    </p>

                    {!dbValidation.databaseExists && dbValidation.canCreateDatabase ? (
                      <div className="p-3.5 rounded-[var(--radius-lg)] bg-[var(--color-surface)] border border-[var(--color-border-strong)] flex items-center justify-between gap-4 flex-wrap">
                        <span className="text-xs text-[var(--color-text-secondary)]">
                          Database <code className="font-semibold text-[var(--color-text)]">{dbName}</code>{' '}
                          does not exist yet.
                        </span>
                        <Button
                          size="sm"
                          variant="secondary"
                          isLoading={creatingDb}
                          onClick={handleExplicitCreateDatabase}
                        >
                          Create Database
                        </Button>
                      </div>
                    ) : null}
                  </>
                ) : (
                  <p className="text-sm text-[var(--color-text-secondary)]">
                    Click Retry to test the database connection.
                  </p>
                )}
              </div>

              <div className="flex items-center justify-between gap-3 pt-4 border-t border-[var(--color-border)] flex-wrap">
                <Button variant="outline" onClick={() => setStep(2)}>
                  Back
                </Button>
                <div className="flex items-center gap-2.5">
                  <Button
                    variant="secondary"
                    isLoading={validatingDb}
                    leftIcon={<Icon name="refresh" size={14} />}
                    onClick={runDatabaseValidation}
                  >
                    Retry
                  </Button>
                  <Button disabled={!dbValidation?.valid} onClick={() => setStep(4)}>
                    Continue
                  </Button>
                </div>
              </div>
            </div>
          ) : null}

          {/* STEP 4: INITIAL ADMINISTRATOR */}
          {step === 4 ? (
            <div className="flex flex-col gap-6">
              <div className="flex flex-col gap-1">
                <h1 className="text-xl font-semibold">Administrator Account</h1>
                <p className="text-sm text-[var(--color-text-secondary)]">
                  Create the primary administrator account for this instance.
                </p>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="sm:col-span-2">
                  <Input
                    label="Full Name"
                    value={fullName}
                    onChange={(e) => setFullName(e.target.value)}
                    placeholder="Davin Metoti"
                    required
                  />
                </div>
                <Input
                  label="Email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="admin@company.com"
                  required
                />
                <Input
                  label="Username"
                  value={username}
                  onChange={(e) => setUsername(e.target.value.toLowerCase())}
                  placeholder="admin"
                  mono
                  required
                />
                <Input
                  label="Password"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Minimum 10 characters"
                  required
                />
                <Input
                  label="Confirm Password"
                  type="password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  placeholder="Re-enter password"
                  required
                />
              </div>

              <div className="p-3.5 rounded-[var(--radius-lg)] bg-[var(--color-background)] border border-[var(--color-border)] flex flex-wrap gap-x-5 gap-y-2">
                {passwordChecks.map((rule) => (
                  <div key={rule.label} className="flex items-center gap-2 text-xs">
                    <span
                      className={cn(
                        'w-4 h-4 rounded-full inline-flex items-center justify-center shrink-0',
                        rule.ok
                          ? 'bg-[var(--color-success-subtle)] text-[var(--color-success)]'
                          : 'bg-[var(--color-surface-secondary)] text-[var(--color-text-muted)]',
                      )}
                    >
                      <Icon name="check" size={11} />
                    </span>
                    <span
                      className={
                        rule.ok
                          ? 'text-[var(--color-text)] font-medium'
                          : 'text-[var(--color-text-muted)]'
                      }
                    >
                      {rule.label}
                    </span>
                  </div>
                ))}
              </div>

              <div className="flex items-center justify-between gap-3 pt-4 border-t border-[var(--color-border)]">
                <Button variant="outline" onClick={() => setStep(3)}>
                  Back
                </Button>
                <Button onClick={handleAdvanceFromStep4}>Continue</Button>
              </div>
            </div>
          ) : null}

          {/* STEP 5: APPLICATION CONFIGURATION */}
          {step === 5 ? (
            <div className="flex flex-col gap-6">
              <div className="flex flex-col gap-1">
                <h1 className="text-xl font-semibold">Application Settings</h1>
                <p className="text-sm text-[var(--color-text-secondary)]">
                  Configure basic workspace preferences. You can change these anytime later.
                </p>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <Input
                  label="Application Name"
                  value={appName}
                  onChange={(e) => setAppName(e.target.value)}
                  required
                />
                <Input
                  label="Organization Name (Optional)"
                  value={organizationName}
                  onChange={(e) => setOrganizationName(e.target.value)}
                  placeholder="Acme Team"
                />
                <div className="sm:col-span-2">
                  <Input
                    label="Public URL"
                    value={publicUrl}
                    onChange={(e) => setPublicUrl(e.target.value)}
                    mono
                    required
                  />
                </div>
                <Select
                  label="Timezone"
                  value={timezone}
                  onValueChange={setTimezone}
                  options={timezoneOptions}
                />
                <Select
                  label="Language"
                  value={language}
                  onValueChange={(val) => setLanguage(val as 'en' | 'id')}
                  options={[
                    { value: 'en', label: 'English' },
                    { value: 'id', label: 'Bahasa Indonesia' },
                  ]}
                />
              </div>

              <div className="flex items-center justify-between gap-3 pt-4 border-t border-[var(--color-border)]">
                <Button variant="outline" onClick={() => setStep(4)}>
                  Back
                </Button>
                <Button onClick={handleAdvanceFromStep5}>Review</Button>
              </div>
            </div>
          ) : null}

          {/* STEP 6: INSTALLATION EXECUTION */}
          {step === 6 ? (
            <div className="flex flex-col gap-6">
              <div className="flex flex-col gap-1">
                <h1 className="text-xl font-semibold">Confirm &amp; Install</h1>
                <p className="text-sm text-[var(--color-text-secondary)]">
                  Review your settings below and start the installation.
                </p>
              </div>

              <div className="border border-[var(--color-border)] rounded-[var(--radius-lg)] divide-y divide-[var(--color-border)] bg-[var(--color-background)] text-sm">
                <div className="px-4 py-3 flex justify-between gap-4">
                  <span className="text-[var(--color-text-secondary)]">Database</span>
                  <span className="font-mono font-medium uppercase">{engine}</span>
                </div>
                <div className="px-4 py-3 flex justify-between gap-4">
                  <span className="text-[var(--color-text-secondary)]">Administrator</span>
                  <span className="font-medium">
                    {fullName} ({email})
                  </span>
                </div>
                <div className="px-4 py-3 flex justify-between gap-4">
                  <span className="text-[var(--color-text-secondary)]">Public URL</span>
                  <span className="font-mono text-xs">{publicUrl}</span>
                </div>
              </div>

              {installing || completedTasks.length > 0 ? (
                <div
                  role="status"
                  aria-live="polite"
                  className="p-5 rounded-[var(--radius-xl)] border border-[var(--color-border-strong)] bg-[var(--color-surface-secondary)] flex flex-col gap-4"
                >
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex items-center gap-2.5 min-w-0">
                      <span className="w-8 h-8 rounded-[var(--radius-md)] bg-[var(--color-primary)] text-[var(--color-primary-foreground)] inline-flex items-center justify-center shrink-0 shadow-[var(--shadow-xs)]">
                        <Icon name="rocket" size={16} />
                      </span>
                      <div className="min-w-0">
                        <div className="text-xs font-semibold text-[var(--color-text)] truncate">
                          Installing {appName}
                        </div>
                        <div className="text-[11px] text-[var(--color-text-secondary)] truncate">
                          {installStageText}
                        </div>
                      </div>
                    </div>
                    <span className="text-sm font-mono font-bold text-[var(--color-primary)] tabular-nums shrink-0">
                      {installProgress}%
                    </span>
                  </div>

                  <div className="relative py-2">
                    <div className="w-full h-2.5 rounded-full bg-[var(--color-surface)] border border-[var(--color-border)] overflow-hidden">
                      <div
                        style={{ width: `${installProgress}%` }}
                        className="h-full rounded-full bg-[var(--color-primary)] transition-all duration-300 ease-out"
                      />
                    </div>
                    <span
                      style={{
                        left: `clamp(0px, calc(${installProgress}% - 14px), calc(100% - 28px))`,
                      }}
                      className="absolute top-0 w-7 h-7 rounded-full bg-[var(--color-primary)] text-[var(--color-primary-foreground)] border-2 border-[var(--color-surface)] shadow-[var(--shadow-sm)] inline-flex items-center justify-center transition-all duration-300 ease-out"
                    >
                      <Icon name="rocket" size={13} />
                    </span>
                  </div>

                  <div className="flex flex-col gap-2 pt-1 text-xs">
                    {[
                      { id: 'database_validated', label: 'Save database configuration' },
                      { id: 'migrations_executed', label: 'Create database tables' },
                      { id: 'administrator_created', label: 'Create administrator account' },
                      { id: 'workspace_seeded', label: 'Set up default workspace' },
                      { id: 'installation_locked', label: 'Finalize installation' },
                    ].map((t) => {
                      const done = completedTasks.includes(t.id)
                      return (
                        <div key={t.id} className="flex items-center gap-2.5">
                          {done ? (
                            <span className="w-4 h-4 rounded-full bg-[var(--color-success-subtle)] text-[var(--color-success)] inline-flex items-center justify-center shrink-0">
                              <Icon name="check" size={11} />
                            </span>
                          ) : installing ? (
                            <Spinner size="sm" className="text-[var(--color-primary)] shrink-0" />
                          ) : (
                            <span className="w-4 h-4 rounded-full border border-[var(--color-border-strong)] shrink-0" />
                          )}
                          <span
                            className={
                              done
                                ? 'font-medium text-[var(--color-text)]'
                                : 'text-[var(--color-text-secondary)]'
                            }
                          >
                            {t.label}
                          </span>
                        </div>
                      )
                    })}
                  </div>
                </div>
              ) : null}

              <div className="flex items-center justify-between gap-3 pt-4 border-t border-[var(--color-border)]">
                <Button variant="outline" disabled={installing} onClick={() => setStep(5)}>
                  Back
                </Button>
                <Button
                  isLoading={installing}
                  leftIcon={<Icon name="rocket" size={15} />}
                  onClick={handleExecuteInstallation}
                >
                  Install Now
                </Button>
              </div>
            </div>
          ) : null}

          {/* STEP 7: INSTALLATION COMPLETE */}
          {step === 7 && installSummary ? (
            <div className="flex flex-col gap-6">
              <div className="flex items-center gap-3.5">
                <div className="w-11 h-11 rounded-full bg-[var(--color-success-subtle)] border border-[var(--color-success-border)] text-[var(--color-success)] inline-flex items-center justify-center shrink-0">
                  <Icon name="check" size={22} />
                </div>
                <div>
                  <h1 className="text-xl font-semibold">Setup Complete</h1>
                  <p className="text-sm text-[var(--color-text-secondary)]">
                    Your workspace is ready to use.
                  </p>
                </div>
              </div>

              <div className="border border-[var(--color-border)] rounded-[var(--radius-lg)] divide-y divide-[var(--color-border)] bg-[var(--color-background)] text-sm">
                <div className="px-4 py-3 flex justify-between gap-4">
                  <span className="text-[var(--color-text-secondary)]">Version</span>
                  <span className="font-mono text-xs tabular-nums">v{installSummary.version}</span>
                </div>
                <div className="px-4 py-3 flex justify-between gap-4">
                  <span className="text-[var(--color-text-secondary)]">Database</span>
                  <span className="font-mono uppercase font-medium">{installSummary.engine}</span>
                </div>
                <div className="px-4 py-3 flex justify-between gap-4">
                  <span className="text-[var(--color-text-secondary)]">Administrator</span>
                  <span className="font-medium">{installSummary.adminEmail}</span>
                </div>
              </div>

              <div className="flex justify-end pt-4 border-t border-[var(--color-border)]">
                <Button onClick={() => router.push('/collections')}>Go to Dashboard</Button>
              </div>
            </div>
          ) : null}
        </Card>
      </main>
    </div>
  )
}
