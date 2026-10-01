-- ROLLBACK da correcao de dado 20260925125350 (reabre_mensalidades_acordo_cancelado_sem_pagamento).
-- NAO EXECUTADO. Registro para reversao, se um dia for decidida.
--
-- Devolve cada mensalidade ao estado salvo em
-- _backup_reabre_mensalidade_acordo_cancelado_20260925 (versao 20260925125311):
-- situacao, status, acordo_id e atualizado_em, por id exato -- nao ha PITR, e
-- a correcao so mudou essas quatro colunas. So toca a linha que continua
-- exatamente como a correcao deixou (ABERTO/em_aberto/sem acordo): se alguem ja
-- a vinculou num acordo novo, baixou ou encerrou depois, ela fica de fora e
-- aparece no aviso, para decisao a mao.
--
-- ORDEM: rollback da 20260925123852 primeiro
-- (supabase/rollbacks/20260925123852_acordo_cancelado_sem_pagamento_reabre_mensalidade.rollback.sql),
-- este depois. Com a regra de 25/09 de pe, qualquer gatilho que reavalie o
-- titulo o reabre de novo.
do $$
declare
  v_restaurados int;
  v_fora int;
begin
  update public.acordos_titulos t
     set situacao = b.situacao, status = b.status, acordo_id = b.acordo_id, atualizado_em = b.atualizado_em
    from public._backup_reabre_mensalidade_acordo_cancelado_20260925 b
   where t.id = b.id
     and t.situacao = 'ABERTO' and t.status = 'em_aberto' and t.acordo_id is null;
  get diagnostics v_restaurados = row_count;

  select count(*) into v_fora
    from public._backup_reabre_mensalidade_acordo_cancelado_20260925 b
    join public.acordos_titulos t on t.id = b.id
   where not (t.situacao = b.situacao and t.status = b.status and t.acordo_id is not distinct from b.acordo_id);

  raise notice 'restauradas: %; mudaram depois da correcao e ficaram de fora: %', v_restaurados, v_fora;
end $$;
