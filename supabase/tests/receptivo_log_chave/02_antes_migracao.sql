-- ANTES da migration: prova a perda com a chave antiga e fotografa o historico.
\set ON_ERROR_STOP on
drop table if exists _snap_antes;
create table _snap_antes as
  select id, operador_email, responsavel_desde, fonte, conversa_id_inexistente from (
    select id, operador_email, responsavel_desde, fonte, null::uuid as conversa_id_inexistente
      from public.receptivo_atendimentos_log) s;

-- dois alunos DIFERENTES, mesmo operador, MESMO instante (mesma transacao)
insert into public.whatsapp_conversas (id, telefone_e164, responsavel_email, responsavel_desde) values
  ('00000000-0000-0000-0000-00000000d001','5551910000001','op_a@test.local', timestamptz '2026-11-10 12:00:00-03'),
  ('00000000-0000-0000-0000-00000000d002','5551910000002','op_a@test.local', timestamptz '2026-11-10 12:00:00-03');
begin;
select public.fila_receptivo_registrar_atendimento('op_a@test.local','00000000-0000-0000-0000-00000000d001');
select public.fila_receptivo_registrar_atendimento('op_a@test.local','00000000-0000-0000-0000-00000000d002');
commit;
select 'PERDA_ANTES' as caso, count(*) as esperado_2_obtido_linhas
  from public.receptivo_atendimentos_log
 where operador_email='op_a@test.local' and responsavel_desde = timestamptz '2026-11-10 12:00:00-03';
