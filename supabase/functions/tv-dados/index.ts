import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { createClient } from 'jsr:@supabase/supabase-js@2'

// tv-dados v2 (2026-11-04) — leitura dos indicadores da TV no formato do painel
// estático aprovado. Três portões, nenhum deles substituível pelo outro:
//   1. gateway: verify_jwt=true (sem JWT válido, nem chega aqui);
//   2. identidade: auth.getUser() tem de devolver um usuário real — a anon key
//      e a service role key passam no gateway mas NÃO têm usuário;
//   3. autorização: public.tv_pode_ler_snapshot() (allowlist de e-mails da TV),
//      e tv_snapshot_ler() roda como o próprio usuário, sem service role.

const CORS = {
  'Access-Control-Allow-Origin': 'https://reativa-tv.netlify.app',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type, apikey',
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  })
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS })
  if (req.method !== 'GET') return json(405, { error: 'Method Not Allowed' })

  const auth = req.headers.get('Authorization') ?? ''
  if (!auth.startsWith('Bearer ')) return json(401, { error: 'autenticacao obrigatoria' })

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_ANON_KEY')!,
    {
      global: { headers: { Authorization: auth } },
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    },
  )

  const { data: u, error: ue } = await supabase.auth.getUser()
  if (ue || !u?.user?.email) return json(401, { error: 'sessao de usuario invalida' })

  const { data: pode, error: pe } = await supabase.rpc('tv_pode_ler_snapshot')
  if (pe || pode !== true) return json(403, { error: 'usuario sem permissao para os indicadores da TV' })

  const { data, error } = await supabase.rpc('tv_snapshot_ler')
  if (error) {
    const negado = String(error.code ?? '') === '42501' || /Acesso negado/i.test(String(error.message ?? ''))
    return json(negado ? 403 : 503, { error: negado ? 'acesso negado' : 'snapshot indisponivel' })
  }
  if (!data?.payload) return json(503, { error: 'snapshot indisponivel' })

  const p = data.payload as Record<string, unknown>
  const hoje = (p.hoje ?? {}) as Record<string, unknown>
  const mes = (p.mes ?? {}) as Record<string, unknown>
  const rankings = (p.rankings ?? {}) as Record<string, unknown>
  const acordosHoje = (p.acordos_hoje ?? {}) as Record<string, unknown>
  const top3 = Array.isArray(rankings.top3_mes) ? rankings.top3_mes : []

  const receptivo = await filaReceptivo(supabase)

  return json(200, {
    atualizado_em: data.gerado_em ?? null,
    fonte: 'CRM ReATIVA One — tv_snapshot',
    resultado: {
      honorarios_hoje:             numOrNull(hoje.honorarios),
      honorarios_mes:              numOrNull(mes.honorarios),
      projecao_honorarios_mes:     numOrNull(mes.proj_honorarios),
      projecao_parcial:            mes.projecao_parcial === true,
      recuperado_hoje:             numOrNull(hoje.recuperado),
      recuperado_mes:              numOrNull(mes.recuperado),
      pagamentos_confirmados_hoje: numOrNull(hoje.pagamentos_confirmados),
      pagamentos_confirmados_mes:  numOrNull(mes.pagamentos_confirmados),
      acordos_fechados_hoje:       numOrNull(acordosHoje.fechados),
      acordos_fechados_mes:        null,
    },
    rankings: {
      honorarios:       top3.map((r: Record<string, unknown>) => String(r.operador ?? '')).filter(Boolean),
      valor_recuperado: [],
      pagamentos:       [],
      acordos:          [],
    },
    receptivo,
  })
})

function numOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

// Fila do Receptivo — mesma regra da tela FilaReceptivo do CRM: participantes
// (usuarios.receptivo), sem pausa, com heartbeat nos últimos 90 s, ordenados por
// atendimentos_hoje, depois ultimo_atendimento, depois online_em. Lida como o
// usuário (RLS de fila_receptivo/usuarios), devolve só nomes. Falha → vazio.
const LIMITE_ONLINE_MS = 90 * 1000

type LinhaFila = {
  email: string | null
  nome: string | null
  atendimentos_hoje: number | null
  ultimo_atendimento: string | null
  online_em: string | null
  em_pausa: boolean | null
}

async function filaReceptivo(supabase: ReturnType<typeof createClient>) {
  const vazio = { atualizado_em: null as string | null, online: null as number | null, proximos: [] as string[] }
  try {
    const { data: usuarios, error: eu } = await supabase
      .from('usuarios').select('email, apelido').eq('receptivo', true)
    if (eu || !usuarios?.length) return vazio

    const apelidoPor = new Map<string, string>()
    for (const u of usuarios as Array<{ email: string | null; apelido: string | null }>) {
      const e = String(u.email ?? '').trim().toLowerCase()
      if (e) apelidoPor.set(e, String(u.apelido ?? '').trim())
    }
    const emails = [...apelidoPor.keys()]

    const { data: linhas, error: ef } = await supabase
      .from('fila_receptivo')
      .select('email, nome, atendimentos_hoje, ultimo_atendimento, online_em, em_pausa')
      .in('email', emails)
    if (ef) return vazio

    const agora = Date.now()
    const t = (v: string | null) => (v ? Date.parse(v) || 0 : 0)
    const online = ((linhas ?? []) as LinhaFila[])
      .filter((l) => !l.em_pausa && l.online_em && agora - t(l.online_em) <= LIMITE_ONLINE_MS)
      .sort((a, b) =>
        (a.atendimentos_hoje ?? 0) - (b.atendimentos_hoje ?? 0) ||
        t(a.ultimo_atendimento) - t(b.ultimo_atendimento) ||
        t(a.online_em) - t(b.online_em))

    const nome = (l: LinhaFila) =>
      apelidoPor.get(String(l.email ?? '').trim().toLowerCase()) ||
      String(l.nome ?? '').trim().split(/\s+/)[0] || ''

    return {
      atualizado_em: new Date().toISOString(),
      online: online.length,
      proximos: online.slice(0, 4).map(nome).filter(Boolean),
    }
  } catch {
    return vazio
  }
}
