-- ROLLBACK de 20260914170000_motor_unico_de_conciliacao.sql
--
-- Devolve as tres funcoes que a migration reescreveu ao comportamento anterior
-- e desfaz a insercao cirurgica em `importar_acordos`. Nao apaga o motor:
-- `pagamento_conciliar_um` fica no banco, sem chamador, para poder voltar.
--
-- O QUE ESTE ROLLBACK NAO FAZ, DE PROPOSITO:
--   * nao desfaz baixa nenhuma. A escada e a mesma nas duas versoes -- o que a
--     migration acrescentou so RESTRINGE (idempotencia e amarracao fraca), entao
--     nada baixou por causa dela;
--   * nao apaga status_conciliacao, motivo nem origem_baixa. Registro do que
--     aconteceu nao se derruba para desfazer regra;
--   * nao reabre linha de fila ja decidida;
--   * nao mexe em `parcelas_amarrar_boleto`, que a migration nunca tocou.
--
-- ATENCAO: depois deste rollback volta o defeito que a migration corrigiu --
-- `baixa_pelo_relatorio_pagamento` baixa a parcela por fora e deixa
-- `status_conciliacao` velho, e a tela mostra pendencia falsa.

-- 1. O gatilho volta a ter a escada dentro dele ------------------------------
-- Restaurado a partir de 20260914140000_conciliacao_do_pagamento.sql, que e a
-- versao que estava em producao (aplicada como 20260914125940).
\echo 'ATENCAO: reaplique o bloco 3 de 20260914140000_conciliacao_do_pagamento.sql'
\echo 'para devolver o corpo completo de _pagamento_conciliar().'

-- 2. baixa_pelo_relatorio_pagamento volta a ter regra propria ----------------
-- Restaurado a partir de 20260908200000_baixa_pelo_documento_respeita_vencimento.sql
-- (secao "Rotina do relatorio"), que e a ultima versao com corpo proprio.
\echo 'ATENCAO: reaplique a secao "Rotina do relatorio" de'
\echo '20260908200000_baixa_pelo_documento_respeita_vencimento.sql.'

-- 3. A assinatura de 3 parametros sai, para o fluxo voltar a resolver a de 2 --
drop function if exists public.baixa_pelo_relatorio_pagamento(boolean, date, boolean);

-- 4. pagamento_vincular_aluno volta a fechar a fila direto -------------------
create or replace function public.pagamento_vincular_aluno(
  p_pagamento_id uuid, p_aluno_id uuid, p_observacao text default null
)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $fn$
declare v_nome text; v_cpf text; v_ant uuid; v_email text; v_fila int := 0;
begin
  if not coalesce(public.usuario_e_gestao(), false)
     and coalesce(auth.role(),'') <> 'service_role' then
    raise exception 'Vincular pagamento a aluno e decisao da gestao.' using errcode = '42501';
  end if;

  v_email := coalesce(nullif(lower(auth.jwt() ->> 'email'),''), 'gestao');

  select a.nome, a.cpf into v_nome, v_cpf from public.alunos a where a.id = p_aluno_id;
  if v_nome is null then
    return jsonb_build_object('ok', false, 'motivo', 'ALUNO_NAO_ENCONTRADO');
  end if;

  select aluno_id into v_ant from public.pagamentos where id = p_pagamento_id;

  update public.pagamentos
     set aluno_id = p_aluno_id,
         cpf = coalesce(cpf, v_cpf),
         origem_vinculo = 'GESTAO_MANUAL',
         origem_vinculo_ref = v_email,
         origem_vinculo_em = now()
   where id = p_pagamento_id;

  update public.fila_pagamento_sem_vinculo
     set decisao = 'VINCULADO',
         aluno_escolhido_id = p_aluno_id,
         decidido_por = v_email,
         decidido_em = now(),
         observacao = p_observacao
   where pagamento_id = p_pagamento_id and decisao is null;
  get diagnostics v_fila = row_count;

  insert into public.aluno_movimentacoes
    (aluno_id, tipo, descricao, registrado_por_nome, registrado_por_email, registrado_em)
  values (p_aluno_id::text, 'PAGAMENTO_VINCULADO',
          'Pagamento vinculado manualmente pela gestao.'
          || case when p_observacao is null then '' else ' ' || p_observacao end,
          v_email, v_email, now());

  return jsonb_build_object('ok', true, 'aluno_nome', v_nome,
                            'aluno_id_anterior', v_ant, 'fila_fechada', v_fila);
end;
$fn$;

grant execute on function public.pagamento_vincular_aluno(uuid, uuid, text) to authenticated;

-- 5. importar_acordos para de reavaliar --------------------------------------
-- Cirurgia inversa: tira as quatro linhas inseridas, mantendo o resto byte a
-- byte. Se o bloco nao estiver la, nada a fazer.
do $cirurgia$
declare v_src text; v_novo text; v_bloco text;
begin
  select p.prosrc into v_src from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'importar_acordos';
  if v_src is null or position('conciliacao_reprocessar' in v_src) = 0 then
    raise notice 'importar_acordos nao chama a conciliacao; nada a fazer'; return;
  end if;

  v_bloco := E'  -- Acordo novo no CRM pode ser exatamente o que faltava para um pagamento\n'
          || E'  -- que ja entrou e ficou em AGUARDANDO_ACORDO. Reavalia -- sem forcar baixa:\n'
          || E'  -- parcela sem boleto vira AGUARDANDO_AMARRACAO, nao BAIXADO.\n'
          || E'  perform public.conciliacao_reprocessar(true, 2000);\n\n';

  if position(v_bloco in v_src) = 0 then
    raise exception 'o bloco inserido nao esta identico -- abortando sem tocar a funcao';
  end if;

  v_novo := replace(v_src, v_bloco, '');
  execute format(
    'create or replace function public.importar_acordos(p_linhas jsonb, p_importacao_id uuid)
       returns json language plpgsql security definer
       set search_path to ''public''
       set statement_timeout to ''180000''
       as %s', quote_literal(v_novo));
end $cirurgia$;

-- 6. O motor fica no banco, sem chamador -------------------------------------
-- Nao apagamos: recolocar o desenho exige so recriar os chamadores.
