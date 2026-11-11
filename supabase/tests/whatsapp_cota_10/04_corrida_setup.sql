-- CORRIDA REAL — preparação
--
-- Duas conexões registram, AO MESMO TEMPO, duas respostas ENVIADAS do mesmo
-- responsável na mesma conversa (clique duplo, ou Edge repetida). Nenhuma
-- enxerga a mensagem não confirmada da outra, então as duas acham que são
-- "a primeira do ciclo". Quem segura a contagem em 1 é o índice único
-- parcial uq_whatsapp_abordagem_receptiva_ciclo + ON CONFLICT DO NOTHING:
-- a segunda espera a primeira confirmar e desiste.
--
-- O job do CI roda as duas conexões; este arquivo só monta o cenário.

\set ON_ERROR_STOP on

do $$
declare v_canal uuid; v_c uuid;
begin
  v_canal := public._t_canal('_cota_corrida', 'ATIVO_CONTROLADO', 10, null);
  v_c := public._t_conversa(v_canal, '5551970000001');
  perform public._t_msg(v_c, 'ENTRADA', 1);
end $$;

select public._t_assumir(id, 'op_corrida@test.local', 600)
  from public.whatsapp_conversas where telefone_e164 = '5551970000001';

insert into public.usuarios (email, nome, perfil, ativo)
values ('op_corrida@test.local', 'Op corrida', 'operador', true)
on conflict (email) do nothing;

select 'corrida pronta' as status;
