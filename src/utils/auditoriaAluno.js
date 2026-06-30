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

  const { error: updateError } = await supabase
    .from("alunos")
    .update({
      registrado_por_nome: usuario.nome,
      registrado_por_email: usuario.email,
      registrado_em: agora,
      responsavel_atual_nome: usuario.nome,
      responsavel_atual_email: usuario.email,
      responsavel_atual_em: agora,
    })
    .eq("id", alunoId);

  if (updateError) {
    console.error("Erro ao atualizar responsável no aluno:", updateError);
    throw updateError;
  }

  return {
    nome: usuario.nome,
    email: usuario.email,
    registrado_em: agora,
  };
}