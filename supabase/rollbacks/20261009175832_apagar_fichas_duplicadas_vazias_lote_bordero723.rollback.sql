-- ROLLBACK de 20261009175832_apagar_fichas_duplicadas_vazias_lote_bordero723.sql
--
-- Recria as 5 fichas duplicadas vazias com o MESMO id, a partir do backup, e
-- devolve as 15 linhas de auditoria shadow. A ficha que ficou (c4c8781e) nao
-- foi alterada pela ida, logo nao e tocada aqui.
--
-- SEM DADO PESSOAL NESTE ARQUIVO (repositorio publico, §7 da premissa de
-- seguranca): as fichas aparecem por `id`, e o CPF e derivado do proprio
-- backup na execucao.

-- 1. Recria as 5 fichas apagadas, coluna a coluna, a partir do backup.
--    A lista de colunas e montada do proprio catalogo (menos copiado_em), para
--    nao depender da ordem nem de uma lista escrita a mao.
do $$
declare v_cols text;
begin
  select string_agg(quote_ident(column_name), ', ' order by ordinal_position)
    into v_cols
    from information_schema.columns
   where table_schema = 'public'
     and table_name = '_backup_alunos_dup_thamis_20261009'
     and column_name <> 'copiado_em';

  execute format($f$
    insert into public.alunos (%1$s)
    select %1$s
      from public._backup_alunos_dup_thamis_20261009
     where id::text in ('d170ac1e-a077-407b-9bf0-34c33a1e283a',
                        '22ba5dd1-c999-4a8b-b9cb-efd440bf5fa8',
                        'bf707bb4-6201-4966-80c5-b49dcf23b12a',
                        '78c350d1-6e1c-4964-b4d2-19db3fc8959b',
                        '468768c2-25a9-4aec-be28-c34494ed9b6d')
    on conflict (id) do nothing
  $f$, v_cols);
end $$;

-- 2. Devolve as 15 linhas de elegibilidade_shadow_divergencia.
insert into public.elegibilidade_shadow_divergencia
  (execucao_id, aluno_id, regra_antiga_elegivel, regra_nova_elegivel, motivo_antigo,
   motivo_novo, tipo_divergencia, regra_provocadora, fila, operador, em_fila,
   saldo_diagnostico, registrado_em)
select b.execucao_id, b.aluno_id, b.regra_antiga_elegivel, b.regra_nova_elegivel,
       b.motivo_antigo, b.motivo_novo, b.tipo_divergencia, b.regra_provocadora,
       b.fila, b.operador, b.em_fila, b.saldo_diagnostico, b.registrado_em
  from public._backup_shadow_dup_thamis_20261009 b
on conflict (execucao_id, aluno_id) do nothing;

-- 3. Confere: 6 fichas de volta e as 15 linhas shadow no lugar.
do $$
declare v_fichas int; v_shadow int;
begin
  select count(*) into v_fichas from public.alunos
   where regexp_replace(coalesce(cpf,''),'\D','','g') in (
     select distinct regexp_replace(coalesce(b.cpf,''),'\D','','g')
       from public._backup_alunos_dup_thamis_20261009 b
      where coalesce(btrim(b.cpf),'') <> '');
  select count(*) into v_shadow from public.elegibilidade_shadow_divergencia
   where aluno_id::text in ('d170ac1e-a077-407b-9bf0-34c33a1e283a',
                            '22ba5dd1-c999-4a8b-b9cb-efd440bf5fa8',
                            'bf707bb4-6201-4966-80c5-b49dcf23b12a',
                            '78c350d1-6e1c-4964-b4d2-19db3fc8959b',
                            '468768c2-25a9-4aec-be28-c34494ed9b6d');
  if v_fichas <> 6 or v_shadow <> 15 then
    raise exception 'ROLLBACK INCOMPLETO: fichas=% shadow=% (esperado 6 e 15).', v_fichas, v_shadow;
  end if;
end $$;
