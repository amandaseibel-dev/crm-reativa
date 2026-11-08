import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { emailReativaPorIdUlbra, type ConsultaSupabase } from './ulbra_operadores'

const MIGRATION = readFileSync(
  new URL('../../aguardando_aprovacao/20261108150000_ulbra_operadores_vinculo.sql.pendente', import.meta.url),
  'utf8',
)

function fakeClient(linhas: Record<string, { email_reativa: string; ativo: boolean }>): ConsultaSupabase {
  return {
    from: () => ({
      select: () => ({
        eq: (_c, id) => ({
          eq: (_c2, ativo) => ({
            maybeSingle: async () => {
              const l = linhas[id as string]
              return { data: l && l.ativo === ativo ? { email_reativa: l.email_reativa } : null, error: null }
            },
          }),
        }),
      }),
    }),
  }
}

describe('leitor server-side do mapeamento ULBRA', () => {
  it('devolve o e-mail do vínculo ativo', async () => {
    const c = fakeClient({ '691e0e1ecd033c6b374b1036': { email_reativa: 'cobranca10@aelbra.com.br', ativo: true } })
    expect(await emailReativaPorIdUlbra(c, '691e0e1ecd033c6b374b1036')).toBe('cobranca10@aelbra.com.br')
  })

  it('vínculo inativo não é devolvido', async () => {
    const c = fakeClient({ '691e0e1ecd033c6b374b1036': { email_reativa: 'cobranca10@aelbra.com.br', ativo: false } })
    expect(await emailReativaPorIdUlbra(c, '691e0e1ecd033c6b374b1036')).toBeNull()
  })

  it('id com formato inválido nem consulta o banco', async () => {
    const c = fakeClient({})
    expect(await emailReativaPorIdUlbra(c, 'João Vitor')).toBeNull()
  })

  it('a migration pendente tem os 11 vínculos e não inclui João Silva nem Marketing', () => {
    const ids = MIGRATION.match(/\('[0-9a-f]{24}'/g) ?? []
    expect(ids).toHaveLength(11)
    expect(MIGRATION).not.toContain('6902d3ebb9fba65197979245')
    expect(MIGRATION).not.toContain('6ada61d95c8b95a1e9765229')
  })

  it('a migration pendente restringe leitura à gestão e não dá escrita a authenticated', () => {
    expect(MIGRATION).toMatch(/usuario_e_gestao\(\)/)
    expect(MIGRATION).toMatch(/revoke all on table public\.ulbra_operadores_vinculo from public, anon, authenticated/i)
    expect(MIGRATION).not.toMatch(/grant\s+(insert|update|delete|truncate)[^;]*to\s+authenticated/i)
  })
})
