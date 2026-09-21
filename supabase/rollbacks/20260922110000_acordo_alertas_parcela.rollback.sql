-- ROLLBACK de 20260922110000_acordo_alertas_parcela. Remove objetos novos (tabela de alertas e funcoes); nenhum dado existente e tocado.
begin;
drop trigger if exists trg_acordo_alerta_resolve_parcela on public.parcelas;
drop trigger if exists trg_acordo_alerta_resolve_acordo on public.acordos;
drop function if exists public.tg_acordo_alerta_resolve_parcela();
drop function if exists public.tg_acordo_alerta_resolve_acordo();
drop function if exists public.acordo_alertas_sem_responsavel();
drop function if exists public.acordo_alertas_do_operador(uuid);
drop function if exists public.acordo_alertas_gerar(date,int,text);
drop function if exists public.acordo_alertas_resolver(date);
drop function if exists public.acordo_alerta_data(date,int,text);
drop function if exists public.acordo_classificar(uuid,date);
drop table if exists public.acordo_alertas_parcela;
delete from public.calibragem_parametros where chave = 'alerta_parcela_d2';
commit;
