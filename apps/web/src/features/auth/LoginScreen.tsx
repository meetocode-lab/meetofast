'use client'

import type { SetupStatusResponse } from '@meofast/shared'
import { AnimatePresence, LayoutGroup, motion } from 'motion/react'
import Image from 'next/image'
import { useRouter } from 'next/navigation'
import { type FormEvent, useEffect, useState } from 'react'
import { Button, Icon, Input, MeofastLogo, Spinner } from '@/components/ui'
import { apiRequest, setActiveCsrfToken } from '@/lib/api-client'
import { useTheme } from '@/providers/ThemeProvider'
import { cn } from '@/utils/cn'

export function LoginScreen() {
  const router = useRouter()
  const { theme, toggleTheme } = useTheme()

  const [checking, setChecking] = useState(true)
  const [registrationMode, setRegistrationMode] = useState<'invite_only' | 'open'>('invite_only')
  const [mode, setMode] = useState<'login' | 'register'>('login')

  // Login fields
  const [identifier, setIdentifier] = useState('')
  const [password, setPassword] = useState('')

  // Register / Invitation fields
  const [fullName, setFullName] = useState('')
  const [email, setEmail] = useState('')
  const [username, setUsername] = useState('')
  const [regPassword, setRegPassword] = useState('')
  const [invitationToken, setInvitationToken] = useState('')

  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    apiRequest<SetupStatusResponse>('/api/v1/setup/status')
      .then((res) => {
        if (!res.installed) {
          router.replace('/setup')
          return
        }
        setRegistrationMode(res.registrationMode)
        setChecking(false)
      })
      .catch(() => {
        setChecking(false)
      })
  }, [router])

  const handleLogin = async (e: FormEvent) => {
    e.preventDefault()
    setSubmitting(true)
    setError(null)
    try {
      const res = await apiRequest<{ csrfToken: string }>('/api/v1/auth/login', {
        method: 'POST',
        body: JSON.stringify({ identifier, password }),
      })
      setActiveCsrfToken(res.csrfToken)
      router.replace('/collections')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sign in failed')
    } finally {
      setSubmitting(false)
    }
  }

  const handleRegister = async (e: FormEvent) => {
    e.preventDefault()
    setSubmitting(true)
    setError(null)
    try {
      const res = await apiRequest<{ csrfToken: string }>('/api/v1/auth/register', {
        method: 'POST',
        body: JSON.stringify({
          fullName,
          email,
          username,
          password: regPassword,
          invitationToken: invitationToken.trim() || undefined,
        }),
      })
      setActiveCsrfToken(res.csrfToken)
      router.replace('/collections')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Registration failed')
    } finally {
      setSubmitting(false)
    }
  }

  if (checking) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[var(--color-background)]">
        <Spinner size="md" />
      </div>
    )
  }

  return (
    <div className="min-h-screen w-full flex items-center justify-center p-4 sm:p-6 bg-[var(--color-background)] text-[var(--color-text)] relative overflow-hidden">
      {/* Subtle Blue Aurora ambient glow */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -top-32 -left-32 w-96 h-96 rounded-full bg-[var(--color-primary)]/10 blur-3xl"
      />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -bottom-32 -right-32 w-96 h-96 rounded-full bg-[var(--color-cyan)]/12 blur-3xl"
      />

      {/* Modern Split-Screen Floating Container */}
      <main className="relative z-10 w-full max-w-[880px] rounded-[24px] bg-[var(--color-surface)] border border-[var(--color-border)] shadow-[var(--shadow-lg)] p-3 grid grid-cols-1 lg:grid-cols-[1fr_1fr] gap-3 lg:min-h-[588px] items-stretch">
        {/* Left Column: Centered Brand + Form */}
        <div className="relative flex flex-col px-4 py-4 sm:px-7 sm:py-5">
          <div className="flex items-center justify-end">
            <button
              type="button"
              onClick={toggleTheme}
              aria-label={`Switch to ${theme === 'light' ? 'dark' : 'light'} mode`}
              title={`Switch to ${theme === 'light' ? 'dark' : 'light'} mode`}
              className="w-8 h-8 rounded-full border border-[var(--color-border)] bg-[var(--color-surface-secondary)] hover:border-[var(--color-primary)] text-[var(--color-text-secondary)] hover:text-[var(--color-primary)] inline-flex items-center justify-center cursor-pointer transition-colors"
            >
              <Icon name={theme === 'light' ? 'moon' : 'sun'} size={14} />
            </button>
          </div>

          <div className="w-full max-w-[332px] mx-auto my-auto py-2 flex flex-col gap-4">
            {/* Brand Logo + Welcome Heading */}
            <div className="flex flex-col items-center text-center gap-2">
              <MeofastLogo size={56} />
              <h1 className="text-xl font-bold tracking-tight text-[var(--color-text)]">
                {mode === 'login' ? 'Welcome Back' : 'Join Workspace'}
              </h1>
            </div>

            {/* Full-Width Full-Rounded Sliding Pill Tabs */}
            <LayoutGroup id="login-auth-mode-tabs">
              <div
                role="tablist"
                aria-label="Authentication mode"
                className="w-full grid grid-cols-2 p-1 rounded-full bg-[var(--color-surface-secondary)] border border-[var(--color-border)]"
              >
                {(
                  [
                    { id: 'login', label: 'Sign In' },
                    {
                      id: 'register',
                      label: registrationMode === 'open' ? 'Create Account' : 'Redeem Invite',
                    },
                  ] as const
                ).map((item) => {
                  const active = mode === item.id
                  return (
                    <button
                      key={item.id}
                      type="button"
                      role="tab"
                      aria-selected={active}
                      onClick={() => {
                        setMode(item.id)
                        setError(null)
                      }}
                      className={cn(
                        'relative h-8 rounded-full text-xs font-semibold cursor-pointer select-none transition-colors flex items-center justify-center',
                        active
                          ? 'text-[var(--color-primary)]'
                          : 'text-[var(--color-text-secondary)] hover:text-[var(--color-text)]',
                      )}
                    >
                      {active ? (
                        <motion.span
                          layoutId="login-mode-sliding-pill"
                          transition={{
                            type: 'spring',
                            stiffness: 460,
                            damping: 34,
                            mass: 0.7,
                          }}
                          className="absolute inset-0 rounded-full bg-[var(--color-surface)] border border-[var(--color-border)] shadow-[var(--shadow-xs)]"
                        />
                      ) : null}
                      <span className="relative z-10">{item.label}</span>
                    </button>
                  )
                })}
              </div>
            </LayoutGroup>

            {error ? (
              <div
                role="alert"
                className="flex items-start gap-2 p-2.5 rounded-[var(--radius-md)] bg-[var(--color-danger-subtle)] border border-[var(--color-danger-border)] text-xs text-[var(--color-danger)]"
              >
                <Icon name="alert" size={14} className="shrink-0 mt-0.5" />
                <span>{error}</span>
              </div>
            ) : null}

            <div className="min-h-[332px] flex flex-col">
              <AnimatePresence mode="wait" initial={false}>
                {mode === 'login' ? (
                  <motion.form
                    key="login-form"
                    initial={{ opacity: 0, x: -12 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, x: 12 }}
                    transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
                    onSubmit={handleLogin}
                    className="flex flex-col gap-3"
                  >
                    <Input
                      label="Email or Username"
                      value={identifier}
                      onChange={(e) => setIdentifier(e.target.value)}
                      placeholder="admin@company.com"
                      autoComplete="username"
                      required
                    />
                    <Input
                      label="Password"
                      type="password"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      placeholder="Enter your password"
                      autoComplete="current-password"
                      required
                    />
                    <Button type="submit" size="lg" isLoading={submitting} className="w-full mt-1">
                      Sign In
                    </Button>
                  </motion.form>
                ) : (
                  <motion.form
                    key="register-form"
                    initial={{ opacity: 0, x: 12 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, x: -12 }}
                    transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
                    onSubmit={handleRegister}
                    className="flex flex-col gap-2.5"
                  >
                    {registrationMode === 'invite_only' ? (
                      <Input
                        label="Invitation Token"
                        value={invitationToken}
                        onChange={(e) => setInvitationToken(e.target.value)}
                        placeholder="Paste invitation token"
                        mono
                        required
                      />
                    ) : null}
                    <div className="grid grid-cols-2 gap-2">
                      <Input
                        label="Full Name"
                        value={fullName}
                        onChange={(e) => setFullName(e.target.value)}
                        placeholder="Jane Dev"
                        required
                      />
                      <Input
                        label="Username"
                        value={username}
                        onChange={(e) => setUsername(e.target.value.toLowerCase())}
                        placeholder="janedev"
                        mono
                        required
                      />
                    </div>
                    <Input
                      label="Email Address"
                      type="email"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      placeholder="jane@company.com"
                      required
                    />
                    <Input
                      label="Password"
                      type="password"
                      value={regPassword}
                      onChange={(e) => setRegPassword(e.target.value)}
                      placeholder="10+ chars, upper, lower, digit, symbol"
                      required
                    />
                    <Button type="submit" size="lg" isLoading={submitting} className="w-full mt-1">
                      Create Account
                    </Button>
                  </motion.form>
                )}
              </AnimatePresence>
            </div>
          </div>
        </div>

        {/* Right Column: Sculptural Organic Framed Hero Artwork */}
        <div className="hidden lg:block relative min-h-[564px]">
          <div className="relative w-full h-full rounded-[20px] overflow-hidden bg-[#0c56f5]">
            {/* Full-bleed edge-to-edge artwork so there is zero color seam */}
            <Image
              src="/login-hero.webp"
              alt="Meetofast API Development Illustration"
              fill
              sizes="(min-width: 1024px) 440px, 100vw"
              priority
              className="object-cover object-center select-none"
            />
          </div>

          {/* Top-left sculptural corner cutout (outside overflow-hidden to avoid corner arc seam) */}
          <div
            aria-hidden="true"
            className="pointer-events-none absolute -top-0.5 -left-0.5 w-[60px] h-[60px] bg-[var(--color-surface)] rounded-br-[24px] z-20"
          />
          <div
            aria-hidden="true"
            className="pointer-events-none absolute top-0 left-[58px] w-5 h-5 z-20"
            style={{
              background:
                'radial-gradient(circle at 100% 100%, transparent 20px, var(--color-surface) 20.5px)',
            }}
          />
          <div
            aria-hidden="true"
            className="pointer-events-none absolute top-[58px] left-0 w-5 h-5 z-20"
            style={{
              background:
                'radial-gradient(circle at 100% 100%, transparent 20px, var(--color-surface) 20.5px)',
            }}
          />

          {/* Bottom-right sculptural corner cutout (outside overflow-hidden to avoid corner arc seam) */}
          <div
            aria-hidden="true"
            className="pointer-events-none absolute -bottom-0.5 -right-0.5 w-[60px] h-[60px] bg-[var(--color-surface)] rounded-tl-[24px] z-20"
          />
          <div
            aria-hidden="true"
            className="pointer-events-none absolute bottom-0 right-[58px] w-5 h-5 z-20"
            style={{
              background:
                'radial-gradient(circle at 0% 0%, transparent 20px, var(--color-surface) 20.5px)',
            }}
          />
          <div
            aria-hidden="true"
            className="pointer-events-none absolute bottom-[58px] right-0 w-5 h-5 z-20"
            style={{
              background:
                'radial-gradient(circle at 0% 0%, transparent 20px, var(--color-surface) 20.5px)',
            }}
          />
        </div>
      </main>
    </div>
  )
}
