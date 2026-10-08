-- ============================================================================
-- ROLLBACK de 20261008120000 -- tira a chave `acordos_hoje` do payload.
-- ============================================================================
-- PATCH ANCORADO, não reescrita: tv_snapshot_atualizar carrega o filtro de
-- tv_equipe_oculta (20261007093518) e a chave magic (20261007111401). Trocar a
-- função inteira pelo texto do repositório apagaria as duas em silêncio.
--
-- Remove só o bloco da chave, por expressão regular, e confere depois que o que
-- não era para sair continua lá.
--
-- NÃO desfaz nada no banco além disso: nenhuma tabela é criada ou apagada por
-- 20261008120000, e nenhum dado de acordo, parcela ou pagamento é tocado por
-- ela nem por este rollback. O snapshot seguinte simplesmente sai sem a chave,
-- e o slide "Acordos de Hoje" passa a mostrar o estado vazio.
-- ============================================================================

begin;

do $patch$
declare
  v_src text; v_novo text; v_n int;
  -- SEM a flag 'n': com ela o `.` não cruza quebra de linha e o bloco (que tem
  -- ~30 linhas) nunca casaria. Erro cometido e medido pelo teste de rollback.
  v_re text := '    -- ACORDOS DE HOJE.*?\n    \)\);\n\n';
begin
  select pg_get_functiondef(p.oid) into v_src
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'tv_snapshot_atualizar' limit 1;
  if v_src is null then
    raise exception 'tv_snapshot_atualizar() nao existe neste banco.';
  end if;

  if position('acordos_hoje' in v_src) = 0 then
    raise notice 'chave acordos_hoje ja estava fora; nada a fazer.';
    return;
  end if;

  select count(*) into v_n from regexp_matches(v_src, v_re, 'g');
  if v_n <> 1 then
    raise exception 'bloco de acordos_hoje encontrado % vez(es) (esperado 1). Nada foi alterado.', v_n;
  end if;

  v_novo := regexp_replace(v_src, v_re, '');

  if position('acordos_hoje' in v_novo) > 0 then
    raise exception 'ainda restou acordos_hoje depois da remocao. Nada foi aplicado.';
  end if;
  if position('tv_equipe_oculta' in v_novo) = 0 or position('magic_number_mensal' in v_novo) = 0 then
    raise exception 'a remocao levaria junto o filtro de equipe oculta ou a chave magic. Nada foi aplicado.';
  end if;

  execute v_novo;
end
$patch$;

commit;
