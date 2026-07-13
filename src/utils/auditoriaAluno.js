import { supabase } from "../services/supabase";

export async function pegarUsuarioLogado() {
  const { data, error } = await supabase.auth.getUser();

  if (error || !data?.user) {
    return {
      nome: "Usuário não identificado",
      email: null,
    };
  }

  const user = data.user;

  const nome =
    user.user_metadata?.nome ||
    user.user_metadata?.name ||
    user.email?.split("@")[0] ||
    "Usuário";

  return {
    nome,
    email: user.email,
  };
}

export async function registrarMovimentacaoAluno({
  alunoId,
  tipo,
  descricao,
  statusAnterior = null,
  statusNovo = null,
}) {
  if (!alunoId) {
    console.error("Aluno sem ID. Não foi possível registrar movimentação.");
    return;
  }

  const usuario = await pegarUsuarioLogado();
  const agora = new Date().toISOString();

  const { error: insertError } = await supabase
    .from("aluno_movimentacoes")
    .insert({
      aluno_id: String(alunoId),
      tipo,
      descricao,
      status_anterior: statusAnterior,
      status_novo: statusNovo,
      registrado_por_nome: usuario.nome,
      registrado_por_email: usuario.email,
      registrado_em: agora,
    });

  if (insertError) {
    console.error("Erro ao registrar movimentação:", insertError);
    throw insertError;
  }

  // registrado_por (nao sensivel) direto; responsavel via RPC segura (self, so
  // se o caso estiver sem responsavel -- nao rouba caso de outro).
  const { error: updateError } = await supabase
    .from("alunos")
    .update({
      registrado_por_nome: usuario.nome,
      registrado_por_email: usuario.email,
      registrado_em: agora,
    })
    .eq("id", alunoId);
  if (updateError) {
    console.error("Erro ao atualizar registro no aluno:", updateError);
    throw updateError;
  }
  const { error: assumirError } = await supabase.rpc("sistema_assumir_atendimento", {
    p_aluno_id: alunoId,
  });
  if (assumirError) {
    console.error("Erro ao assumir (responsavel):", assumirError);
    // nao interrompe a tabulacao; ok:false (ex.: JA_TEM_RESPONSAVEL) e ignorado
  }

  return {
    nome: usuario.nome,
    email: usuario.email,
    registrado_em: agora,
  };
}
