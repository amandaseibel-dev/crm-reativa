-- ROLLBACK de 20261009190000_consolidar_19_fichas_duplicadas_bordero_723.sql
--
-- Recria as 19 fichas vazias com o MESMO id, a partir do backup, e devolve as
-- linhas de auditoria shadow que o backup guardou -- quantas forem: a shadow
-- roda a cada 6 horas e cresce 19 linhas por rodada, entao nada aqui usa
-- contagem fixa. As 14 fichas que ficaram nao foram alteradas pela ida, logo
-- nao sao tocadas aqui.
--
-- SEM DADO PESSOAL NESTE ARQUIVO (repositorio publico, §7 da premissa de
-- seguranca): as fichas aparecem por `id`, e o conjunto de CPFs e derivado do
-- proprio backup na execucao.

-- 1. Recria as 19 fichas apagadas. A lista de colunas vem do catalogo (menos
--    copiado_em), para nao depender da ordem nem de lista escrita a mao.
do $$
declare v_cols text;
begin
  select string_agg(quote_ident(column_name), ', ' order by ordinal_position)
    into v_cols
    from information_schema.columns
   where table_schema = 'public'
     and table_name = '_backup_alunos_dup_bordero723_20261009'
     and column_name <> 'copiado_em';

  execute format($f$
    insert into public.alunos (%1$s)
    select %1$s
      from public._backup_alunos_dup_bordero723_20261009
     where id::text in (
       '3d0309cf-cf7a-4767-858e-36a2e8a75462','d857dbf5-6b19-49c7-8c89-c9e0c956944e',
       '65d59d55-d50b-42e2-b78f-3ed6633cce42','67ba1317-34c2-47b7-9490-56fd9d3dfc35',
       'b9c6d8a8-9a14-4a7f-9fe2-eac43b25f7b3','d6d62bf9-c4ea-4801-a7fc-b6676b038641',
       '5f68241c-1523-42ef-b999-546492484099','5024469f-98e0-4e53-a8c9-3e40a979e88c',
       '266d05d4-4a15-493f-aced-26a9b3a15e72','cd75953c-025f-4d4d-8b87-f4e9dd6122c7',
       'cc2c8f47-b2a6-459d-a2f1-8326d22b3bc8','7cdcad35-fe32-4bee-80f8-885925c12c45',
       'c190d993-cdf0-4054-8110-126d2b2c358a','81d12a75-3e4c-48f3-98ae-984b0db5d2fd',
       '84adc675-ce3c-4e59-b27a-ec85d191e66c','0b2daeef-5542-4645-a6a5-87de1c2d6321',
       '2dbb2ab3-f5bd-45a4-8c32-4331bf69533e','1502e88f-760d-43e7-aa90-ea44199b2c40',
       'b2c1b4bf-7390-4db2-aa4c-720cee13c4d0')
    on conflict (id) do nothing
  $f$, v_cols);
end $$;

-- 2. Devolve as linhas de elegibilidade_shadow_divergencia guardadas no backup.
insert into public.elegibilidade_shadow_divergencia
  (execucao_id, aluno_id, regra_antiga_elegivel, regra_nova_elegivel, motivo_antigo,
   motivo_novo, tipo_divergencia, regra_provocadora, fila, operador, em_fila,
   saldo_diagnostico, registrado_em)
select b.execucao_id, b.aluno_id, b.regra_antiga_elegivel, b.regra_nova_elegivel,
       b.motivo_antigo, b.motivo_novo, b.tipo_divergencia, b.regra_provocadora,
       b.fila, b.operador, b.em_fila, b.saldo_diagnostico, b.registrado_em
  from public._backup_shadow_dup_bordero723_20261009 b
on conflict (execucao_id, aluno_id) do nothing;

-- 3. Confere: 33 fichas de volta e TODAS as linhas shadow do backup no lugar.
--    Contagem dinamica: a auditoria shadow roda a cada 6 horas e cresce 19
--    linhas por rodada, entao o numero certo e "o que o backup guardou", nunca
--    um literal.
do $$
declare v_fichas int; v_shadow int; v_esperado int;
begin
  select count(*) into v_esperado from public._backup_shadow_dup_bordero723_20261009;
  select count(*) into v_fichas from public.alunos a
   where regexp_replace(coalesce(a.cpf,''),'\D','','g') in (
     select distinct regexp_replace(coalesce(b.cpf,''),'\D','','g')
       from public._backup_alunos_dup_bordero723_20261009 b
      where coalesce(btrim(b.cpf),'') <> '');
  select count(*) into v_shadow from public.elegibilidade_shadow_divergencia e
   where exists (select 1 from public._backup_shadow_dup_bordero723_20261009 b
                  where b.execucao_id = e.execucao_id and b.aluno_id = e.aluno_id);
  if v_fichas <> 33 or v_shadow <> v_esperado then
    raise exception 'ROLLBACK INCOMPLETO: fichas=% shadow=% (esperado 33 e %).',
      v_fichas, v_shadow, v_esperado;
  end if;
end $$;
