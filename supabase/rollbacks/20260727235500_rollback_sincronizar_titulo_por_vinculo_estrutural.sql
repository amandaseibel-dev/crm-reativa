-- ROLLBACK COMPLETO da correcao estrutural (A)
-- 20260727235500_sincronizar_titulo_por_vinculo_estrutural.sql
--
-- Restaura a funcao/trigger titulo_situacao_por_vinculo() ao estado ANTERIOR
-- (so ajustava `situacao` ABERTO<->NEGOCIADO em INSERT/UPDATE; sem DELETE; sem
-- mexer em `status`/`acordo_id`). Executar manualmente (nao e uma migration da
-- sequencia). NAO reverte dados -- a reconciliacao (B) e separada e, se aplicada,
-- tem seu proprio racional; este rollback trata apenas do objeto estrutural.
--
-- OBS: reverter reabre a causa raiz (escrita parcial / titulos negociado-orfaos).
-- Use apenas se a correcao estrutural precisar ser retirada.

create or replace function public.titulo_situacao_por_vinculo()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
begin
  if coalesce(new.ativo,true) then
    update public.acordos_titulos set situacao='NEGOCIADO', atualizado_em=now()
    where id=new.titulo_id and situacao='ABERTO';
  else
    update public.acordos_titulos set situacao='ABERTO', atualizado_em=now()
    where id=new.titulo_id and situacao='NEGOCIADO';
  end if;
  return new;
end;
$function$;

drop trigger if exists trg_titulo_situacao_por_vinculo on public.acordo_titulo_vinculo;
create trigger trg_titulo_situacao_por_vinculo
after insert or update on public.acordo_titulo_vinculo
for each row execute function public.titulo_situacao_por_vinculo();
