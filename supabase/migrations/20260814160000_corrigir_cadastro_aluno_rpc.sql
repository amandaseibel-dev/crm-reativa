-- Corrigir cadastro do aluno (nome/CPF/telefone/e-mail) de forma confiável.
--
-- Motivação: alunos "sem nome" (nome vazio) muitas vezes estão SEM responsável
-- atual. A RLS de UPDATE em `alunos` (política alunos_update) só permite gravar
-- se o usuário for gestão OU o responsável atual do aluno. Quando a RLS barra
-- um UPDATE, o Postgres NÃO gera erro — apenas afeta 0 linhas. O frontend só
-- checava `error`, então mostrava "salvo com sucesso" e nada mudava.
--
-- Esta RPC (SECURITY DEFINER) permite que QUALQUER usuário ativo (gestão ou
-- operador) corrija o cadastro, inclusive de alunos órfãos, e:
--   * sincroniza `nome_aluno` com `nome` (várias telas leem coalesce(nome_aluno, nome)),
--   * registra a movimentação de auditoria com o autor real,
--   * devolve erro explícito quando o aluno não existe ou os dados são inválidos.

create or replace function public.corrigir_cadastro_aluno(
  p_aluno_id uuid,
  p_nome     text,
  p_cpf      text,
  p_telefone text default null,
  p_email    text default null
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_email       text := lower(coalesce(auth.jwt() ->> 'email', ''));
  v_nome        text := nullif(btrim(coalesce(p_nome, '')), '');
  v_cpf         text := nullif(btrim(coalesce(p_cpf, '')), '');
  v_telefone    text := nullif(btrim(coalesce(p_telefone, '')), '');
  v_email_aluno text := nullif(btrim(coalesce(p_email, '')), '');
  v_autor_nome  text;
  v_antigo      public.alunos%rowtype;
begin
  -- Só usuário ativo do CRM (bloqueia painel/TV e anônimo).
  if public.eh_painel() or not public.app_usuario_ativo() then
    raise exception 'SEM_PERMISSAO_CORRIGIR_CADASTRO';
  end if;

  if v_nome is null then
    raise exception 'NOME_OBRIGATORIO';
  end if;
  if v_cpf is null then
    raise exception 'CPF_OBRIGATORIO';
  end if;

  select * into v_antigo from public.alunos where id = p_aluno_id;
  if not found then
    raise exception 'ALUNO_NAO_ENCONTRADO';
  end if;

  update public.alunos
     set nome          = v_nome,
         nome_aluno    = v_nome,      -- mantém a coluna lida por coalesce(nome_aluno, nome)
         cpf           = v_cpf,
         telefone      = v_telefone,
         email         = v_email_aluno,
         atualizado_em = now()
   where id = p_aluno_id;

  select nome into v_autor_nome from public.usuarios where lower(email) = v_email limit 1;

  insert into public.aluno_movimentacoes (
    aluno_id, tipo, descricao,
    status_anterior, status_novo,
    registrado_por_nome, registrado_por_email, registrado_em
  ) values (
    p_aluno_id::text, 'CORRECAO_CADASTRO',
    format(
      'Cadastro corrigido. Nome: "%s" -> "%s". CPF: "%s" -> "%s". Telefone: "%s" -> "%s". E-mail: "%s" -> "%s".',
      coalesce(v_antigo.nome, ''), v_nome,
      coalesce(v_antigo.cpf, ''),  v_cpf,
      coalesce(v_antigo.telefone, ''), coalesce(v_telefone, ''),
      coalesce(v_antigo.email, ''), coalesce(v_email_aluno, '')
    ),
    v_antigo.status_atual, v_antigo.status_atual,
    coalesce(v_autor_nome, v_email), v_email, now()
  );

  return jsonb_build_object('ok', true, 'aluno_id', p_aluno_id, 'nome', v_nome);
end;
$function$;

revoke all on function public.corrigir_cadastro_aluno(uuid, text, text, text, text) from public, anon;
grant execute on function public.corrigir_cadastro_aluno(uuid, text, text, text, text) to authenticated;
