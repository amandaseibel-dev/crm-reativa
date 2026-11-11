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

/** Prévia na própria Mensageria: custo, janela e recusa. Nada é enviado. 1 chamada da cota do operador. */
export function envioPrevia(conversaId, texto) {
  return chamar("ulbra-conversa", { acao: "envio_previa", conversa_id: conversaId, texto });
}
/** Envio confirmado, idempotente pela chave. 1 chamada da cota do operador. */
export function envioConfirmar(conversaId, texto, chave, previa = {}) {
  return chamar("ulbra-conversa", {
    acao: "envio_confirmar", conversa_id: conversaId, texto, chave,
    previa_custo_usd: typeof previa.custo_usd === "number" ? previa.custo_usd : undefined,
    previa_janela_aberta: typeof previa.janela_aberta === "boolean" ? previa.janela_aberta : undefined,
    previa_em: previa.em || undefined,
  });
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

/** Resume a prévia da Mensageria para a confirmação: custo, janela e recusa, sem inventar valor. */
export function resumirPrevia(resposta) {
  if (!resposta) return { ok: false, recusa: "Sem resposta da prévia.", custo_usd: null, janela_aberta: null, texto: null };
  if (resposta.ok !== true) {
    const motivo = resposta.recusa || (resposta.motivos || []).join(", ") || resposta.motivo || "prévia recusada";
    return { ok: false, recusa: String(motivo), custo_usd: null, janela_aberta: resposta.contexto?.janela_aberta ?? null, texto: null };
  }
  const p = resposta.previa || {};
  const custo = typeof p.custoEstimado === "number" ? p.custoEstimado : typeof p.custo === "number" ? p.custo : typeof p.custoUsd === "number" ? p.custoUsd : null;
  const janela = typeof p.janelaAberta === "boolean" ? p.janelaAberta : resposta.contexto?.janela_aberta ?? null;
  return { ok: true, recusa: null, custo_usd: custo, janela_aberta: janela, texto: typeof p.texto === "string" ? p.texto : null, em: new Date().toISOString() };
}
