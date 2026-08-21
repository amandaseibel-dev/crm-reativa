// Desfazer a ação recém-feita: termo enviado, link solicitado e tabulação.
//
// A regra de quem pode desfazer NÃO mora aqui -- mora no banco (RPC
// desfazer_acao, que confere o dono do cartão e se o item ainda está intocado
// na fila do ADM). Este arquivo só roteia a chamada e traduz o motivo da recusa
// para uma frase que o operador entenda.
//
// Termo passa pela Edge Function porque desfazer um termo apaga o anexo do
// Storage, e apagar objeto é privilégio dela. Link e tabulação vão direto na
// RPC -- não tocam em arquivo.
import { supabase } from "../services/supabase";

export const TIPO_ROTULO = {
  TERMO_ENVIADO: "Termo",
  LINK_SOLICITADO: "Link",
  TABULACAO: "Tabulação",
};

// Por que este cartão não pode mais ser desfeito. Frases no lugar de códigos:
// o operador precisa saber o que fazer em seguida, não o nome do erro.
const MOTIVO = {
  ja_desfeito: "Esta ação já foi desfeita.",
  nao_e_sua: "Só quem fez a ação pode desfazer.",
  sem_sessao: "Sessão expirada. Saia e entre novamente no CRM.",
  acao_nao_encontrada: "Não encontrei essa ação para desfazer.",
  motivo_obrigatorio: "Informe o motivo para desfazer a ação de outro operador.",
  termo_nao_encontrado: "O termo não está mais no sistema.",
  termo_ja_tratado: "O ADM já tratou este termo — fale com a Fernanda/Amanda para corrigir.",
  link_nao_encontrado: "A solicitação de link não está mais no sistema.",
  link_ja_em_atendimento: "O ADM já assumiu este link — fale com a Fernanda/Amanda para corrigir.",
  prazo_expirado: "Passou de 24h: a tabulação não pode mais ser desfeita pelo operador.",
  houve_acao_depois: "O aluno já teve outro atendimento depois desta ação.",
  confirmacao_aberta: "Existe confirmação de pagamento aberta para este aluno — fale com o ADM.",
  desfazer_failed: "Não foi possível desfazer agora. Tente de novo em instantes.",
  forbidden: "Você não tem permissão para desfazer esta ação.",
};

export function explicarBloqueio(codigo) {
  if (!codigo) return "";
  return MOTIVO[codigo] || "Não é mais possível desfazer esta ação.";
}

// Lista o que ainda dá para desfazer. Sem alunoId, traz as últimas ações do
// próprio operador (para uma barra geral); com alunoId, só as daquele aluno.
export async function listarDesfazer(alunoId = null, limite = 10) {
  const { data, error } = await supabase.rpc("desfazer_listar", {
    p_aluno_id: alunoId || null,
    p_limite: limite,
  });
  if (error) return { ok: false, erro: error.message, itens: [] };
  if (!data?.ok) return { ok: false, erro: explicarBloqueio(data?.erro), itens: [] };
  return { ok: true, itens: data.itens || [] };
}

export async function desfazerAcao(acao, motivo = null) {
  if (!acao?.id) return { ok: false, erro: "Ação inválida." };

  if (acao.tipo === "TERMO_ENVIADO") {
    const { data, error } = await supabase.functions.invoke("documento-financeiro-url", {
      body: { acao: "desfazer_acao", id: String(acao.id), motivo: motivo || null },
    });
    if (error) {
      // A Edge devolve o código real no corpo; o supabase-js só entrega o
      // status. Tenta ler o corpo antes de cair no genérico.
      let codigo = "desfazer_failed";
      try {
        const corpo = await error.context?.json?.();
        if (corpo?.error) codigo = corpo.error;
      } catch { /* corpo ilegível: fica o genérico */ }
      return { ok: false, erro: explicarBloqueio(codigo) };
    }
    if (!data?.ok) return { ok: false, erro: explicarBloqueio(data?.error) };
    return {
      ok: true,
      statusRestaurado: data.status_restaurado || null,
      anexosPendentes: data.pendentes_no_storage || 0,
    };
  }

  const { data, error } = await supabase.rpc("desfazer_acao", {
    p_id: String(acao.id),
    p_motivo: motivo || null,
  });
  if (error) return { ok: false, erro: error.message };
  if (!data?.ok) return { ok: false, erro: explicarBloqueio(data?.erro) };
  return { ok: true, statusRestaurado: data.status_restaurado || null, anexosPendentes: 0 };
}
