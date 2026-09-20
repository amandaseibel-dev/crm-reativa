// Protecao da Fila Operacional contra aluno com CONFIRMACAO FINANCEIRA ABERTA
// (solicitacoes_confirmacao_pagamento em AGUARDANDO_CONFIRMACAO ou
// PAGAMENTO_RECEBIDO_AGUARDANDO_VINCULO).
//
// FONTE UNICA: o RPC `alunos_em_confirmacao_pendente()` (SECURITY DEFINER,
// devolve os aluno_id de texto das solicitacoes abertas, pelos DOIS estados).
// Este arquivo NAO reimplementa regra nenhuma: so consome o RPC e separa a lista.
//
// FAIL-CLOSED: se o RPC falhar ou devolver algo que nao seja lista, o resultado
// e `ok: false` e a tela NAO carrega a fila -- nunca lista alunos potencialmente
// acionaveis sem a protecao.

export const MENSAGEM_ERRO_PROTECAO_CONFIRMACAO =
  "Não foi possível verificar os alunos com confirmação de pagamento pendente. " +
  "Por segurança, a fila não foi carregada. Tente novamente em instantes; " +
  "se o erro continuar, avise a gestão.";

export const ROTULO_EM_CONFIRMACAO = "Aguardando confirmação de pagamento";

// O RPC devolve `setof text`: o PostgREST entrega ["uuid", ...]; aceita-se
// tambem [{ alunos_em_confirmacao_pendente: "uuid" }, ...].
function idDaLinha(linha) {
  if (linha && typeof linha === "object") return String(Object.values(linha)[0] ?? "");
  return String(linha ?? "");
}

export async function carregarIdsEmConfirmacao(cliente) {
  try {
    const { data, error } = await cliente.rpc("alunos_em_confirmacao_pendente");
    if (error) return { ok: false, ids: null, erro: error.message || "erro do RPC" };
    if (!Array.isArray(data)) return { ok: false, ids: null, erro: "resposta inesperada do RPC" };
    return { ok: true, ids: new Set(data.map(idDaLinha).filter(Boolean)), erro: null };
  } catch (e) {
    return { ok: false, ids: null, erro: e?.message || "falha ao chamar o RPC" };
  }
}

export function alunoEmConfirmacao(aluno, ids) {
  return !!ids && ids.has(String(aluno?.id ?? ""));
}

// `acionaveis`: entram na fila normal. `protegidos`: aluno com confirmacao
// aberta -- nunca aparecem como acionaveis (vao para o grupo "fora da cobranca").
export function separarPorConfirmacao(alunos, ids) {
  const acionaveis = [];
  const protegidos = [];
  for (const a of alunos || []) (alunoEmConfirmacao(a, ids) ? protegidos : acionaveis).push(a);
  return { acionaveis, protegidos };
}
