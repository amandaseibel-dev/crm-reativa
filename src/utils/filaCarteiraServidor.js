// Fila "sem interação" da CARTEIRA, consultada no SERVIDOR (Postgres via PostgREST).
//
// Não busca a carteira inteira para filtrar no navegador:
//  - operador_email = o próprio usuário (explícito; a RLS de casos também deixa
//    ler casos SEM operador, então o filtro não pode ser omitido);
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

/** Monta a consulta (sem executar). */
export function montarConsultaFilaCarteira(supabase, { operador, agoraMs, de = 0, ate = 49 }) {
  return supabase
    .from("casos")
    .select("id, aluno_id, nome, data_ultimo_acionamento, operador_email")
    .eq("operador_email", operador)
    .not("aluno_id", "is", null)
    .not("data_ultimo_acionamento", "is", null)
    .lte("data_ultimo_acionamento", dataCorte(agoraMs))
    .order("data_ultimo_acionamento", { ascending: true })
    .order("aluno_id", { ascending: true })
    .range(de, ate);
}

/**
 * Uma página da fila, na forma da Central. `temMais` vem de pedir uma linha a mais.
 * @returns {{ linhas: Array, temMais: boolean, erro: string|null }}
 */
export async function buscarFilaCarteira(supabase, { operador, agoraMs = Date.now(), pagina = 0, tamanho = 50 }) {
  const de = pagina * tamanho;
  const ate = de + tamanho;
  const { data, error } = await montarConsultaFilaCarteira(supabase, { operador, agoraMs, de, ate });
  if (error) return { linhas: [], temMais: false, erro: error.message || "falha ao ler a carteira" };
  const brutas = Array.isArray(data) ? data : [];
  const temMais = brutas.length > tamanho;
  const linhas = [];
  for (const c of brutas.slice(0, tamanho)) {
    const dias = diasSemContato(c, agoraMs);
    const faixa = dias === null ? null : faixaDeDias(dias);
    if (!faixa) continue; // defesa extra: o servidor já filtrou
    linhas.push({
      aluno_id: c.aluno_id,
      nome: nomeAluno(c),
      dias_sem_acionamento: dias,
      faixa,
      ultimo_acionamento: c.data_ultimo_acionamento,
      responsavel_reativa: operador,
      responsabilidade: "CARTEIRA",
      minha: true,
      responsavel_definido: true,
      notificar: false,
      origem: "carteira",
    });
  }
  return { linhas, temMais, erro: null };
}
