-- Rollback de supabase/migrations/20261006100000_tv_semana_comeca_na_segunda.sql
--
-- Devolve a semana da TV para a janela MOVEL de 7 dias
-- (`data_pagamento >= current_date - 6`), que e como estava antes de 06/10/2026.
--
-- Efeito de rodar isto: o "Destaque da Semana" volta a nao zerar na segunda --
-- na manha de segunda ele exibe de novo o acumulado dos sete dias anteriores,
-- carregando a semana que acabou.
--
-- Mesma tecnica da migration -- patch ancorado, idempotente pelo texto NOVO e
-- exigindo exatamente uma ocorrencia -- para nao reescrever os 18.406 bytes da
-- funcao a mao.

do $$
declare
  v_def   text;
  v_ancora constant text := 'data_pagamento >= date_trunc(''week'', current_date)::date';
  v_troca  constant text := 'data_pagamento >= current_date - 6';
  v_n int;
begin
  select pg_get_functiondef(p.oid) into v_def
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'tv_snapshot_calcular';

  if v_def is null then
    raise exception 'tv_snapshot_calcular nao encontrada em public';
  end if;

  if position(v_troca in v_def) > 0 then
    raise notice 'tv_snapshot_calcular ja usa a janela movel de 7 dias; nada a fazer';
    return;
  end if;

  v_n := (length(v_def) - length(replace(v_def, v_ancora, ''))) / length(v_ancora);
  if v_n <> 1 then
    raise exception
      'esperava exatamente 1 ocorrencia de "%" em tv_snapshot_calcular, encontrei %.',
      v_ancora, v_n;
  end if;

  execute replace(v_def, v_ancora, v_troca);
end $$;
