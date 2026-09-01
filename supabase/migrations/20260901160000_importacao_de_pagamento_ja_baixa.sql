-- Amanda, 01/09: "o que estamos fazendo e ajustando o que vai importar e
-- reduzindo esses casos".
--
-- Ate aqui a baixa dependia de a parcela JA ter o numero do boleto gravado. O
-- gatilho por linha (trg_pagamento_baixa_documento) so casa quando
-- `parcelas.boleto` esta preenchido -- e ele fica vazio sempre que os titulos
-- do acordo nao entram na importacao. Em 01/09 isso deixou 25 dos 36 pagamentos
-- do lote sem baixar, incluindo dois acordos pagos por completo.
--
-- Agora a importacao fecha o ciclo sozinha: terminado o lote, a rotina le o
-- numero do documento NO PROPRIO PAGAMENTO, grava na parcela e baixa.
--
-- Gatilho de STATEMENT, nao de linha: roda uma vez por lote, nao uma vez por
-- pagamento. E nao derruba a importacao se falhar -- o pagamento entrar e mais
-- importante que a baixa automatica; o cron e a tela pegam o que sobrar. A
-- falha fica registrada em auditoria para alguem olhar.

create or replace function public._pagamentos_baixar_lote()
returns trigger language plpgsql security definer set search_path to 'public'
as $function$
declare v_res jsonb;
begin
  perform set_config('reativa.fluxo_pagamentos','on', true);
  begin
    v_res := public.baixa_pelo_relatorio_pagamento(true, (current_date - 180));
  exception when others then
    insert into public.auditoria (usuario, acao, tabela_afetada, registro_id, detalhes)
    values ('rotina','BAIXA_LOTE_FALHOU','pagamentos', null,
            jsonb_build_object('erro', SQLERRM));
    return null;
  end;
  return null;
end;
$function$;

drop trigger if exists trg_pagamentos_baixar_lote on public.pagamentos;
create trigger trg_pagamentos_baixar_lote
  after insert on public.pagamentos
  referencing new table as novos
  for each statement execute function public._pagamentos_baixar_lote();
