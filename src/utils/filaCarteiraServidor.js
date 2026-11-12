// Fila "sem interação" da CARTEIRA, consultada no SERVIDOR (Postgres via PostgREST).
//
// Não busca a carteira inteira para filtrar no navegador:
//  - operador_email = o próprio usuário (explícito; a RLS de casos também deixa
//    ler casos SEM operador, então o filtro não pode ser omitido);
//  - GESTÃO sem filtro (`todas: true`): operador_email NÃO nulo, qualquer
//    operador — a RLS de `casos` é quem decide o que a gestão lê; caso sem
//    operador continua fora;
//  - data_ultimo_acionamento <= hoje - 8 dias (8 dias ou mais: fora do prazo);
//  - aluno_id não nulo (o caso aponta para um aluno);
//  - ordenação e paginação no servidor (range), desempate por aluno_id.
// Casos internos NÃO exigem vínculo ULBRA: esta consulta não olha a Mensageria.
import { diasSemContato, nomeAluno } from "./carteiraFila";
import { faixaDeDias, PRAZO_DIAS } from "./filaSemInteracaoCarteira";

export const DIAS_CORTE = PRAZO_DIAS + 1; // 8 dias

function dataCorte(agoraMs) {
  return new Date(agoraMs - DIAS_CORTE * 86400000).toISOString().slice(0, 10);
}

/**
 * Monta a consulta (sem executar).
 * `todas` só vale para a gestão (visão "todas as carteiras"); sem `todas`, o
 * operador é obrigatório — nunca se consulta "sem filtro" por acidente.
 */
export function montarConsultaFilaCarteira(supabase, { operador, todas = false, agoraMs, de = 0, ate = 49 }) {
  let q = supabase
    .from("casos")
    .select("id, aluno_id, nome, data_ultimo_acionamento, operador_email");
  q = todas === true ? q.not("operador_email", "is", null) : q.eq("operador_email", operador);
  return q
    .not("aluno_id", "is", null)
    .not("data_ultimo_acionamento", "is", null)
    .lte("data_ultimo_acionamento", dataCorte(agoraMs))
    .order("data_ultimo_acionamento", { ascending: true })
    .order("aluno_id", { ascending: true })
    .range(de, ate);
}

/**
 * Uma página da fila, na forma da Central. `temMais` vem de pedir uma linha a mais.
 * Com `todas: true` (gestão), cada linha traz o operador da carteira em
 * `responsavel_reativa` e `minha` é false — ver não é responder.
 * @returns {{ linhas: Array, temMais: boolean, erro: string|null }}
 */
export async function buscarFilaCarteira(supabase, { operador, todas = false, agoraMs = Date.now(), pagina = 0, tamanho = 50 }) {
  const eu = String(operador || "").toLowerCase();
  if (todas !== true && !eu) return { linhas: [], temMais: false, erro: "operador não informado" };
  const de = pagina * tamanho;
  const ate = de + tamanho;
  const { data, error } = await montarConsultaFilaCarteira(supabase, { operador: eu, todas: todas === true, agoraMs, de, ate });
  if (error) return { linhas: [], temMais: false, erro: error.message || "falha ao ler a carteira" };
  const brutas = Array.isArray(data) ? data : [];
  const temMais = brutas.length > tamanho;
  const linhas = [];
  for (const c of brutas.slice(0, tamanho)) {
    const dono = String(c.operador_email || "").toLowerCase();
    // defesa em profundidade: caso sem operador nunca entra; fora de `todas`,
    // caso de outro operador também não
    if (!dono) continue;
    if (todas !== true && dono !== eu) continue;
    const dias = diasSemContato(c, agoraMs);
    const faixa = dias === null ? null : faixaDeDias(dias);
    if (!faixa) continue; // defesa extra: o servidor já filtrou
    linhas.push({
      aluno_id: c.aluno_id,
      nome: nomeAluno(c),
      dias_sem_acionamento: dias,
      faixa,
      ultimo_acionamento: c.data_ultimo_acionamento,
      responsavel_reativa: dono,
      responsabilidade: "CARTEIRA",
      minha: todas !== true,
      responsavel_definido: true,
      notificar: false,
      origem: "carteira",
    });
  }
  return { linhas, temMais, erro: null };
}
