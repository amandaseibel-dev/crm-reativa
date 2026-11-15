-- Rollback de 20261114120000_tabulacao_termo_fisico_restrita_gestao.sql.
-- Restaura EXATAMENTE o estado anterior: antes da migração as duas linhas não existiam.
-- Por isso remove as linhas, e SÓ se for seguro. Recusa INTEIRA (nada é alterado) se:
--   1. alguma coluna de alguma das duas linhas for diferente do que a migração gravou
--      (comparação por IS DISTINCT FROM: NULL conta como diferença);
--   2. algum registro de histórico ou de estado do aluno citar os códigos, em QUALQUER
--      campo (tabelas consultadas se existirem).
-- Só então remove as linhas, a trigger e a função. O histórico é preservado.
BEGIN;
do $$
declare
  v_codigos constant text[] := array['TERMO_FISICO_EM_ANDAMENTO','TERMO_FISICO_ARQUIVADO'];
  v_alteradas integer;
  v_usados integer := 0;
  v_tab text;
  v_n integer;
  v_padrao constant text := 'TERMO_FISICO_(EM_ANDAMENTO|ARQUIVADO)';
begin
  -- 1. Estado exato: cada linha precisa bater com o que a migração gravou, coluna a coluna.
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

  -- 2. Histórico e estado: nenhum registro pode citar os códigos, em nenhum campo.
  --    Verificação por texto da linha inteira (cobre status_novo, status_anterior, estados, snapshots).
  foreach v_tab in array array['aluno_movimentacoes','alunos','acoes_desfazer','alunos_estado_anterior'] loop
    if to_regclass('public.' || v_tab) is not null then
      execute format('select count(*) from public.%I t where t::text ~* $1', v_tab)
        into v_n using v_padrao;
      v_usados := v_usados + v_n;
    end if;
  end loop;
  if v_usados > 0 then
    raise exception 'rollback recusado: % registro(s) de histórico ou estado do aluno citam estes códigos. O histórico é preservado; nada foi alterado nem removido. Tratar pelo fluxo autorizado.', v_usados;
  end if;

  delete from public.tabulacoes
   where codigo = any(v_codigos) and criado_por = 'migration_termo_fisico';
  drop trigger if exists aluno_mov_tabulacao_so_gestao on public.aluno_movimentacoes;
  drop function if exists public.aluno_movimentacao_tabulacao_so_gestao();
end $$;
COMMIT;
