-- ROLLBACK — conferência DEPOIS de rodar
-- 20261111150000_whatsapp_cota_10_operador.rollback.sql (duas vezes)
--
-- Prova que o banco voltou ao estado "v2 aplicada, cota antiga":
--   estrutura, limites, grants E comportamento.

\set ON_ERROR_STOP on

select id as c10_rb from public.whatsapp_canais where sessao_chave = '_cota10' \gset

drop table if exists _cota_rb;
create table _cota_rb (n text, caso text, esperado text, obtido text);

insert into _cota_rb values
 ('R1', 'checar com CONTINUIDADE e sem a regra por perfil/RECEPTIVA', 'true|false|false',
   (select (prosrc ilike '%CONTINUIDADE%')::text || '|' || (prosrc ilike '%sem_limite_individual%')::text
           || '|' || (prosrc ilike '%RECEPTIVA%')::text
      from pg_proc where proname = 'whatsapp_cadencia_checar' and pronamespace = 'public'::regnamespace)),
 ('R2', 'trigger, funcao do trigger e helper removidos', '0|0|0',
   (select count(*) from pg_trigger where tgname = 'trg_whatsapp_cadencia_receptiva')::text || '|' ||
   (select count(*) from pg_proc where proname = 'whatsapp_cadencia_marcar_receptiva')::text || '|' ||
   (select count(*) from pg_proc where proname = 'whatsapp_cadencia_sem_limite_individual')::text),
 ('R3', 'colunas novas removidas e UNIQUE (canal, conversa, dia) de volta', '0|1',
   (select count(*) from information_schema.columns
     where table_schema = 'public' and table_name = 'whatsapp_abordagens'
       and column_name in ('origem', 'ciclo_desde', 'wamid'))::text || '|' ||
   (select count(*) from pg_constraint where conname = 'uq_whatsapp_abordagem'
       and conrelid = 'public.whatsapp_abordagens'::regclass)::text),
 ('R4', 'teto_abordagens_operador volta a 3', '3',
   (select teto_abordagens_operador::text from public.whatsapp_config)),
 ('R5', 'canais reais voltam a Cobranca 15, Comercial 2, Piloto 3', '15|2|3',
   (select string_agg(limite_abordagens_operador::text, '|' order by apelido)
      from public.whatsapp_canais where id in ('b8f00c75-aee3-4d22-83b7-f0041be0ef71',
        '9f5fc202-3a22-4b24-8794-65fd92858e31', '3628d3fd-ab44-4c47-bf42-3d344c1e9336'))),
 ('R6', 'consumo volta a assinatura de producao (sem as 2 colunas novas)', 'false',
   (pg_get_function_result('public.whatsapp_cadencia_consumo()'::regprocedure) ilike '%sem_limite_individual%')::text),
 ('R7', 'grants de producao: checar sem authenticated, consumo com', 'false|false|true|false',
   has_function_privilege('authenticated', 'public.whatsapp_cadencia_checar(uuid, uuid, text)', 'EXECUTE')::text
   || '|' || has_function_privilege('anon', 'public.whatsapp_cadencia_checar(uuid, uuid, text)', 'EXECUTE')::text
   || '|' || has_function_privilege('authenticated', 'public.whatsapp_cadencia_consumo()', 'EXECUTE')::text
   || '|' || has_function_privilege('anon', 'public.whatsapp_cadencia_consumo()', 'EXECUTE')::text);

-- Comportamento no Comercial real (limite voltou a 2)
select public._t_conversa('b8f00c75-aee3-4d22-83b7-f0041be0ef71', '5551980000' || lpad(g::text, 3, '0')) as x
  from generate_series(1, 6) g;

insert into _cota_rb
select 'R8', 'operador volta ao limite 2: 3a barrada', '2|LIMITE_OPERADOR',
       (select count(*) filter (where r = 'NOVA_ABORDAGEM')
          from (select public._t_checar('b8f00c75-aee3-4d22-83b7-f0041be0ef71', id, 'op_rb@test.local') r
                  from public.whatsapp_conversas
                 where telefone_e164 in ('5551980000001', '5551980000002')) x)::text
       || '|' || public._t_checar('b8f00c75-aee3-4d22-83b7-f0041be0ef71',
                   (select id from public.whatsapp_conversas where telefone_e164 = '5551980000003'),
                   'op_rb@test.local');

insert into _cota_rb
select 'R9', 'gerencia perde a isencao (regra antiga): 3a barrada', '2|LIMITE_OPERADOR',
       (select count(*) filter (where r = 'NOVA_ABORDAGEM')
          from (select public._t_checar('b8f00c75-aee3-4d22-83b7-f0041be0ef71', id, 'ger_cota@test.local') r
                  from public.whatsapp_conversas
                 where telefone_e164 in ('5551980000004', '5551980000005')) x)::text
       || '|' || public._t_checar('b8f00c75-aee3-4d22-83b7-f0041be0ef71',
                   (select id from public.whatsapp_conversas where telefone_e164 = '5551980000006'),
                   'ger_cota@test.local');

-- Resposta enviada depois do rollback não gera linha nenhuma
select public._t_conversa(:'c10_rb', '5551980000100') as rb_c \gset
select count(*) as antes from public.whatsapp_abordagens \gset
select public._t_assumir(:'rb_c', 'op_rb@test.local', 600);
select public._t_registrar(:'rb_c', 'op_rb@test.local', 'ENVIADO', 'w-rb-1', 300);
insert into _cota_rb values ('R10', 'sem trigger: resposta enviada nao grava em whatsapp_abordagens', :'antes',
  (select count(*)::text from public.whatsapp_abordagens));

-- CONTINUIDADE da v2 segue funcionando depois do rollback
select public._t_conversa(:'c10_rb', '5551980000200') as rb_cont \gset
select public._t_msg(:'rb_cont', 'ENTRADA', 48), public._t_msg(:'rb_cont', 'SAIDA', 46, 'op_rb2@test.local'),
       public._t_msg(:'rb_cont', 'ENTRADA', 40);
insert into _cota_rb values ('R11', 'CONTINUIDADE v2 segue de pe', 'CONTINUIDADE',
  public._t_checar(:'c10_rb', :'rb_cont', 'op_rb2@test.local'));

select n, caso, esperado, obtido,
       case when obtido is not distinct from esperado then 'OK' else 'FALHOU' end as veredito
  from _cota_rb order by n;

do $final$
declare v_falhas integer; v_total integer;
begin
  select count(*) filter (where obtido is distinct from esperado), count(*)
    into v_falhas, v_total from _cota_rb;
  raise notice 'ROLLBACK COTA 10: % assercoes, % falhas', v_total, v_falhas;
  if v_total <> 11 then
    raise exception 'esperava 11 assercoes, rodaram %', v_total using errcode = '22023';
  end if;
  if v_falhas > 0 then
    raise exception 'rollback: % assercoes falharam', v_falhas using errcode = '22023';
  end if;
end $final$;
