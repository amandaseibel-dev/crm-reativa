-- ============================================================================
-- TESTE DE REGRESSÃO — projecao_relatorio_pdf respeita o acesso da tela
-- Rodar DEPOIS de aplicar 20261112120000 e em ROLLBACK (não grava dados).
-- Simula o JWT por request.jwt.claims. Falha com RAISE se algo sair da regra.
--
-- RESULTADO ESPERADO:
--   diretoria ........... e_diretoria=true; total = consolidado da empresa;
--                         por_operador=[], por_unidade=[], sem operador_nome
--   gestão (Amanda) ..... tudo, inclusive por_operador
--   operador da equipe .. só os próprios pagamentos (total ≤ empresa)
--   mês sem pagamentos .. sem_pagamentos=true, sem erro
--   anônimo / inativo ... 42501
-- ============================================================================

begin;

create or replace function pg_temp.pdf(p_email text, p_mes text) returns jsonb
language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
    json_build_object('email', p_email, 'role', 'authenticated')::text, true);
  return public.projecao_relatorio_pdf(p_mes);
end $$;

do $$
declare
  v_mes text := to_char(current_date, 'YYYY-MM');
  v_dir jsonb; v_ger jsonb; v_op jsonb; v_vazio jsonb;
  v_emp_rec numeric; v_emp_pag bigint;
  v_erro text;
begin
  -- Consolidado da empresa, calculado direto da mesma base (sem a função).
  select round(sum(coalesce(valor_pago,0)),2), count(*)
    into v_emp_rec, v_emp_pag
    from public.pagamentos
   where retroativo = false and to_char(data_pagamento,'YYYY-MM') = v_mes;

  -- 1) Diretoria: vê consolidado, não vê ranking/unidade/meta.
  v_dir := pg_temp.pdf('gustavo.ene@aelbra.com.br', v_mes);
  if coalesce(v_dir->>'e_diretoria','') <> 'true' then raise exception 'REGRESSÃO: diretoria não reconhecida'; end if;
  if coalesce(v_dir->>'e_gestao','') <> 'false' then raise exception 'REGRESSÃO: diretoria com e_gestao=true'; end if;
  if jsonb_array_length(v_dir->'por_operador') <> 0 then raise exception 'VAZAMENTO: diretoria recebeu por_operador'; end if;
  if jsonb_array_length(v_dir->'por_unidade') <> 0 then raise exception 'VAZAMENTO: diretoria recebeu por_unidade'; end if;
  if v_dir->>'operador_nome' is not null then raise exception 'VAZAMENTO: diretoria recebeu operador_nome'; end if;
  if (v_dir->'total'->>'pagamentos')::bigint <> v_emp_pag then
    raise exception 'REGRESSÃO: total da diretoria (%) ≠ empresa (%)', v_dir->'total'->>'pagamentos', v_emp_pag;
  end if;
  if (v_dir->'total'->>'recuperado')::numeric <> v_emp_rec then
    raise exception 'REGRESSÃO: recuperado da diretoria ≠ empresa';
  end if;

  -- 2) Gestão: mantém ranking por operador.
  v_ger := pg_temp.pdf('amanda.seibel@aelbra.com.br', v_mes);
  if v_ger->>'e_gestao' <> 'true' then raise exception 'REGRESSÃO: gestão perdeu e_gestao'; end if;
  if (v_ger->'total'->>'pagamentos')::bigint <> v_emp_pag then raise exception 'REGRESSÃO: gestão ≠ empresa'; end if;

  -- 3) Operador (ex.: Olga): só os próprios pagamentos.
  v_op := pg_temp.pdf('cobranca03@aelbra.com.br', v_mes);
  if v_op->>'e_diretoria' <> 'false' or v_op->>'e_gestao' <> 'false' then raise exception 'VAZAMENTO: operador com perfil elevado'; end if;
  if jsonb_array_length(v_op->'por_operador') <> 0 then raise exception 'VAZAMENTO: operador recebeu ranking'; end if;
  if (v_op->'total'->>'pagamentos')::bigint > v_emp_pag then raise exception 'VAZAMENTO: operador vê mais que a empresa'; end if;

  -- 4) Ausência legítima de pagamentos: mês futuro, sem erro.
  v_vazio := pg_temp.pdf('gustavo.ene@aelbra.com.br', '2099-01');
  if v_vazio->>'sem_pagamentos' <> 'true' then raise exception 'REGRESSÃO: mês vazio não sinalizado'; end if;

  -- 5) Anônimo e inativo continuam bloqueados.
  begin
    perform set_config('request.jwt.claims', '{}', true);
    perform public.projecao_relatorio_pdf(v_mes);
    raise exception 'VAZAMENTO: anônimo passou';
  exception when sqlstate '42501' then null;
  end;
  begin
    perform pg_temp.pdf('usuario.inativo.teste@aelbra.com.br', v_mes);
    raise exception 'VAZAMENTO: não cadastrado/inativo passou';
  exception when sqlstate '42501' then null;
  end;

  raise notice 'OK: acesso do PDF alinhado à tela (diretoria, gestão, operador, ausência, bloqueios).';
end $$;

rollback;
