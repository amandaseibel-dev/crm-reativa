-- ACORDO SEM PAGAMENTO E SIMULACAO -- A MENSALIDADE NAO SAI.
--
-- REGRA DA AMANDA, que eu deixei de fora da deducao do elo: a mensalidade sai e
-- vira acordo, mas o ACORDO SO E VALIDO SE TIVER PAGAMENTO. Sem pagamento e
-- simulacao: a divida continua sendo da mensalidade e tem que seguir cobrada.
--
-- O ERRO. A migration 20260909170000 vinculou 1.530 titulos a 474 acordos sem
-- olhar se o acordo foi pago. Medido depois: 383 dos 474 nao tinham pagamento
-- nenhum. R$ 2.012.553,84 de mensalidade saiu da cobranca sem lastro.
--
-- A CORRECAO. Desfaz o vinculo desses acordos. O gatilho titulo_reavaliar
-- devolve cada titulo para ABERTO/em_aberto sozinho -- e por isso que o vinculo
-- foi criado com origem propria: da para desfazer exatamente estes.
--
-- FICAM os acordos com pelo menos uma parcela PAGO.
--
-- Pagamento solto do aluno na janela do acordo NAO conta como lastro: a regra
-- da casa e casar pelo NUMERO DO TITULO, nunca por proximidade de data.
--
-- EFEITO EM CADEIA, aplicado na mesma data: excluir as baixas sem lastro
-- (20260909180000) tirou o pagamento de mais 20 acordos, que viraram simulacao
-- DEPOIS deste desfazer. O bloco final trata isso e serve de rede permanente.

create table if not exists public._backup_elo_desfeito_sem_pagamento_20260909 (
  acordo_id uuid, titulo_id uuid, motivo text, em timestamptz default now()
);
alter table public._backup_elo_desfeito_sem_pagamento_20260909 enable row level security;
drop policy if exists sem_acesso on public._backup_elo_desfeito_sem_pagamento_20260909;
create policy sem_acesso on public._backup_elo_desfeito_sem_pagamento_20260909 for select using (false);

with sem_lastro as (
  select distinct v.acordo_id
    from public.acordo_titulo_vinculo v
   where v.origem = 'regra_liquidacao_prime_20260909'
     and not exists (select 1 from public.parcelas p
                      where p.acordo_id = v.acordo_id and p.status = 'PAGO')
)
insert into public._backup_elo_desfeito_sem_pagamento_20260909 (acordo_id, titulo_id, motivo)
select v.acordo_id, v.titulo_id, 'acordo sem parcela paga: simulacao, a mensalidade volta'
  from public.acordo_titulo_vinculo v
  join sem_lastro s on s.acordo_id = v.acordo_id
 where v.origem = 'regra_liquidacao_prime_20260909';

delete from public.acordo_titulo_vinculo v
 where v.origem = 'regra_liquidacao_prime_20260909'
   and v.acordo_id in (select acordo_id from public._backup_elo_desfeito_sem_pagamento_20260909);

do $$
declare v_titulo uuid;
begin
  for v_titulo in select distinct titulo_id from public._backup_elo_desfeito_sem_pagamento_20260909 loop
    perform public.titulo_reavaliar(v_titulo);
  end loop;
end $$;

do $$
declare v_aluno uuid;
begin
  for v_aluno in
    select distinct t.aluno_id from public._backup_elo_desfeito_sem_pagamento_20260909 b
      join public.acordos_titulos t on t.id = b.titulo_id
     where t.aluno_id is not null
  loop
    perform public.recalcular_situacao_aluno(v_aluno);
  end loop;
end $$;

insert into public.invariante_config (nome, severidade, titulo, explicacao, base_09_09)
values ('acordo_sem_pagamento_com_mensalidade_fora','GRAVE','Acordo sem pagamento tirando mensalidade da cobranca',
  'Acordo sem NENHUMA parcela paga que mesmo assim tem mensalidade vinculada. Acordo sem pagamento e simulacao: a divida continua sendo da mensalidade e tem que seguir cobrada.','547 acordos / R$ 3.691.957,02 em 09/09')
on conflict (nome) do update
  set severidade = excluded.severidade, titulo = excluded.titulo, explicacao = excluded.explicacao;
