-- Cobertura que o 12p_reaplica (migração B1, em proposta separada) tinha e que pertence à 20261114120000:
-- (1) a flag é NOT NULL (definida na 20261114120000); (2) ligar/desligar pela fixture é idempotente e
-- o estado final é o esperado. Usa só atualizações de fixture, sem a migração B1. Roda como postgres (banco descartável).
\set ON_ERROR_STOP on

-- (1) NULL não é armazenável
do $$
begin
  begin
    update public.termo_fisico_contencao set contencao_ativa = null where id;
    raise exception 'FALHOU: flag aceitou NULL';
  exception when not_null_violation then
    null;
  end;
end $$;

-- (2) liga, liga de novo, desliga, desliga de novo: estado final = desligada, linha única
update public.termo_fisico_contencao set contencao_ativa = true,  alterado_em = clock_timestamp(), alterado_por = 'fixture_teste' where id;
update public.termo_fisico_contencao set contencao_ativa = true,  alterado_em = clock_timestamp(), alterado_por = 'fixture_teste' where id;
update public.termo_fisico_contencao set contencao_ativa = false, alterado_em = clock_timestamp(), alterado_por = 'migration_termo_fisico' where id;
update public.termo_fisico_contencao set contencao_ativa = false, alterado_em = clock_timestamp(), alterado_por = 'migration_termo_fisico' where id;
do $$
begin
  if (select count(*) from public.termo_fisico_contencao) <> 1
     or not (select not contencao_ativa and alterado_por = 'migration_termo_fisico' from public.termo_fisico_contencao where id) then
    raise exception 'FALHOU: estado final da contenção não é desligado com autoria da migração';
  end if;
  raise notice 'PASS: flag NOT NULL e ligar/desligar por fixture idempotente (estado final desligado)';
end $$;
