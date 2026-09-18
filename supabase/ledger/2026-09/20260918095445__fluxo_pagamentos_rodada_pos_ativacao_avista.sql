do $f$
begin
  if exists (select 1 from pg_stat_activity where query ilike '%fluxo_pagamentos_rodar%' and pid <> pg_backend_pid() and state = 'active') then
    raise exception 'RODADA: ja existe uma rodada em curso';
  end if;
  perform public.fluxo_pagamentos_rodar('rollout_avista_pos_ativacao');
end;
$f$;
