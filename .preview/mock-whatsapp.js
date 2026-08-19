// Camada de serviço do preview: mesma assinatura da real, dados de exemplo.
// O componente da Central é o REAL — nada aqui é uma reprodução da tela.
import * as real from "/src/services/whatsapp.js";
import { CANAIS, OPERADORES, CONVERSAS, MENSAGENS, RESUMO, SUPERVISAO, SYNC, ALUNOS, FICHA }
  from "./dados.js";
import { normalizarE164 } from "/src/utils/telefone.js";

export const STATUS_CONVERSA = real.STATUS_CONVERSA;
export const ROTULO_STATUS = real.ROTULO_STATUS;
export const ROTULO_CONEXAO = real.ROTULO_CONEXAO;
export const FILTRO_SEM_RETORNO = real.FILTRO_SEM_RETORNO;
export const FILTRO_NAO_LIDAS = real.FILTRO_NAO_LIDAS;
export const FILTRO_SEM_RESPONSAVEL = real.FILTRO_SEM_RESPONSAVEL;
export const FILTRO_MINHAS = real.FILTRO_MINHAS;
export const esperaDesde = real.esperaDesde;
export const linkWhatsApp = real.linkWhatsApp;

const estado = {
  canais: CANAIS.map((c) => ({ ...c })),
  conversas: CONVERSAS.map((c) => ({ ...c })),
  mensagens: JSON.parse(JSON.stringify(MENSAGENS)),
};

// Cenários que o preview precisa demonstrar, ligados pela barra do topo.
export const cenario = {
  gestao: false,
  telefoneOcupado: "5551944332211", // número já em atendimento por outra pessoa
};
if (typeof window !== "undefined") window.__cenario = cenario;

const espera = (v) => new Promise((r) => setTimeout(() => r(v), 60));

export const souGestao = async () => cenario.gestao;
// A RPC real devolve objetos NOVOS a cada chamada. Devolver o mesmo array
// mutado faria os useMemo da tela nunca recalcularem — artefato de preview que
// não existe em produção.
export const listarCanais = async () => espera(estado.canais.map((c) => ({ ...c })));
export const listarOperadores = async () => espera(OPERADORES);
export const carregarResumo = async () => espera(RESUMO);
export const carregarSupervisao = async () => espera(SUPERVISAO);
export const carregarSyncStatus = async () => espera(SYNC);

export const listarConversas = async ({ status, canalId, busca, responsavel } = {}) => {
  let l = estado.conversas.map((c) => ({ ...c }));
  if (canalId) l = l.filter((c) => c.canal_id === canalId);
  if (responsavel) l = l.filter((c) => c.responsavel_email === responsavel);
  if (status === "SEM_RETORNO") l = l.filter((c) => c.aguardando_resposta);
  else if (status === "NAO_LIDAS") l = l.filter((c) => c.nao_lidas > 0);
  else if (status === "SEM_RESPONSAVEL") l = l.filter((c) => !c.responsavel_email && c.status !== "ENCERRADO");
  else if (status === "MINHAS") l = l.filter((c) => c.responsavel_email === "operador@aelbra.com.br");
  else if (status) l = l.filter((c) => c.status === status);
  if (busca) {
    const t = busca.toLowerCase();
    l = l.filter((c) =>
      (c.aluno_nome || "").toLowerCase().includes(t) ||
      (c.nome_perfil || "").toLowerCase().includes(t) ||
      c.telefone_e164.includes(busca.replace(/\D/g, "")));
  }
  return espera(l);
};

// A camada real já entrega na ordem de leitura (mais antiga primeiro); o
// `reverse` dela existe porque a RPC devolve ao contrário. Aqui não há RPC.
export const listarMensagens = async (id) => espera((estado.mensagens[id] || []).slice());
export const carregarFichaAluno = async () => espera(FICHA);
export const carregarCandidatos = async () => espera([
  { aluno_id: "b1", nome: "Juliana Martins da Silva", matricula: "20204411", curso: "Pedagogia" },
  { aluno_id: "b2", nome: "Juliana Martins Silva", matricula: "20228833", curso: "Nutrição" },
]);
export const buscarAluno = async (termo) => {
  const t = String(termo || "").toLowerCase();
  return espera(ALUNOS.filter((a) => a.nome.toLowerCase().includes(t) || (a.matricula || "").includes(t)));
};

export const marcarLida = async (id) => {
  const c = estado.conversas.find((x) => x.id === id);
  if (c) c.nao_lidas = 0;
};
export const assumirConversa = async (id) => {
  const c = estado.conversas.find((x) => x.id === id);
  if (c) { c.responsavel_email = "operador@aelbra.com.br"; c.responsavel_nome = "Operador Preview"; c.status = "EM_ATENDIMENTO"; }
};
export const transferirConversa = async (id, email) => {
  const c = estado.conversas.find((x) => x.id === id);
  const o = OPERADORES.find((x) => x.email === email);
  if (c) { c.responsavel_email = email; c.responsavel_nome = o?.nome || email; }
};
export const retirarResponsavel = async (id) => {
  const c = estado.conversas.find((x) => x.id === id);
  if (c) { c.responsavel_email = null; c.responsavel_nome = null; }
};
export const encerrarConversa = async (id) => {
  const c = estado.conversas.find((x) => x.id === id);
  if (c) c.status = "ENCERRADO";
};
export const reabrirConversa = async (id) => {
  const c = estado.conversas.find((x) => x.id === id);
  if (c) c.status = "EM_ATENDIMENTO";
};
export const vincularAluno = async (id, alunoId) => {
  const c = estado.conversas.find((x) => x.id === id);
  const a = ALUNOS.find((x) => x.id === alunoId);
  if (c) { c.aluno_id = alunoId; c.aluno_nome = a?.nome || "Aluno vinculado"; c.aluno_status = "ENCONTRADO"; }
};
// No preview não abre outra aba de verdade, mas REGISTRA — é assim que dá para
// verificar que abrir a ficha é a única ação da Central que sai dela, e que
// nenhuma seleção de operador faz isso.
export const abrirFichaDoAluno = (alunoId) => {
  (window.__fichasAbertas ||= []).push(alunoId);
};

export const carregarQr = async () => espera({
  qr_code:
    "data:image/svg+xml;utf8," +
    encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="320">' +
      '<rect width="320" height="320" fill="#fff"/>' +
      '<text x="160" y="150" text-anchor="middle" font-family="system-ui" font-size="15" fill="#334155">QR Code</text>' +
      '<text x="160" y="175" text-anchor="middle" font-family="system-ui" font-size="12" fill="#94a3b8">(exemplo — preview)</text>' +
      "</svg>"),
});
export const comandarSessao = async (canalId, comando) => {
  const c = estado.canais.find((x) => x.id === canalId);
  if (!c) return;
  if (comando === "desconectar") { c.online = false; c.conexao_status = "DESCONECTADO"; c.aguardando_qr = false; }
  if (comando === "logout") { c.online = false; c.conexao_status = "PAREAMENTO_NECESSARIO"; c.aguardando_qr = true; }
  if (comando === "reconectar") { c.online = true; c.conexao_status = "CONECTADO"; c.aguardando_qr = false; }
};
export const salvarCanal = async ({ id, apelido, numero, sessaoChave, ativo }) => {
  if (id) {
    const c = estado.canais.find((x) => x.id === id);
    if (c) { c.apelido = apelido; c.display_phone_number = numero; c.ativo = ativo; }
    return;
  }
  estado.canais.push({
    id: "c" + (estado.canais.length + 1), apelido, display_phone_number: numero,
    sessao_chave: sessaoChave, ativo, conexao_status: "DESCONECTADO", online: false,
    aguardando_qr: false, sync_inicial_em: null,
  });
};

export const enviarMensagem = async (id, texto) => {
  (estado.mensagens[id] ||= []).push({
    id: "x" + Math.random(), direcao: "SAIDA", texto, status: "ENVIADO",
    enviado_por_email: "operador@aelbra.com.br", origem: "TEMPO_REAL",
    timestamp_wa: new Date().toISOString(),
  });
  const c = estado.conversas.find((x) => x.id === id);
  if (c) { c.aguardando_resposta = false; c.aguardando_desde = null; c.ultima_mensagem_previa = texto; }
  return { ok: true };
};

export const procurarConversaPorTelefone = async (canalId, telefone) => {
  const e164 = normalizarE164(telefone);
  if (!canalId || !e164) return null;
  // Um número de propósito "ocupado" para demonstrar o aviso de conversa
  // que já pertence a outro operador.
  if (e164 === cenario.telefoneOcupado) {
    return {
      conversa_id: "k7", telefone_e164: e164, status: "EM_ATENDIMENTO",
      responsavel_email: "maria@aelbra.com.br", responsavel_nome: "Maria Souza",
      aluno_id: "a9", aluno_nome: "Ana Paula Ferreira",
    };
  }
  const achou = estado.conversas.find((c) => c.canal_id === canalId && c.telefone_e164 === e164);
  return achou
    ? { conversa_id: achou.id, telefone_e164: e164, status: achou.status,
        responsavel_email: achou.responsavel_email, responsavel_nome: achou.responsavel_nome,
        aluno_id: achou.aluno_id, aluno_nome: achou.aluno_nome }
    : null;
};

export const iniciarConversa = async ({ canalId, telefone, alunoId, texto }) => {
  if (telefone === cenario.telefoneOcupado) {
    throw new Error("ja existe conversa com este numero, em atendimento por Maria Souza");
  }
  const canal = estado.canais.find((c) => c.id === canalId);
  const aluno = ALUNOS.find((a) => a.id === alunoId);
  estado.conversas.unshift({
    id: "k-nova", canal_id: canalId, canal_apelido: canal?.apelido,
    canal_numero: canal?.display_phone_number, telefone_e164: telefone,
    nome_perfil: null, status: "EM_ATENDIMENTO",
    responsavel_email: "operador@aelbra.com.br", responsavel_nome: "Operador Preview",
    nao_lidas: 0, aluno_id: alunoId || null, aluno_nome: aluno?.nome || null,
    aluno_status: alunoId ? "ENCONTRADO" : "NAO_ENCONTRADO",
    ultima_mensagem_em: new Date().toISOString(), ultima_mensagem_previa: texto,
    aguardando_resposta: false, aguardando_desde: null, origem_sync: false,
  });
  estado.mensagens["k-nova"] = [{
    id: "mn", direcao: "SAIDA", texto, status: "ENVIADO",
    enviado_por_email: "operador@aelbra.com.br", origem: "TEMPO_REAL",
    timestamp_wa: new Date().toISOString(),
  }];
  return { ok: true, conversa_id: "k-nova", ja_existia: false };
};
