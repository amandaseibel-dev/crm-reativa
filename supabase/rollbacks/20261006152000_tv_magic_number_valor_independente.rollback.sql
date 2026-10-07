-- ============================================================================
-- ROLLBACK de 20261006152000 -- devolve tv_snapshot_atualizar à versão
-- 20261001142500 (sem a chave 'magic') e descarta a tabela do Magic Number.
-- ============================================================================
-- ORDEM IMPORTA: primeiro a função para de ler a tabela, só depois a tabela cai.
-- Invertido, uma atualização da TV disparada no meio do caminho encontraria a
-- função viva apontando para uma tabela que já não existe.
--
-- O QUE ISTO APAGA: o valor do Magic Number de cada competência cadastrada,
-- incluindo os R$ 142.800,00 de outubro/2026. Não há outra cópia — o valor é
-- independente por definição e não se recalcula a partir da meta. Guarde o
-- conteúdo antes de rodar:
--   select * from public.magic_number_mensal order by mes_referencia;
--
-- O QUE ISTO NÃO MEXE: metas_projecao (a meta piso), tv_snapshot_calcular e
-- qualquer cálculo financeiro. O snapshot seguinte simplesmente volta a sair
-- sem a chave 'magic', e o slide some do rodízio sozinho.
-- ============================================================================

begin;

-- 1) A chave 'magic' sai do payload -- por PATCH ANCORADO, não por reescrita.
--    Reescrever a função a partir do texto do repositório apagaria o filtro de
--    tv_equipe_oculta (saída da Olga) e qualquer outro patch que esteja vivo.
do $patch$
declare
  v_src text; v_n int;
  v_re text := '    -- MAGIC NUMBER da competência corrente\..*?limit 1\)\);\s*\n\n';
begin
  select pg_get_functiondef(p.oid) into v_src
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'tv_snapshot_atualizar' limit 1;
  if v_src is null then
    raise exception 'tv_snapshot_atualizar() nao existe neste banco.';
  end if;
  if position('magic_number_mensal' in v_src) = 0 then
    raise notice 'chave magic ja estava fora; nada a fazer.';
    return;
  end if;

  select count(*) into v_n from regexp_matches(v_src, v_re, 'gn');
  if v_n <> 1 then
    raise exception 'bloco da chave magic encontrado % vez(es) (esperado 1). Nada foi alterado.', v_n;
  end if;

  execute regexp_replace(v_src, v_re, '', 'n');
end
$patch$;

-- 2) Só agora a tabela.
drop table if exists public.magic_number_mensal;

commit;
