-- Rollback de 20261114120000_tabulacao_termo_fisico_restrita_gestao.sql.
--
-- O QUE FAZ: remove as DUAS linhas do catálogo criadas pela migração, e só se for seguro.
-- O QUE NÃO FAZ: não remove a trigger aluno_mov_tabulacao_so_gestao nem a função.
--   A barreira contra gravação dos códigos restritos PERMANECE enquanto eles puderem ser
--   enviados por qualquer cliente. Remover a barreira é decisão separada, depois que o
--   frontend estiver revertido e houver evidência de que nenhum cliente envia os códigos.
--
-- Recusa INTEIRA (nada é alterado) se:
--   1. alguma coluna das duas linhas divergir do que a migração gravou (IS DISTINCT FROM);
--   2. qualquer tabela pública tiver registro que cite os códigos, em QUALQUER coluna,
--      com a mesma normalização do trigger (ASCII + upper em COLLATE "C").
-- Locks: as tabelas são travadas em EXCLUSIVE antes das checagens, para que nada mude entre a
-- verificação e a remoção.
BEGIN;
LOCK TABLE public.tabulacoes, public.aluno_movimentacoes IN EXCLUSIVE MODE;

do $$
declare
  v_codigos constant text[] := array['TERMO_FISICO_EM_ANDAMENTO','TERMO_FISICO_ARQUIVADO'];
  v_padrao constant text := 'TERMO_FISICO_(EM_ANDAMENTO|ARQUIVADO)';
  v_alteradas integer;
  v_usados integer := 0;
  v_n integer;
  v_tab record;
begin
  -- 1. Estado exato, coluna a coluna.
  select count(*) into v_alteradas
    from (values
      ('TERMO_FISICO_EM_ANDAMENTO', 'Possui termo físico assinado, em andamento', 355),
      ('TERMO_FISICO_ARQUIVADO',    'Termo físico arquivado, quitado',            356)
    ) as esperado(codigo, rotulo, ordem)
    left join public.tabulacoes t on t.codigo = esperado.codigo
   where t.codigo is null
      or t.rotulo is distinct from esperado.rotulo
      or t.ordem is distinct from esperado.ordem
      or t.ativa is distinct from true
      or t.grupo is distinct from 'ADMINISTRATIVO'
      or t.retorno_modo is distinct from 'NENHUM'
      or t.retorno_dias_uteis is distinct from null
      or t.proxima_acao is distinct from 'CONTATAR'
      or t.bloco_ficha is distinct from null
      or t.exige_processo is distinct from false
      or t.bloqueia_acionamento is distinct from false
      or t.sistema is distinct from false
      or t.criado_em is distinct from timestamptz '2026-11-14 00:00:00-03'
      or t.criado_por is distinct from 'migration_termo_fisico'
      or t.atualizado_em is distinct from null
      or t.atualizado_por is distinct from null
      or t.desativada_em is distinct from null
      or t.desativada_por is distinct from null
      or t.somente_gestao is distinct from true
      or t.redireciona_para_email is distinct from null
      or t.efeito_desfecho is distinct from null;
  if v_alteradas > 0 then
    raise exception 'rollback recusado: a tabulação de termo físico foi alterada depois da migração. Nada foi alterado nem removido. Tratar pelo fluxo autorizado.';
  end if;

  -- 2. Dependências: qualquer tabela pública (derivada do catálogo, não lista fixa), exceto o
  --    próprio catálogo. Texto da linha normalizado como o trigger: ASCII, upper em COLLATE "C".
  for v_tab in
    select c.relname
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind = 'r' and c.relname <> 'tabulacoes'
  loop
    execute format(
      'select count(*) from public.%I t where upper(regexp_replace(t::text, ''[^A-Za-z0-9_]'', '''', ''g'') COLLATE "C") ~ $1',
      v_tab.relname)
      into v_n using v_padrao;
    v_usados := v_usados + v_n;
  end loop;
  if v_usados > 0 then
    raise exception 'rollback recusado: % registro(s) em tabelas do sistema citam estes códigos. O histórico é preservado; nada foi alterado nem removido. Tratar pelo fluxo autorizado.', v_usados;
  end if;

  -- 3. Remoção: só as linhas criadas pela migração, sem tocar em outras tabulações.
  delete from public.tabulacoes
   where codigo = any(v_codigos) and criado_por = 'migration_termo_fisico';
end $$;
COMMIT;
