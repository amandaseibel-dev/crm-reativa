import 'jsr:@supabase/functions-js/edge-runtime.d.ts'
import { createClient } from 'jsr:@supabase/supabase-js@2'

// tv-dados v3 (2026-11-10) — leitura dos indicadores da TV no formato do painel
// estático aprovado. v3 acrescenta `destaques` (rankings por operador, com foto)
// e o resultado do mês em centavos, lidos de public.tv_painel_operadores()
// (20261110200000). Sem essa função no banco, a v3 responde exatamente o que a
// v2 respondia, mais meta/dias úteis do snapshot e o ranking de acordos de hoje.
// Três portões, nenhum deles substituível pelo outro:
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

  // Função nova, lida como o próprio usuário. Ausente (migration não aplicada)
  // ou com erro → null, e a resposta cai no que o snapshot tem.
  const painel = await lerPainel(supabase)
  const fotos = painel ? await fotosPorId(auth, idsDoPainel(painel)) : {}

  const receptivo = await filaReceptivo(supabase)

  const pm = (painel?.mes ?? {}) as Record<string, unknown>
  const ph = (painel?.hoje ?? {}) as Record<string, unknown>

  return json(200, {
    atualizado_em: data.gerado_em ?? null,
    fonte: 'CRM ReATIVA One — tv_snapshot',
    resultado: {
      // Com o painel: valores em centavos, como estão em pagamentos. Sem ele:
      // os inteiros do snapshot, marcados em `precisao` para a tela não
      // inventar casas decimais.
      precisao:                    painel ? 'centavos' : 'inteiro',
      honorarios_hoje:             painel ? numOrNull(ph.honorarios) : numOrNull(hoje.honorarios),
      honorarios_mes:              painel ? numOrNull(pm.honorarios) : numOrNull(mes.honorarios),
      projecao_honorarios_mes:     numOrNull(mes.proj_honorarios),
      projecao_parcial:            mes.projecao_parcial === true,
      recuperado_hoje:             painel ? numOrNull(ph.recuperado) : numOrNull(hoje.recuperado),
      recuperado_mes:              painel ? numOrNull(pm.recuperado) : numOrNull(mes.recuperado),
      pagamentos_confirmados_hoje: numOrNull(hoje.pagamentos_confirmados),
      pagamentos_confirmados_mes:  numOrNull(mes.pagamentos_confirmados),
      acordos_fechados_hoje:       numOrNull(acordosHoje.fechados),
      acordos_fechados_mes:        null,
      // META é metas_projecao.meta_honorario (snapshot: mes.meta_empresa).
      // Projeção é outra coisa e segue em projecao_honorarios_mes.
      meta_honorarios_mes:         painel ? numOrNull(pm.meta_honorario) : numOrNull(mes.meta_empresa),
      dias_uteis_mes:              painel ? numOrNull(pm.dias_uteis_mes) : numOrNull(mes.dias_uteis_mes),
      dias_uteis_ate_hoje:         painel ? numOrNull(pm.dias_uteis_ate_hoje) : numOrNull(mes.dias_uteis_transcorridos),
    },
    rankings: {
      honorarios:       top3.map((r: Record<string, unknown>) => String(r.operador ?? '')).filter(Boolean),
      valor_recuperado: [],
      pagamentos:       [],
      acordos:          [],
    },
    destaques: painel ? destaquesDoPainel(painel, fotos) : destaquesDoSnapshot(top3, acordosHoje),
    receptivo,
  })
})

type Linha = Record<string, unknown>

async function lerPainel(supabase: ReturnType<typeof createClient>): Promise<Linha | null> {
  try {
    const { data, error } = await supabase.rpc('tv_painel_operadores')
    if (error || !data || typeof data !== 'object') return null
    return data as Linha
  } catch {
    return null
  }
}

const RE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function idsDoPainel(painel: Linha): string[] {
  const ids = new Set<string>()
  const lider = painel.lider_honorarios_mes as Linha | null
  if (lider?.usuario_id) ids.add(String(lider.usuario_id))
  for (const k of LISTAS) {
    const lista = Array.isArray(painel[k]) ? painel[k] as Linha[] : []
    for (const r of lista) if (r?.usuario_id) ids.add(String(r.usuario_id))
  }
  return [...ids].filter((v) => RE_UUID.test(v))
}

// Fotos pelo caminho oficial do CRM: a Edge Function foto-perfil-url, chamada
// com o JWT do próprio usuário da TV. Ela resolve o caminho no servidor e
// devolve URL assinada de 5 min — nenhuma permissão nova, nenhum caminho
// interno sai daqui. Falha → sem foto (a tela usa iniciais).
async function fotosPorId(auth: string, ids: string[]): Promise<Record<string, string>> {
  if (!ids.length) return {}
  try {
    const r = await fetch(`${Deno.env.get('SUPABASE_URL')}/functions/v1/foto-perfil-url`, {
      method: 'POST',
      headers: { Authorization: auth, apikey: Deno.env.get('SUPABASE_ANON_KEY')!, 'Content-Type': 'application/json' },
      body: JSON.stringify({ usuario_ids: ids }),
    })
    if (!r.ok) return {}
    const j = await r.json()
    return j && typeof j.urls === 'object' && j.urls ? j.urls as Record<string, string> : {}
  } catch {
    return {}
  }
}

const LISTAS = ['podio_mes', 'top_honorario_pagamento_mes', 'top_recuperado_mes', 'top_pagamentos_hoje', 'top_acordos_hoje'] as const

// O id do operador NÃO sai para o navegador: vira só a URL assinada da foto.
function pessoa(r: Linha, fotos: Record<string, string>) {
  const id = String(r.usuario_id ?? '')
  return {
    nome: String(r.nome ?? '').trim(),
    foto: (id && fotos[id]) || null,
    valor: numOrNull(r.valor),
    qtd: numOrNull(r.qtd),
    data: typeof r.data === 'string' ? r.data : null,
  }
}

function destaquesDoPainel(painel: Linha, fotos: Record<string, string>) {
  const lista = (k: string) => (Array.isArray(painel[k]) ? painel[k] as Linha[] : []).slice(0, 3).map((r) => pessoa(r, fotos))
  const lider = painel.lider_honorarios_mes as Linha | null
  return {
    fonte: 'tv_painel_operadores',
    precisao: 'centavos',
    referencia: painel.referencia ?? null,
    // Pódio de reconhecimento: só nome e foto (decisão da gestão para este
    // card). Os cards de ranking abaixo levam o resultado.
    lider_honorarios_mes: lider ? { ...pessoa(lider, fotos), valor: null, qtd: null } : null,
    podio_mes: lista('podio_mes').map((x) => ({ ...x, valor: null, qtd: null })),
    top_honorario_pagamento_mes: lista('top_honorario_pagamento_mes'),
    top_recuperado_mes: lista('top_recuperado_mes'),
    top_pagamentos_hoje: lista('top_pagamentos_hoje'),
    top_acordos_hoje: lista('top_acordos_hoje'),
  }
}

// Sem a função nova: só o que o snapshot já garante. Rankings que o snapshot
// não tem (ele guarda apenas o 1º colocado) ficam null = "dado indisponível" —
// nunca um top 3 montado com um só nome.
function destaquesDoSnapshot(top3: unknown[], acordosHoje: Record<string, unknown>) {
  const l = (top3[0] ?? null) as Linha | null
  const ranking = Array.isArray(acordosHoje.ranking) ? acordosHoje.ranking as Linha[] : []
  return {
    fonte: 'tv_snapshot',
    precisao: 'inteiro',
    referencia: null,
    lider_honorarios_mes: l && l.operador
      ? { nome: String(l.operador), foto: null, valor: null, qtd: null, data: null }
      : null,
    podio_mes: (top3 as Linha[])
      .filter((r) => r?.operador)
      .slice(0, 3)
      .map((r) => ({ nome: String(r.operador), foto: null, valor: null, qtd: null, data: null })),
    top_honorario_pagamento_mes: null,
    top_recuperado_mes: null,
    top_pagamentos_hoje: null,
    top_acordos_hoje: ranking
      .filter((r) => r?.operador && String(r.operador) !== 'Sem responsável')
      .slice(0, 3)
      .map((r) => ({ nome: String(r.operador), foto: null, valor: null, qtd: numOrNull(r.fechados), data: null })),
  }
}

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
