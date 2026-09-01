-- Amanda, 31/08: "isso nao pode acontecer, se esta quitado e quitado --
-- zerado e quitado sai da nossa contagem".
--
-- `acordos_titulos` diz a mesma coisa em dois campos, `situacao` e `status`, e
-- o recalculo le OS DOIS (situacao in ABERTO/NEGOCIADO **e** status <>
-- 'quitada'). Discordando, o saldo ignora o titulo mas a ficha mostra como
-- divida aberta. Achados em 31/08: 6 titulos (R$ 37.537,38) da limpeza de
-- 20/07, e mais 385 com situacao PAGO e status de aberto.
--
-- O gatilho normaliza na escrita, para o problema nao nascer de novo.

create or replace function public._titulo_situacao_e_status_coerentes()
returns trigger language plpgsql set search_path to 'public'
as $function$
declare v_sit text; v_st text;
begin
  v_sit := upper(coalesce(new.situacao,''));
  v_st  := lower(coalesce(new.status,''));

  if v_st = 'quitada' and v_sit in ('ABERTO','NEGOCIADO') then
    new.situacao := 'PAGO'; v_sit := 'PAGO';
  end if;

  if v_sit = 'PAGO' and v_st not in ('quitada','pago') then
    new.status := 'quitada';
  elsif v_sit = 'ABERTO' and v_st <> 'em_aberto' then
    new.status := 'em_aberto';
  elsif v_sit = 'NEGOCIADO' and v_st <> 'vinculada' then
    new.status := 'vinculada';
  elsif v_sit = 'CANCELADA' and v_st <> 'cancelada' then
    new.status := 'cancelada';
  end if;

  return new;
end;
$function$;

drop trigger if exists trg_titulo_situacao_status_coerentes on public.acordos_titulos;
create trigger trg_titulo_situacao_status_coerentes
  before insert or update of situacao, status on public.acordos_titulos
  for each row execute function public._titulo_situacao_e_status_coerentes();
