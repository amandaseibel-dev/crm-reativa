// ===========================================================================
// Cliente das funções `ulbra-historico` e `ulbra-conversa` para a tela.
//
// Toda chamada leva o JWT do usuário logado; nenhuma usa credencial central.
// Cada chamada que vai à ULBRA custa cota: histórico (1 por página, cota da
// credencial de backend), prévia e envio (1 cada, cota DO OPERADOR), conexão
// (1 `meu_acesso` do operador ao conectar). A tela mostra isso antes do clique.
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

/** Histórico sob demanda: 1 chamada por página (cota da credencial de backend). */
export function lerHistorico(conversaId, antesDe = null) {
  return chamar("ulbra-historico", { conversa_id: conversaId, antes_de: antesDe });
}

export function conexaoEstado() { return chamar("ulbra-conversa", { acao: "conexao_estado" }); }
export function conexaoIniciar() { return chamar("ulbra-conversa", { acao: "conexao_iniciar" }); }
export function conexaoConcluir(code, state) { return chamar("ulbra-conversa", { acao: "conexao_concluir", code, state }); }
export function conexaoDesconectar() { return chamar("ulbra-conversa", { acao: "conexao_desconectar" }); }

/**
 * Prévia registrada no servidor: valida agora e guarda por validade curta. Nada é enviado
 * e a Mensageria não é chamada nesta etapa. Devolve previa_id, usado na confirmação.
 */
export function envioPrevia(conversaId, texto) {
  return chamar("ulbra-conversa", { acao: "envio_previa", conversa_id: conversaId, texto });
}
/**
 * Confirma o envio consumindo a prévia (previa_id). Idempotente pela chave.
 * Custo e janela NÃO são enviados pelo navegador: o servidor os decide.
 */
export function envioConfirmar(previaId, texto, chave) {
  return chamar("ulbra-conversa", { acao: "envio_confirmar", previa_id: previaId, texto, chave });
}

// ------------------------------------------------------------ puros (testáveis)

export const MOTIVOS_HISTORICO = {
  IDENTIDADE_NAO_CONFIRMADA: "Aluno sem CPF confirmado: o histórico não é lido.",
  SEM_PERMISSAO_NA_CONVERSA: "Esta conversa não é da sua carteira nem está sob sua responsabilidade.",
  SALDO_SEM_INFORMACAO: "Sem medida recente da cota da Mensageria: leitura bloqueada para não estourar o limite.",
  SALDO_DESATUALIZADO: "A medida da cota venceu: leitura bloqueada até nova medida.",
  LIMITE_OPERADOR_DIA: "Você atingiu o limite diário de leituras de histórico.",
  RESERVA_GLOBAL: "A cota diária da Mensageria está reservada para a coleta: tente mais tarde.",
  ULBRA_INDISPONIVEL: "A Mensageria não respondeu. A chamada contou na cota; não foi repetida.",
  CONVERSA_INVALIDA: "Conversa inválida.",
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

export const ROTULO_CONEXAO = {
  SEM_CONEXAO: "Sua conta da Mensageria não está conectada.",
  ATIVA: "Conectado à Mensageria com a sua conta.",
  EXPIRANDO: "Conectado (renovação automática ao usar).",
  EXPIRADA: "Conexão expirada: conecte de novo para responder.",
  REVOGADA: "Conexão desfeita: conecte de novo para responder.",
};

/** Só ATIVA ou EXPIRANDO permitem prévia e envio. */
export function conexaoPermiteEnvio(estado) {
  return estado === "ATIVA" || estado === "EXPIRANDO";
}

/** Resume a resposta de envio_previa: prévia registrada (com previa_id) ou o motivo da recusa. */
export function resumirPrevia(resposta) {
  if (!resposta) return { ok: false, recusa: "Sem resposta da prévia.", previa_id: null, expira_em_ms: null, janela_aberta: null };
  if (resposta.ok !== true || resposta.situacao === "BLOQUEADO") {
    const motivo = (resposta.motivos || []).join(", ") || resposta.motivo || resposta.recusa || "prévia recusada";
    return { ok: false, recusa: String(motivo), previa_id: null, expira_em_ms: null, janela_aberta: null };
  }
  return {
    ok: true,
    recusa: null,
    previa_id: typeof resposta.previa_id === "string" ? resposta.previa_id : null,
    expira_em_ms: typeof resposta.expira_em_ms === "number" ? resposta.expira_em_ms : null,
    janela_aberta: resposta.janela_aberta === true,
  };
}
