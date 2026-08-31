-- Cadastrar aluno que nao esta na base, para vincular o pagamento dele.
--
-- Amanda, 31/08: "tem casos a vincular que nao tem cadastro e tem acordo para
-- acompanhamento".
--
-- POR QUE PRECISA EXISTIR. Ate aqui o sistema inteiro tinha UM unico caminho que
-- cria aluno: `importar_acordos`. Nenhuma tela insere aluno, e nao havia RPC de
-- cadastro -- conferido em 31/08 varrendo o front e todas as funcoes do banco.
-- Entao, quando entrava dinheiro de alguem fora da base, a fila mostrava "sem
-- vinculo" e a unica saida era montar uma planilha de uma linha para importar
-- um acordo.
--
-- O QUE ESTA FUNCAO NAO FAZ: nao cria acordo, nao cria caso, nao mexe em
-- dinheiro. So abre a ficha, para o pagamento ter em quem ser ligado e o acordo
-- poder ser acompanhado. O acordo segue sendo lancado pelo caminho de sempre.
--
-- TRAVA DE DUPLICIDADE: se o CPF ja existe, devolve o aluno existente em vez de
-- criar outro. Cadastro repetido nesta base ja custou uma migration inteira de
-- fusao; nao vale reabrir essa porta por comodidade de tela.
--
-- Marca `origem = 'CADASTRO_CONFERENCIA'` para depois se saber de onde estes
-- alunos vieram e se o caminho esta sendo usado como deveria.
--
-- DESFAZER: supabase/rollbacks/20260831200000_criar_aluno_para_vincular_pagamento.rollback.sql

create or replace function public.criar_aluno_para_vinculo(
  p_nome     text,
  p_cpf      text,
  p_unidade  text default null
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_cpf text := lpad(regexp_replace(coalesce(p_cpf,''), '\D', '', 'g'), 11, '0');
  v_nome text := btrim(coalesce(p_nome,''));
  v_email text := lower(coalesce(auth.jwt()->>'email',''));
  v_id uuid;
begin
  if not public.usuario_e_gestao() then
    raise exception 'Acesso negado: somente gestao financeira.' using errcode = '42501';
  end if;
  if length(regexp_replace(coalesce(p_cpf,''), '\D', '', 'g')) <> 11 then
    raise exception 'CPF invalido: informe os 11 digitos.';
  end if;
  if length(v_nome) < 3 then
    raise exception 'Informe o nome do aluno.';
  end if;

  select a.id into v_id
    from public.alunos a
   where lpad(regexp_replace(coalesce(a.cpf,''), '\D', '', 'g'), 11, '0') = v_cpf
   limit 1;

  if v_id is not null then
    return jsonb_build_object('criado', false, 'aluno_id', v_id,
                              'motivo', 'CPF_JA_CADASTRADO');
  end if;

  insert into public.alunos (nome, cpf, unidade, status_jornada, tipo_base, origem, observacao)
  values (v_nome, v_cpf, nullif(btrim(coalesce(p_unidade,'')),''), 'Em cobrança',
          'ACORDO_IMPORTADO', 'CADASTRO_CONFERENCIA',
          'Cadastrado na Conferência de Pagamentos por ' || coalesce(v_email,'(sem email)')
          || ' em ' || to_char(now(),'DD/MM/YYYY') || ' -- entrou dinheiro sem cadastro na base.')
  returning id into v_id;

  return jsonb_build_object('criado', true, 'aluno_id', v_id);
end;
$function$;

revoke all on function public.criar_aluno_para_vinculo(text, text, text) from public, anon;
grant execute on function public.criar_aluno_para_vinculo(text, text, text) to authenticated, service_role;
