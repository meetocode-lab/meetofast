import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { hashPassword, verifyPassword } from '../src/core/crypto/argon2.js'
import { SecretVault } from '../src/core/crypto/vault.js'
import { validateOutboundTargetUrl } from '../src/modules/proxy/ssrf-guard.js'

describe('Argon2id & SecretVault Cryptography', () => {
  it('hashes and verifies passwords with RFC 9106 Argon2id in PHC format', async () => {
    const hash = await hashPassword('CorrectHorse!Battery99')
    expect(hash.startsWith('$argon2id$v=19$m=65536,t=3,p=4$')).toBe(true)

    expect(await verifyPassword('CorrectHorse!Battery99', hash)).toBe(true)
    expect(await verifyPassword('WrongHorse!Battery99', hash)).toBe(false)
    expect(await verifyPassword('CorrectHorse!Battery99', `${hash}tampered`)).toBe(false)
  })

  it('encrypts and decrypts secrets with AES-256-GCM and persists master.key across restarts', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meofast-vault-'))
    try {
      const vaultA = new SecretVault(tmpDir)
      const cipher = vaultA.encrypt('postgres://super:secret-db-pass@db.internal:5432/prod')
      expect(cipher.startsWith('v1:')).toBe(true)
      expect(cipher).not.toContain('secret-db-pass')

      const vaultB = new SecretVault(tmpDir)
      expect(vaultB.decrypt(cipher)).toBe('postgres://super:secret-db-pass@db.internal:5432/prod')
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })
})

describe('SSRF Protection & Company Internal Network Policies', () => {
  const defaultPolicy = {
    allowPrivateNetworks: false,
    allowLocalhost: false,
    allowedCidrs: [],
    allowedDomains: [],
  }

  it('unconditionally blocks cloud metadata IPs even if admin enables private networks and localhost', async () => {
    const permissivePolicy = {
      allowPrivateNetworks: true,
      allowLocalhost: true,
      allowedCidrs: ['0.0.0.0/0'],
      allowedDomains: ['*'],
    }

    await expect(
      validateOutboundTargetUrl('http://169.254.169.254/latest/meta-data/', permissivePolicy),
    ).rejects.toMatchObject({ code: 'SSRF_METADATA_BLOCKED' })

    await expect(
      validateOutboundTargetUrl('http://[::ffff:169.254.169.254]/latest', permissivePolicy),
    ).rejects.toMatchObject({ code: 'SSRF_METADATA_BLOCKED' })

    await expect(
      validateOutboundTargetUrl('http://metadata.google.internal/computeMetadata/v1/', permissivePolicy),
    ).rejects.toMatchObject({ code: 'SSRF_METADATA_BLOCKED' })
  })

  it('blocks localhost and RFC1918 private IPs by default', async () => {
    await expect(
      validateOutboundTargetUrl('http://127.0.0.1:8080/health', defaultPolicy),
    ).rejects.toMatchObject({ code: 'SSRF_LOOPBACK_BLOCKED' })

    await expect(
      validateOutboundTargetUrl('http://10.24.1.9:3000/internal', defaultPolicy),
    ).rejects.toMatchObject({ code: 'SSRF_PRIVATE_NETWORK_BLOCKED' })
  })

  it('allows explicitly authorized company internal CIDRs and wildcard domains', async () => {
    const companyPolicy = {
      allowPrivateNetworks: false,
      allowLocalhost: false,
      allowedCidrs: ['10.24.0.0/16'],
      allowedDomains: ['*.corp.internal'],
    }

    const cidrUrl = await validateOutboundTargetUrl('http://10.24.5.12:8080/v1/orders', companyPolicy)
    expect(cidrUrl.hostname).toBe('10.24.5.12')

    const domainUrl = await validateOutboundTargetUrl(
      'https://billing.corp.internal/api/status',
      companyPolicy,
      async () => [{ address: '192.168.50.10' }],
    )
    expect(domainUrl.hostname).toBe('billing.corp.internal')
  })
})
