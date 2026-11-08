// Leitor server-side do mapeamento operador ReATIVA ↔ atendente ULBRA.
// Só para Edge Functions, com cliente service_role. Nunca importar no frontend.
// Lê public.ulbra_operadores_vinculo (migration pendente em
// supabase/aguardando_aprovacao/). Id desconhecido ou inativo → null.
// Nunca casa por nome.

export interface ConsultaSupabase {
  from(tabela: string): {
    select(colunas: string): {
      eq(coluna: string, valor: unknown): {
        eq(coluna: string, valor: unknown): {
          maybeSingle(): Promise<{ data: { email_reativa: string } | null; error: unknown }>
        }
      }
    }
  }
}

export async function emailReativaPorIdUlbra(
  admin: ConsultaSupabase,
  idUlbra: string,
): Promise<string | null> {
  if (!/^[0-9a-f]{24}$/.test(idUlbra)) return null
  const { data, error } = await admin
    .from('ulbra_operadores_vinculo')
    .select('email_reativa')
    .eq('id_ulbra', idUlbra)
    .eq('ativo', true)
    .maybeSingle()
  if (error || !data) return null
  return data.email_reativa
}
