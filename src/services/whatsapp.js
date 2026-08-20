// Acesso da Central WhatsApp ao backend.
//
// Tudo passa por RPC (autorizada pelo JWT) ou pelas Edge Functions. O frontend
// NUNCA vê segredo do gateway nem escolhe por qual número responder: quem
// decide isso é a conversa, no banco.
import { supabase } from "./supabase";
import { normalizarE164 } from "../utils/telefone";

export const STATUS_CONVERSA = {
  NOVO: "NOVO",
  EM_ATENDIMENTO: "EM_ATENDIMENTO",
  RESPONDIDO: "RESPONDIDO",
  ENCERRADO: "ENCERRADO",
};

export const ROTULO_STATUS = {
  NOVO: "Novo",
  EM_ATENDIMENTO: "Em atendimento",
  RESPONDIDO: "Respondido",
  ENCERRADO: "Encerrado",
};

// Filtros derivados do dado — não são status guardados em coluna.
export const FILTRO_SEM_RETORNO = "SEM_RETORNO";
export const FILTRO_NAO_LIDAS = "NAO_LIDAS";
export const FILTRO_SEM_RESPONSAVEL = "SEM_RESPONSAVEL";
export const FILTRO_MINHAS = "MINHAS";
// Arquivadas nao e status: e a coluna `arquivada_em`. Fica aqui junto com os
// outros filtros derivados porque, para a tela, funciona igual.
export const FILTRO_ARQUIVADAS = "ARQUIVADAS";

export const ROTULO_CONEXAO = {
  CONECTADO: "Conectado",
  CONECTANDO: "Conectando",
  AGUARDANDO_QR: "Aguardando QR Code",
  DESCONECTADO: "Desconectado",
  PAREAMENTO_NECESSARIO: "Precisa ler o QR de novo",
  ERRO: "Erro de conexão",
};

// ---------------------------------------------------------------------------
// Painéis
// ---------------------------------------------------------------------------

export async function carregarResumo() {
  const { data, error } = await supabase.rpc("whatsapp_resumo");
  if (error) throw new Error(error.message);
  return (Array.isArray(data) ? data[0] : data) || null;
}

export async function carregarSupervisao() {
  const { data, error } = await supabase.rpc("whatsapp_supervisao");
  if (error) throw new Error(error.message);
  return data || [];
}

export async function carregarSyncStatus() {
  const { data, error } = await supabase.rpc("whatsapp_sync_status");
  if (error) throw new Error(error.message);
  return data || [];
}

export async function souGestao() {
  const { data, error } = await supabase.rpc("usuario_e_gestao");
  if (error) return false;
  return Boolean(data);
}

// Há quanto tempo espera. Devolve texto curto e um nível de urgência para a
// tela pintar sem repetir regra de negócio.
export function esperaDesde(iso) {
  if (!iso) return null;
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return null;

  const minutos = Math.floor(ms / 60000);
  const horas = Math.floor(minutos / 60);
  const dias = Math.floor(horas / 24);

  let texto;
  if (minutos < 60) texto = `${minutos}min`;
  else if (horas < 24) texto = `${horas}h`;
  else texto = `${dias}d`;

  // calmo até 1h · atenção até 24h · crítico depois disso
  const nivel = horas >= 24 ? "critico" : horas >= 1 ? "atencao" : "calmo";
  return { texto, nivel, minutos };
}

// ---------------------------------------------------------------------------
// Canais e conexão
// ---------------------------------------------------------------------------

export async function listarCanais() {
  const { data, error } = await supabase.rpc("whatsapp_canais_listar");
  if (error) throw new Error(error.message);
  return data || [];
}

// QR é credencial de acesso ao WhatsApp da empresa: só gestão, e a leitura fica
// registrada no banco.
export async function carregarQr(canalId) {
  const { data, error } = await supabase.rpc("whatsapp_canal_qr", { p_canal_id: canalId });
  if (error) throw new Error(error.message);
  return (Array.isArray(data) ? data[0] : data) || null;
}

export async function comandarSessao(canalId, comando) {
  const { data, error } = await supabase.functions.invoke("whatsapp-sessao", {
    body: { canal_id: canalId, comando },
  });
  if (error) throw new Error(await detalharErro(error));
  if (data?.erro) throw new Error(data.erro);
  return data;
}

export async function salvarCanal({ id, apelido, numero, sessaoChave, ativo } = {}) {
  const { data, error } = await supabase.rpc("whatsapp_canal_salvar", {
    p_apelido: apelido,
    p_display_numero: numero,
    p_sessao_chave: sessaoChave,
    p_id: id || null,
    p_ativo: ativo === undefined ? true : Boolean(ativo),
  });
  if (error) throw new Error(error.message);
  return data;
}

// ---------------------------------------------------------------------------
// Conversas
// ---------------------------------------------------------------------------

export async function listarConversas({ status, canalId, busca, limite, responsavel } = {}) {
  const { data, error } = await supabase.rpc("whatsapp_conversas_listar", {
    p_status: status || null,
    p_canal_id: canalId || null,
    p_busca: busca || null,
    p_limite: limite || 100,
    p_responsavel: responsavel || null,
  });
  if (error) throw new Error(error.message);
  return data || [];
}

export async function listarMensagens(conversaId, limite = 200) {
  const { data, error } = await supabase.rpc("whatsapp_mensagens_listar", {
    p_conversa_id: conversaId,
    p_limite: limite,
  });
  if (error) throw new Error(error.message);
  // A RPC devolve do mais novo para o mais velho (para o LIMIT pegar o fim da
  // conversa); a tela lê de cima para baixo.
  return (data || []).slice().reverse();
}

export async function assumirConversa(conversaId) {
  const { error } = await supabase.rpc("whatsapp_assumir_conversa", { p_conversa_id: conversaId });
  if (error) throw new Error(error.message);
}

export async function transferirConversa(conversaId, paraEmail) {
  const { error } = await supabase.rpc("whatsapp_transferir_conversa", {
    p_conversa_id: conversaId,
    p_para_email: paraEmail,
  });
  if (error) throw new Error(error.message);
}

export async function retirarResponsavel(conversaId) {
  const { error } = await supabase.rpc("whatsapp_retirar_responsavel", { p_conversa_id: conversaId });
  if (error) throw new Error(error.message);
}

export async function marcarLida(conversaId) {
  const { error } = await supabase.rpc("whatsapp_marcar_lida", { p_conversa_id: conversaId });
  if (error) throw new Error(error.message);
}

// Arquivar tira a conversa das filas operacionais SEM alterar status,
// responsavel, nao_lidas ou historico — a RPC no banco garante isso. Nova
// mensagem de ENTRADA do aluno desarquiva sozinha, do lado do banco: e demanda
// nova, nao decisao nossa. Saida nossa nao desarquiva.
export async function arquivarConversa(conversaId) {
  const { error } = await supabase.rpc("whatsapp_arquivar_conversa", { p_conversa_id: conversaId });
  if (error) throw new Error(error.message);
}

export async function desarquivarConversa(conversaId) {
  const { error } = await supabase.rpc("whatsapp_desarquivar_conversa", { p_conversa_id: conversaId });
  if (error) throw new Error(error.message);
}

export async function encerrarConversa(conversaId) {
  const { error } = await supabase.rpc("whatsapp_encerrar_conversa", { p_conversa_id: conversaId });
  if (error) throw new Error(error.message);
}

export async function reabrirConversa(conversaId) {
  const { error } = await supabase.rpc("whatsapp_reabrir_conversa", { p_conversa_id: conversaId });
  if (error) throw new Error(error.message);
}

export async function listarOperadores() {
  const { data, error } = await supabase.rpc("whatsapp_operadores_listar");
  if (error) throw new Error(error.message);
  return data || [];
}

// ---------------------------------------------------------------------------
// Aluno — identificação leve na lista, ficha só quando a conversa é aberta
// ---------------------------------------------------------------------------

// Chamada SOMENTE ao abrir a conversa. Nunca por linha listada: com 11
// operadores olhando a central ao mesmo tempo, uma consulta por linha derrubaria
// o banco.
export async function carregarFichaAluno(conversaId) {
  const { data, error } = await supabase.rpc("whatsapp_aluno_resumo", { p_conversa_id: conversaId });
  if (error) throw new Error(error.message);
  return (Array.isArray(data) ? data[0] : data) || null;
}

export async function carregarCandidatos(conversaId) {
  const { data, error } = await supabase.rpc("whatsapp_conversa_candidatos", {
    p_conversa_id: conversaId,
  });
  if (error) throw new Error(error.message);
  return data || [];
}

export async function vincularAluno(conversaId, alunoId) {
  const { error } = await supabase.rpc("whatsapp_vincular_aluno", {
    p_conversa_id: conversaId,
    p_aluno_id: alunoId,
  });
  if (error) throw new Error(error.message);
}

export async function buscarAluno(termo, limite = 20) {
  const { data, error } = await supabase.rpc("whatsapp_buscar_aluno", {
    p_termo: termo,
    p_limite: limite,
  });
  if (error) throw new Error(error.message);
  return data || [];
}

// Abre a ficha completa do aluno no padrão já usado no resto do CRM.
export function abrirFichaDoAluno(alunoId) {
  if (!alunoId) return;
  localStorage.setItem("reativa_aluno_abrir_id", alunoId);
  window.open("/aluno", "_blank");
}

// ---------------------------------------------------------------------------
// Envio
// ---------------------------------------------------------------------------

async function detalharErro(error) {
  try {
    const corpo = await error.context?.json?.();
    if (corpo?.erro) return corpo.erro;
  } catch {
    /* mantém a mensagem original */
  }
  return error.message;
}

// O número de saída é decidido no BANCO a partir da conversa. Se o canal estiver
// fora do ar ou a conversa for de outro operador, a RPC recusa antes de o
// gateway ser chamado.
export async function enviarMensagem(conversaId, texto) {
  const { data, error } = await supabase.functions.invoke("whatsapp-send", {
    body: { conversa_id: conversaId, texto },
  });
  if (error) throw new Error(await detalharErro(error));
  if (data?.erro) throw new Error(data.erro);
  return data;
}

// ---------------------------------------------------------------------------
// NOVA CONVERSA — o operador inicia o contato
//
// Sem isto, iniciar contato obrigava o operador a sair da Central para o
// celular ou o WhatsApp Web. O que sai por fora não tem histórico aqui, não tem
// responsável e não aparece na supervisão — some da operação.
// ---------------------------------------------------------------------------

// Chamada enquanto o operador digita o número. Serve para avisar ANTES que já
// existe conversa com aquela pessoa (e de quem ela é), em vez de o operador
// descobrir depois de escrever a mensagem — ou abrir um atendimento paralelo ao
// de um colega sem perceber.
export async function procurarConversaPorTelefone(canalId, telefone) {
  if (!canalId || !normalizarE164(telefone)) return null;
  const { data, error } = await supabase.rpc("whatsapp_conversa_por_telefone", {
    p_canal_id: canalId,
    p_telefone: telefone,
  });
  if (error) throw new Error(error.message);
  const linha = Array.isArray(data) ? data[0] : data;
  return linha || null;
}

// A conversa nasce no envio, não ao abrir o formulário: quem desiste no meio
// não deixa conversa vazia na caixa de entrada. O número de saída continua
// sendo decidido no banco — daqui vai o canal, nunca a sessão.
export async function iniciarConversa({ canalId, telefone, alunoId, texto } = {}) {
  const { data, error } = await supabase.functions.invoke("whatsapp-send", {
    body: {
      canal_id: canalId,
      telefone,
      aluno_id: alunoId || null,
      texto,
    },
  });
  if (error) throw new Error(await detalharErro(error));
  if (data?.erro) throw new Error(data.erro);
  return data;
}

// ---------------------------------------------------------------------------
// LEADS RECEBIDOS — registro manual, funciona sem nenhuma integração no ar.
// ---------------------------------------------------------------------------

export async function listarLeads({ status, busca, limite } = {}) {
  const { data, error } = await supabase.rpc("whatsapp_leads_listar", {
    p_status: status || null,
    p_busca: busca || null,
    p_limite: limite || 200,
  });
  if (error) throw new Error(error.message);
  return data || [];
}

export async function registrarLead({ telefone, nome, canalId, assunto } = {}) {
  const { data, error } = await supabase.rpc("whatsapp_lead_registrar", {
    p_telefone: telefone,
    p_nome: nome || null,
    p_canal_id: canalId || null,
    p_assunto: assunto || null,
  });
  if (error) throw new Error(error.message);
  return data;
}

export async function atualizarLead(id, { status, observacao, assumir } = {}) {
  const { error } = await supabase.rpc("whatsapp_lead_atualizar", {
    p_id: id,
    p_status: status || null,
    p_observacao: observacao || null,
    p_assumir: Boolean(assumir),
  });
  if (error) throw new Error(error.message);
}

export function linkWhatsApp(telefone) {
  const d = String(telefone || "").replace(/\D/g, "");
  return d ? `https://wa.me/${d}` : null;
}
