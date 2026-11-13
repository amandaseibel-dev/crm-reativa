// ===========================================================================
// Cliente SOMENTE LEITURA do histórico ULBRA (função ulbra-historico).
// Não há conexão, prévia de envio, confirmação nem rota de autorização externa neste módulo.
// Toda chamada leva o JWT do usuário; nenhuma usa credencial central.
// Cada página consome 1 chamada da cota de backend da ULBRA: só ao clicar.
// ===========================================================================
import { supabase } from "../services/supabase";

async function chamar(funcao, corpo) {
  const { data: { session } } = await supabase.auth.getSession();
  const token = session?.access_token;
  if (!token) return { ok: false, motivo: "SEM_SESSAO", http: 0 };
  const resp = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/${funcao}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(corpo),
  });
  let json;
  try { json = await resp.json(); } catch { json = null; }
  if (!json) return { ok: false, motivo: resp.ok ? "RESPOSTA_VAZIA" : `HTTP_${resp.status}`, http: resp.status };
  return { ...json, http: resp.status, ok: json.ok ?? resp.ok };
}

/** Histórico sob demanda: 1 chamada por página. Só deve ser chamada por clique do usuário. */
/** Histórico pela FICHA do aluno: o servidor resolve a conversa. 1 chamada por página, só ao clicar. */
export function lerHistoricoDoAluno(alunoId, antesDe = null) {
  return chamar("ulbra-historico", { aluno_id: alunoId, antes_de: antesDe });
}

export function lerHistorico(conversaId, antesDe = null) {
  return chamar("ulbra-historico", { conversa_id: conversaId, antes_de: antesDe });
}

export const MOTIVOS_HISTORICO = {
  IDENTIDADE_NAO_CONFIRMADA: "Aluno sem CPF confirmado: o histórico não é lido.",
  SEM_PERMISSAO_NA_CONVERSA: "Esta conversa não é da sua carteira nem está sob sua responsabilidade.",
  SALDO_SEM_INFORMACAO: "Sem medida recente da cota da Mensageria: leitura bloqueada para não estourar o limite.",
  SALDO_DESATUALIZADO: "A medida da cota venceu: leitura bloqueada até nova medida.",
  LIMITE_OPERADOR_DIA: "Você atingiu o limite diário de leituras de histórico.",
  RESERVA_GLOBAL: "A cota diária da Mensageria está reservada para a coleta: tente mais tarde.",
  ULBRA_INDISPONIVEL: "A Mensageria não respondeu. A chamada contou na cota; não foi repetida.",
  CONVERSA_INVALIDA: "Conversa inválida.",
  CONVERSA_NAO_ENCONTRADA: "Este aluno ainda não tem conversa coletada na Mensageria.",
  TETO_PILOTO_ESGOTADO: "O limite de consultas do piloto foi atingido. Nenhuma consulta foi feita.",
  ULBRA_LIMITE: "A Mensageria devolveu limite de uso (429). A consulta parou; não será repetida.",
  ALUNO_ID_INVALIDO: "Aluno inválido.",
};

/** Traduz a resposta da função para o estado que a Central exibe. Acumula páginas quando `anterior` vem. */
export function mapearHistorico(resposta, anterior = null) {
  if (!resposta || resposta.ok !== true) {
    const motivo = resposta?.motivo || resposta?.erro || "ULBRA_INDISPONIVEL";
    return { estado: "erro", mensagens: anterior?.mensagens || [], erro: MOTIVOS_HISTORICO[motivo] || motivo, motivo, antesDe: anterior?.antesDe ?? null };
  }
  const novas = resposta.pagina?.mensagens || [];
  const mensagens = anterior ? [...novas, ...anterior.mensagens] : novas;
  const antesDe = resposta.pagina?.antes_de || null;
  return {
    estado: mensagens.length === 0 ? "vazio" : antesDe ? "parcial" : "ok",
    mensagens, antesDe, origem: resposta.origem || null, chamadas: resposta.chamadas ?? null, erro: null, motivo: null,
  };
}

