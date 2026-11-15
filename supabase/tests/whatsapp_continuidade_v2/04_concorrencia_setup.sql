-- CONCORRÊNCIA — preparo do cenário para DUAS CONEXÕES INDEPENDENTES.
--
-- Este arquivo só monta o cenário. A corrida é orquestrada pelo passo do
-- workflow, que abre dois psql de verdade — teste sequencial não prova
-- proteção contra corrida.
--
-- CENÁRIO: canal com limite_abordagens_operador = 1 e duas conversas novas.
--   Sessão A: BEGIN; cadencia_checar(conv1); pg_sleep(3); COMMIT;
--   Sessão B: cadencia_checar(conv2)  — começa ~1s depois
--
-- SEM o lock de linha do canal, A e B leriam a contagem antes do INSERT do
-- outro e AMBAS passariam: o limite de 1 seria furado e sobrariam 2 linhas.
-- COM o lock (SELECT ... FOR UPDATE no topo da função), B fica bloqueada até
-- A commitar, depois enxerga v_op = 2 > 1 e levanta LIMITE_OPERADOR.
--
-- ASSERÇÕES feitas pelo workflow:
--   1. B falhou com LIMITE_OPERADOR          -> o limite resistiu
--   2. B esperou >= 2s                       -> bloqueou no lock, nao correu
--   3. sobrou exatamente 1 abordagem          -> o INSERT de B foi desfeito

\set ON_ERROR_STOP on

do $conc$
declare
  v_canal uuid;
begin
  v_canal := public._t_canal('_cont_v2_conc', 'ATIVO_CONTROLADO', 1, null);
  perform public._t_conversa(v_canal, '5551900300001', 'NOVO');
  perform public._t_conversa(v_canal, '5551900300002', 'NOVO');
  raise notice 'cenario de concorrencia montado: canal com limite_abordagens_operador = 1';
end $conc$;

-- Garante que o cenário nasce limpo
delete from public.whatsapp_abordagens a
 using public.whatsapp_canais k
 where a.canal_id = k.id and k.sessao_chave = '_cont_v2_conc';

select k.id          as canal_id,
       c1.id         as conversa_1,
       c2.id         as conversa_2
  from public.whatsapp_canais k
  join public.whatsapp_conversas c1 on c1.canal_id = k.id and c1.telefone_e164 = '5551900300001'
  join public.whatsapp_conversas c2 on c2.canal_id = k.id and c2.telefone_e164 = '5551900300002'
 where k.sessao_chave = '_cont_v2_conc';
