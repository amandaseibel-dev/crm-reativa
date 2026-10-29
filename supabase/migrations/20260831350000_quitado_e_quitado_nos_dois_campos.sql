-- Quitado e quitado: `situacao` e `status` nunca mais discordam.
--
-- Amanda, 31/08: "isso nao pode acontecer, se esta quitado e quitado -- zerado
-- e quitado sai da nossa contagem" e "essa situacao do status esta acontecendo
-- com frequencia".
--
-- POR QUE DOI. `recalcular_situacao_aluno` le OS DOIS campos:
--     situacao in ('ABERTO','NEGOCIADO') and lower(status) not in ('quitada')
-- Discordando, o titulo cai num limbo: o SALDO ignora (por causa do status) mas
-- a FICHA mostra como divida aberta (por causa da situacao). O operador ve
-- divida que o sistema jura que nao existe.
--
-- O QUE FOI ENCONTRADO em 31/08:
--   6 titulos ABERTO + status 'quitada', R$ 37.537,38, em 3 alunos (Anna Laura
--     Vilela Grings, Izadora Vianna Alves, Edilson Lira Patrocinio). Todos com
--     motivo "Aluno ja pago/quitado (limpeza carteira)", gravados no mesmo
--     segundo: 20/07/2026 22:36:41. A limpeza escreveu o status e esqueceu a
--     situacao -- meia gravacao.
--   385 titulos PAGO com status de aberto (361 'em_aberto' + 24 'vinculada'),
--     R$ 442.940,93.
--
-- Decisao da Amanda: quitado manda. Os 6 viraram PAGO (a divida NAO volta) e os
-- 385 tiveram o status alinhado. Backup em
-- `_backup_situacao_status_divergentes_20260831`.
--
-- A trava normaliza NA ESCRITA, entao vale para qualquer caminho -- tela,
-- importacao, script de limpeza ou update direto no banco. Nao rejeita nada:
-- corrige e deixa passar, para nunca virar um erro mudo que trava a operacao.

create or replace function public._titulo_situacao_e_status_coerentes()
returns trigger
language plpgsql
set search_path to 'public'
as $function$
declare v_sit text; v_st text;
begin
  v_sit := upper(coalesce(new.situacao,''));
  v_st  := lower(coalesce(new.status,''));

  -- quitado manda: quem chega com status 'quitada' sai como PAGO
  if v_st = 'quitada' and v_sit in ('ABERTO','NEGOCIADO') then
    new.situacao := 'PAGO';
    v_sit := 'PAGO';
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

  -- DUPLICADA fica de fora de proposito: sao 210 titulos com status
  -- 'em_aberto' e a situacao ja os exclui do recalculo. Normalizar ali
  -- mexeria em coisa que hoje esta certa.

  return new;
end;
$function$;

drop trigger if exists trg_titulo_situacao_status_coerentes on public.acordos_titulos;
create trigger trg_titulo_situacao_status_coerentes
  before insert or update of situacao, status on public.acordos_titulos
  for each row execute function public._titulo_situacao_e_status_coerentes();
